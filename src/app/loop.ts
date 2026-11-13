// 运行循环：固定 100 毫秒一步，渲染帧里用累加器，暂停和三档速度，窗口不可见时的补算和离开。
// 纯逻辑，不碰 DOM 和系统时钟。时间由调用方传入，而且分成两种，不要混用：
//   帧时间 nowMs：单调时钟，渲染帧的时间戳（requestAnimationFrame 给的那个）。只用来算两帧之间隔了多久。
//   墙上时间 wallMs：系统时间（Date.now）。只用来算窗口不可见了多久，因为它在机器睡眠期间也会走。
//   用户可以改系统时间，所以它不用来算帧间隔。系统时间被调回过去时，不可见的时长按 0 处理。
// 循环只负责算「这一帧推进几步」，不持有状态，也不调用核心的 step：调用方拿到步数自己去推进。
import { STEP_MS } from '../core/index.ts';

/** 一帧最多补的模拟步数。补不上的部分丢掉，让模拟变慢，不让它越追越卡。 */
export const MAX_STEPS_PER_FRAME = 6;

/** 窗口恢复可见之后补算欠下的步数，每帧最多补这么多，分几帧补完，不让一帧卡太久。 */
export const CATCH_UP_STEPS_PER_FRAME = 30;

/** 窗口不可见的时间达到这个长度（毫秒）按程序关闭处理，不补算，只报告离开的秒数。不到这个长度才补算。 */
export const AWAY_AFTER_MS = 60_000;

export const SPEEDS = [1, 2, 3] as const;
export type Speed = (typeof SPEEDS)[number];

export interface LoopOptions {
  speed?: Speed;
  paused?: boolean;
  maxStepsPerFrame?: number;
  catchUpStepsPerFrame?: number;
  awayAfterMs?: number;
}

export interface FrameResult {
  /** 这一帧要推进的步数，等于累加器给出的步数加上补算的步数。 */
  steps: number;
  /** 其中补算的步数，是窗口恢复可见之后欠下的。 */
  catchUpSteps: number;
  /** 两步之间的插值系数，0 到 1，不含 1：画面位置在上一步和当前步之间的哪里。 */
  alpha: number;
  /** 还欠着多少步没有补完。 */
  owedSteps: number;
}

/** 窗口恢复可见的结果：补算（欠下 catchUpSteps 步，分几帧补完），或者超过时限、按关闭处理。 */
export type ResumeOutcome =
  | { kind: 'resumed'; hiddenMs: number; catchUpSteps: number }
  | { kind: 'away'; hiddenMs: number; awaySeconds: number };

export interface Loop {
  /** 渲染帧调用一次，nowMs 是这一帧的单调时间戳（毫秒）。 */
  frame(nowMs: number): FrameResult;
  /** 窗口变为不可见。wallMs 是此刻的系统时间（毫秒）。重复调用只认第一次。 */
  hide(wallMs: number): void;
  /** 窗口恢复可见。不到 AWAY_AFTER_MS 就算出要补的步数，达到了就报告离开的秒数。 */
  show(wallMs: number): ResumeOutcome;
  /** 模拟最后一次还在前进的系统时间：不可见时是变为不可见的那一刻，否则是 wallMs。存档里的保存时间用它。 */
  lastActiveWallMs(wallMs: number): number;
  speed(): Speed;
  setSpeed(speed: Speed): void;
  paused(): boolean;
  setPaused(paused: boolean): void;
  togglePause(): void;
  hidden(): boolean;
  owedSteps(): number;
  /** 当前的插值系数，不推进。 */
  alpha(): number;
  /** 读档或重开之后调用：清掉累加器、欠下的步数和不可见的记录，速度和暂停保持不变。 */
  reset(): void;
}

/** 离开了多少秒：从 fromMs 到 toMs。系统时间被调回过去（toMs 早于 fromMs）或者不是有限数字时按 0 处理。 */
export function awaySecondsSince(fromMs: number, toMs: number): number {
  const ms = toMs - fromMs;
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
}

function requirePositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
}

function requireSpeed(speed: number): Speed {
  if (!(SPEEDS as readonly number[]).includes(speed)) throw new RangeError(`speed must be one of ${SPEEDS.join(', ')}, got ${String(speed)}`);
  return speed as Speed;
}

export function createLoop(options: LoopOptions = {}): Loop {
  const maxSteps = options.maxStepsPerFrame ?? MAX_STEPS_PER_FRAME;
  const catchUpPerFrame = options.catchUpStepsPerFrame ?? CATCH_UP_STEPS_PER_FRAME;
  const awayAfterMs = options.awayAfterMs ?? AWAY_AFTER_MS;
  requirePositiveInt('maxStepsPerFrame', maxSteps);
  requirePositiveInt('catchUpStepsPerFrame', catchUpPerFrame);
  if (!(awayAfterMs > 0)) throw new RangeError(`awayAfterMs must be positive, got ${String(awayAfterMs)}`);

  let speed: Speed = requireSpeed(options.speed ?? 1);
  let paused = options.paused ?? false;
  let acc = 0; // 累加器：当前步之后已经过去的游戏毫秒数，不满一步
  let lastNow: number | null = null; // 上一帧的时间戳
  let hiddenAt: number | null = null; // 变为不可见的系统时间
  let debt = 0; // 恢复可见后欠下、还没有补的步数

  const alpha = (): number => acc / STEP_MS;

  function setPaused(next: boolean): void {
    // 取消暂停之后的第一帧没有「上一帧」：调用方暂停期间可能不再调用 frame，不能把停下的这段时间算进去
    if (paused && !next) lastNow = null;
    paused = next;
  }

  const loop: Loop = {
    frame(nowMs: number): FrameResult {
      let dt = 0;
      if (Number.isFinite(nowMs)) {
        if (lastNow !== null) dt = Math.max(0, nowMs - lastNow);
        lastNow = nowMs;
      }
      // 暂停和不可见时只更新帧时间，不推进。恢复之后第一帧的间隔是几毫秒，不会把暂停的时间一次补上
      if (paused || hiddenAt !== null) return { steps: 0, catchUpSteps: 0, alpha: alpha(), owedSteps: debt };
      acc += dt * speed;
      const due = Math.floor(acc / STEP_MS);
      acc = Math.max(0, acc - due * STEP_MS);
      const normal = Math.min(due, maxSteps);
      const catchUp = Math.min(debt, catchUpPerFrame);
      debt -= catchUp;
      return { steps: normal + catchUp, catchUpSteps: catchUp, alpha: alpha(), owedSteps: debt };
    },

    hide(wallMs: number): void {
      if (hiddenAt === null && Number.isFinite(wallMs)) hiddenAt = wallMs;
    },

    show(wallMs: number): ResumeOutcome {
      const from = hiddenAt;
      hiddenAt = null;
      lastNow = null; // 不可见期间的帧间隔不能算进下一帧，缺的时间由下面单独补
      if (from === null) return { kind: 'resumed', hiddenMs: 0, catchUpSteps: 0 };
      const hiddenMs = Number.isFinite(wallMs) ? wallMs - from : 0;
      // 系统时间被调回过去：离开的秒数按 0 处理，什么也不补
      if (!(hiddenMs > 0)) return { kind: 'resumed', hiddenMs: 0, catchUpSteps: 0 };
      // 按程序关闭处理：游戏内时间不前进，不补算。此前没补完的也不再补
      if (hiddenMs >= awayAfterMs) {
        debt = 0;
        return { kind: 'away', hiddenMs, awaySeconds: hiddenMs / 1000 };
      }
      // 暂停时没有欠的时间。没暂停时，缺的步数照常按当前倍速算
      if (paused) return { kind: 'resumed', hiddenMs, catchUpSteps: 0 };
      const total = acc + hiddenMs * speed;
      const owed = Math.floor(total / STEP_MS);
      acc = Math.max(0, total - owed * STEP_MS);
      debt += owed;
      return { kind: 'resumed', hiddenMs, catchUpSteps: owed };
    },

    lastActiveWallMs: (wallMs: number): number => hiddenAt ?? wallMs,
    speed: () => speed,
    setSpeed(next: Speed): void {
      speed = requireSpeed(next);
    },
    paused: () => paused,
    setPaused,
    togglePause(): void {
      setPaused(!paused);
    },
    hidden: () => hiddenAt !== null,
    owedSteps: () => debt,
    alpha,

    reset(): void {
      acc = 0;
      lastNow = null;
      hiddenAt = null;
      debt = 0;
    },
  };
  return loop;
}

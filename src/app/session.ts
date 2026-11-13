// 一局游戏的运行会话：把运行循环、自动保存的判断和存档模块接在一起。
// 会话不持有状态，也不调用核心的 step：推进由调用方通过 host.advance 完成，
// 这样调用方可以在每一步前后做自己的事（记下飞机位置供插值、处理命令、生成小结）。
// 两种时间都由调用方传入：帧时间 nowMs（单调）和墙上时间 wallMs，见 loop.ts。
import type { SimState } from '../core/index.ts';
import { saveGame } from '../save/index.ts';
import type { KeyValueStore, SaveOutcome, SlotOptions } from '../save/index.ts';
import { AUTOSAVE_INTERVAL_STEPS, CHANGE_SAVE_DELAY_MS, autosaveReason } from './autosave.ts';
import type { AutosaveReason } from './autosave.ts';
import { createLoop } from './loop.ts';
import type { FrameResult, Loop, LoopOptions, ResumeOutcome } from './loop.ts';

export interface SaveReport {
  reason: AutosaveReason;
  /** 保存时状态所在的步。 */
  step: number;
  outcome: SaveOutcome;
}

/** 调用方提供的几个入口。 */
export interface SessionHost {
  /** 当前的游戏状态。保存时读它。 */
  state(): SimState;
  /** 推进 steps 步。调用方在这里执行核心的 step，以及自己要做的事。 */
  advance(steps: number): void;
  /** 窗口不可见超过时限，按程序关闭处理：不补算，只报告离开的秒数，由上层做离开结算。 */
  away?(seconds: number): void;
  /** 每次保存有了结果就通知一次，界面据此提示。 */
  saved?(report: SaveReport): void;
}

export interface SessionOptions {
  store: KeyValueStore;
  host: SessionHost;
  loop?: LoopOptions;
  /** 每隔多少步自动保存一次，默认 AUTOSAVE_INTERVAL_STEPS。 */
  intervalSteps?: number;
  /** 玩家做了改变状态的操作之后，过多久（墙上时间，毫秒）保存，默认 CHANGE_SAVE_DELAY_MS。 */
  changeDelayMs?: number;
  /** 读档开局时填读到的状态所在的步，表示这一步已经存过。新开局不填，第一次触发就会存。 */
  savedStep?: number | null;
  /** 存档的键前缀等，原样传给存档模块。 */
  save?: SlotOptions;
}

export interface Session {
  readonly loop: Loop;
  /** 渲染帧调用：按循环算出步数，交给 host.advance，再判断要不要自动保存。 */
  frame(nowMs: number, wallMs: number): FrameResult;
  /** 窗口变为不可见：记下时刻，并保存。 */
  hide(wallMs: number): void;
  /** 窗口恢复可见。超过时限时调用 host.away，其余情况欠下的步数在之后的帧里补。 */
  show(wallMs: number): ResumeOutcome;
  /** 页面正在关闭：保存。 */
  close(wallMs: number): void;
  /** 玩家做了改变状态但没有走步数的操作（买东西、换策略卡）之后调用。过一小会儿会保存，不可见或关闭时也会保存。 */
  noteChange(): void;
  /** 换了一份状态（读档、导入）之后调用：清掉循环的累加器，把当前步当作已经存过。 */
  restart(savedStep?: number | null): void;
  /** 等所有已经发出的保存结束。 */
  flush(): Promise<void>;
}

function unexpectedFailure(error: unknown): SaveOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: 'store', message, quarantined: [], warnings: [] };
}

export function createSession(options: SessionOptions): Session {
  const { store, host } = options;
  const loop = createLoop(options.loop);
  const intervalSteps = options.intervalSteps ?? AUTOSAVE_INTERVAL_STEPS;
  const changeDelayMs = options.changeDelayMs ?? CHANGE_SAVE_DELAY_MS;
  let prevStep = host.state().step;
  // 保存的记账：lastAttemptStep 是最近一次发出保存时状态所在的步（不论成败），unsaved 表示从没存过，
  // dirty 表示状态变过但没有走步数，或者最近一次保存没有成功。
  // 保存一发出就记账，不等它完成：窗口变为不可见之后紧接着页面关闭，两个事件之间保存可能还没写完，
  // 不这样记的话会把同样的内容连存两次，挤掉一代备份。保存失败了再把 dirty 立起来，下一次触发时重试
  let unsaved = options.savedStep === undefined || options.savedStep === null;
  let lastAttemptStep = options.savedStep ?? prevStep;
  let dirty = false;
  // 玩家操作（和离开结算）带来的、还没存的改变：changeFresh 是刚发生、还没有记下墙上时间，
  // changeAt 是记下的最早那一个的墙上时间。保存一发出就清掉。保存失败不重新记，失败之后由别的时机重试，免得存储坏了时每几秒试一次
  let changeFresh = false;
  let changeAt: number | null = null;
  const pending = new Set<Promise<void>>();

  function markChanged(): void {
    dirty = true;
    changeFresh = true;
  }

  function startSave(reason: AutosaveReason, step: number, wallMs: number): void {
    lastAttemptStep = step;
    unsaved = false;
    dirty = false;
    changeFresh = false;
    changeAt = null;
    // 状态在 saveGame 被调用的这一刻就序列化好，之后的步数不影响这一份。
    // 自动保存出任何意外都不能让渲染帧出错，所以都按保存失败处理
    let call: Promise<SaveOutcome>;
    try {
      call = saveGame(store, host.state(), loop.lastActiveWallMs(wallMs), options.save);
    } catch (error) {
      call = Promise.resolve(unexpectedFailure(error));
    }
    const task: Promise<void> = call
      .catch((error: unknown) => unexpectedFailure(error))
      .then((outcome) => {
        if (!outcome.ok) dirty = true; // 没存成：状态仍然算变过，下一次触发时再试
        host.saved?.({ reason, step, outcome });
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  }

  function check(wallMs: number, events: { hidden?: boolean; closing?: boolean }): void {
    const step = host.state().step;
    const changed = unsaved || step !== lastAttemptStep || dirty;
    if (changeFresh) {
      changeFresh = false;
      if (changeAt === null) changeAt = wallMs;
    }
    // 系统时间被调回过去：从现在重新算，不让这次保存一直等下去
    if (changeAt !== null && wallMs < changeAt) changeAt = wallMs;
    const sinceChangeMs = changeAt === null ? null : wallMs - changeAt;
    const reason = autosaveReason({ prevStep, step, lastAttemptStep, changed, intervalSteps, sinceChangeMs, changeDelayMs, ...events });
    prevStep = step;
    if (reason !== null) startSave(reason, step, wallMs);
  }

  return {
    loop,

    frame(nowMs: number, wallMs: number): FrameResult {
      const result = loop.frame(nowMs);
      if (result.steps > 0) host.advance(result.steps);
      check(wallMs, {});
      return result;
    },

    hide(wallMs: number): void {
      loop.hide(wallMs);
      check(wallMs, { hidden: true });
    },

    show(wallMs: number): ResumeOutcome {
      const outcome = loop.show(wallMs);
      if (outcome.kind === 'away') {
        host.away?.(outcome.awaySeconds);
        markChanged(); // 离开结算会改状态，过一小会儿就存，不等到下一个间隔
      }
      return outcome;
    },

    close(wallMs: number): void {
      check(wallMs, { closing: true });
    },

    noteChange(): void {
      markChanged();
    },

    restart(next?: number | null): void {
      loop.reset();
      prevStep = host.state().step;
      unsaved = next === null;
      lastAttemptStep = next ?? prevStep;
      dirty = false;
      changeFresh = false;
      changeAt = null;
    },

    async flush(): Promise<void> {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

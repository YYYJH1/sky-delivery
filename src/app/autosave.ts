// 自动保存的时机。这里只判断「要不要存、为什么存」，是纯函数，不读时钟也不碰存储。
// 保存本身由 session.ts 调用存档模块去做。
//
// 触发的时机，按优先级从高到低：
//   closing  页面正在关闭
//   hidden   窗口变为不可见
//   day      越过了一天的结束（日结）
//   summary  越过了某一场高峰的小结时刻
//   change   玩家做了改变状态的操作（买东西、换策略卡）之后过了一小会儿，默认 1 秒
//   interval 距上一次保存已经过了一段游戏内时间，默认 30 秒
// 状态自上次保存之后没有变过时不存。否则窗口变为不可见、紧接着页面关闭会连存两次相同的内容，
// 每多存一次，滚动备份里就有一代旧存档被挤掉。
// 加 change 是因为网页版的存档放在 IndexedDB 里：页面正在关闭（pagehide）时发出的写入一律写不进去，
// 在无头 Chrome 156 里实测，同步发出的 put 也一样会丢。关闭时的保存因此指望不上，
// 玩家暂停之后买了东西就关掉页面，这个操作没有走步数，间隔和日结都等不到，只能靠操作之后的这一次保存留下来。
import { DAY_STEPS, summaryStep } from '../core/index.ts';
import type { PeakName } from '../core/index.ts';

/** 每隔多少步自动保存一次：300 步，游戏内 30 秒。 */
export const AUTOSAVE_INTERVAL_STEPS = 300;

/** 玩家的操作改变了状态，过了这么久（墙上时间，毫秒）还没存，就存一次。一连串操作合并成一次保存。 */
export const CHANGE_SAVE_DELAY_MS = 1000;

export type AutosaveReason = 'closing' | 'hidden' | 'day' | 'summary' | 'change' | 'interval';

const PEAKS: readonly PeakName[] = ['noon', 'evening'];

export interface Milestones {
  /** 越过了一天的结束：日结在这一步生成。 */
  day: boolean;
  /** 越过了某一场高峰的小结时刻：小结在这一步生成。 */
  summary: boolean;
}

/**
 * 状态从第 prevStep 步走到第 step 步的过程中，有没有越过日结和高峰小结的时刻。
 * 一帧可能走好几步，所以看的是区间 (prevStep, step]，不是只看当前这一步。
 */
export function milestonesBetween(prevStep: number, step: number): Milestones {
  if (!(step > prevStep)) return { day: false, summary: false };
  const firstDay = Math.floor(prevStep / DAY_STEPS);
  const lastDay = Math.floor(step / DAY_STEPS);
  const day = lastDay > firstDay;
  // 跨过一整天的区间里一定有小结时刻，不必逐天检查
  if (step - prevStep >= DAY_STEPS) return { day, summary: true };
  let summary = false;
  for (let d = firstDay; d <= lastDay && !summary; d++) {
    for (const peak of PEAKS) {
      const at = summaryStep(d, peak);
      if (prevStep < at && at <= step) summary = true;
    }
  }
  return { day, summary };
}

export interface AutosaveInput {
  /** 上一次检查时状态所在的步。 */
  prevStep: number;
  /** 现在状态所在的步。 */
  step: number;
  /** 上一次保存（不论成败）时状态所在的步。 */
  lastAttemptStep: number;
  /** 状态自上次成功保存之后有没有变过：走过步数，或玩家做过改变状态的操作。 */
  changed: boolean;
  /** 窗口刚变为不可见。 */
  hidden?: boolean;
  /** 页面正在关闭。 */
  closing?: boolean;
  /** 每隔多少步保存一次，默认 AUTOSAVE_INTERVAL_STEPS。 */
  intervalSteps?: number;
  /** 最早的那个还没存的玩家操作，距现在过去了多少毫秒。没有这样的操作时为 null 或不给。 */
  sinceChangeMs?: number | null;
  /** 操作之后等多久再存，默认 CHANGE_SAVE_DELAY_MS。 */
  changeDelayMs?: number;
}

/** 要不要存。要存返回原因（只返回优先级最高的一个），不用存返回 null。 */
export function autosaveReason(input: AutosaveInput): AutosaveReason | null {
  if (!input.changed) return null;
  if (input.closing === true) return 'closing';
  if (input.hidden === true) return 'hidden';
  const milestones = milestonesBetween(input.prevStep, input.step);
  if (milestones.day) return 'day';
  if (milestones.summary) return 'summary';
  const since = input.sinceChangeMs;
  if (since !== undefined && since !== null && since >= (input.changeDelayMs ?? CHANGE_SAVE_DELAY_MS)) return 'change';
  const interval = input.intervalSteps ?? AUTOSAVE_INTERVAL_STEPS;
  if (input.step - input.lastAttemptStep >= interval) return 'interval';
  return null;
}

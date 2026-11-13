// 自动保存的时机：纯函数，只判断要不要存、为什么存。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, createRng, nextInt, summaryStep } from '../src/core/index.ts';
import type { PeakName } from '../src/core/index.ts';
import { AUTOSAVE_INTERVAL_STEPS, CHANGE_SAVE_DELAY_MS, autosaveReason, milestonesBetween } from '../src/app/index.ts';
import type { AutosaveInput } from '../src/app/index.ts';

const PEAKS: PeakName[] = ['noon', 'evening'];

/** 第 step 步生成日结或小结吗？逐步判断，不用区间，作为 milestonesBetween 的参照。 */
function milestoneAt(step: number): { day: boolean; summary: boolean } {
  const day = step > 0 && step % DAY_STEPS === 0;
  let summary = false;
  for (let d = 0; d * DAY_STEPS <= step; d++) for (const peak of PEAKS) if (summaryStep(d, peak) === step) summary = true;
  return { day, summary };
}

describe('日结和高峰小结的时刻', () => {
  it('小结在高峰结束 30 秒之后，日结在一天结束：午高峰小结第 1800 步，晚高峰小结第 3400 步，日结第 3600 步', () => {
    expect(summaryStep(0, 'noon')).toBe(1800);
    expect(summaryStep(0, 'evening')).toBe(3400);
    expect(DAY_STEPS).toBe(3600);
  });

  it('恰好在越过的那一步：前一步到这一步是 true，前后两步都不是', () => {
    for (let d = 0; d < 5; d++) {
      for (const peak of PEAKS) {
        const s = summaryStep(d, peak);
        expect(milestonesBetween(s - 1, s), `第 ${d} 天 ${peak}`).toEqual({ day: false, summary: true });
        expect(milestonesBetween(s - 2, s - 1).summary).toBe(false);
        expect(milestonesBetween(s, s + 1).summary).toBe(false);
        expect(milestonesBetween(s - 50, s + 50).summary).toBe(true);
      }
      const end = (d + 1) * DAY_STEPS;
      expect(milestonesBetween(end - 1, end)).toEqual({ day: true, summary: false });
      expect(milestonesBetween(end, end + 1).day).toBe(false);
    }
  });

  it('一帧走好几步时看的是区间：区间里有就算，区间的起点本身不算', () => {
    expect(milestonesBetween(3399, 3600)).toEqual({ day: true, summary: true });
    expect(milestonesBetween(3400, 3600)).toEqual({ day: true, summary: false });
    expect(milestonesBetween(1799, 1801)).toEqual({ day: false, summary: true });
    expect(milestonesBetween(1800, 1801)).toEqual({ day: false, summary: false });
  });

  it('跨过一整天或更长：一定有小结，也一定有日结', () => {
    expect(milestonesBetween(0, DAY_STEPS)).toEqual({ day: true, summary: true });
    expect(milestonesBetween(123, 123 + DAY_STEPS)).toEqual({ day: true, summary: true });
    expect(milestonesBetween(0, 100_000)).toEqual({ day: true, summary: true });
  });

  it('没有前进或往回走：没有越过任何时刻', () => {
    expect(milestonesBetween(1799, 1799)).toEqual({ day: false, summary: false });
    expect(milestonesBetween(3600, 0)).toEqual({ day: false, summary: false });
  });

  it('与逐步判断一致：前三天每一步，以及五百个随机的区间', () => {
    for (let s = 1; s <= 3 * DAY_STEPS + 10; s++) expect(milestonesBetween(s - 1, s), `第 ${s} 步`).toEqual(milestoneAt(s));
    const rng = createRng(31);
    for (let i = 0; i < 500; i++) {
      const prev = nextInt(rng, 3 * DAY_STEPS);
      const step = prev + nextInt(rng, 2500);
      let day = false;
      let summary = false;
      for (let s = prev + 1; s <= step; s++) {
        const m = milestoneAt(s);
        day ||= m.day;
        summary ||= m.summary;
      }
      expect(milestonesBetween(prev, step), `${prev} 到 ${step}`).toEqual({ day, summary });
    }
  });
});

describe('要不要保存', () => {
  const BASE: AutosaveInput = { prevStep: 100, step: 101, lastAttemptStep: 100, changed: true };

  it('每隔一段游戏内时间保存：默认 300 步，也就是 30 秒', () => {
    expect(AUTOSAVE_INTERVAL_STEPS).toBe(300);
    expect(autosaveReason({ ...BASE, lastAttemptStep: 0, prevStep: 298, step: 299 })).toBeNull();
    expect(autosaveReason({ ...BASE, lastAttemptStep: 0, prevStep: 299, step: 300 })).toBe('interval');
    expect(autosaveReason({ ...BASE, lastAttemptStep: 0, prevStep: 400, step: 401 })).toBe('interval');
    expect(autosaveReason({ ...BASE, lastAttemptStep: 50, prevStep: 348, step: 349 })).toBeNull();
    expect(autosaveReason({ ...BASE, lastAttemptStep: 50, prevStep: 349, step: 350 })).toBe('interval');
  });

  it('间隔可以调整', () => {
    expect(autosaveReason({ ...BASE, intervalSteps: 20, lastAttemptStep: 0, prevStep: 19, step: 20 })).toBe('interval');
    expect(autosaveReason({ ...BASE, intervalSteps: 20, lastAttemptStep: 0, prevStep: 18, step: 19 })).toBeNull();
  });

  it('每场高峰小结生成之后保存，每天日结之后保存', () => {
    expect(autosaveReason({ ...BASE, lastAttemptStep: 1790, prevStep: 1799, step: 1800 })).toBe('summary');
    expect(autosaveReason({ ...BASE, lastAttemptStep: 3390, prevStep: 3399, step: 3400 })).toBe('summary');
    expect(autosaveReason({ ...BASE, lastAttemptStep: 3590, prevStep: 3599, step: 3600 })).toBe('day');
  });

  it('窗口变为不可见时保存，页面关闭时保存，不论距上次保存多久', () => {
    expect(autosaveReason({ ...BASE, hidden: true })).toBe('hidden');
    expect(autosaveReason({ ...BASE, closing: true })).toBe('closing');
  });

  it('同时满足几个条件时只给出优先级最高的：closing，hidden，day，summary，interval', () => {
    const due: AutosaveInput = { ...BASE, lastAttemptStep: 0, prevStep: 3399, step: 3600 }; // 日结、小结、间隔都到了
    expect(autosaveReason(due)).toBe('day');
    expect(autosaveReason({ ...due, hidden: true })).toBe('hidden');
    expect(autosaveReason({ ...due, hidden: true, closing: true })).toBe('closing');
    expect(autosaveReason({ ...due, prevStep: 3500, step: 3501 })).toBe('interval');
    const summaryAndInterval: AutosaveInput = { ...BASE, lastAttemptStep: 1000, prevStep: 1799, step: 1800 };
    expect(autosaveReason(summaryAndInterval)).toBe('summary');
  });

  it('状态自上次保存之后没有变过就不存：窗口变不可见紧接着页面关闭，不会连存两次，也就不会挤掉一代备份', () => {
    const still: AutosaveInput = { ...BASE, changed: false };
    expect(autosaveReason({ ...still, hidden: true })).toBeNull();
    expect(autosaveReason({ ...still, closing: true })).toBeNull();
    expect(autosaveReason({ ...still, lastAttemptStep: 0, prevStep: 1799, step: 1800 })).toBeNull();
  });

  it('游戏暂停时一步也不走：时间间隔不会到', () => {
    expect(autosaveReason({ prevStep: 500, step: 500, lastAttemptStep: 500, changed: true })).toBeNull();
    // 玩家在暂停时买了东西：状态变过，窗口一变不可见就保存
    expect(autosaveReason({ prevStep: 500, step: 500, lastAttemptStep: 500, changed: true, hidden: true })).toBe('hidden');
  });
});

describe('玩家操作之后保存（change）', () => {
  // 暂停时一步也不走，没有间隔和日结可等，所以操作之后要有自己的保存时机
  const PAUSED: AutosaveInput = { prevStep: 500, step: 500, lastAttemptStep: 500, changed: true };

  it('操作之后过 1 秒（墙上时间）保存：不到不存，到了存，原因是 change', () => {
    expect(CHANGE_SAVE_DELAY_MS).toBe(1000);
    expect(autosaveReason({ ...PAUSED, sinceChangeMs: 0 })).toBeNull();
    expect(autosaveReason({ ...PAUSED, sinceChangeMs: CHANGE_SAVE_DELAY_MS - 1 })).toBeNull();
    expect(autosaveReason({ ...PAUSED, sinceChangeMs: CHANGE_SAVE_DELAY_MS })).toBe('change');
    expect(autosaveReason({ ...PAUSED, sinceChangeMs: 60_000 })).toBe('change');
  });

  it('没有未存的操作（null 或不给）：和以前完全一样', () => {
    expect(autosaveReason({ ...PAUSED, sinceChangeMs: null })).toBeNull();
    expect(autosaveReason({ ...PAUSED })).toBeNull();
    expect(autosaveReason({ ...PAUSED, lastAttemptStep: 0, step: 300, sinceChangeMs: null })).toBe('interval');
  });

  it('等多久可以调整', () => {
    expect(autosaveReason({ ...PAUSED, sinceChangeMs: 500, changeDelayMs: 500 })).toBe('change');
    expect(autosaveReason({ ...PAUSED, sinceChangeMs: 499, changeDelayMs: 500 })).toBeNull();
  });

  it('优先级：低于 closing、hidden、day、summary，高于 interval', () => {
    const due: AutosaveInput = { ...PAUSED, sinceChangeMs: 5000 };
    expect(autosaveReason({ ...due, closing: true })).toBe('closing');
    expect(autosaveReason({ ...due, hidden: true })).toBe('hidden');
    expect(autosaveReason({ ...due, prevStep: 3599, step: 3600, lastAttemptStep: 3590 })).toBe('day');
    expect(autosaveReason({ ...due, prevStep: 1799, step: 1800, lastAttemptStep: 1790 })).toBe('summary');
    // 间隔也到了，说成是 change：是玩家的操作促成了这次保存
    expect(autosaveReason({ ...due, prevStep: 800, step: 801, lastAttemptStep: 0 })).toBe('change');
  });

  it('状态自上次保存之后没有变过就不存，操作的记录再久也一样', () => {
    expect(autosaveReason({ ...PAUSED, changed: false, sinceChangeMs: 99_999 })).toBeNull();
  });
});

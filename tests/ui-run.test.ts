// 真实运行里算界面数据：几个游戏日里每隔几步算一次，换着看不同的片区和页签，
// 全部文字都是整句（没有没填的参数），数都是有限数，算完状态不变。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, advance, applyCommand, hashState, unlock } from '../src/core/index.ts';
import { computeUiData } from '../src/ui/view-model.ts';
import type { UiView } from '../src/ui/view-model.ts';
import { campaignOf, runningState, unlockAll } from './campaign-helpers.ts';

/** 界面数据里的每个字符串和数。字符串里不能有没填的参数，数都是有限数。 */
function scan(value: unknown, path: string, problems: string[]): void {
  if (typeof value === 'string') {
    if (/undefined|NaN|\bnull\b|\{|\}|\[object/.test(value)) problems.push(`${path}: ${value}`);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) problems.push(`${path}: ${String(value)}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${String(i)}]`, problems));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // 命令对象里有给核心的英文代码，不是给玩家看的
      if (k === 'command') continue;
      scan(v, `${path}.${k}`, problems);
    }
  }
}

describe('真实运行：三个游戏日里算界面数据', () => {
  it('每隔几步算一次，所有文字都是整句，数都是有限数，算完状态不变', () => {
    // 写字楼区开通，老街三星，开放项全部打开：白板的三栏、两个页签、几个片区都有东西可看
    const state = unlockAll(runningState(42, [3, 3, 1], [true, true, false]));
    campaignOf(state).money = 5000;
    advance(state, 1); // 开通写字楼区之后，规矩分成午晚两套
    expect(campaignOf(state).ruleSets).not.toBeNull();
    const problems: string[] = [];
    let shownSummary = 0;
    let shownDayEnd = 0;
    let boards = 0;
    for (let i = 0; i < (3 * DAY_STEPS) / 25; i++) {
      advance(state, 25);
      const hash = hashState(state);
      const view: UiView = { noteDistrict: i % 3, boardPeak: i % 3 === 0 ? null : i % 3 === 1 ? 'noon' : 'evening', dayEndOpen: i % 2 === 0 };
      const data = computeUiData(state, view);
      expect(data).not.toBeNull();
      if (data === null) return;
      scan(data, 'ui', problems);
      if (data.summary !== null) shownSummary += 1;
      if (data.dayEnd !== null) shownDayEnd += 1;
      if (data.board !== null) boards += 1;
      expect(hashState(state)).toBe(hash);
    }
    expect(problems).toEqual([]);
    expect(shownSummary).toBeGreaterThan(10);
    expect(shownDayEnd).toBeGreaterThan(10);
    expect(boards).toBe(3 * DAY_STEPS / 25);
  });

  it('玩家换卡、读便签、开通片区之后继续算：界面数据跟着变，也没有问题', () => {
    const state = runningState(7);
    campaignOf(state).districts[0]!.star = 3;
    unlock(state, 'priceTags');
    unlock(state, 'selectColumn');
    unlock(state, 'showOffice');
    campaignOf(state).money = 1000;
    advance(state, 1900);
    expect(computeUiData(state)?.openTags.map((t) => t.district)).toEqual([1]);
    expect(applyCommand(state, { type: 'openDistrict', district: 1 }).ok).toBe(true);
    advance(state, 1);
    expect(applyCommand(state, { type: 'setRules', rules: { select: 'deadline' }, peak: 'evening' }).ok).toBe(true);
    const data = computeUiData(state, { noteDistrict: 1, boardPeak: 'evening', dayEndOpen: false });
    expect(data?.openTags).toEqual([]);
    expect(data?.note.name).toBe('写字楼区');
    expect(data?.board?.tabs?.map((t) => t.on)).toEqual([false, true]);
    expect(data?.board?.columns[0]?.cards.find((c) => c.key === 'deadline')?.selected).toBe(true);
    const problems: string[] = [];
    scan(data, 'ui', problems);
    expect(problems).toEqual([]);
  });

  it('同一个状态、同样的选择，算两次结果完全相同', () => {
    const state = unlockAll(runningState(42, [3, 3, 1], [true, true, false]));
    advance(state, DAY_STEPS + 2000);
    const view: UiView = { noteDistrict: 1, boardPeak: 'evening', dayEndOpen: true };
    expect(JSON.stringify(computeUiData(state, view))).toBe(JSON.stringify(computeUiData(state, view)));
  });
});

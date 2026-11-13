// 便签的队列和文字，结局的文字，界面怎么发现新出现的小结、日结和结局。
import { describe, expect, it } from 'vitest';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { DAY_STEPS, TIP_IDS, advance, applyCommand, pushTip } from '../src/core/index.ts';
import type { TipId } from '../src/core/index.ts';
import { freshSince, seenOf } from '../src/ui/notices.ts';
import { currentTip, endingLines, endingText, tipText } from '../src/ui/tips.ts';
import { campaignOf, campaignState, runningState } from './campaign-helpers.ts';

describe('便签的文字', () => {
  it('七条的文字都取自词表', () => {
    const expected: [TipId, string][] = [
      ['firstOrder', STR.tips.firstOrder],
      ['autoDispatchOn', STR.tips.autoDispatchOn],
      ['firstRedOrder', STR.tips.firstRedOrder],
      ['boardReady', STR.tips.boardReady],
      ['canAddBay', STR.tips.canAddBay],
      ['openOffice', STR.tips.openOffice],
    ];
    for (const [id, text] of expected) expect(tipText({ id, step: 0, station: null, read: false })).toBe(text);
  });

  it('起降拥堵带站号：核心给的是编号，写成「{n}号站」的汉字', () => {
    expect(tipText({ id: 'gateBusy', step: 0, station: 0, read: false })).toBe(fmt(STR.tips.gateBusy, { station: '一' }));
    expect(tipText({ id: 'gateBusy', step: 0, station: 2, read: false })).toBe(fmt(STR.tips.gateBusy, { station: '三' }));
  });

  it('核心的七个便签编号都有文字，没有没填的参数', () => {
    expect(TIP_IDS).toHaveLength(7);
    for (const id of TIP_IDS) {
      const text = tipText({ id, step: 0, station: 1, read: false });
      expect(text.length).toBeGreaterThan(4);
      expect(text).not.toMatch(/undefined|NaN|\{|\}/);
    }
  });
});

describe('便签的队列', () => {
  it('没有便签：没有', () => {
    expect(currentTip(campaignState())).toBeNull();
  });

  it('同一时刻只贴最早的一张，其余排队，排在后面的张数写在 queued', () => {
    const state = campaignState();
    pushTip(state, 'firstOrder');
    pushTip(state, 'autoDispatchOn');
    pushTip(state, 'boardReady');
    expect(currentTip(state)).toEqual({ id: 'firstOrder', text: STR.tips.firstOrder, queued: 2 });
  });

  it('点一张发 readTip：它标成已读，下一张才出来；全读完就没有了', () => {
    const state = campaignState();
    pushTip(state, 'firstOrder');
    pushTip(state, 'autoDispatchOn');
    expect(applyCommand(state, { type: 'readTip', tip: 'firstOrder' }).ok).toBe(true);
    expect(currentTip(state)).toMatchObject({ id: 'autoDispatchOn', queued: 0 });
    expect(applyCommand(state, { type: 'readTip', tip: 'autoDispatchOn' }).ok).toBe(true);
    expect(currentTip(state)).toBeNull();
  });

  it('已读的便签留在核心的队列里，界面不再贴它', () => {
    const state = campaignState();
    pushTip(state, 'firstOrder');
    applyCommand(state, { type: 'readTip', tip: 'firstOrder' });
    expect(campaignOf(state).tips).toHaveLength(1);
    expect(campaignOf(state).tips[0]!.read).toBe(true);
    expect(currentTip(state)).toBeNull();
  });

  it('每条便签最多出现一次：重复放不会再贴', () => {
    const state = campaignState();
    expect(pushTip(state, 'firstOrder')).toBe(true);
    expect(pushTip(state, 'firstOrder')).toBe(false);
    applyCommand(state, { type: 'readTip', tip: 'firstOrder' });
    expect(pushTip(state, 'firstOrder')).toBe(false);
    expect(currentTip(state)).toBeNull();
  });

  it('次序按出现的先后，不按编号', () => {
    const state = campaignState();
    pushTip(state, 'openOffice');
    pushTip(state, 'firstOrder');
    expect(currentTip(state)?.id).toBe('openOffice');
  });

  it('真实运行：开局第一张订单出现，就有第一张便签', () => {
    const state = campaignState({ seed: 42 });
    advance(state, 60);
    expect(currentTip(state)?.id).toBe('firstOrder');
  });

  it('只读：贴哪一张不改状态', () => {
    const state = campaignState();
    pushTip(state, 'firstOrder');
    const json = JSON.stringify(state);
    currentTip(state);
    expect(JSON.stringify(state)).toBe(json);
  });
});

describe('结局', () => {
  it('没到结局：没有文字', () => {
    expect(endingText(campaignState())).toBeNull();
  });

  it('到了结局：三个片区均已达到四星，共送达几单，用时几天', () => {
    const state = campaignState();
    campaignOf(state).ending = { step: 12 * DAY_STEPS, days: 12, orders: 345 };
    expect(endingText(state)).toBe(fmt(STR.system.ending, { orders: 345, days: 12 }));
  });
});

describe('结局分行', () => {
  it('每个句号收一行，不在一句话的中间折开', () => {
    expect(endingLines('三个片区均已达到四星。共送达 345 单，用时 12 天。')).toEqual(['三个片区均已达到四星。', '共送达 345 单，用时 12 天。']);
  });

  it('没有句号的文字是一行，空字符串没有行', () => {
    expect(endingLines('没有句号')).toEqual(['没有句号']);
    expect(endingLines('')).toEqual([]);
  });

  it('词表里的结局文字正好分成两行', () => {
    const state = campaignState();
    campaignOf(state).ending = { step: DAY_STEPS, days: 3, orders: 99 };
    expect(endingLines(endingText(state)!)).toHaveLength(2);
  });
});

describe('发现新出现的小结、日结和结局', () => {
  it('读档或开局时已有的当作见过：没有新的', () => {
    const state = runningState(42);
    advance(state, DAY_STEPS + 2000);
    const seen = seenOf(state);
    expect(seen.days).toBe(1);
    expect(seen.peaks).toBeGreaterThanOrEqual(2);
    expect(freshSince(seen, state)).toEqual({ peaks: 0, days: 0, ending: false });
  });

  it('推进之后多出来的就是新的：先是小结，再是日结', () => {
    const state = runningState(42);
    const seen = seenOf(state);
    advance(state, 1801);
    expect(freshSince(seen, state)).toEqual({ peaks: 1, days: 0, ending: false });
    advance(state, 1800);
    expect(freshSince(seen, state)).toEqual({ peaks: 2, days: 1, ending: false });
  });

  it('结局：只在出现的那一次是新的', () => {
    const state = campaignState();
    const before = seenOf(state);
    campaignOf(state).ending = { step: DAY_STEPS, days: 1, orders: 10 };
    expect(freshSince(before, state).ending).toBe(true);
    expect(freshSince(seenOf(state), state).ending).toBe(false);
  });

  it('记录不会变少：见过的比现在多时新的数是 0，不会是负数', () => {
    const state = campaignState();
    expect(freshSince({ peaks: 3, days: 2, ending: true }, state)).toEqual({ peaks: 0, days: 0, ending: false });
  });
});

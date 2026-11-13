// 高峰进行中的结果、片区纸条上的余量和还差几单、结局里累计的对照。
import { describe, expect, it } from 'vitest';
import { GOALS_V1 } from '../src/content/goals_v1.ts';
import { DAY_STEPS, districtNote } from '../src/core/index.ts';
import type { DistrictGoal, LiveRow, PeakRecord } from '../src/core/index.ts';
import { farthestRow, goalText, liveView } from '../src/ui/live.ts';
import { noteExtra, noteView } from '../src/ui/note.ts';
import { endingLines, endingText } from '../src/ui/tips.ts';
import { DEFAULT_VIEW, computeUiData } from '../src/ui/view-model.ts';
import { batchOrders, campaignOf, outcomeOrder, quietState } from './campaign-helpers.ts';

const goal = (patch: Partial<DistrictGoal> = {}): DistrictGoal => ({ district: 0, kind: 'line', line: 72, basis: 'next', ...patch });
const row = (patch: Partial<LiveRow> = {}): LiveRow => ({ district: 0, onTime: 5, late: 3, cancelled: 0, goal: goal(), ...patch });

describe('这一场的目标写成文字', () => {
  it('有目标线：本场目标 准时率 72%', () => {
    expect(goalText(goal())).toBe('本场目标 准时率 72%');
  });

  it('全部准时也到不了星级线：目标改用星级线本身，写明预计仅靠本场无法升星，或者无法保星', () => {
    expect(goalText(goal({ kind: 'capped', line: 85 }))).toBe('本场目标 准时率 85%，预计仅靠本场无法升星');
    expect(goalText(goal({ kind: 'capped', line: 85, basis: 'keep' }))).toBe('本场目标 准时率 85%，预计仅靠本场无法保星');
  });

  it('这一场一单也不准时，准时率也够了：不写目标线，写准时率已高于升星线或保星线，本场不设目标', () => {
    expect(goalText(goal({ kind: 'enough', line: null }))).toBe('准时率已高于升星线，本场不设目标');
    expect(goalText(goal({ kind: 'enough', line: null, basis: 'keep' }))).toBe('准时率已高于保星线，本场不设目标');
  });

  it('没有设线：没有文字', () => {
    expect(goalText(null)).toBeNull();
  });
});

describe('离目标线最远的一行', () => {
  it('取目标线减准时率最大的，并且已经低于目标线', () => {
    const rows = [
      row({ district: 0, onTime: 8, late: 2, goal: goal({ line: 70 }) }), // 准时率 80%，高于线
      row({ district: 1, onTime: 5, late: 5, goal: goal({ district: 1, line: 80 }) }), // 50%，差 30
      row({ district: 2, onTime: 6, late: 4, goal: goal({ district: 2, line: 85 }) }), // 60%，差 25
    ];
    expect(farthestRow(rows)).toBe(1);
  });

  it('准时率算的是已完成的订单：准时、超时、退单都在分母里', () => {
    // 4 张准时，2 张超时，2 张退单：50%，线 60，差 10。另一个片区 3 准时 3 超时：50%，线 55，差 5
    const rows = [row({ district: 0, onTime: 4, late: 2, cancelled: 2, goal: goal({ line: 60 }) }), row({ district: 1, onTime: 3, late: 3, goal: goal({ district: 1, line: 55 }) })];
    expect(farthestRow(rows)).toBe(0);
  });

  it('已经达到或高于目标线的行不突出：全都达到时没有突出的', () => {
    expect(farthestRow([row({ onTime: 8, late: 2, goal: goal({ line: 80 }) })])).toBeNull(); // 恰好 80%
    expect(farthestRow([row({ onTime: 9, late: 1, goal: goal({ line: 80 }) })])).toBeNull();
  });

  it('没有设线的、不设线的（已经够了）、已完成的订单不到下限的，都不参与', () => {
    expect(farthestRow([row({ goal: null }), row({ district: 1, goal: goal({ district: 1, kind: 'enough', line: null }) })])).toBeNull();
    const few = GOALS_V1.minLiveOrders - 1;
    expect(farthestRow([row({ onTime: 0, late: few, goal: goal({ line: 90 }) })])).toBeNull();
    expect(farthestRow([row({ onTime: 0, late: GOALS_V1.minLiveOrders, goal: goal({ line: 90 }) })])).toBe(0);
  });

  it('差一样大时取片区编号小的', () => {
    const rows = [row({ district: 2, onTime: 5, late: 5, goal: goal({ district: 2, line: 70 }) }), row({ district: 1, onTime: 5, late: 5, goal: goal({ district: 1, line: 70 }) })];
    expect(farthestRow(rows)).toBe(2); // 先遇到的取，行本来按片区编号排，这里只是顺序反了
    expect(farthestRow([...rows].reverse())).toBe(1);
  });
});

describe('高峰进行中的几行', () => {
  it('不在高峰里没有；在高峰里每个开通的片区一行：片区名，准时、超时、退单各几张，和这一场的目标', () => {
    const state = quietState();
    state.step = 500;
    expect(liveView(state)).toBeNull();
    state.step = 1200;
    campaignOf(state).goals = { day: 0, peak: 'noon', step: 600, goals: [{ district: 0, kind: 'line', line: 72, basis: 'next' }] };
    outcomeOrder(state, { district: 0, tOrder: 700, delivered: 900 });
    outcomeOrder(state, { district: 0, tOrder: 710, delivered: 1100 });
    outcomeOrder(state, { district: 0, tOrder: 720, cancelled: 1000 });
    const view = liveView(state);
    expect(view?.rows).toEqual([{ district: 0, name: '老街', counts: '老街　准时 1　超时 1　取消 1', goal: '本场目标 准时率 72%', farthest: true }]); // 3 张里准时 1 张，低于线
  });

  it('离目标线最远的一行带 farthest', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.districts[1]!.open = true;
    state.step = 1200;
    campaign.goals = {
      day: 0,
      peak: 'noon',
      step: 600,
      goals: [
        { district: 0, kind: 'line', line: 50, basis: 'next' },
        { district: 1, kind: 'line', line: 80, basis: 'next' },
      ],
    };
    for (let i = 0; i < 4; i++) outcomeOrder(state, { district: 0, tOrder: 700 + i, delivered: 700 + i + 200 });
    for (let i = 0; i < 2; i++) outcomeOrder(state, { district: 1, tOrder: 720 + i, delivered: 720 + i + 200 });
    for (let i = 0; i < 2; i++) outcomeOrder(state, { district: 1, tOrder: 730 + i, delivered: 730 + i + 400 });
    const view = liveView(state);
    expect(view?.rows.map((r) => [r.name, r.farthest])).toEqual([
      ['老街', false],
      ['写字楼区', true],
    ]);
  });

  it('没有设线的片区只有数，没有目标', () => {
    const state = quietState();
    state.step = 1200;
    expect(liveView(state)?.rows[0]).toMatchObject({ goal: null, farthest: false });
  });

  it('界面数据里有它：高峰里有，高峰之外为 null', () => {
    const state = quietState();
    state.step = 1200;
    expect(computeUiData(state, DEFAULT_VIEW)?.live?.rows).toHaveLength(1);
    state.step = 1850;
    expect(computeUiData(state, DEFAULT_VIEW)?.live).toBeNull();
  });
});

describe('片区纸条的补充', () => {
  /** 老街，第 1 天，星级 star，最近两天完成的订单。 */
  function note(star: number, onTime: number, late: number, misses = 0) {
    const state = quietState();
    campaignOf(state).districts[0]!.star = star;
    campaignOf(state).rating[0]!.misses = misses;
    state.step = DAY_STEPS + 2000;
    batchOrders(state, 0, 1, { onTime, late });
    return state;
  }

  it('一星、二星：没到下一星的准时率线时写还要连续准时几单', () => {
    // 二星，40 张里准时 28 张：(75 × 40 - 2800) / 25 = 8
    expect(noteView(note(2, 28, 12), 0).extra).toBe('准时率达到升星线还需连续 8 单准时');
    expect(noteView(note(1, 30, 10), 0).extra).toBeNull(); // 一星，二星的线 55，已经达到
  });

  it('三星以上：先写保星的余量，空一格再写还要连续准时几单。三星 40 张里准时 31 张，保星线 55，准时率 77%，高 22 个百分点，升四星的线 85 还要连续准时 20 张', () => {
    // (85 × 40 - 3100) / 15 = 20
    expect(noteView(note(3, 31, 9), 0).extra).toBe('保星线 55%，当前高 22 个百分点　准时率达到升星线还需连续 20 单准时');
  });

  it('正好在保星线上：写持平，不写高 0 个百分点', () => {
    // 三星 40 张里准时 22 张，55%，等于保星线。(85 × 40 - 2200) / 15 = 80
    expect(noteView(note(3, 22, 18), 0).extra).toBe('保星线 55%，当前持平　准时率达到升星线还需连续 80 单准时');
  });

  it('比保星线低：写低几个百分点', () => {
    // (85 × 40 - 2000) / 15 = 93.3，向上取整 94
    expect(noteView(note(3, 20, 20), 0).extra).toBe('保星线 55%，当前低 5 个百分点　准时率达到升星线还需连续 94 单准时');
  });

  it('已经五星：只写余量。已经达到下一星的线：不写还差几单，只写余量', () => {
    expect(noteView(note(5, 38, 2), 0).extra).toBe('保星线 85%，当前高 10 个百分点');
    expect(noteView(note(3, 36, 4), 0).extra).toBe('保星线 55%，当前高 35 个百分点');
  });

  it('还没有订单、订单不到下限、处在可能掉星的状态：不写，那几条自己已经写了准时率', () => {
    expect(noteView(quietState(), 0).extra).toBeNull();
    expect(noteView(note(3, 3, 3), 0).extra).toBeNull();
    const risk = note(3, 20, 20, 1);
    expect(districtNote(risk, 0).kind).toBe('dropByOnTime');
    expect(noteView(risk, 0).extra).toBeNull();
    expect(noteExtra({ ...districtNote(risk, 0), kind: 'noData' })).toBeNull();
  });
});

describe('结局里累计的对照', () => {
  function ended(gains: (number | null)[]) {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.ending = { step: 5000, days: 12, orders: 3456 };
    gains.forEach((gain, i) => {
      const record = { onTime: 20, baseline: gain === null ? null : { orders: 30, onTime: 20 - gain, late: 0, lateOpen: 0, cancelled: 0, revenue: 0, districts: [], lowLoad: false } } as unknown as PeakRecord;
      campaign.peaks.push({ ...record, day: Math.floor(i / 2), peak: i % 2 === 0 ? 'noon' : 'evening' } as PeakRecord);
    });
    return state;
  }

  it('没有对照过：只写送了多少单、用了几天', () => {
    expect(endingText(ended([null, null]))).toBe('三个片区均已达到四星。共送达 3456 单，用时 12 天。');
  });

  it('累计多准时：后面接一句。每场比开局策略多或少的单数相加，没有对照的场不算', () => {
    const text = endingText(ended([5, null, -2, 8]));
    expect(text).toBe('三个片区均已达到四星。共送达 3456 单，用时 12 天。累计准时订单较开局策略多 11 单。');
    expect(endingLines(text ?? '')).toEqual(['三个片区均已达到四星。', '共送达 3456 单，用时 12 天。', '累计准时订单较开局策略多 11 单。']);
  });

  it('累计少准时写少，相抵为 0 不写', () => {
    expect(endingText(ended([-3, 1]))).toContain('累计准时订单较开局策略少 2 单。');
    expect(endingText(ended([3, -3]))).toBe('三个片区均已达到四星。共送达 3456 单，用时 12 天。');
  });

  it('还没到结局：没有', () => {
    expect(endingText(quietState())).toBeNull();
  });
});

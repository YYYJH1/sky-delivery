// 每场高峰的目标线：公式和各种边界情形，高峰开始时存下的目标，小结里各片区一行的达标标记和整张小结的标记，
// 日结里达标的场数，高峰进行中各片区已有的结果，片区纸条上的余量和还差几张。
import { describe, expect, it } from 'vitest';
import { GOALS_V1 } from '../src/content/goals_v1.ts';
import { STARS_V1 } from '../src/content/stars_v1.ts';
import {
  DAY_STEPS,
  createState,
  districtGoal,
  districtNote,
  goalOf,
  liveRows,
  peakGoals,
  peakInProgress,
  peakStartingAt,
  reachesLine,
  recordPeakGoals,
  recordPeakSummary,
  settleDay,
  step,
  summaryStep,
} from '../src/core/index.ts';
import type { DayRecord, PeakName, PeakRecord, SimState } from '../src/core/index.ts';
import { batchOrders, campaignOf, outcomeOrder, quietState } from './campaign-helpers.ts';
import { campaignScript, richCampaign } from './save-helpers.ts';

/** 升到 star 星的准时率线，二星到五星。 */
function line(star: number): number {
  const found = STARS_V1.rules.find((r) => r.star === star);
  if (found === undefined) throw new Error(`no rule for star ${star}`);
  return found.onTimeMin;
}

function peakStub(day: number, peak: PeakName, districts: PeakRecord['districts']): PeakRecord {
  return {
    day,
    peak,
    step: day * DAY_STEPS + (peak === 'noon' ? 1800 : 3400),
    orders: 0,
    onTime: 0,
    late: 0,
    lateOpen: 0,
    cancelled: 0,
    revenue: 0,
    districts,
    segments: null,
    select: 'fifo',
    early: 0,
    changedMidPeak: false,
    main: { id: 'noOrders' },
    extra: null,
    cleared: null,
    baseline: null,
  };
}

function dayStub(day: number, fromStar: number): DayRecord {
  return {
    day,
    step: (day + 1) * DAY_STEPS,
    ordered: 0,
    resolved: 0,
    onTime: 0,
    late: 0,
    cancelled: 0,
    pending: 0,
    income: 0,
    districts: [{ district: 0, kind: 'starKept', fromStar, star: fromStar, n: 0, onTime: 0, cancelled: 0, onTimePct: null, cancelPct: null, needOnTimePct: null, needCancelPct: null, newShops: [] }],
    peaksJudged: 0,
    peaksCleared: 0,
  };
}

interface Setup {
  day?: number;
  peak?: PeakName;
  star?: number;
  /** 昨天这个片区的星级，缺省与今天相同 */
  yesterdayStar?: number;
  misses?: number;
  /** 昨天同一场送往老街的订单数，null 表示没有昨天的小结记录 */
  yesterdayOrders: number | null;
  /** 最近两天里老街已完成的订单：准时的和超时的 */
  onTime: number;
  late: number;
}

/** 第 day 天某场高峰刚开始时的状态：老街，昨天的记录，最近两天里已完成的订单。 */
function goalState(s: Setup): SimState {
  const day = s.day ?? 3;
  const peak = s.peak ?? 'noon';
  const state = quietState();
  const campaign = campaignOf(state);
  campaign.districts[0]!.star = s.star ?? 2;
  campaign.rating[0]!.misses = s.misses ?? 0;
  state.step = day * DAY_STEPS + (peak === 'noon' ? 600 : 2150);
  if (s.yesterdayOrders !== null) {
    campaign.peaks.push(peakStub(day - 1, peak, [{ district: 0, n: s.yesterdayOrders, onTime: 0, pct: null, delta: null, line: null, met: null }]));
  }
  for (let d = 0; d < day; d++) campaign.days.push(dayStub(d, s.yesterdayStar ?? s.star ?? 2));
  batchOrders(state, 0, day - 1, { onTime: s.onTime, late: s.late });
  return state;
}

describe('目标线的公式：(星级线 × (N + m) - P) ÷ m', () => {
  it('在 0 到 100 之间：直接用。二星要升三星，线是 75。最近两天 40 张里准时 28 张，昨天这一场 20 张，(75 × 60 - 2800) ÷ 20 = 85', () => {
    const state = goalState({ star: 2, yesterdayOrders: 20, onTime: 28, late: 12 });
    expect(districtGoal(state, 3, 'noon', 0)).toEqual({ district: 0, kind: 'line', line: 85, basis: 'next' });
    expect(line(3)).toBe(75);
  });

  it('有小数时向上取整：39 张里准时 28 张，(75 × 59 - 2800) ÷ 20 = 81.25，线是 82', () => {
    const state = goalState({ star: 2, yesterdayOrders: 20, onTime: 28, late: 11 });
    expect(districtGoal(state, 3, 'noon', 0)).toMatchObject({ kind: 'line', line: 82 });
  });

  it('恰好是整数时不多进一位：要求刚好 85，写 85，不写 86', () => {
    const state = goalState({ star: 2, yesterdayOrders: 20, onTime: 28, late: 12 });
    expect(districtGoal(state, 3, 'noon', 0)?.line).toBe(85);
  });

  it('要求超过 100：改用星级线本身，并标明今晚做不到。40 张里准时 10 张，(75 × 60 - 1000) ÷ 20 = 175', () => {
    const state = goalState({ star: 2, yesterdayOrders: 20, onTime: 10, late: 30 });
    expect(districtGoal(state, 3, 'noon', 0)).toEqual({ district: 0, kind: 'capped', line: 75, basis: 'next' });
  });

  it('要求恰好是 100：不算超过，写 100', () => {
    // 40 张里准时 P 张，m = 20，(75 × 60 - 100P) ÷ 20 = 100 时 P = 25
    const state = goalState({ star: 2, yesterdayOrders: 20, onTime: 25, late: 15 });
    expect(districtGoal(state, 3, 'noon', 0)).toMatchObject({ kind: 'line', line: 100 });
  });

  it('要求小于 0：这一场一单也不准时，日结时也够了，不设线。40 张全准时，m = 4，(75 × 44 - 4000) ÷ 4 < 0', () => {
    const state = goalState({ star: 2, yesterdayOrders: 4, onTime: 40, late: 0 });
    expect(districtGoal(state, 3, 'noon', 0)).toEqual({ district: 0, kind: 'enough', line: null, basis: 'next' });
  });

  it('要求恰好是 0：也算已经够了。36 张里准时 30 张，m = 4，75 × 40 = 100 × 30', () => {
    const state = goalState({ star: 2, yesterdayOrders: 4, onTime: 30, late: 6 });
    expect(districtGoal(state, 3, 'noon', 0)).toMatchObject({ kind: 'enough', line: null });
  });

  it('最近两天加这一场预计的订单不到下限：不设线，到下限就设', () => {
    const min = STARS_V1.minSample;
    const few = goalState({ star: 2, yesterdayOrders: 5, onTime: 2, late: 2 });
    expect(2 + 2 + 5).toBeLessThan(min);
    expect(districtGoal(few, 3, 'noon', 0)).toBeNull();
    const enough = goalState({ star: 2, yesterdayOrders: 5, onTime: 3, late: 2 });
    expect(3 + 2 + 5).toBe(min);
    // m = 5，(75 × 10 - 300) ÷ 5 = 90
    expect(districtGoal(enough, 3, 'noon', 0)).toMatchObject({ kind: 'line', line: 90 });
  });

  it('没有昨天的记录时不设线：第一天，昨天没有这一场的小结，小结里没有这个片区，日结里没有这个片区，昨天这一场没有订单', () => {
    const first = goalState({ day: 1, star: 2, yesterdayOrders: null, onTime: 20, late: 5 });
    first.step = 600;
    expect(districtGoal(first, 0, 'noon', 0)).toBeNull();
    expect(districtGoal(goalState({ star: 2, yesterdayOrders: null, onTime: 28, late: 12 }), 3, 'noon', 0)).toBeNull();
    const missingRow = goalState({ star: 2, yesterdayOrders: 20, onTime: 28, late: 12 });
    campaignOf(missingRow).peaks[0]!.districts = [];
    expect(districtGoal(missingRow, 3, 'noon', 0)).toBeNull();
    const missingDay = goalState({ star: 2, yesterdayOrders: 20, onTime: 28, late: 12 });
    campaignOf(missingDay).days[2]!.districts = [];
    expect(districtGoal(missingDay, 3, 'noon', 0)).toBeNull();
    expect(districtGoal(goalState({ star: 2, yesterdayOrders: 0, onTime: 28, late: 12 }), 3, 'noon', 0)).toBeNull();
  });

  it('午高峰对午高峰，晚高峰对晚高峰：晚高峰用昨天晚高峰的订单数', () => {
    const state = goalState({ peak: 'evening', star: 2, yesterdayOrders: 20, onTime: 28, late: 12 });
    expect(districtGoal(state, 3, 'evening', 0)?.line).toBe(85);
    expect(districtGoal(state, 3, 'noon', 0)).toBeNull(); // 昨天没有午高峰的记录
  });

  it('星级升了，预计的订单数乘星级倍数的比：昨天二星今天三星，m = 20 × 1.25 = 25', () => {
    // 三星要升四星，线 85。40 张里准时 34 张，(85 × 65 - 3400) ÷ 25 = 85
    const state = goalState({ star: 3, yesterdayStar: 2, yesterdayOrders: 20, onTime: 34, late: 6 });
    expect(districtGoal(state, 3, 'noon', 0)).toEqual({ district: 0, kind: 'line', line: 85, basis: 'next' });
  });

  it('星级降了，m 变少：昨天三星今天二星，m = 20 ÷ 1.25 = 16，(75 × 56 - 2800) ÷ 16 = 87.5，线是 88', () => {
    const state = goalState({ star: 2, yesterdayStar: 3, yesterdayOrders: 20, onTime: 28, late: 12 });
    expect(districtGoal(state, 3, 'noon', 0)).toMatchObject({ kind: 'line', line: 88 });
  });

  it('五星和可能掉星的片区按保星线反推，其余按升星线', () => {
    // 五星：保星线是四星的 85，没有升星线。40 张里准时 36 张，(85 × 60 - 3600) ÷ 20 = 75
    const five = goalState({ star: 5, yesterdayOrders: 20, onTime: 36, late: 4 });
    expect(districtGoal(five, 3, 'noon', 0)).toEqual({ district: 0, kind: 'line', line: 75, basis: 'keep' });
    expect(line(4)).toBe(85);
    // 三星、上一次日结没有达到：保星线是二星的 55，(55 × 60 - 2800) ÷ 20 = 25
    const risk = goalState({ star: 3, misses: 1, yesterdayOrders: 20, onTime: 28, late: 12 });
    expect(districtGoal(risk, 3, 'noon', 0)).toEqual({ district: 0, kind: 'line', line: 25, basis: 'keep' });
    expect(line(2)).toBe(55);
    // 三星、没有可能掉星：升四星的线 85，(85 × 60 - 2800) ÷ 20 = 115，超过 100
    const calm = goalState({ star: 3, yesterdayOrders: 20, onTime: 28, late: 12 });
    expect(districtGoal(calm, 3, 'noon', 0)).toEqual({ district: 0, kind: 'capped', line: 85, basis: 'next' });
    // 二星没有保星线，连续没有达到也不用它
    const two = goalState({ star: 2, misses: 1, yesterdayOrders: 20, onTime: 28, late: 12 });
    expect(districtGoal(two, 3, 'noon', 0)?.basis).toBe('next');
  });

  it('没开通的片区不设线，peakGoals 只列设了线的开通的片区', () => {
    const state = goalState({ star: 2, yesterdayOrders: 20, onTime: 28, late: 12 });
    const campaign = campaignOf(state);
    expect(districtGoal(state, 3, 'noon', 1)).toBeNull();
    campaign.districts[1]!.open = true;
    expect(peakGoals(state, 3, 'noon')).toEqual({ day: 3, peak: 'noon', step: 3 * DAY_STEPS + 600, goals: [{ district: 0, kind: 'line', line: 85, basis: 'next' }] });
    expect(peakGoals(state, 3, 'evening').step).toBe(3 * DAY_STEPS + 2150);
  });
});

describe('达标的比较：用整数', () => {
  it('准时率不小于目标线才算：8 张里准时 6 张是 75%，线 75 达标，线 76 不达标', () => {
    expect(reachesLine(75, 8, 6)).toBe(true);
    expect(reachesLine(76, 8, 6)).toBe(false);
    expect(reachesLine(100, 8, 8)).toBe(true);
    expect(reachesLine(1, 8, 0)).toBe(false);
  });
});

describe('高峰的第一步', () => {
  it('天内第 600 步是午高峰的第一步，第 2150 步是晚高峰的第一步，其余都不是', () => {
    expect(peakStartingAt(600)).toBe('noon');
    expect(peakStartingAt(2150)).toBe('evening');
    expect(peakStartingAt(3 * DAY_STEPS + 600)).toBe('noon');
    for (const step of [0, 599, 601, 1500, 2149, 2151, 3599]) expect(peakStartingAt(step), `${step}`).toBeNull();
  });

  it('高峰进行中：从第一步到小结生成的那一步之前，包括下单时段结束后的 30 秒', () => {
    expect(peakInProgress(599)).toBeNull();
    expect(peakInProgress(600)).toBe('noon');
    expect(peakInProgress(1500)).toBe('noon');
    expect(peakInProgress(1799)).toBe('noon');
    expect(peakInProgress(1800)).toBeNull();
    expect(peakInProgress(2149)).toBeNull();
    expect(peakInProgress(2150)).toBe('evening');
    expect(peakInProgress(3399)).toBe('evening');
    expect(peakInProgress(3400)).toBeNull();
    expect(peakInProgress(DAY_STEPS + 700)).toBe('noon');
  });

  it('日程阶段在第一步存下目标，换掉上一场的；第一天没有昨天的记录，目标是空的', () => {
    const state = createState({ mode: 'campaign', seed: 7 });
    const campaign = campaignOf(state);
    expect(campaign.goals).toBeNull();
    const seen: { step: number; day: number; peak: PeakName }[] = [];
    for (let i = 0; i < 3 * DAY_STEPS; i++) {
      campaignScript(state);
      step(state);
      const goals = campaign.goals;
      if (goals !== null && !seen.some((x) => x.step === goals.step)) seen.push({ step: goals.step, day: goals.day, peak: goals.peak });
    }
    expect(seen.map((x) => x.step)).toEqual([600, 2150, DAY_STEPS + 600, DAY_STEPS + 2150, 2 * DAY_STEPS + 600, 2 * DAY_STEPS + 2150]);
    expect(seen.map((x) => `${x.day}${x.peak}`)).toEqual(['0noon', '0evening', '1noon', '1evening', '2noon', '2evening']);
  });

  it('recordPeakGoals 存下的就是 peakGoals 算的，换掉旧的；沙盒模式什么也不做', () => {
    const state = goalState({ star: 2, yesterdayOrders: 20, onTime: 28, late: 12 });
    const campaign = campaignOf(state);
    campaign.goals = { day: 0, peak: 'evening', step: 0, goals: [] };
    recordPeakGoals(state, 3, 'noon');
    expect(campaign.goals).toEqual(peakGoals(state, 3, 'noon'));
    expect(goalOf(campaign, 3, 'noon', 0)?.line).toBe(85);
    expect(goalOf(campaign, 3, 'evening', 0)).toBeNull();
    expect(goalOf(campaign, 2, 'noon', 0)).toBeNull();
    expect(goalOf(campaign, 3, 'noon', 1)).toBeNull();
  });
});

/** 在第 day 天的下单时段里放一批送往老街的订单，把步数设到小结时刻，生成这一场的记录。 */
function summarize(state: SimState, day: number, peak: PeakName, kinds: readonly ('on' | 'late' | 'cancel')[], district = 0): PeakRecord {
  const base = day * DAY_STEPS + (peak === 'noon' ? 700 : 2200);
  kinds.forEach((kind, i) => {
    const t = base + i;
    if (kind === 'cancel') outcomeOrder(state, { district, tOrder: t, cancelled: t + 900 });
    else outcomeOrder(state, { district, tOrder: t, delivered: t + (kind === 'on' ? 290 : 400) });
  });
  state.step = summaryStep(day, peak);
  return recordPeakSummary(state, day, peak);
}

function many(n: number, kind: 'on' | 'late' | 'cancel'): ('on' | 'late' | 'cancel')[] {
  return Array.from({ length: n }, () => kind);
}

/** 目标线为 line 的一场高峰开始时的状态：campaign.goals 里老街一行。 */
function withLine(lineValue: number | null, kind: 'line' | 'capped' | 'enough' = 'line'): SimState {
  const state = quietState();
  campaignOf(state).goals = { day: 2, peak: 'noon', step: 2 * DAY_STEPS + 600, goals: lineValue === null && kind !== 'enough' ? [] : [{ district: 0, kind, line: lineValue, basis: 'next' }] };
  return state;
}

describe('小结：各片区一行的目标线和达标', () => {
  it('行里写这一场的目标线，准时率达到了就是达标', () => {
    const state = withLine(75);
    const record = summarize(state, 2, 'noon', [...many(6, 'on'), ...many(2, 'late')]);
    expect(record.districts[0]).toMatchObject({ n: 8, onTime: 6, pct: 75, line: 75, met: true });
    expect(record.cleared).toBe(true);
  });

  it('没有达到就是没达标，整张小结没有标记', () => {
    const state = withLine(76);
    const record = summarize(state, 2, 'noon', [...many(6, 'on'), ...many(2, 'late')]);
    expect(record.districts[0]).toMatchObject({ line: 76, met: false });
    expect(record.cleared).toBe(false);
  });

  it('这一场送往这个片区的订单不到下限时不判：写目标线，达标一栏是空的，整张小结也没有标记', () => {
    const state = withLine(50);
    const record = summarize(state, 2, 'noon', many(GOALS_V1.minJudgedOrders - 1, 'on'));
    expect(record.districts[0]).toMatchObject({ line: 50, met: null });
    expect(record.cleared).toBeNull();
    const state2 = withLine(50);
    const exact = summarize(state2, 2, 'noon', many(GOALS_V1.minJudgedOrders, 'on'));
    expect(exact.districts[0]).toMatchObject({ met: true });
  });

  it('没有设线的片区也不判。高峰开始时存下的不是这一场的，也当作没有设线', () => {
    const none = summarize(withLine(null), 2, 'noon', many(10, 'on'));
    expect(none.districts[0]).toMatchObject({ line: null, met: null });
    expect(none.cleared).toBeNull();
    const enough = summarize(withLine(null, 'enough'), 2, 'noon', many(10, 'on'));
    expect(enough.districts[0]).toMatchObject({ line: null, met: null });
    const other = withLine(50);
    const record = summarize(other, 2, 'evening', many(10, 'on'));
    expect(record.districts[0]).toMatchObject({ line: null, met: null });
    const noGoals = quietState();
    expect(summarize(noGoals, 2, 'noon', many(10, 'on')).cleared).toBeNull();
  });

  it('判过的片区全部达标，但这一场有退单：整张小结没有标记', () => {
    const state = withLine(50);
    const record = summarize(state, 2, 'noon', [...many(8, 'on'), 'cancel']);
    expect(record.districts[0]).toMatchObject({ n: 9, met: true });
    expect(record.cancelled).toBe(1);
    expect(record.cleared).toBe(false);
  });

  it('有一个判过的片区没达标，整张小结没有标记；没判的片区不拖累别的', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.districts[1]!.open = true;
    campaign.districts[2]!.open = true;
    campaign.goals = {
      day: 2,
      peak: 'noon',
      step: 2 * DAY_STEPS + 600,
      goals: [
        { district: 0, kind: 'line', line: 50, basis: 'next' },
        { district: 1, kind: 'line', line: 90, basis: 'next' },
        { district: 2, kind: 'line', line: 90, basis: 'next' },
      ],
    };
    // 老街 8 张全准时，写字楼区 8 张里准时 4 张，大学城只有 3 张
    const base = 2 * DAY_STEPS + 700;
    let k = 0;
    for (let i = 0; i < 8; i++) outcomeOrder(state, { district: 0, tOrder: base + k++, delivered: base + k + 200 });
    for (let i = 0; i < 4; i++) outcomeOrder(state, { district: 1, tOrder: base + k++, delivered: base + k + 200 });
    for (let i = 0; i < 4; i++) outcomeOrder(state, { district: 1, tOrder: base + k++, delivered: base + k + 400 });
    for (let i = 0; i < 3; i++) outcomeOrder(state, { district: 2, tOrder: base + k++, delivered: base + k + 200 });
    state.step = summaryStep(2, 'noon');
    const record = recordPeakSummary(state, 2, 'noon');
    expect(record.districts.map((d) => d.met)).toEqual([true, false, null]);
    expect(record.cleared).toBe(false);
    // 把没达标的那一个拿掉，只剩判过并且达标的，没判的大学城不影响
    const only = quietState();
    const c2 = campaignOf(only);
    c2.districts[2]!.open = true;
    c2.goals = { day: 2, peak: 'noon', step: 2 * DAY_STEPS + 600, goals: [{ district: 0, kind: 'line', line: 50, basis: 'next' }, { district: 2, kind: 'line', line: 90, basis: 'next' }] };
    const record2 = ((): PeakRecord => {
      let j = 0;
      for (let i = 0; i < 8; i++) outcomeOrder(only, { district: 0, tOrder: base + j++, delivered: base + j + 200 });
      for (let i = 0; i < 3; i++) outcomeOrder(only, { district: 2, tOrder: base + j++, delivered: base + j + 400 });
      only.step = summaryStep(2, 'noon');
      return recordPeakSummary(only, 2, 'noon');
    })();
    expect(record2.districts.map((d) => d.met)).toEqual([true, null]);
    expect(record2.cleared).toBe(true);
  });

  it('生成小结之后，记录里的 baseline 是空的：对照要等会话层补进来', () => {
    const record = summarize(withLine(50), 2, 'noon', many(8, 'on'));
    expect(record.baseline).toBeNull();
  });
});

describe('日结：今天判过目标的场数和其中达标的场数', () => {
  it('午高峰达标、晚高峰没达标：判过 2 场，达标 1 场', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.goals = { day: 2, peak: 'noon', step: 2 * DAY_STEPS + 600, goals: [{ district: 0, kind: 'line', line: 50, basis: 'next' }] };
    summarize(state, 2, 'noon', many(8, 'on'));
    campaign.goals = { day: 2, peak: 'evening', step: 2 * DAY_STEPS + 2150, goals: [{ district: 0, kind: 'line', line: 90, basis: 'next' }] };
    summarize(state, 2, 'evening', [...many(4, 'on'), ...many(4, 'late')]);
    state.step = 3 * DAY_STEPS;
    const record = settleDay(state, 2);
    expect([record.peaksJudged, record.peaksCleared]).toEqual([2, 1]);
  });

  it('没有判过的场不算：第一天没有设线，两个数都是 0；别的天的高峰也不算', () => {
    const state = quietState();
    summarize(state, 0, 'noon', many(8, 'on'));
    summarize(state, 0, 'evening', many(8, 'on'));
    state.step = DAY_STEPS;
    const record = settleDay(state, 0);
    expect([record.peaksJudged, record.peaksCleared]).toEqual([0, 0]);
    const next = quietState();
    const campaign = campaignOf(next);
    campaign.goals = { day: 1, peak: 'noon', step: DAY_STEPS + 600, goals: [{ district: 0, kind: 'line', line: 50, basis: 'next' }] };
    summarize(next, 1, 'noon', many(8, 'on'));
    next.step = 3 * DAY_STEPS;
    expect(settleDay(next, 2)).toMatchObject({ peaksJudged: 0, peaksCleared: 0 });
  });
});

describe('每一场的记录和高峰开始时算的目标一致', () => {
  it('带脚本的几天：每场小结里各片区的目标线就是这一场开始时存下的，达标按整数比较，整张小结的标记按规则给', () => {
    const state = richCampaign(7, 6000);
    const campaign = campaignOf(state);
    const started = new Map<string, ReturnType<typeof peakGoals>>();
    for (let i = 0; i < 4 * DAY_STEPS; i++) {
      campaignScript(state);
      step(state);
      const goals = campaign.goals;
      if (goals !== null) started.set(`${goals.day}${goals.peak}`, structuredClone(goals));
    }
    expect(campaign.peaks.length).toBeGreaterThanOrEqual(7);
    let lines = 0;
    let judged = 0;
    for (const record of campaign.peaks) {
      const goals = started.get(`${record.day}${record.peak}`);
      expect(goals, `${record.day}${record.peak}`).toBeDefined();
      const marks: (boolean | null)[] = [];
      for (const row of record.districts) {
        const goal = goals?.goals.find((g) => g.district === row.district);
        expect(row.line, `${record.day}${record.peak} ${row.district}`).toBe(goal?.line ?? null);
        if (row.line !== null) lines += 1;
        const expectedMet = row.line === null || row.n < GOALS_V1.minJudgedOrders ? null : 100 * row.onTime >= row.line * row.n;
        expect(row.met).toBe(expectedMet);
        if (row.met !== null) judged += 1;
        marks.push(row.met);
      }
      const decided = marks.filter((m) => m !== null);
      expect(record.cleared).toBe(decided.length === 0 ? null : decided.every((m) => m === true) && record.cancelled === 0);
    }
    expect(lines).toBeGreaterThan(0);
    expect(judged).toBeGreaterThan(0);
  });
});

describe('高峰进行中：各个开通的片区已有的结果', () => {
  /** 午高峰里的一个时刻，老街有几张订单：下单的步 tOrder，送达的步或退单的步。 */
  function live(now: number): SimState {
    const state = quietState();
    state.step = now;
    return state;
  }

  it('不在高峰里没有；在午高峰里有开通的每个片区一行，没有订单时都是 0', () => {
    expect(liveRows(live(500))).toBeNull();
    const view = liveRows(live(900));
    expect(view).toEqual({ peak: 'noon', rows: [{ district: 0, onTime: 0, late: 0, cancelled: 0, goal: null }] });
    const state = live(900);
    campaignOf(state).districts[1]!.open = true;
    expect(liveRows(state)?.rows.map((r) => r.district)).toEqual([0, 1]);
  });

  it('准时、超时、退单：送达用时不超过 30 秒是准时，超过是超时，退单单独数', () => {
    const state = live(1200);
    outcomeOrder(state, { district: 0, tOrder: 700, delivered: 1000 }); // 用时 300 步，准时
    outcomeOrder(state, { district: 0, tOrder: 710, delivered: 1011 }); // 用时 301 步，超时
    outcomeOrder(state, { district: 0, tOrder: 720, cancelled: 1100 });
    expect(liveRows(state)?.rows[0]).toMatchObject({ onTime: 1, late: 1, cancelled: 1 });
  });

  it('还没送到的订单：下单超过 30 秒算超时，不到 30 秒还说不上，不计在任何一项里', () => {
    const state = live(1200);
    outcomeOrder(state, { district: 0, tOrder: 850 }); // 等了 350 步，已经超时
    outcomeOrder(state, { district: 0, tOrder: 900 }); // 等了 300 步，还不算超时
    outcomeOrder(state, { district: 0, tOrder: 1100 }); // 等了 100 步
    expect(liveRows(state)?.rows[0]).toMatchObject({ onTime: 0, late: 1, cancelled: 0 });
    state.step = 1201;
    expect(liveRows(state)?.rows[0]).toMatchObject({ late: 2 });
  });

  it('只数这一场下单时段里的订单：上午的、午后的、前一天的、别的片区的都不算', () => {
    const state = live(1500);
    outcomeOrder(state, { district: 0, tOrder: 300, delivered: 400 }); // 上午
    outcomeOrder(state, { district: 0, tOrder: 700, delivered: 800 });
    outcomeOrder(state, { district: 0, tOrder: 1499, delivered: 1600 });
    outcomeOrder(state, { district: 0, tOrder: 1500 }); // 下单时段已经结束
    expect(liveRows(state)?.rows[0]).toMatchObject({ onTime: 2, late: 0 });
    const next = live(DAY_STEPS + 900);
    outcomeOrder(next, { district: 0, tOrder: 700, delivered: 800 }); // 前一天的午高峰
    expect(liveRows(next)?.rows[0]).toMatchObject({ onTime: 0, late: 0 });
  });

  it('下单时段结束之后到小结生成之前仍有，之后没有；这一场的目标跟着给', () => {
    const state = live(1700);
    const campaign = campaignOf(state);
    campaign.goals = { day: 0, peak: 'noon', step: 600, goals: [{ district: 0, kind: 'capped', line: 75, basis: 'next' }] };
    outcomeOrder(state, { district: 0, tOrder: 1400, delivered: 1650 });
    expect(liveRows(state)).toEqual({ peak: 'noon', rows: [{ district: 0, onTime: 1, late: 0, cancelled: 0, goal: { district: 0, kind: 'capped', line: 75, basis: 'next' } }] });
    state.step = 1800;
    expect(liveRows(state)).toBeNull();
    state.step = 2300;
    expect(liveRows(state)?.peak).toBe('evening');
    expect(liveRows(state)?.rows[0]?.goal).toBeNull(); // 记着的是午高峰的目标
  });
});

describe('片区纸条：余量和还差几张', () => {
  /** 老街，第 1 天，星级 star，最近两天完成的订单 onTime 张准时、late 张超时。 */
  function noteState(star: number, onTime: number, late: number): SimState {
    const state = quietState();
    campaignOf(state).districts[0]!.star = star;
    state.step = DAY_STEPS + 2000;
    batchOrders(state, 0, 1, { onTime, late });
    return state;
  }

  it('没到下一星：还要连续准时几张 = (升星线 × 完成的订单数 - 100 × 准时的订单数) / (100 - 升星线)，向上取整。二星 40 张里准时 28 张，(75 × 40 - 2800) / 25 = 8', () => {
    const note = districtNote(noteState(2, 28, 12), 0);
    expect(note.shortfall).toBe(8);
    expect((28 + 8) / (40 + 8)).toBeGreaterThanOrEqual(0.75); // 再准时 8 张正好到线
    expect((28 + 7) / (40 + 7)).toBeLessThan(0.75);
    // 取整：39 张里准时 28 张，(75 × 39 - 2800) / 25 = 5
    expect(districtNote(noteState(2, 28, 11), 0).shortfall).toBe(5);
    // 76 张里准时 56 张：(75 × 76 - 5600) / 25 = 4
    expect(districtNote(noteState(2, 56, 20), 0).shortfall).toBe(4);
  });

  it('已经达到升星线，或者已经五星，或者完成的订单不到下限：不写还差几张', () => {
    expect(districtNote(noteState(2, 30, 10), 0).shortfall).toBeNull(); // 75% 恰好
    expect(districtNote(noteState(5, 20, 20), 0).shortfall).toBeNull();
    expect(districtNote(noteState(2, 3, 3), 0).shortfall).toBeNull();
    expect(districtNote(quietState(), 0).shortfall).toBeNull();
  });

  it('三星以上写余量：最近两天的准时率比保星线高几个百分点。三星的保星线是二星的 55，准时 79%，余量 24', () => {
    const note = districtNote(noteState(3, 31, 9), 0);
    expect(note.keep?.onTimeMin).toBe(55);
    expect(note.onTimePct).toBe(77);
    expect(note.margin).toBe(22);
    // 比保星线低时是负数
    expect(districtNote(noteState(3, 20, 20), 0).margin).toBe(-5);
    // 五星：保星线是四星的 85
    expect(districtNote(noteState(5, 38, 2), 0).margin).toBe(10);
  });

  it('三星以下没有余量，完成的订单不到下限时也没有', () => {
    expect(districtNote(noteState(2, 38, 2), 0).margin).toBeNull();
    expect(districtNote(noteState(1, 38, 2), 0).margin).toBeNull();
    expect(districtNote(noteState(4, 3, 3), 0).margin).toBeNull();
  });
});

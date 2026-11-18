// 效果记录：购买起降口升级、双层货箱、就近降落时记一条跟踪，购买之后的 3 次日结里，每次在日结记录里写一行这项改装对应的指标，
// 现在的数值和不购买时同一场高峰的数值。指标取自高峰小结的记录，只读，不另行模拟，不影响派单和任何决定。
// 不购买时的数来自会话层里的副本（src/app/twins.ts）：核心只提供记数的函数 recordTwin，副本本身的测试在 app-twins.test.ts。
import { describe, expect, it } from 'vitest';
import { createPlay } from '../src/app/index.ts';
import { FORECAST_V1 } from '../src/content/forecast_v1.ts';
import { DAY_STEPS, applyCommand, effectValue, hashState, pushTip, quoteCommand, recordTwin, settleDay, step } from '../src/core/index.ts';
import type { Command, PeakFleet, PeakName, PeakRecord, PeakStationRow, SimState } from '../src/core/index.ts';
import { campaignOf, expectRejected, must, quietState, roofWhere, runningState, unlockAll, withMoney } from './campaign-helpers.ts';

const OLD_SMALL = roofWhere((r) => r.district === 0 && r.size === 'small');

// ---- 小结记录的桩：只写指标要用的几项 ----

function stationRow(station: number, gateWait: number | null, sorties = 0): PeakStationRow {
  return { station, gateWait, landWaitAvg: 0, takeoffWaitPct: 0, queuePct: 0, sorties, fleet: null };
}

/** 五项加起来是 100，空载飞行是 empty。 */
function fleetOfEmpty(empty: number): PeakFleet {
  return { loaded: 30, empty, work: 100 - 30 - empty - 10, queue: 5, parked: 5 };
}

interface PeakSpec {
  onTime?: number;
  late?: number;
  lateOpen?: number;
  stations?: PeakStationRow[];
  fleet?: PeakFleet | null;
  fleetBack?: number | null;
}

/** 回站飞行占 back，空载飞行比它多 10 个百分点（去取餐的部分）：指标取 fleetBack，不取空载飞行，写错了数对不上。back 不超过 50。 */
function backOf(back: number): PeakSpec {
  return { fleet: fleetOfEmpty(back + 10), fleetBack: back };
}

function peakStub(day: number, peak: PeakName, spec: PeakSpec = {}): PeakRecord {
  return {
    day,
    peak,
    step: day * DAY_STEPS + (peak === 'noon' ? 1800 : 3400),
    orders: 0,
    onTime: spec.onTime ?? 0,
    late: spec.late ?? 0,
    lateOpen: spec.lateOpen ?? 0,
    cancelled: 0,
    revenue: 0,
    districts: [],
    segments: null,
    select: 'fifo',
    early: 0,
    changedMidPeak: false,
    main: { id: 'noOrders' },
    extra: null,
    cleared: null,
    baseline: null,
    fleet: spec.fleet ?? null,
    fleetBack: spec.fleetBack ?? null,
    stations: spec.stations ?? [],
  };
}

/** 做第 day 天的日结。 */
function settle(state: SimState, day: number): void {
  state.step = (day + 1) * DAY_STEPS;
  settleDay(state, day);
}

/**
 * 主状态生成了一场高峰的小结记录，副本（不购买的一份）同一场的小结记录是 twin，会话层用它调用 recordTwin，记进每条还在的跟踪。
 * 不给 twin 就是副本这一场没有数：读档之后副本已经不在，或者副本作废。
 */
function addPeak(state: SimState, day: number, peak: PeakName, spec: PeakSpec = {}, twin?: PeakSpec): void {
  const campaign = campaignOf(state);
  campaign.peaks.push(peakStub(day, peak, spec));
  if (twin === undefined) return;
  for (const watch of campaign.effectWatches) recordTwin(watch, peakStub(day, peak, twin));
}

/** 所有开放都打开、钱很多、没有订单的状态，购买都能成功。 */
function shopState(): SimState {
  return withMoney(quietState());
}

describe('每种改装对应的指标：从一场小结记录里取', () => {
  it('起降口升级：这座站的起降排队秒数，按站的编号找，不按下标；这一场没有这座站，或这座站没有已送达的订单，没有数', () => {
    const record = peakStub(0, 'noon', { stations: [stationRow(0, 1.4), stationRow(2, 0.8), stationRow(3, null)] });
    expect(effectValue('gate', 0, record)).toBe(1.4);
    expect(effectValue('gate', 2, record)).toBe(0.8);
    expect(effectValue('gate', 3, record)).toBeNull(); // 这座站在这一场没有已送达的订单
    expect(effectValue('gate', 1, record)).toBeNull(); // 这一场没有这座站（还没建，或已经退回）
    expect(effectValue('gate', 0, peakStub(0, 'noon'))).toBeNull(); // 旧存档的记录没有各站的一行
  });

  it('双层货箱：已送达的订单数（准时加超时减去超时里没送到的）除以各站放行起飞的架次合计，不取整', () => {
    const record = peakStub(0, 'evening', { onTime: 10, late: 4, lateOpen: 1, stations: [stationRow(0, 1, 5), stationRow(1, 1, 4)] });
    expect(effectValue('doubleBox', null, record)).toBe(13 / 9);
    const exact = peakStub(0, 'evening', { onTime: 12, late: 2, lateOpen: 0, stations: [stationRow(0, null, 7), stationRow(1, null, 3)] });
    expect(effectValue('doubleBox', null, exact)).toBe(1.4);
  });

  it('双层货箱：架次合计是 0 时没有数；旧存档的记录没有各站的一行，也没有数；已送达的是 0 但有架次，数是 0', () => {
    expect(effectValue('doubleBox', null, peakStub(0, 'noon', { onTime: 5, stations: [stationRow(0, null, 0), stationRow(1, null, 0)] }))).toBeNull();
    expect(effectValue('doubleBox', null, peakStub(0, 'noon', { onTime: 5 }))).toBeNull();
    expect(effectValue('doubleBox', null, peakStub(0, 'noon', { late: 2, lateOpen: 2, stations: [stationRow(0, null, 3)] }))).toBe(0);
  });

  it('就近降落：全场回站飞行占机队时间的百分数，也就是记录里的 fleetBack，不是机队时间构成里的空载飞行；记录里没有 fleetBack 时没有数', () => {
    // 空载飞行 38%，其中回站飞行 24%：取 24
    expect(effectValue('nearest', null, peakStub(0, 'noon', { fleet: fleetOfEmpty(38), fleetBack: 24 }))).toBe(24);
    // 记录里没有回站飞行占比（旧存档的记录），哪怕有空载飞行的数：没有数
    expect(effectValue('nearest', null, peakStub(0, 'noon', { fleet: fleetOfEmpty(38), fleetBack: null }))).toBeNull();
    expect(effectValue('nearest', null, peakStub(0, 'noon', { fleet: null, fleetBack: null }))).toBeNull();
    // 0 是有数的：这一场的回站飞行占 0%
    expect(effectValue('nearest', null, peakStub(0, 'noon', { fleet: fleetOfEmpty(30), fleetBack: 0 }))).toBe(0);
  });
});

describe('购买成功时记一条跟踪', () => {
  it('起降口升级：记种类、购买的步、站、升到的等级，购买前的数值取最近一场小结记录里这座站的起降排队，并记下那一场是午高峰还是晚高峰', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    expect(campaign.effectWatches).toEqual([{ kind: 'gate', step: 2000, station: 0, level: 2, peak: 'noon', beforeDay: 0, before: 1.4, left: FORECAST_V1.effectDays, twins: [] }]);
    must(state, { type: 'upgradeGate', station: 0 });
    expect(campaign.effectWatches[1]).toMatchObject({ kind: 'gate', station: 0, level: 3, before: 1.4 }); // 升到三级也记，等级是升到的那一级
  });

  it('双层货箱：购买前的数值是最近一场的每趟单数', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { onTime: 6, late: 0, stations: [stationRow(0, 1, 4)] }));
    campaign.peaks.push(peakStub(0, 'evening', { onTime: 9, late: 3, lateOpen: 0, stations: [stationRow(0, 1, 8)] })); // 最近的是这一场，每趟 1.5 单
    state.step = 3500;
    must(state, { type: 'buyDoubleBox' });
    expect(campaign.effectWatches).toEqual([{ kind: 'doubleBox', step: 3500, station: null, level: null, peak: 'evening', beforeDay: 0, before: 1.5, left: 3, twins: [] }]);
  });

  it('就近降落：购买前的数值是最近一场的回站飞行百分数；之后开关就近降落不再记', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    must(state, { type: 'buildStation', roof: OLD_SMALL }); // 就近降落要有两座站，建站不记
    campaign.peaks.push(peakStub(0, 'noon', backOf(31))); // 空载飞行 41%，回站飞行 31%
    state.step = 2000;
    must(state, { type: 'buyNearestLanding' });
    expect(campaign.effectWatches).toEqual([{ kind: 'nearest', step: 2000, station: null, level: null, peak: 'noon', beforeDay: 0, before: 31, left: 3, twins: [] }]);
    must(state, { type: 'setNearestLanding', on: false });
    must(state, { type: 'setNearestLanding', on: true });
    expect(campaign.effectWatches).toHaveLength(1);
  });

  it('其余的购买和命令不记：建站、买无人机、加停机位、退回、开通片区、换卡、点订单、便签、推演', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4, 3)], ...backOf(20) }));
    campaign.forecast.charges = 2;
    pushTip(state, 'canAddBay');
    must(state, { type: 'buyBay', station: 0 });
    must(state, { type: 'buyDrone', station: 0 });
    must(state, { type: 'refundDrone', drone: 2 });
    must(state, { type: 'refundBay', station: 0 });
    must(state, { type: 'buildStation', roof: OLD_SMALL });
    must(state, { type: 'refundStation', station: 1 });
    campaign.districts[0]!.star = 3;
    must(state, { type: 'openDistrict', district: 1 });
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    must(state, { type: 'readTip', tip: 'canAddBay' });
    must(state, { type: 'useForecast' });
    expect(campaign.effectWatches).toEqual([]);
  });

  it('购买失败不记：起降口已是最高级、余额不够、价签没开放', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    must(state, { type: 'upgradeGate', station: 0 });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(campaign.effectWatches).toHaveLength(2);
    expectRejected(state, { type: 'upgradeGate', station: 0 }, 'gateMax');
    campaign.money = 1;
    expectRejected(state, { type: 'buyDoubleBox' }, 'notEnoughMoney');
    const locked = withMoney(quietState({}, false));
    expectRejected(locked, { type: 'buyDoubleBox' }, 'priceTagsLocked');
    expect(campaign.effectWatches).toHaveLength(2);
    expect(campaignOf(locked).effectWatches).toEqual([]);
  });

  it('问价是只读的：问价不记，状态和哈希都不变', () => {
    const state = shopState();
    const hash = hashState(state);
    for (const command of [{ type: 'upgradeGate', station: 0 }, { type: 'buyDoubleBox' }, { type: 'buyNearestLanding' }] as const) quoteCommand(state, command);
    expect(campaignOf(state).effectWatches).toEqual([]);
    expect(hashState(state)).toBe(hash);
  });

  it('购买时还没有小结记录：购买前的数值、哪一场、哪一天都是 null；跟踪仍然记下', () => {
    const state = shopState();
    expect(campaignOf(state).peaks).toEqual([]);
    must(state, { type: 'buyDoubleBox' });
    expect(campaignOf(state).effectWatches).toEqual([{ kind: 'doubleBox', step: 0, station: null, level: null, peak: null, beforeDay: null, before: null, left: 3, twins: [] }]);
  });

  it('最近一场的记录里没有这项数据：购买前的数值是 null，但记下那一场是午高峰还是晚高峰', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, null, 0)], fleet: null, fleetBack: null })); // 没有已送达的订单，没有架次，没有机队时间构成
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    must(state, { type: 'buyDoubleBox' });
    expect(campaign.effectWatches.map((w) => [w.kind, w.peak, w.beforeDay, w.before])).toEqual([
      ['gate', 'noon', 0, null],
      ['doubleBox', 'noon', 0, null],
    ]);
  });

  it('这座站在最近一场的记录里还没有（后来才建的）：起降排队的购买前数值是 null', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4)] }));
    state.step = 2000;
    must(state, { type: 'buildStation', roof: OLD_SMALL });
    must(state, { type: 'upgradeGate', station: 1 });
    expect(campaign.effectWatches).toEqual([{ kind: 'gate', step: 2000, station: 1, level: 2, peak: 'noon', beforeDay: 0, before: null, left: 3, twins: [] }]);
  });

  it('同一座站连着升两级：记两条，各记升到的等级，购买前的数值取各自购买时最近的小结记录', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    campaign.peaks.push(peakStub(0, 'evening', { stations: [stationRow(0, 0.9)] }));
    state.step = 3500;
    must(state, { type: 'upgradeGate', station: 0 });
    expect(campaign.effectWatches.map((w) => [w.level, w.peak, w.before, w.step])).toEqual([
      [2, 'noon', 1.4, 2000],
      [3, 'evening', 0.9, 3500],
    ]);
  });
});

describe('副本的数记进跟踪：recordTwin', () => {
  /** 午高峰小结之后买了起降口升级：购买前取的是第 0 天的午高峰。 */
  function boughtGate(): { state: SimState; watch: ReturnType<typeof campaignOf>['effectWatches'][number] } {
    const state = shopState();
    campaignOf(state).peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    return { state, watch: campaignOf(state).effectWatches[0]! };
  }

  it('记下哪一天、哪一场、数值：数是副本这一场小结记录里这项改装的指标，不取整', () => {
    const { watch } = boughtGate();
    expect(recordTwin(watch, peakStub(1, 'noon', { stations: [stationRow(0, 10 / 7)] }))).toBe(true);
    expect(recordTwin(watch, peakStub(2, 'noon', { stations: [stationRow(1, 0.4), stationRow(0, 0.8)] }))).toBe(true); // 按站的编号找
    expect(watch.twins).toEqual([
      { day: 1, peak: 'noon', value: 10 / 7 },
      { day: 2, peak: 'noon', value: 0.8 },
    ]);
  });

  it('三种改装各取各的指标：双层货箱是每趟单数，就近降落是回站飞行占比', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    must(state, { type: 'buildStation', roof: OLD_SMALL });
    campaign.peaks.push(peakStub(0, 'noon', { onTime: 8, stations: [stationRow(0, 1, 4)], ...backOf(30) }));
    state.step = 2000;
    must(state, { type: 'buyDoubleBox' });
    must(state, { type: 'buyNearestLanding' });
    const twin = peakStub(1, 'noon', { onTime: 9, lateOpen: 0, stations: [stationRow(0, 1, 6)], ...backOf(44) });
    for (const watch of campaign.effectWatches) recordTwin(watch, twin);
    expect(campaign.effectWatches.map((w) => [w.kind, w.twins.map((t) => t.value)])).toEqual([
      ['doubleBox', [1.5]],
      ['nearest', [44]],
    ]);
  });

  it('只记与跟踪同类（午高峰或晚高峰）、并且晚于购买前那一场的高峰：别的场日结里用不到，不记', () => {
    const { watch } = boughtGate();
    const row = { stations: [stationRow(0, 1.1)] };
    expect(recordTwin(watch, peakStub(1, 'evening', row))).toBe(false); // 另一类的高峰
    expect(recordTwin(watch, peakStub(0, 'noon', row))).toBe(false); // 购买前的那一场
    expect(recordTwin(watch, peakStub(1, 'noon', row))).toBe(true);
    expect(watch.twins).toEqual([{ day: 1, peak: 'noon', value: 1.1 }]);
  });

  it('副本这一场没有这项数据（指标是 null）不记；同一场已经记过的不重复记', () => {
    const { watch } = boughtGate();
    expect(recordTwin(watch, peakStub(1, 'noon', { stations: [stationRow(0, null)] }))).toBe(false); // 这座站没有已送达的订单
    expect(recordTwin(watch, peakStub(1, 'noon', { stations: [stationRow(3, 0.9)] }))).toBe(false); // 副本里没有这座站的一行
    expect(watch.twins).toEqual([]);
    expect(recordTwin(watch, peakStub(2, 'noon', { stations: [stationRow(0, 0.9)] }))).toBe(true);
    expect(recordTwin(watch, peakStub(2, 'noon', { stations: [stationRow(0, 0.1)] }))).toBe(false);
    expect(watch.twins).toEqual([{ day: 2, peak: 'noon', value: 0.9 }]);
  });

  it('购买时还没有小结记录的跟踪写不出行，什么也不记', () => {
    const state = shopState();
    must(state, { type: 'buyDoubleBox' });
    const watch = campaignOf(state).effectWatches[0]!;
    expect(recordTwin(watch, peakStub(1, 'noon', { onTime: 6, stations: [stationRow(0, 1, 3)] }))).toBe(false);
    expect(watch.twins).toEqual([]);
  });

  it('只写这条跟踪的 twins：状态里别的东西不变；状态的哈希里有副本记下的数', () => {
    const { state, watch } = boughtGate();
    const before = structuredClone(state);
    const hash = hashState(state);
    recordTwin(watch, peakStub(1, 'noon', { stations: [stationRow(0, 0.7)] }));
    expect(hashState(state)).not.toBe(hash);
    watch.twins = [];
    expect(JSON.stringify(state)).toBe(JSON.stringify(before));
    expect(hashState(state)).toBe(hash);
  });
});

describe('日结里写效果：购买之后的 3 次日结，每次一行，写现在的数和不购买时的数', () => {
  it('起降口升级，购买在午高峰小结之后：当天的日结里最近的午高峰还是购买前那一场，不写，也不占行数；之后三天各写一行，写满三行后跟踪删掉，第五次日结不写', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    addPeak(state, 0, 'evening', { stations: [stationRow(0, 2.2)] }, { stations: [stationRow(0, 2.9)] }); // 晚高峰的记录不是同类，不能当作现在的数值
    settle(state, 0);
    expect(campaign.days[0]!.effects).toEqual([]); // 最近的午高峰记录就是购买前的那一场，那一场的数在购买之前
    expect(campaign.effectWatches).toHaveLength(1);
    expect(campaign.effectWatches[0]!.left).toBe(3); // 没写出行，不减

    addPeak(state, 1, 'noon', { stations: [stationRow(0, 0.5)] }, { stations: [stationRow(0, 1.3)] });
    addPeak(state, 1, 'evening', { stations: [stationRow(0, 9)] }, { stations: [stationRow(0, 9)] });
    settle(state, 1);
    expect(campaign.days[1]!.effects).toEqual([{ kind: 'gate', station: 0, level: 2, peak: 'noon', beforeDay: 0, afterDay: 1, before: 1.4, after: 0.5, twin: 1.3 }]);
    expect(campaign.effectWatches[0]!.left).toBe(2);

    addPeak(state, 2, 'noon', { stations: [stationRow(0, 0.4)] }, { stations: [stationRow(0, 1.2)] });
    addPeak(state, 2, 'evening', { stations: [stationRow(0, 9)] }, { stations: [stationRow(0, 9)] });
    settle(state, 2);
    expect(campaign.days[2]!.effects).toEqual([{ kind: 'gate', station: 0, level: 2, peak: 'noon', beforeDay: 0, afterDay: 2, before: 1.4, after: 0.4, twin: 1.2 }]);
    expect(campaign.effectWatches[0]!.left).toBe(1);

    addPeak(state, 3, 'noon', { stations: [stationRow(0, 0.3)] }, { stations: [stationRow(0, 1.1)] });
    addPeak(state, 3, 'evening', { stations: [stationRow(0, 9)] }, { stations: [stationRow(0, 9)] });
    settle(state, 3);
    expect(campaign.days[3]!.effects).toEqual([{ kind: 'gate', station: 0, level: 2, peak: 'noon', beforeDay: 0, afterDay: 3, before: 1.4, after: 0.3, twin: 1.1 }]);
    expect(campaign.effectWatches).toEqual([]); // 写满三行，删掉

    addPeak(state, 4, 'noon', { stations: [stationRow(0, 0.2)] }, { stations: [stationRow(0, 1.0)] });
    addPeak(state, 4, 'evening', { stations: [stationRow(0, 9)] }, { stations: [stationRow(0, 9)] });
    settle(state, 4);
    expect(campaign.days.map((d) => d.effects.length)).toEqual([0, 1, 1, 1, 0]);
  });

  it('购买在晚高峰小结之后、当天日结之前：晚高峰的数是购买前的，当天的日结不写，也不占行数；之后三天各写一行，共三行', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', backOf(50)), peakStub(0, 'evening', backOf(40)));
    state.step = 3500;
    must(state, { type: 'buildStation', roof: OLD_SMALL });
    must(state, { type: 'buyNearestLanding' });
    settle(state, 0);
    expect(campaign.days[0]!.effects).toEqual([]); // 最近的晚高峰记录就是购买前的那一场
    for (const day of [1, 2, 3]) {
      addPeak(state, day, 'noon', backOf(50), backOf(50));
      addPeak(state, day, 'evening', backOf(40 - 5 * day), backOf(41)); // 不购买时回站飞行占 41%，买了之后一天比一天少
      settle(state, day);
    }
    expect(campaign.days.map((d) => d.effects)).toEqual([
      [],
      [{ kind: 'nearest', station: null, level: null, peak: 'evening', beforeDay: 0, afterDay: 1, before: 40, after: 35, twin: 41 }],
      [{ kind: 'nearest', station: null, level: null, peak: 'evening', beforeDay: 0, afterDay: 2, before: 40, after: 30, twin: 41 }],
      [{ kind: 'nearest', station: null, level: null, peak: 'evening', beforeDay: 0, afterDay: 3, before: 40, after: 25, twin: 41 }],
    ]);
    expect(campaign.effectWatches).toEqual([]); // 写满三行，删掉
  });

  it('购买在一天的开头，最近一场是前一天的晚高峰：购买那天的日结就有当天的晚高峰，三次日结各一行，共三行', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { onTime: 4, stations: [stationRow(0, null, 4)] }), peakStub(0, 'evening', { onTime: 6, stations: [stationRow(0, null, 4)] }));
    settle(state, 0);
    state.step = DAY_STEPS + 100; // 第 1 天的开头
    must(state, { type: 'buyDoubleBox' });
    expect(campaign.effectWatches[0]).toMatchObject({ kind: 'doubleBox', peak: 'evening', beforeDay: 0, before: 1.5 });
    const after = [3, 4, 5]; // 之后三个晚高峰每趟的单数：每次 4 架次，已送达 12、16、20
    for (const [i, day] of [1, 2, 3].entries()) {
      addPeak(state, day, 'noon', {}, {});
      addPeak(state, day, 'evening', { onTime: 4 * (after[i] as number), stations: [stationRow(0, null, 4)] }, { onTime: 4 * 2, stations: [stationRow(0, null, 4)] }); // 不购买时每趟 2 单
      settle(state, day);
    }
    expect(campaign.days.slice(1).map((d) => d.effects.map((l) => [l.kind, l.afterDay, l.before, l.after, l.twin]))).toEqual([
      [['doubleBox', 1, 1.5, 3, 2]],
      [['doubleBox', 2, 1.5, 4, 2]],
      [['doubleBox', 3, 1.5, 5, 2]],
    ]);
    expect(campaign.effectWatches).toEqual([]);
  });

  it('购买时没有小结记录：购买前的数值是 null，三次日结都不写，副本的数也不记，跟踪照样在三次日结之后删掉', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    must(state, { type: 'upgradeGate', station: 0 });
    for (const day of [0, 1, 2]) {
      addPeak(state, day, 'noon', { stations: [stationRow(0, 0.5, 4)] }, { stations: [stationRow(0, 1.5, 4)] });
      addPeak(state, day, 'evening', { stations: [stationRow(0, 0.5, 4)] }, { stations: [stationRow(0, 1.5, 4)] });
      settle(state, day);
      expect(campaign.days[day]!.effects).toEqual([]);
    }
    expect(campaign.effectWatches).toEqual([]);
  });

  it('购买前那一场记录里没有这项数据：三次日结都不写，哪怕之后的记录里有数；跟踪照样删掉', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, null)] })); // 0 号站这一场没有已送达的订单
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    for (const day of [0, 1, 2, 3]) {
      if (day > 0) {
        addPeak(state, day, 'noon', { stations: [stationRow(0, 0.6)] }, { stations: [stationRow(0, 1.6)] });
        addPeak(state, day, 'evening', { stations: [stationRow(0, 0.6)] }, { stations: [stationRow(0, 1.6)] });
      }
      settle(state, day);
    }
    expect(campaign.days.map((d) => d.effects.length)).toEqual([0, 0, 0, 0]);
    expect(campaign.effectWatches).toEqual([]);
  });

  it('现在的数值是 null 的那一天不写，也不占行数，数值回来之后照写；购买之后第五次日结还没写满的跟踪也删掉', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    addPeak(state, 0, 'evening', {}, {});
    settle(state, 0); // 没有新的午高峰
    addPeak(state, 1, 'noon', { stations: [stationRow(0, null)] }, { stations: [stationRow(0, 1.1)] }); // 第 1 天这座站没有已送达的订单
    settle(state, 1);
    expect(campaign.days[1]!.effects).toEqual([]);
    expect(campaign.effectWatches[0]!.left).toBe(3);
    addPeak(state, 2, 'noon', { stations: [stationRow(0, 0.7)] }, { stations: [stationRow(0, 1.2)] });
    settle(state, 2);
    expect(campaign.days[2]!.effects).toEqual([{ kind: 'gate', station: 0, level: 2, peak: 'noon', beforeDay: 0, afterDay: 2, before: 1.4, after: 0.7, twin: 1.2 }]);
    expect(campaign.effectWatches[0]!.left).toBe(2);
    addPeak(state, 3, 'noon', { stations: [stationRow(0, null)] }, { stations: [stationRow(0, 1.0)] });
    settle(state, 3);
    expect(campaign.effectWatches[0]!.left).toBe(2); // 第 3 天又没有数，仍不占行数
    addPeak(state, 4, 'noon', { stations: [stationRow(0, 0.6)] }, { stations: [stationRow(0, 1.1)] });
    settle(state, 4); // 购买之后第五次日结：写一行，之后不论写没写满都删掉
    expect(campaign.days[4]!.effects).toHaveLength(1);
    expect(campaign.effectWatches).toEqual([]);
    expect(campaign.days.map((d) => d.effects.length)).toEqual([0, 0, 1, 0, 1]);
  });

  it('副本这一场没有数（读档之后副本已经不在，或者副本作废）：这一天不写这一行，也不占行数，不拿别的一场的数凑；副本的数回来之后照写', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    addPeak(state, 0, 'evening', {}, {});
    settle(state, 0);
    addPeak(state, 1, 'noon', { stations: [stationRow(0, 0.5)] }); // 副本不在：主状态有数，副本这一场没有
    settle(state, 1);
    expect(campaign.days[1]!.effects).toEqual([]);
    expect(campaign.effectWatches[0]!.left).toBe(3); // 不占行数
    addPeak(state, 2, 'noon', { stations: [stationRow(0, 0.5)] }, { stations: [stationRow(0, 1.3)] });
    settle(state, 2);
    expect(campaign.days[2]!.effects).toHaveLength(1);
    // 第 3 天副本没有数：副本记下的第 2 天午高峰的数，不能当作第 3 天午高峰的不购买时的数
    campaign.peaks.push(peakStub(3, 'noon', { stations: [stationRow(0, 0.5)] }));
    settle(state, 3);
    expect(campaign.days[3]!.effects).toEqual([]);
    expect(campaign.effectWatches[0]!.left).toBe(2);
    addPeak(state, 4, 'noon', { stations: [stationRow(0, 0.4)] }, { stations: [stationRow(0, 1.2)] });
    settle(state, 4);
    expect(campaign.days[4]!.effects).toEqual([{ kind: 'gate', station: 0, level: 2, peak: 'noon', beforeDay: 0, afterDay: 4, before: 1.4, after: 0.4, twin: 1.2 }]);
  });

  it('副本一直没有数：购买之后第五次日结，跟踪照样删掉，一行也没有写', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    for (const day of [0, 1, 2, 3, 4]) {
      if (day > 0) addPeak(state, day, 'noon', { stations: [stationRow(0, 0.5)] });
      settle(state, day);
    }
    expect(campaign.effectWatches).toEqual([]);
    expect(campaign.days.every((d) => d.effects.length === 0)).toBe(true);
  });

  it('现在的记录里没有这座站（已经退回）：不写', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.4), stationRow(1, 2.0)] }));
    state.step = 2000;
    campaign.effectWatches.push({ kind: 'gate', step: 2000, station: 1, level: 2, peak: 'noon', beforeDay: 0, before: 2.0, left: 3, twins: [] });
    settle(state, 0);
    addPeak(state, 1, 'noon', { stations: [stationRow(0, 1.1)] }, { stations: [stationRow(0, 1.5), stationRow(1, 2.5)] }); // 1 号站退回之后不在主状态的记录里
    settle(state, 1);
    expect(campaign.days[1]!.effects).toEqual([]);
  });

  it('日结按购买的先后写，每笔购买各写各的，互不影响，三种改装各用各的指标', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    const noon0 = peakStub(0, 'noon', { onTime: 8, stations: [stationRow(0, 1.2, 8)], ...backOf(36) });
    campaign.peaks.push(noon0);
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    must(state, { type: 'buyDoubleBox' });
    must(state, { type: 'buildStation', roof: OLD_SMALL });
    must(state, { type: 'buyNearestLanding' });
    settle(state, 0);
    addPeak(state, 1, 'noon', { onTime: 12, stations: [stationRow(0, 0.6, 8)], ...backOf(28) }, { onTime: 8, stations: [stationRow(0, 1.0, 8)], ...backOf(36) });
    settle(state, 1);
    expect(campaign.days[1]!.effects.map((l) => [l.kind, l.before, l.after, l.twin])).toEqual([
      ['gate', 1.2, 0.6, 1.0],
      ['doubleBox', 1, 1.5, 1],
      ['nearest', 36, 28, 36],
    ]);
    // 三条跟踪各写各的：购买前取的都是同一场午高峰
    expect(campaign.days[1]!.effects.every((l) => l.peak === 'noon' && l.beforeDay === 0 && l.afterDay === 1)).toBe(true);
  });

  it('购买前、现在和不购买时的数值都是原始的数，核心不取整：每趟 13 除以 9 单，起降排队 1.4285714285714286 秒', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { onTime: 13, stations: [stationRow(0, 10 / 7, 9)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    must(state, { type: 'buyDoubleBox' });
    settle(state, 0);
    addPeak(state, 1, 'noon', { onTime: 20, stations: [stationRow(0, 8 / 7, 12)] }, { onTime: 14, stations: [stationRow(0, 11 / 7, 12)] });
    settle(state, 1);
    const [gate, box] = campaign.days[1]!.effects;
    expect([gate!.before, gate!.after, gate!.twin]).toEqual([10 / 7, 8 / 7, 11 / 7]);
    expect([box!.before, box!.after, box!.twin]).toEqual([13 / 9, 20 / 12, 14 / 12]);
  });

  it('日结里的效果行只有这几项：种类、站、等级、哪一场高峰、前后两个数取自哪一天、购买前的数、现在的数、不购买时的数；站和等级只有起降口升级有，其余是 null', () => {
    const state = shopState();
    const campaign = campaignOf(state);
    campaign.peaks.push(peakStub(0, 'noon', { onTime: 4, stations: [stationRow(0, 1, 4)] }));
    state.step = 2000;
    must(state, { type: 'upgradeGate', station: 0 });
    must(state, { type: 'buyDoubleBox' });
    settle(state, 0);
    addPeak(state, 1, 'noon', { onTime: 6, stations: [stationRow(0, 0.5, 4)] }, { onTime: 4, stations: [stationRow(0, 0.9, 4)] });
    settle(state, 1);
    const [gate, box] = campaign.days[1]!.effects;
    expect(Object.keys(gate!).sort()).toEqual(['after', 'afterDay', 'before', 'beforeDay', 'kind', 'level', 'peak', 'station', 'twin']);
    expect(gate).toMatchObject({ station: 0, level: 2 });
    expect(box).toMatchObject({ station: null, level: null });
    expect(JSON.parse(JSON.stringify(campaign.days[1]!.effects))).toEqual(campaign.days[1]!.effects); // 可以直接序列化
  });
});

describe('真实的运行：经过会话层的副本，效果行取自真实的小结记录，只读，不影响决定', () => {
  /** 一条效果行用到的小结记录，各自重算出的指标必须就是行里的数。不购买时的数由 app-twins.test.ts 与独立的不购买模拟对照。 */
  function checkLines(state: SimState): number {
    const campaign = campaignOf(state);
    let lines = 0;
    for (const day of campaign.days) {
      for (const line of day.effects) {
        lines += 1;
        const before = campaign.peaks.find((p) => p.day === line.beforeDay && p.peak === line.peak);
        const after = campaign.peaks.find((p) => p.day === line.afterDay && p.peak === line.peak);
        expect(before, `day ${day.day}`).toBeDefined();
        expect(after, `day ${day.day}`).toBeDefined();
        expect(effectValue(line.kind, line.station, before as PeakRecord), `before ${JSON.stringify(line)}`).toBe(line.before);
        expect(effectValue(line.kind, line.station, after as PeakRecord), `after ${JSON.stringify(line)}`).toBe(line.after);
        if (line.kind === 'nearest') {
          // 就近降落的数是小结记录里的回站飞行占比，是整数，不大于同一场的空载飞行
          const [b, a] = [before as PeakRecord, after as PeakRecord];
          expect([line.before, line.after], `nearest ${JSON.stringify(line)}`).toEqual([b.fleetBack, a.fleetBack]);
          expect(Number.isInteger(line.before) && Number.isInteger(line.after) && Number.isInteger(line.twin)).toBe(true);
          expect(line.before).toBeLessThanOrEqual((b.fleet as PeakFleet).empty);
          expect(line.after).toBeLessThanOrEqual((a.fleet as PeakFleet).empty);
        }
        expect(line.afterDay).toBeGreaterThan(line.beforeDay);
        expect(line.afterDay).toBeLessThanOrEqual(day.day); // 现在的数值最迟取自这次日结的当天
        expect(Number.isFinite(line.before) && Number.isFinite(line.after) && Number.isFinite(line.twin)).toBe(true);
        if (line.kind === 'gate') expect([line.station !== null, line.level === 2 || line.level === 3]).toEqual([true, true]);
        else expect([line.station, line.level]).toEqual([null, null]);
      }
    }
    return lines;
  }

  it('三种改装在不同的时刻购买，四个订单种子各跑六个游戏日：写出的每一行，购买前和现在的数都与小结记录里重算的相同，后一场晚于前一场，站和等级只有起降口升级有', () => {
    let total = 0;
    const kinds = new Set<string>();
    for (const seed of [3, 7, 11, 17]) {
      const state = unlockAll(runningState(seed));
      campaignOf(state).money = 20_000;
      const play = createPlay(state);
      const schedule = new Map<number, Command>([
        [2000, { type: 'upgradeGate', station: 0 }], // 第 0 天午高峰的小结之后
        [3700, { type: 'buildStation', roof: OLD_SMALL }], // 第 1 天的开头建第二座站，就近降落要有两座站
        [4000, { type: 'buyDoubleBox' }],
        [6000, { type: 'buyNearestLanding' }], // 第 1 天午高峰的小结之后
        [10_000, { type: 'upgradeGate', station: 1 }], // 第 2 天午高峰的小结之后
      ]);
      for (let i = 0; i < 6 * DAY_STEPS; i++) {
        const command = schedule.get(i);
        if (command !== undefined) expect(play.command(command).ok, `${seed} ${JSON.stringify(command)}`).toBe(true);
        play.step();
      }
      total += checkLines(state);
      for (const day of campaignOf(state).days) for (const line of day.effects) kinds.add(line.kind);
    }
    expect(total).toBeGreaterThan(15);
    expect([...kinds].sort()).toEqual(['doubleBox', 'gate', 'nearest']); // 三种改装都写出过
  });

  it('午高峰小结之后买双层货箱，连跑四天：购买当天的日结不写，第 1 到 3 天的日结各写一行，写满三行后跟踪删掉', () => {
    const state = unlockAll(runningState(5));
    const campaign = campaignOf(state);
    campaign.money = 5000;
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step(); // 第 0 天午高峰的小结（第 1800 步）之后
    expect(campaign.peaks).toHaveLength(1);
    expect(play.command({ type: 'buyDoubleBox' }).ok).toBe(true);
    const watch = campaign.effectWatches[0]!;
    expect(watch).toMatchObject({ kind: 'doubleBox', step: 2000, peak: 'noon', beforeDay: 0, left: 3 });
    expect(watch.before).toBe(effectValue('doubleBox', null, campaign.peaks[0] as PeakRecord));
    while (state.step <= 4 * DAY_STEPS) play.step(); // 跑到第 4 天的第 1 步，第 0 到 3 天的日结都做过
    expect(campaign.days).toHaveLength(4);
    const lines = campaign.days.map((d) => d.effects.length);
    // 第 0 天的日结没有新的午高峰：不写。第 1 到 3 天的日结，只要这一天的午高峰有每趟单数（有架次），副本这一场也有，就写
    expect(lines[0]).toBe(0);
    let written = 0;
    for (const day of [1, 2, 3]) {
      const now = campaign.peaks.find((p) => p.day === day && p.peak === 'noon') as PeakRecord;
      const expected = watch.before !== null && effectValue('doubleBox', null, now) !== null && watch.twins.some((t) => t.day === day && t.peak === 'noon') ? 1 : 0;
      expect(lines[day], `第 ${day} 天`).toBe(expected);
      written += expected;
    }
    expect(written).toBeGreaterThan(0);
    // 写满三行就删掉。某一天没有数时不占行数，跟踪留到写满，或者购买之后过了五次日结
    expect(campaign.effectWatches).toHaveLength(written === 3 ? 0 : 1);
    expect(checkLines(state)).toBe(written);
  });

  it('只读，不影响任何决定：每次购买之后把效果跟踪清掉（副本也跟着丢掉），其余的状态与不清掉的一局每一步相同', () => {
    const make = (): SimState => {
      const s = unlockAll(runningState(9));
      campaignOf(s).money = 8000;
      return s;
    };
    const kept = make();
    const cleared = make();
    const keptPlay = createPlay(kept);
    const clearedPlay = createPlay(cleared);
    // 起降口升级和双层货箱都在第一场小结之后买，这时购买前的数值才有
    const shopping = new Map<number, Command>([
      [0, { type: 'buyBay', station: 0 }],
      [300, { type: 'buyDrone', station: 0 }],
      [600, { type: 'buyBay', station: 0 }],
      [900, { type: 'buyDrone', station: 0 }],
      [2000, { type: 'upgradeGate', station: 0 }],
      [2500, { type: 'buyDoubleBox' }],
      [6000, { type: 'upgradeGate', station: 0 }],
    ]);
    for (let i = 0; i < 4 * DAY_STEPS; i++) {
      const command = shopping.get(i);
      if (command !== undefined) {
        expect(keptPlay.command(command)).toEqual(clearedPlay.command(command));
        campaignOf(cleared).effectWatches = [];
      }
      keptPlay.step();
      clearedPlay.step();
      if (i % 300 === 1) {
        const copy = structuredClone(kept);
        const c = campaignOf(copy);
        c.effectWatches = [];
        for (const d of c.days) d.effects = [];
        expect(hashState(copy), `第 ${i} 步`).toBe(hashState(cleared));
      }
    }
    expect(campaignOf(kept).days.some((d) => d.effects.length > 0)).toBe(true);
    expect(campaignOf(cleared).days.every((d) => d.effects.length === 0)).toBe(true);
    expect(clearedPlay.twinWatches()).toEqual([]); // 跟踪清掉之后副本不留
  });

  it('不经过会话层的运行（核心的 step 和 applyCommand）没有副本：购买照样记跟踪，但一行效果也写不出来', () => {
    const state = unlockAll(runningState(5));
    const campaign = campaignOf(state);
    campaign.money = 5000;
    for (let i = 0; i < 2000; i++) step(state);
    expect(applyCommand(state, { type: 'buyDoubleBox' }).ok).toBe(true);
    expect(campaign.effectWatches).toHaveLength(1);
    while (state.step <= 5 * DAY_STEPS) step(state);
    expect(campaign.effectWatches).toEqual([]); // 过了五次日结，删掉
    expect(campaign.days.every((d) => d.effects.length === 0)).toBe(true);
  });
});

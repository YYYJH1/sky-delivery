// 解锁：每一条解锁都测开放之前命令失败、状态不变，开放之后可用，以及开放的时机和边界。
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { UNLOCKS_V1 } from '../src/content/unlocks_v1.ts';
import {
  DAY_STEPS,
  UNLOCK_KEYS,
  advance,
  anyStationAtCap,
  createState,
  isUnlocked,
  quoteCommand,
  recordPeakSummary,
  refreshShops,
  ruleLock,
  ruleOpen,
  settleDay,
  step,
} from '../src/core/index.ts';
import type { Command, SimState, UnlockKey } from '../src/core/index.ts';
import { batchOrders, campaignOf, expectRejected, must, outcomeOrder, quietState, roofWhere, withMoney } from './campaign-helpers.ts';
import { OPENING } from './helpers.ts';

const OLD_SMALL = roofWhere((r) => r.district === 0 && r.size === 'small');
const NOON = 1800; // 午高峰的小结时刻（天内）
const EVENING = 3400; // 晚高峰的小结时刻

/** 开局的锁定状态，余额很多：价签、调度台的栏和卡、片区的显示都没开放。 */
function lockedState(): SimState {
  return withMoney(quietState({}, false));
}

function stepOf(state: SimState, key: UnlockKey): number {
  return campaignOf(state).unlocks[key];
}

/** 做第 day 天的日结。 */
function settle(state: SimState, day: number): void {
  state.step = (day + 1) * DAY_STEPS;
  settleDay(state, day);
}

/**
 * 在第 0 天某场高峰的下单时段里放一批订单，再把步数设到小结时刻，生成这一场的记录。
 * onTime 张用时 290 步，late 张用时 400 步，unresolved 张没有结果，cancelled 张在小结之前退单。
 * waiting 是下单到派单的步数（等飞机）：缺省为 10，造「订单主要在等飞机」的情形时给 240，这时等飞机最长。
 */
interface PeakOrders {
  onTime?: number;
  late?: number;
  unresolved?: number;
  cancelled?: number;
  waiting?: number;
}

function peakSummaryWith(state: SimState, peak: 'noon' | 'evening', orders: PeakOrders): void {
  let t = peak === 'noon' ? 700 : 2200;
  const waiting = orders.waiting ?? 10;
  for (let i = 0; i < (orders.onTime ?? 0); i++, t++) outcomeOrder(state, { district: 0, tOrder: t, delivered: t + 290, assignDelay: waiting });
  for (let i = 0; i < (orders.late ?? 0); i++, t++) outcomeOrder(state, { district: 0, tOrder: t, delivered: t + 400, assignDelay: waiting });
  for (let i = 0; i < (orders.unresolved ?? 0); i++, t++) outcomeOrder(state, { district: 0, tOrder: t });
  for (let i = 0; i < (orders.cancelled ?? 0); i++, t++) outcomeOrder(state, { district: 0, tOrder: t, cancelled: t + 900 });
  state.step = peak === 'noon' ? NOON : EVENING;
  recordPeakSummary(state, 0, peak);
}

const noonSummary = (state: SimState, orders: PeakOrders): void => peakSummaryWith(state, 'noon', orders);

describe('价签：第一次日结之后余额达到 140（停机位的价格）时开放', () => {
  const PURCHASES: Command[] = [
    { type: 'buildStation', roof: OLD_SMALL },
    { type: 'buyDrone', station: 0 },
    { type: 'buyBay', station: 0 },
    { type: 'upgradeGate', station: 0 },
    { type: 'buyDoubleBox' },
    { type: 'buyNearestLanding' },
  ];

  it('开局锁着：建站、添飞机、加停机位、起降口升级、双层货箱、就近降落都失败，原因是 priceTagsLocked，状态一点不变', () => {
    const state = lockedState();
    expect(isUnlocked(state, 'priceTags')).toBe(false);
    for (const command of PURCHASES) expectRejected(state, command, 'priceTagsLocked');
    expect(campaignOf(state).money).toBe(1_000_000);
  });

  it('只读的价签也给出同样的原因，并且仍给出价格，供界面决定怎么显示', () => {
    const state = lockedState();
    expect(quoteCommand(state, { type: 'buyBay', station: 0 })).toEqual({ ok: false, reason: 'priceTagsLocked', kind: 'buy', price: 140 });
    expect(quoteCommand(state, { type: 'buyDrone', station: 0 })).toEqual({ ok: false, reason: 'priceTagsLocked', kind: 'buy', price: 100 });
    expect(quoteCommand(state, { type: 'buyDoubleBox' })).toEqual({ ok: false, reason: 'priceTagsLocked', kind: 'buy', price: ECONOMY_V1.doubleBoxPrice });
  });

  it('不是价签的命令照常可用：换规矩卡和点击订单不受价签影响', () => {
    const state = lockedState();
    const order = outcomeOrder(state, { district: 0, tOrder: 0 });
    expect(must(state, { type: 'prioritizeOrder', order: order.id })).toBe(order.id);
  });

  it('第一次日结之前，余额再多也不开放', () => {
    const state = lockedState();
    advance(state, DAY_STEPS);
    expect(state.step).toBe(DAY_STEPS);
    expect(campaignOf(state).days.length).toBe(0);
    expect(isUnlocked(state, 'priceTags')).toBe(false);
  });

  it('日结时余额达到 140：当场开放，记下日结的那一步，同时放出便签', () => {
    const state = quietState({}, false);
    advance(state, DAY_STEPS);
    campaignOf(state).money = 140;
    step(state); // 第 3600 步：日结
    expect(campaignOf(state).days.length).toBe(1);
    expect(stepOf(state, 'priceTags')).toBe(DAY_STEPS);
    expect(campaignOf(state).tips.filter((t) => t.id === 'canAddBay').map((t) => t.step)).toEqual([DAY_STEPS]);
  });

  it('日结时余额不到 140：不开放，之后余额达到 140 的那一步开放，不必等下一次日结', () => {
    const state = quietState({}, false);
    advance(state, DAY_STEPS);
    campaignOf(state).money = 139.99;
    step(state); // 第 3600 步：日结，余额差 0.01
    expect(campaignOf(state).days.length).toBe(1);
    expect(isUnlocked(state, 'priceTags')).toBe(false);
    expect(campaignOf(state).tips.some((t) => t.id === 'canAddBay')).toBe(false);
    advance(state, 50);
    expect(isUnlocked(state, 'priceTags')).toBe(false);
    campaignOf(state).money = 140;
    step(state);
    expect(isUnlocked(state, 'priceTags')).toBe(true);
    expect(stepOf(state, 'priceTags')).toBe(DAY_STEPS + 51);
    expect(campaignOf(state).tips.filter((t) => t.id === 'canAddBay').length).toBe(1);
  });

  it('开放之后命令可用，余额再掉到 140 以下也不会再锁上', () => {
    const state = quietState({}, false);
    advance(state, DAY_STEPS);
    campaignOf(state).money = 500;
    step(state);
    expect(isUnlocked(state, 'priceTags')).toBe(true);
    must(state, { type: 'buyBay', station: 0 });
    campaignOf(state).money = 3;
    expect(isUnlocked(state, 'priceTags')).toBe(true);
    expectRejected(state, { type: 'buyBay', station: 0 }, 'notEnoughMoney'); // 没钱，但不是价签的原因
    campaignOf(state).money = 1000;
    must(state, { type: 'buyDrone', station: 0 });
  });
});

describe('「先送哪张单」一栏：高峰小结里超时的订单超过来单的一定比例，最晚在第二天的日结时开放', () => {
  it('内容表里的门槛是一成半（初值是三成）：老街来单降到 11 以后第一场午高峰超时超过三成的种子少了', () => {
    expect(UNLOCKS_V1.selectLateAbove).toBe(15);
    expect(UNLOCKS_V1.selectLatestDay).toBe(1);
  });

  it('开局锁着：整栏都锁着，包括「先下单的先送」，原因是 ruleLocked，状态不变', () => {
    const state = lockedState();
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline' } }, 'ruleLocked');
    expectRejected(state, { type: 'setRules', rules: { select: 'fifo' } }, 'ruleLocked');
    expect(ruleLock(state, 'select', 'deadline')).toBe('selectColumn');
    expect(ruleOpen(state, 'select', 'fifo')).toBe(false);
  });

  // 一场 100 张订单，每张占 1%，所以超时的张数就是百分数。P 是内容表里的门槛，「超过」不含 P
  const P = UNLOCKS_V1.selectLateAbove;
  it.each([
    ['超时比门槛多一张：开放', { onTime: 99 - P, late: P + 1 }, true],
    ['超时恰好是门槛：不开放，「超过」不含门槛', { onTime: 100 - P, late: P }, false],
    ['超时送达加上还没送到的，比门槛多一张：开放，没送到的也算超时', { onTime: 99 - P, late: P - 1, unresolved: 2 }, true],
    ['超时送达加上还没送到的，恰好是门槛：不开放', { onTime: 100 - P, late: P - 1, unresolved: 1 }, false],
    ['超时恰好是门槛，再加一张退单：退单不计入超时，不开放', { onTime: 99 - P, late: P, cancelled: 1 }, false],
    ['全部准时：不开放', { onTime: 100 }, false],
    ['没有订单：不开放', {}, false],
    ['只有一张订单还没送到：超时占十成，开放', { unresolved: 1 }, true],
  ] as const)('某场高峰的小结：%s', (_name, orders, opens) => {
    const state = quietState({}, false);
    noonSummary(state, orders);
    expect(isUnlocked(state, 'selectColumn')).toBe(opens);
    if (opens) expect(stepOf(state, 'selectColumn')).toBe(NOON);
  });

  it('开放时同时开放「快超时的先送」，放出「调度台可以用了」的便签，只出现一次', () => {
    const state = quietState({}, false);
    noonSummary(state, { onTime: 5, late: 5 });
    expect(ruleOpen(state, 'select', 'fifo')).toBe(true);
    expect(ruleOpen(state, 'select', 'deadline')).toBe(true);
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    expect(state.rules.select).toBe('deadline');
    expect(campaignOf(state).tips.filter((t) => t.id === 'boardReady').map((t) => t.step)).toEqual([NOON]);
    // 之后每一场小结条件仍满足，也不会重复放便签，开放的步不变
    state.step = 3400;
    recordPeakSummary(state, 0, 'evening');
    expect(campaignOf(state).tips.filter((t) => t.id === 'boardReady').length).toBe(1);
    expect(stepOf(state, 'selectColumn')).toBe(NOON);
  });

  it('开放之后「来回快的先送」和三张「某一片的先送」仍然锁着，各有自己的条件', () => {
    const state = quietState({}, false);
    noonSummary(state, { onTime: 5, late: 5 });
    for (const id of ['roundtrip', 'prioOld', 'prioOffice', 'prioCampus']) {
      expectRejected(state, { type: 'setRules', rules: { select: id } }, 'ruleLocked');
    }
    expect(ruleLock(state, 'select', 'roundtrip')).toBe('roundtrip');
    expect(ruleLock(state, 'select', 'prioOffice')).toBe('prioDistrict');
  });

  it('最晚在第二天的日结时开放：第一天的日结（第 0 天）不开放，第二天的日结（第 1 天）开放', () => {
    const state = quietState({}, false);
    settle(state, 0);
    expect(isUnlocked(state, 'selectColumn')).toBe(false);
    settle(state, 1);
    expect(isUnlocked(state, 'selectColumn')).toBe(true);
    expect(stepOf(state, 'selectColumn')).toBe(2 * DAY_STEPS);
    expect(campaignOf(state).tips.filter((t) => t.id === 'boardReady').map((t) => t.step)).toEqual([2 * DAY_STEPS]);
  });

  it('日结推进的是真实的一步：第 7200 步开始时开放', () => {
    const state = quietState({}, false);
    advance(state, 2 * DAY_STEPS);
    expect(isUnlocked(state, 'selectColumn')).toBe(false);
    step(state);
    expect(stepOf(state, 'selectColumn')).toBe(2 * DAY_STEPS);
  });
});

describe('双层货箱：停机位到屋顶上限之后，某场高峰小结的主句是「订单主要在等飞机」时开放', () => {
  /** 开局的站在中屋顶上，上限 9 个停机位。价签开放，双层货箱没开放。 */
  function boxState(bays: number): SimState {
    const state = withMoney(quietState());
    campaignOf(state).unlocks.doubleBox = -1;
    while ((state.stations[0] as { bays: number }).bays < bays) must(state, { type: 'buyBay', station: 0 });
    return state;
  }

  /** 等飞机最长的一场：10 张订单都等了 24 秒才派出，6 张准时，4 张超时，准时率 60%。 */
  const WAITING = { onTime: 6, late: 4, waiting: 240 };

  it('锁着：双层货箱 doubleBoxLocked，价签没开放时先报价签的原因，余额够也一样', () => {
    const state = boxState(2);
    expectRejected(state, { type: 'buyDoubleBox' }, 'doubleBoxLocked');
    const locked = lockedState();
    expectRejected(locked, { type: 'buyDoubleBox' }, 'priceTagsLocked');
  });

  it('停机位到了屋顶上限，并且小结的主句是等飞机：开放，记下小结的那一步', () => {
    const state = boxState(9);
    expect(anyStationAtCap(state)).toBe(true);
    noonSummary(state, WAITING);
    expect(campaignOf(state).peaks[0]?.main.id).toBe('waitDrone');
    expect(stepOf(state, 'doubleBox')).toBe(NOON);
    must(state, { type: 'buyDoubleBox' });
    expect(state.capacity).toBe(2);
  });

  it('停机位还没到上限：主句是等飞机也不开放，差一个也不行', () => {
    const state = boxState(8);
    expect(anyStationAtCap(state)).toBe(false);
    noonSummary(state, WAITING);
    expect(campaignOf(state).peaks[0]?.main.id).toBe('waitDrone');
    expect(isUnlocked(state, 'doubleBox')).toBe(false);
    expectRejected(state, { type: 'buyDoubleBox' }, 'doubleBoxLocked');
  });

  it('到了上限，但小结的主句不是等飞机：不开放', () => {
    const state = boxState(9);
    noonSummary(state, { onTime: 10 }); // 准时率 100%，主句写准时率
    expect(campaignOf(state).peaks[0]?.main.id).toBe('onTimeHigh');
    expect(isUnlocked(state, 'doubleBox')).toBe(false);
    const road = boxState(9);
    noonSummary(road, { onTime: 6, late: 4 }); // 等飞机只有 1 秒，路上最长
    expect(campaignOf(road).peaks[0]?.main.id).toBe('road');
    expect(isUnlocked(road, 'doubleBox')).toBe(false);
  });

  it('先到上限，之后的某一场小结才开放：到上限之前的小结不算', () => {
    const state = boxState(8);
    noonSummary(state, WAITING);
    expect(isUnlocked(state, 'doubleBox')).toBe(false);
    must(state, { type: 'buyBay', station: 0 }); // 第 9 个，到了上限
    peakSummaryWith(state, 'evening', WAITING);
    expect(campaignOf(state).peaks[1]?.main.id).toBe('waitDrone');
    expect(stepOf(state, 'doubleBox')).toBe(EVENING);
  });

  it('开放之后不再锁上：停机位退回到上限以下，双层货箱仍然可以买', () => {
    const state = boxState(9);
    noonSummary(state, WAITING);
    must(state, { type: 'refundBay', station: 0 }); // 当天买的停机位当天原价退回
    expect(anyStationAtCap(state)).toBe(false);
    expect(isUnlocked(state, 'doubleBox')).toBe(true);
    must(state, { type: 'buyDoubleBox' });
  });
});

describe('双层货箱：买下之后「一趟送几单」一栏开放，并且自动换成「顺路的一起送」', () => {
  function afterBox(): SimState {
    const state = withMoney(quietState());
    campaignOf(state).unlocks.poolColumn = -1;
    return state;
  }

  it('买之前「一趟送几单」整栏锁着，ruleLocked，状态不变', () => {
    const state = afterBox();
    expect(isUnlocked(state, 'poolColumn')).toBe(false);
    for (const id of ['single', 'same', 'any']) expectRejected(state, { type: 'setRules', rules: { pool: id } }, 'ruleLocked');
    expect(ruleLock(state, 'pool', 'any')).toBe('poolColumn');
  });

  it('买下的同时开放这一栏，这一栏从「一趟送一单」换成「顺路的一起送」，这次换卡不记进换卡记录，一起送的规矩立刻生效', () => {
    const state = afterBox();
    expect(state.rules.pool).toBe('single');
    must(state, { type: 'buyDoubleBox' });
    expect(state.capacity).toBe(2);
    expect(isUnlocked(state, 'poolColumn')).toBe(true);
    expect(stepOf(state, 'poolColumn')).toBe(state.step);
    expect(state.rules).toEqual({ select: 'fifo', zone: 'global', pool: 'any' });
    expect(state.stats.ruleChanges).toEqual([]);
    // 开放之后玩家自己换卡才记录
    must(state, { type: 'setRules', rules: { pool: 'same' } });
    expect(state.stats.ruleChanges.map((c) => [c.column, c.from, c.to])).toEqual([['pool', 'any', 'same']]);
  });

  it('这一栏已经不是「一趟送一单」时不替玩家换：配置里指定了「同一家店的一起送」，买了货箱仍是它', () => {
    const state = withMoney(quietState({ rules: { pool: 'same' } }));
    campaignOf(state).unlocks.poolColumn = -1;
    must(state, { type: 'buyDoubleBox' });
    expect(state.rules.pool).toBe('same');
    expect(state.stats.ruleChanges).toEqual([]);
  });

  it('买了货箱之后，订单真的会一起送：同样的订单，载量 2 加「顺路的一起送」时有同乘', () => {
    const run = (buy: boolean): number => {
      const state = withMoney(quietState({ orderEndStep: null, seed: 42 }), 1000);
      campaignOf(state).opening.orders = [0, 1, 2, 3, 4];
      if (buy) must(state, { type: 'buyDoubleBox' });
      for (let i = 0; i < 2 * DAY_STEPS; i++) step(state);
      return state.orders.filter((o) => o.shared).length;
    };
    expect(run(false)).toBe(0);
    expect(run(true)).toBeGreaterThan(3);
  });
});

describe('「别的站帮不帮」一栏和就近降落：有两座以上没退回的站', () => {
  function oneStation(): SimState {
    const state = withMoney(quietState());
    campaignOf(state).unlocks.zoneColumn = -1;
    campaignOf(state).unlocks.nearestLanding = -1;
    return state;
  }

  it('只有一座站：整栏锁着，三张卡都失败，就近降落 needTwoStations', () => {
    const state = oneStation();
    for (const id of ['global', 'hybrid', 'strict']) expectRejected(state, { type: 'setRules', rules: { zone: id } }, 'ruleLocked');
    expectRejected(state, { type: 'buyNearestLanding' }, 'needTwoStations');
    expect(ruleLock(state, 'zone', 'strict')).toBe('zoneColumn');
  });

  it('建成第二座站当场开放，三张卡同时开放，就近降落可以买', () => {
    const state = oneStation();
    must(state, { type: 'buildStation', roof: OLD_SMALL });
    expect(stepOf(state, 'zoneColumn')).toBe(state.step);
    expect(stepOf(state, 'nearestLanding')).toBe(state.step);
    for (const id of ['hybrid', 'strict', 'global']) must(state, { type: 'setRules', rules: { zone: id } });
    must(state, { type: 'buyNearestLanding' });
    expect(state.returnRule).toBe('nearest');
  });

  it('已经开放的不会再锁上：第二座站当天退回，这一栏仍然开放，就近降落的购买要的是现在有两座站', () => {
    const state = oneStation();
    const second = must(state, { type: 'buildStation', roof: OLD_SMALL });
    must(state, { type: 'refundStation', station: second });
    expect(isUnlocked(state, 'zoneColumn')).toBe(true);
    must(state, { type: 'setRules', rules: { zone: 'strict' } });
    expectRejected(state, { type: 'buyNearestLanding' }, 'needTwoStations');
  });

  it('退回的站不算：只剩一座没退回的站时不开放', () => {
    const state = oneStation();
    const second = must(state, { type: 'buildStation', roof: OLD_SMALL });
    campaignOf(state).unlocks.zoneColumn = -1;
    campaignOf(state).unlocks.nearestLanding = -1;
    must(state, { type: 'refundStation', station: second });
    step(state); // 每步开始检查：站数是 1
    expect(isUnlocked(state, 'zoneColumn')).toBe(false);
  });
});

describe('某一片的先送：写字楼区连续两次日结没有升星，并且它的准时率比其他片区合在一起低 20 个百分点以上', () => {
  /** 老街和写字楼区开通，第 0 天的订单：老街 oldOn / oldAll，写字楼区 officeOn / officeAll 准时，其余超时。 */
  function setup(old: [number, number], office: [number, number]): SimState {
    const state = quietState({}, false);
    const campaign = campaignOf(state);
    campaign.districts[1]!.open = true;
    refreshShops(state);
    batchOrders(state, 0, 0, { onTime: old[0], late: old[1] - old[0] });
    batchOrders(state, 1, 0, { onTime: office[0], late: office[1] - office[0] });
    return state;
  }

  it('差正好 20 个百分点：连续两次日结没有升星之后开放，「以上」包括 20', () => {
    const state = setup([7, 10], [5, 10]); // 老街 70%，写字楼区 50%
    settle(state, 0);
    expect(isUnlocked(state, 'prioDistrict')).toBe(false); // 才一次日结
    expect(campaignOf(state).rating[1]?.noUpgrade).toBe(1);
    settle(state, 1);
    expect(isUnlocked(state, 'prioDistrict')).toBe(true);
    expect(stepOf(state, 'prioDistrict')).toBe(2 * DAY_STEPS);
    expect(campaignOf(state).rating[1]?.noUpgrade).toBe(2);
  });

  it('差 19 个百分点：不开放', () => {
    const state = setup([69, 100], [50, 100]);
    settle(state, 0);
    settle(state, 1);
    expect(campaignOf(state).rating[1]?.noUpgrade).toBe(2);
    expect(isUnlocked(state, 'prioDistrict')).toBe(false);
  });

  it('只有一次日结没有升星：差再多也不开放', () => {
    const state = setup([10, 10], [1, 10]);
    settle(state, 0);
    expect(isUnlocked(state, 'prioDistrict')).toBe(false);
  });

  it('中间升过星：连续的次数清零，不开放', () => {
    const state = setup([10, 10], [5, 10]);
    settle(state, 0); // 写字楼区 50%，没升星，次数 1
    expect(campaignOf(state).rating[1]?.noUpgrade).toBe(1);
    batchOrders(state, 1, 1, { onTime: 40 }); // 第二天的统计范围是前两天：45 / 50 = 90%，升到二星
    settle(state, 1);
    expect(campaignOf(state).districts[1]?.star).toBe(2);
    expect(campaignOf(state).rating[1]?.noUpgrade).toBe(0);
    expect(isUnlocked(state, 'prioDistrict')).toBe(false);
  });

  it('写字楼区还没开通、或最近两天没有订单、或其他片区没有订单：没法比，不开放', () => {
    const closed = quietState({}, false);
    batchOrders(closed, 0, 0, { onTime: 10 });
    settle(closed, 0);
    settle(closed, 1);
    expect(isUnlocked(closed, 'prioDistrict')).toBe(false);
    const quiet = setup([10, 10], [0, 0]);
    settle(quiet, 0);
    settle(quiet, 1);
    expect(campaignOf(quiet).rating[1]?.noUpgrade).toBe(2);
    expect(isUnlocked(quiet, 'prioDistrict')).toBe(false);
    const alone = setup([0, 0], [1, 10]);
    settle(alone, 0);
    settle(alone, 1);
    expect(isUnlocked(alone, 'prioDistrict')).toBe(false);
  });

  it('其他片区合在一起算：老街和大学城的订单合并，再与写字楼区比', () => {
    const state = setup([10, 10], [5, 10]);
    campaignOf(state).districts[2]!.open = true;
    refreshShops(state);
    batchOrders(state, 2, 0, { onTime: 4, late: 6 }); // 大学城 40%
    // 其他片区合在一起 14 / 20 = 70%，写字楼区 50%，差 20
    settle(state, 0);
    settle(state, 1);
    expect(isUnlocked(state, 'prioDistrict')).toBe(true);
    // 同样的订单，大学城再多几张超时的，合在一起只有 14 / 26 = 54%，写字楼区 50%，不开放
    const other = setup([10, 10], [5, 10]);
    campaignOf(other).districts[2]!.open = true;
    refreshShops(other);
    batchOrders(other, 2, 0, { onTime: 4, late: 12 });
    settle(other, 0);
    settle(other, 1);
    expect(isUnlocked(other, 'prioDistrict')).toBe(false);
  });

  it('开放三张「某一片的先送」，之前 ruleLocked', () => {
    const state = setup([7, 10], [5, 10]);
    campaignOf(state).unlocks.selectColumn = 0;
    for (const id of ['prioOld', 'prioOffice', 'prioCampus']) expectRejected(state, { type: 'setRules', rules: { select: id } }, 'ruleLocked');
    settle(state, 0);
    settle(state, 1);
    for (const id of ['prioOld', 'prioOffice', 'prioCampus']) must(state, { type: 'setRules', rules: { select: id } });
  });
});

describe('「来回快的先送」、显示写字楼区、显示大学城：看星级', () => {
  it('写字楼区到三星：「来回快的先送」开放，大学城显示，之前锁着', () => {
    const state = quietState({}, false);
    campaignOf(state).unlocks.selectColumn = 0;
    const campaign = campaignOf(state);
    campaign.districts[0]!.star = 3;
    campaign.districts[1]!.open = true;
    campaign.districts[1]!.star = 2;
    expectRejected(state, { type: 'setRules', rules: { select: 'roundtrip' } }, 'ruleLocked');
    settle(state, 0);
    expect(isUnlocked(state, 'roundtrip')).toBe(false);
    expect(isUnlocked(state, 'showCampus')).toBe(false);
    campaign.districts[1]!.star = 3;
    settle(state, 1);
    expect(stepOf(state, 'roundtrip')).toBe(2 * DAY_STEPS);
    expect(stepOf(state, 'showCampus')).toBe(2 * DAY_STEPS);
    must(state, { type: 'setRules', rules: { select: 'roundtrip' } });
  });

  it('老街到三星：显示写字楼区，放出「河对岸的写字楼区可以开通了」的便签，之前开通写字楼区失败 districtHidden', () => {
    const state = withMoney(quietState({}, false));
    campaignOf(state).unlocks.priceTags = 0;
    const campaign = campaignOf(state);
    campaign.districts[0]!.star = 2;
    settle(state, 0);
    expect(isUnlocked(state, 'showOffice')).toBe(false);
    // 星级直接设成三星，但日结还没有确认：界面看不到写字楼区，命令也失败，原因是还没显示
    campaign.districts[0]!.star = 3;
    expectRejected(state, { type: 'openDistrict', district: 1 }, 'districtHidden');
    settle(state, 1);
    expect(stepOf(state, 'showOffice')).toBe(2 * DAY_STEPS);
    expect(campaign.tips.filter((t) => t.id === 'openOffice').map((t) => t.step)).toEqual([2 * DAY_STEPS]);
    expect(must(state, { type: 'openDistrict', district: 1 })).toBe(1);
  });

  it('大学城要写字楼区到三星才显示：写字楼区没开通或不到三星时开通大学城失败 districtHidden', () => {
    const state = withMoney(quietState({}, false));
    const campaign = campaignOf(state);
    campaign.unlocks.showOffice = 0;
    campaign.districts[0]!.star = 3;
    must(state, { type: 'openDistrict', district: 1 });
    campaign.districts[1]!.star = 3;
    expectRejected(state, { type: 'openDistrict', district: 2 }, 'districtHidden');
    settle(state, 0);
    expect(isUnlocked(state, 'showCampus')).toBe(true);
    must(state, { type: 'openDistrict', district: 2 });
  });

  it('已经开放的不会再锁上：掉星之后显示和「来回快的先送」仍然开放，开通片区要的星级仍按现在的算', () => {
    const state = withMoney(quietState({}, false));
    const campaign = campaignOf(state);
    campaign.unlocks.selectColumn = 0;
    campaign.districts[0]!.star = 3;
    campaign.districts[1]!.open = true;
    campaign.districts[1]!.star = 3;
    settle(state, 0);
    const opened = UNLOCK_KEYS.filter((key) => campaign.unlocks[key] >= 0);
    expect(opened).toEqual(expect.arrayContaining(['showOffice', 'showCampus', 'roundtrip']));
    const stepsBefore = opened.map((key) => campaign.unlocks[key]);
    // 两个片区都掉到二星：连续两次日结没达到
    batchOrders(state, 0, 1, { onTime: 1, late: 9 });
    batchOrders(state, 1, 1, { onTime: 1, late: 9 });
    settle(state, 1);
    batchOrders(state, 0, 2, { late: 10 });
    batchOrders(state, 1, 2, { late: 10 });
    settle(state, 2);
    expect(campaign.districts.map((d) => d.star)).toEqual([2, 2, 1]);
    expect(opened.map((key) => campaign.unlocks[key])).toEqual(stepsBefore);
    expect(ruleOpen(state, 'select', 'roundtrip')).toBe(true);
    // 显示一直开放，但开通要的星级按现在的算：写字楼区掉到了二星，开通大学城仍要先回到三星
    expectRejected(state, { type: 'openDistrict', district: 2 }, 'needStars');
  });
});

describe('调度台的栏和卡：setRules 命令', () => {
  it('没开放的栏或卡：失败，原因是 ruleLocked，一张也不换，状态不变；开放之后可用', () => {
    const state = quietState({}, false);
    // 一次换三栏，其中任何一栏没开放，整条命令都不执行
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline', zone: 'hybrid', pool: 'any' } }, 'ruleLocked');
    expect(state.rules).toEqual({ select: 'fifo', zone: 'global', pool: 'single' });
    campaignOf(state).unlocks.selectColumn = 0;
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline', zone: 'hybrid' } }, 'ruleLocked');
    campaignOf(state).unlocks.zoneColumn = 0;
    must(state, { type: 'setRules', rules: { select: 'deadline', zone: 'hybrid' } });
    expect(state.rules).toEqual({ select: 'deadline', zone: 'hybrid', pool: 'single' });
  });

  it('不存在的卡仍然是 unknownRule，不是 ruleLocked', () => {
    const state = quietState({}, false);
    expectRejected(state, { type: 'setRules', rules: { select: 'nope' } }, 'unknownRule');
  });

  it('只读的价签对没开放的换卡也给出 ruleLocked', () => {
    const state = quietState({}, false);
    expect(quoteCommand(state, { type: 'setRules', rules: { select: 'deadline' } })).toMatchObject({ ok: false, reason: 'ruleLocked', kind: 'free', price: 0 });
  });

  it('每一栏每一张卡各有一项锁着它：界面按它写未开放的条件', () => {
    const state = quietState({}, false);
    const lock = (column: 'select' | 'zone' | 'pool', id: string): string | null => ruleLock(state, column, id);
    expect([lock('select', 'fifo'), lock('select', 'deadline'), lock('select', 'roundtrip'), lock('select', 'prioOld')]).toEqual(['selectColumn', 'selectColumn', 'selectColumn', 'selectColumn']);
    campaignOf(state).unlocks.selectColumn = 0;
    expect([lock('select', 'fifo'), lock('select', 'deadline'), lock('select', 'roundtrip'), lock('select', 'prioCampus')]).toEqual([null, null, 'roundtrip', 'prioDistrict']);
    expect([lock('pool', 'any'), lock('zone', 'strict')]).toEqual(['poolColumn', 'zoneColumn']);
  });
});

describe('开放的记录', () => {
  it('开局全部没开放，每项记的是开放的步，-1 表示没开放', () => {
    const state = quietState({}, false);
    expect(UNLOCK_KEYS.map((key) => stepOf(state, key))).toEqual(UNLOCK_KEYS.map(() => -1));
    expect(UNLOCK_KEYS.length).toBe(11);
  });

  it('沙盒模式没有开放这回事，一律当作开放', () => {
    const sandbox = createState({ ...OPENING });
    expect(sandbox.campaign).toBeNull();
    for (const key of UNLOCK_KEYS) expect(isUnlocked(sandbox, key)).toBe(true);
    expect(ruleOpen(sandbox, 'select', 'roundtrip')).toBe(true);
  });

  it('开放的项一旦记下步，之后再触发条件也不会改步', () => {
    const state = withMoney(quietState({}, false));
    advance(state, DAY_STEPS);
    step(state); // 日结，余额够，价签开放
    const opened = stepOf(state, 'priceTags');
    expect(opened).toBe(DAY_STEPS);
    advance(state, 1000);
    expect(stepOf(state, 'priceTags')).toBe(opened);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { ruleName } from '../src/content/strings.zh.ts';
import {
  DroneState,
  OrderStatus,
  PICK_SECONDS,
  SPEED,
  addOrder,
  advance,
  buildRound,
  createState,
  deliverOrder,
  dispatchRound,
  hashState,
  peakSummary,
  prioritizeOrder,
  RULE_NAMES,
  recordEarlyDispatches,
  ruleIds,
  setRules,
  settlement,
  windowStats,
} from '../src/core/index.ts';
import type { DispatchContext, Drone, Order, PoolRule, SelectRule, SimState, ZoneRule } from '../src/core/index.ts';
import { RULE_REGISTRY, getSelectRule } from '../src/core/dispatch/registry.ts';
import { planRound } from '../src/core/dispatch/run.ts';
import { deadlineRule, fifoRule, prioCampusRule, prioOfficeRule, prioOldRule, roundtripRule } from '../src/core/dispatch/select.ts';
import { dist } from '../src/core/world.ts';
import { OPENING, makeOrder } from './helpers.ts';

/** pendingIds 缺省为全部订单。orders 的下标必须等于订单编号。 */
function ctxOf(orders: Order[], flyTime: number[], now: number, pendingIds?: number[]): DispatchContext {
  return { state: { orders } as unknown as SimState, now, pendingIds: pendingIds ?? orders.map((o) => o.id), flyTime, tripTime: () => [] };
}

describe('调度策略的两条规则', () => {
  // 四张订单。下单时刻（步）、出餐完成（步）、店到楼的距离，最近的可用飞机飞到店的用时（秒）。现在是第 1000 步。
  const four = [
    makeOrder({ id: 0, tOrder: 900, prepDone: 950, dMB: 550 }),
    makeOrder({ id: 1, tOrder: 950, prepDone: 1000, dMB: 1100 }),
    makeOrder({ id: 2, tOrder: 500, prepDone: 550, dMB: 330 }),
    makeOrder({ id: 3, tOrder: 990, prepDone: 1040, dMB: 220 }),
  ];
  const fly = [5, 2, 1, Infinity]; // 第 4 张没有可用飞机

  it('先到先送：按下单时间排序', () => {
    expect(fifoRule.rank(ctxOf(four, fly, 1000))).toEqual([2, 0, 1, 3]);
  });

  it('时限优先：赶得上的按剩余时间从少到多，赶不上的排在后面，没有飞机能接的排在最后', () => {
    // 订单 0：取餐在 105 秒，送到在 112.4 秒，承诺在 120 秒，剩余 7.6 秒
    // 订单 1：取餐在 102 秒，送到在 114.4 秒，承诺在 125 秒，剩余 10.6 秒
    // 订单 2：承诺在 80 秒，早已赶不上
    // 订单 3：没有飞机能接
    expect(deadlineRule.rank(ctxOf(four, fly, 1000))).toEqual([0, 1, 2, 3]);
  });

  it('剩余时间少的先送，即使下单更晚', () => {
    // A：90 秒下单，剩余 120 - (102 + 1.2 + 1 + 1.2) = 14.6 秒
    // B：95 秒下单，路上要 6 秒，剩余 125 - (103 + 1.2 + 6 + 1.2) = 13.6 秒
    const two = [
      makeOrder({ id: 0, tOrder: 900, prepDone: 900, dMB: 110 }),
      makeOrder({ id: 1, tOrder: 950, prepDone: 950, dMB: 660 }),
    ];
    expect(fifoRule.rank(ctxOf(two, [2, 3], 1000))).toEqual([0, 1]);
    expect(deadlineRule.rank(ctxOf(two, [2, 3], 1000))).toEqual([1, 0]);
  });

  it('剩余时间要计入出餐：出餐晚的订单取餐时刻也晚', () => {
    // E：95 秒下单，出餐在 113 秒，取餐在 113 秒，剩余 125 - (113 + 1.2 + 1 + 1.2) = 8.6 秒
    // F：90 秒下单，飞机 102 秒到店就能取，剩余 120 - (102 + 1.2 + 1 + 1.2) = 14.6 秒
    const two = [
      makeOrder({ id: 0, tOrder: 900, prepDone: 900, dMB: 110 }),
      makeOrder({ id: 1, tOrder: 950, prepDone: 1130, dMB: 110 }),
    ];
    expect(deadlineRule.rank(ctxOf(two, [2, 2], 1000))).toEqual([1, 0]);
  });

  it('赶不上的订单之间按下单时间排序，赶得上的排在它们前面', () => {
    const orders = [
      makeOrder({ id: 0, tOrder: 100, prepDone: 150, dMB: 110 }),
      makeOrder({ id: 1, tOrder: 200, prepDone: 250, dMB: 110 }),
      makeOrder({ id: 2, tOrder: 990, prepDone: 1040, dMB: 110 }),
      makeOrder({ id: 3, tOrder: 50, prepDone: 100, dMB: 110 }),
    ];
    expect(deadlineRule.rank(ctxOf(orders, [2, 2, 2, Infinity], 1000))).toEqual([2, 0, 1, 3]);
  });

  it('飞到店的用时一样时，按下单时间，再按编号', () => {
    const orders = Array.from({ length: 6 }, (_, id) => makeOrder({ id, tOrder: 900, prepDone: 900, dMB: 110 }));
    // 待派的是编号 5 和 3 的订单（下标 0 和 1），条件完全相同：编号小的先送
    expect(deadlineRule.rank(ctxOf(orders, [2, 2], 1000, [5, 3]))).toEqual([1, 0]);
    expect(fifoRule.rank(ctxOf(orders, [2, 2], 1000, [5, 3]))).toEqual([1, 0]);
  });
});

/** 带整趟用时的上下文：trip 与 pendingIds 一一对应。 */
function ctxWithTrip(orders: Order[], flyTime: number[], trip: number[], now: number, pendingIds?: number[]): DispatchContext {
  return { ...ctxOf(orders, flyTime, now, pendingIds), tripTime: () => trip };
}

describe('短程优先', () => {
  // 整趟用时（秒）：订单 0 是 20，订单 1 和 2 都是 8，订单 3 和 4 没有飞机能接
  const orders = [
    makeOrder({ id: 0, tOrder: 900, dMB: 550 }),
    makeOrder({ id: 1, tOrder: 950, dMB: 220 }),
    makeOrder({ id: 2, tOrder: 800, dMB: 330 }),
    makeOrder({ id: 3, tOrder: 700, dMB: 660 }),
    makeOrder({ id: 4, tOrder: 600, dMB: 110 }),
  ];
  const fly = [3, 3, 3, Infinity, Infinity];
  const trip = [20, 8, 8, Infinity, Infinity];

  it('先送整趟用时最短的，用时相同按下单时间，没有飞机能接的排在最后，按店到楼的用时从短到长', () => {
    expect(roundtripRule.rank(ctxWithTrip(orders, fly, trip, 1000))).toEqual([2, 1, 0, 4, 3]);
  });

  it('用时和下单时间都相同时按编号', () => {
    const same = Array.from({ length: 6 }, (_, id) => makeOrder({ id, tOrder: 900, dMB: 110 }));
    // 待派的是编号 3、1、2 的订单（下标 0、1、2）：编号小的先送
    expect(roundtripRule.rank(ctxWithTrip(same, [2, 2, 2], [9, 9, 9], 1000, [3, 1, 2]))).toEqual([1, 2, 0]);
  });

  it('不看剩余时间：赶不上的订单只要来回快，也排在赶得上但来回慢的订单前面', () => {
    // 订单 0 下单很早，已经赶不上，整趟只要 6 秒。订单 1 刚下单，赶得上，整趟要 12 秒
    const two = [makeOrder({ id: 0, tOrder: 100, prepDone: 150, dMB: 110 }), makeOrder({ id: 1, tOrder: 990, prepDone: 1040, dMB: 660 })];
    expect(roundtripRule.rank(ctxWithTrip(two, [2, 2], [6, 12], 1000))).toEqual([0, 1]);
    expect(deadlineRule.rank(ctxWithTrip(two, [2, 2], [6, 12], 1000))).toEqual([1, 0]);
  });

  it('只排待派的订单：下标对应 pendingIds，不是订单编号', () => {
    expect(roundtripRule.rank(ctxWithTrip(orders, [3, 3], [9, 4], 1000, [4, 1]))).toEqual([1, 0]);
  });

  /** 一座站、一架飞机、同一家店的两张订单：远的先下单，近的后下单。 */
  function farThenNear(select: string): { state: SimState; far: Order; near: Order } {
    const state = createState({ ...OPENING, drones: 1, rules: { select } });
    const shop = state.world.merchants[0] as { x: number; y: number };
    const distances = state.world.buildings.map((b) => dist(shop.x, shop.y, b.x, b.y));
    const far = addOrder(state, { merchant: 0, building: distances.indexOf(Math.max(...distances)), portion: 1, prepSteps: 40, tOrder: 100 });
    const near = addOrder(state, { merchant: 0, building: distances.indexOf(Math.min(...distances)), portion: 1, prepSteps: 40, tOrder: 105 });
    state.step = 150;
    return { state, far, near };
  }

  it('整趟用时来自可用飞机：站到店、店到楼、楼回站。派出整趟短的订单，比按下单顺序更早，记一次提前派出', () => {
    const { state, far, near } = farThenNear('roundtrip');
    const station = state.stations[0] as { x: number; y: number };
    const shop = state.world.merchants[0] as { x: number; y: number };
    const building = state.world.buildings[near.building] as { x: number; y: number };
    const trip = (dist(station.x, station.y, shop.x, shop.y) + near.dMB + dist(building.x, building.y, station.x, station.y)) / SPEED;
    expect(buildRound(state).ctx.tripTime()[1]).toBeCloseTo(trip, 12);
    expect(buildRound(state).ctx.tripTime()[0]).toBeGreaterThan(trip);
    const result = dispatchRound(state);
    expect(result.dispatched).toEqual([near.id]);
    expect(result.early).toEqual([near.id]);
    expect(far.status).toBe(OrderStatus.Pending);
  });

  it('「先到先送」在同一局面里派出先下单的', () => {
    const { state, far } = farThenNear('fifo');
    expect(dispatchRound(state).dispatched).toEqual([far.id]);
  });
});

describe('{片区}优先', () => {
  // 六张订单，送往老街、写字楼区、大学城各两张。现在是第 1000 步，每张都有飞机能接，飞到店 2 秒，出餐早已完成。
  // 取餐在 102 秒。剩余时间 = 下单时刻 + 30 - (102 + 1.2 + 店到楼用时 + 1.2)，每张订单手算如下：
  //   0：90 秒下单，店到楼 9 秒，剩余 6.6，老街
  //   1：91 秒下单，店到楼 8 秒，剩余 8.6，写字楼区
  //   2：92 秒下单，店到楼 1 秒，剩余 16.6，大学城
  //   3：93 秒下单，店到楼 7 秒，剩余 11.6，写字楼区
  //   4：94 秒下单，店到楼 4 秒，剩余 15.6，老街
  //   5：95 秒下单，店到楼 2 秒，剩余 18.6，大学城
  const orders = [
    makeOrder({ id: 0, tOrder: 900, prepDone: 900, dMB: 990, district: 0 }),
    makeOrder({ id: 1, tOrder: 910, prepDone: 910, dMB: 880, district: 1 }),
    makeOrder({ id: 2, tOrder: 920, prepDone: 920, dMB: 110, district: 2 }),
    makeOrder({ id: 3, tOrder: 930, prepDone: 930, dMB: 770, district: 1 }),
    makeOrder({ id: 4, tOrder: 940, prepDone: 940, dMB: 440, district: 0 }),
    makeOrder({ id: 5, tOrder: 950, prepDone: 950, dMB: 220, district: 2 }),
  ];
  const fly = [2, 2, 2, 2, 2, 2];

  it('时限优先按剩余时间排：0、1、3、4、2、5', () => {
    expect(deadlineRule.rank(ctxOf(orders, fly, 1000))).toEqual([0, 1, 3, 4, 2, 5]);
  });

  it('送到指定片区的订单排在最前，两部分各自保持「时限优先」的次序', () => {
    expect(prioOldRule.rank(ctxOf(orders, fly, 1000))).toEqual([0, 4, 1, 3, 2, 5]);
    expect(prioOfficeRule.rank(ctxOf(orders, fly, 1000))).toEqual([1, 3, 0, 4, 2, 5]);
    expect(prioCampusRule.rank(ctxOf(orders, fly, 1000))).toEqual([2, 5, 0, 1, 3, 4]);
  });

  it('指定片区里没有飞机能接的订单，也排在其他片区有飞机能接的订单前面', () => {
    const noFly = [2, Infinity, 2, 2, 2, 2]; // 订单 1（写字楼区）没有飞机能接
    // 写字楼区里，赶得上的订单 3 在前，没有飞机的订单 1 在后，其余按时限优先
    expect(prioOfficeRule.rank(ctxOf(orders, noFly, 1000))).toEqual([3, 1, 0, 4, 2, 5]);
    expect(deadlineRule.rank(ctxOf(orders, noFly, 1000))).toEqual([0, 3, 4, 2, 5, 1]); // 时限优先里它在最后
  });

  it('指定片区里已经赶不上的订单，也排在其他片区赶得上的订单前面，片区内部仍是赶得上的在先', () => {
    // 现在是第 1100 步（110 秒），取餐在 112 秒。剩余时间：订单 0 是 -3.4，订单 1 是 -1.4，已经赶不上。
    // 订单 2 是 6.6，订单 3 是 1.6，订单 4 是 5.6，订单 5 是 8.6
    const now = ctxOf(orders, fly, 1100);
    expect(deadlineRule.rank(now)).toEqual([3, 4, 2, 5, 0, 1]);
    expect(prioOldRule.rank(now)).toEqual([4, 0, 3, 2, 5, 1]); // 老街：赶得上的 4 在前，赶不上的 0 在后，然后才是其他片区
    expect(prioOfficeRule.rank(now)).toEqual([3, 1, 4, 2, 5, 0]);
  });

  it('指定片区里没有订单时，次序与时限优先相同', () => {
    const noOffice = orders.map((o) => makeOrder({ ...o, district: o.district === 1 ? 0 : o.district }));
    expect(prioOfficeRule.rank(ctxOf(noOffice, fly, 1000))).toEqual(deadlineRule.rank(ctxOf(noOffice, fly, 1000)));
  });

  it('下标对应 pendingIds，不是订单编号', () => {
    // 待派的是订单 5（大学城）和订单 1（写字楼区）
    expect(prioOfficeRule.rank(ctxOf(orders, [2, 2], 1000, [5, 1]))).toEqual([1, 0]);
    expect(prioCampusRule.rank(ctxOf(orders, [2, 2], 1000, [5, 1]))).toEqual([0, 1]);
  });

  it('核心里每个片区一张卡，名称按界面上的写法', () => {
    expect(ruleIds('select')).toEqual(expect.arrayContaining(['prioOld', 'prioOffice', 'prioCampus']));
    expect([RULE_NAMES.prioOld, RULE_NAMES.prioOffice, RULE_NAMES.prioCampus]).toEqual((['prioOld', 'prioOffice', 'prioCampus'] as const).map(ruleName));
  });

  it('排序用到的片区是订单送往的片区：整局运行里，写字楼区优先让送往写字楼区的订单更早派出', () => {
    const run = (select: string): SimState => {
      const state = createState({ scenario: 'threeDistricts', drones: 16, peakRate: 82, gateInterval: 0.8, seed: 42, rules: { select } });
      advance(state, 2400);
      return state;
    };
    const waitOf = (state: SimState, district: number): number => {
      const sent = state.orders.filter((o) => o.district === district && o.tAssign >= 0);
      return sent.reduce((sum, o) => sum + (o.tAssign - o.tOrder), 0) / sent.length;
    };
    const plain = run('deadline');
    const office = run('prioOffice');
    expect(waitOf(office, 1)).toBeLessThan(waitOf(plain, 1)); // 写字楼区的订单等飞机的时间更短
    expect(waitOf(office, 0)).toBeGreaterThan(waitOf(plain, 0)); // 代价落在别的片区
  });
});

describe('延迟支援', () => {
  /** 两座站各一架飞机。订单的店离 0 号站最近，下单时刻 1000。 */
  function scene(zone: string, free: 0 | 1): { state: SimState; order: Order } {
    const state = createState({ scenario: 'threeDistricts', drones: 2, rules: { zone } });
    expect(state.drones.map((d) => d.home)).toEqual([0, 1]);
    (state.drones[free === 0 ? 1 : 0] as Drone).state = DroneState.Fly; // 另一架在空中，不可用
    const shop = state.world.merchants.findIndex((m) => m.district === 0);
    const order = addOrder(state, { merchant: shop, building: 0, portion: 1, prepSteps: 40, tOrder: 1000 });
    expect(order.home).toBe(0);
    return { state, order };
  }

  const okAt = (state: SimState, step: number): number[] => {
    state.step = step;
    return Array.from(buildRound(state).ok);
  };

  it('只有别的站的飞机可用时：下单后 99 步（9.9 秒）不能接，满 100 步（10 秒）可以接', () => {
    const { state, order } = scene('hybrid', 1);
    expect(okAt(state, 1000)).toEqual([0]);
    expect(okAt(state, 1099)).toEqual([0]);
    expect(buildRound(state).eligible).toEqual([]);
    expect(okAt(state, 1100)).toEqual([1]);
    expect(buildRound(state).eligible).toEqual([order.id]);
    expect(okAt(state, 1500)).toEqual([1]);
  });

  it('本站的飞机一直可以接，不用等', () => {
    const { state } = scene('hybrid', 0);
    expect(okAt(state, 1000)).toEqual([1]);
    expect(okAt(state, 1050)).toEqual([1]);
  });

  it('另两张卡作对照：全站协同一直可以接，仅限最近站点一直不能接别的站的飞机', () => {
    for (const step of [1000, 1099, 1100, 3000]) {
      expect(okAt(scene('global', 1).state, step)).toEqual([1]);
      expect(okAt(scene('strict', 1).state, step)).toEqual([0]);
    }
  });

  it('等待满 10 秒之前，订单在别的站空闲时也不派，满 10 秒之后派给别的站的飞机', () => {
    const { state, order } = scene('hybrid', 1);
    state.step = 1095; // 每 5 步派一次单
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(order.status).toBe(OrderStatus.Pending);
    state.step = 1100;
    expect(dispatchRound(state).dispatched).toEqual([order.id]);
    expect(order.departed).toBe(1);
  });
});

describe('结算', () => {
  // 金额 10，用时按步计，承诺时间 300 步
  it.each([
    [0, 11, 1],
    [150, 11, 1], // 半个承诺时间
    [180, 11, 1], // 恰在六成：有打赏
    [181, 10, 0], // 刚过六成：没有打赏
    [300, 10, 0], // 恰在承诺时间：全额
    [450, 6.5, 0], // 1.5 倍：10 × (1 − 0.7 × 0.5)
    [600, 3, 0], // 两倍：降到三成
    [900, 3, 0], // 再晚也是三成
  ])('用时 %i 步：进账 %f，其中打赏 %f', (elapsed, total, tip) => {
    const s = settlement(10, elapsed);
    expect(s.pay + s.tip).toBeCloseTo(total, 9);
    expect(s.tip).toBeCloseTo(tip, 9);
  });

  it('刚过承诺时间：从全额开始线性下降', () => {
    const s = settlement(10, 301);
    expect(s.pay).toBeCloseTo(10 * (1 - 0.7 / 300), 9);
    expect(s.pay).toBeLessThan(10);
    expect(settlement(10, 599).pay).toBeGreaterThan(3);
  });

  it('订单金额：5 元起，按距离计，大单 1.8 倍', () => {
    const state = createState(OPENING);
    const m = state.world.merchants[0] as { x: number; y: number };
    const b = state.world.buildings[0] as { x: number; y: number };
    const d = dist(m.x, m.y, b.x, b.y);
    const normal = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50 });
    const big = addOrder(state, { merchant: 0, building: 0, portion: 2, prepSteps: 50 });
    expect(normal.dMB).toBeCloseTo(d, 9);
    expect(normal.amount).toBeCloseTo(5 + 0.004 * d, 9);
    expect(big.amount).toBeCloseTo((5 + 0.004 * d) * 1.8, 9);
  });

  it('送达时记录时刻并结算', () => {
    const o = makeOrder({ id: 0, tOrder: 100, amount: 10 });
    deliverOrder(o, 250);
    expect(o.status).toBe(OrderStatus.Delivered);
    expect(o.tDeliver).toBe(250);
    expect(o.tip).toBeCloseTo(1, 9);
    expect(o.rev).toBeCloseTo(11, 9);
  });
});

describe('「提前派出」的统计', () => {
  /** 一座站、六张等待中的订单，下单时刻 100、110、…、150；现在是第 200 步。 */
  function sixPending(): SimState {
    const state = createState(OPENING);
    for (let i = 0; i < 6; i++) addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50, tOrder: 100 + 10 * i });
    state.step = 200;
    return state;
  }

  it('实际派出的订单里不在名单里的，各记一次：名单是按下单顺序会派出的订单', () => {
    const state = sixPending();
    // 按下单顺序会派出订单 0 和订单 1。实际派出订单 2 和订单 0，所以只有订单 2 记一次
    expect(recordEarlyDispatches(state, [0, 1], [2, 0])).toEqual([2]);
    expect(state.orders.map((o) => o.early)).toEqual([false, false, true, false, false, false]);
    expect(state.stats.early).toEqual([{ step: 200, order: 2, rule: 'fifo', day: 0, peak: -1 }]);
    // 派出的就是名单里的订单（先后不同也一样）时没有记录
    expect(recordEarlyDispatches(state, [0, 1], [1, 0])).toEqual([]);
    // 这一轮没有派出订单时没有记录
    expect(recordEarlyDispatches(state, [4, 5], [])).toEqual([]);
  });

  it('同一张订单只记一次', () => {
    const state = sixPending();
    expect(recordEarlyDispatches(state, [0, 1], [3])).toEqual([3]);
    expect(recordEarlyDispatches(state, [0, 1], [3])).toEqual([]);
    expect(state.stats.early.length).toBe(1);
  });

  it('玩家点击插队的订单不计入', () => {
    const state = sixPending();
    expect(prioritizeOrder(state, 5)).toBe(true);
    expect(prioritizeOrder(state, 5)).toBe(false); // 已经点过
    // 插队的订单 5 在最前，名单是订单 5 和订单 0。实际派出订单 5 和订单 4：订单 4 不在名单里，记一次，订单 5 不记
    expect(recordEarlyDispatches(state, [5, 0], [5, 4])).toEqual([4]);
    expect(state.orders[5]?.early).toBe(false);
    // 插队的订单即使不在名单里也不记
    const only = sixPending();
    prioritizeOrder(only, 3);
    expect(recordEarlyDispatches(only, [0], [3])).toEqual([]);
    expect(only.stats.early).toEqual([]);
  });

  it('每次计数记下当时生效的卡和订单所属的高峰', () => {
    const state = createState(OPENING);
    const earlier = [20, 30, 40, 50].map((t) => addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50, tOrder: t }));
    const quiet = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50, tOrder: 300 });
    const noon = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50, tOrder: 700 });
    const evening = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50, tOrder: 2200 });
    const nextNoon = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50, tOrder: 3600 + 650 });
    const roster = earlier.map((o) => o.id); // 按下单顺序会派出的是最早的四张
    state.step = 4400;
    setRules(state, { select: 'deadline' });
    state.step = 4410;
    expect(recordEarlyDispatches(state, roster, [quiet.id, noon.id, evening.id, nextNoon.id])).toEqual([quiet.id, noon.id, evening.id, nextNoon.id]);
    expect(state.stats.early).toEqual([
      { step: 4410, order: quiet.id, rule: 'deadline', day: 0, peak: -1 },
      { step: 4410, order: noon.id, rule: 'deadline', day: 0, peak: 0 },
      { step: 4410, order: evening.id, rule: 'deadline', day: 0, peak: 1 },
      { step: 4410, order: nextNoon.id, rule: 'deadline', day: 1, peak: 0 },
    ]);
  });

  describe('名单：用同一批飞机、同样的条件，把订单按下单顺序再排一遍', () => {
    /** 离这家店最近的站。 */
    function homeOf(state: SimState, shop: number): number {
      const m = state.world.merchants[shop] as { x: number; y: number };
      const d = state.stations.map((s) => dist(m.x, m.y, s.x, s.y));
      return d.indexOf(Math.min(...d));
    }

    /** 第一家离 home 号站最近的店。 */
    function shopOf(state: SimState, home: number): number {
      return state.world.merchants.findIndex((_, shop) => homeOf(state, shop) === home);
    }

    /** 离这家店的距离最接近 wanted 的楼。 */
    function buildingAt(state: SimState, shop: number, wanted: number): number {
      const m = state.world.merchants[shop] as { x: number; y: number };
      const gap = state.world.buildings.map((b) => Math.abs(dist(m.x, m.y, b.x, b.y) - wanted));
      return gap.indexOf(Math.min(...gap));
    }

    const SPEC = { portion: 1, prepSteps: 40 };

    /**
     * 两座站、三架可用飞机：0 号站两架（0、1 号），1 号站一架（2 号）。「协同策略」为仅限最近站点，现在是第 150 步。
     * 甲、乙是同一家店的订单，这家店离 1 号站最近，所以只有 2 号飞机能接。甲的楼近，乙的楼离店约 1000，晚下单 5 步。
     * 丙的店离 0 号站最近，由 0、1 号飞机接，楼近，最晚下单。下单顺序是甲、乙、丙，订单编号 0、1、2。
     */
    function threeOrders(select: string): { state: SimState; a: Order; b: Order; c: Order } {
      const state = createState({ scenario: 'threeDistricts', drones: 3, rules: { select, zone: 'strict' } });
      expect(state.drones.map((d) => d.home)).toEqual([0, 0, 1]);
      const shopAB = shopOf(state, 1);
      const shopC = shopOf(state, 0);
      const a = addOrder(state, { ...SPEC, merchant: shopAB, building: buildingAt(state, shopAB, 0), tOrder: 100 });
      const b = addOrder(state, { ...SPEC, merchant: shopAB, building: buildingAt(state, shopAB, 1000), tOrder: 105 });
      const c = addOrder(state, { ...SPEC, merchant: shopC, building: buildingAt(state, shopC, 0), tOrder: 110 });
      state.step = 150;
      return { state, a, b, c };
    }

    it('名单只含满足派单条件的订单：没有飞机能接的订单不在名单里，也不占名额', () => {
      // 两座站各一架飞机，0 号站的飞机在空中，只有 1 号飞机可用。「仅限最近站点」时，离 0 号站近的店没有飞机能接
      const state = createState({ scenario: 'threeDistricts', drones: 2, rules: { select: 'fifo', zone: 'strict' } });
      (state.drones[0] as Drone).state = DroneState.Fly;
      const shop0 = shopOf(state, 0);
      const shop1 = shopOf(state, 1);
      const a = addOrder(state, { ...SPEC, merchant: shop0, building: buildingAt(state, shop0, 0), tOrder: 100 });
      const b = addOrder(state, { ...SPEC, merchant: shop0, building: buildingAt(state, shop0, 0), tOrder: 105 });
      const c = addOrder(state, { ...SPEC, merchant: shop1, building: buildingAt(state, shop1, 0), tOrder: 110 });
      state.step = 150;
      const round = buildRound(state);
      expect(round.free.map((d) => d.id)).toEqual([1]);
      expect(round.eligible).toEqual([c.id]);
      // 甲、乙比丙早，但没有飞机能接：名单里只有丙
      expect(planRound(round, [0, 1, 2])).toEqual([{ k: 2, drone: 0 }]);
      // 丙是唯一能派出的订单，不算提前派出
      expect(dispatchRound(state)).toEqual({ dispatched: [c.id], early: [] });
      expect([a.status, b.status]).toEqual([OrderStatus.Pending, OrderStatus.Pending]);
    });

    it('较早的订单只有一架飞机能接，这架飞机又被更早的订单用掉：排在它后面派出的订单不记为提前派出', () => {
      const { state, a, b, c } = threeOrders('fifo');
      const round = buildRound(state);
      // 甲、乙只有 2 号飞机能接，丙只有 0、1 号飞机能接。三架飞机都有单可接，三张订单都有飞机能接
      expect(Array.from(round.ok)).toEqual([0, 0, 1, 0, 0, 1, 1, 1, 0]);
      expect(round.available).toBe(3);
      expect(round.eligible).toEqual([a.id, b.id, c.id]);
      // 按下单顺序：甲拿走 2 号飞机，乙没有飞机可用，丙拿走 0 号飞机（用时相同取编号小的）
      const before = hashState(state);
      expect(planRound(round, [0, 1, 2])).toEqual([
        { k: 0, drone: 2 },
        { k: 2, drone: 0 },
      ]);
      expect(hashState(state)).toBe(before); // 算方案不修改状态
      // 先到先送：实际也是甲和丙。名单是甲、丙，丙在名单里，不记。
      // 旧办法取「有飞机能接的订单里最早的两张」，名单是甲、乙，会把丙误记为提前派出
      const result = dispatchRound(state);
      expect(result.dispatched).toEqual([a.id, c.id]);
      expect(result.early).toEqual([]);
      expect(state.stats.early).toEqual([]);
      expect(c.early).toBe(false);
      expect(b.status).toBe(OrderStatus.Pending);
    });

    it('同一个局面换成时限优先：排序与下单顺序不同，记数与按下单顺序手算的名单一致', () => {
      const { state, a, b, c } = threeOrders('deadline');
      const round = buildRound(state);
      // 乙的楼更远，剩余时间比甲少：时限优先把乙排在甲前面
      const ranked = deadlineRule.rank(round.ctx);
      expect(ranked.indexOf(1)).toBeLessThan(ranked.indexOf(0));
      // 手算。按下单顺序（甲、乙、丙）：甲拿走 2 号飞机，乙没有飞机，丙拿走 0 号飞机，名单是甲、丙。
      // 实际（乙在甲前面）：乙拿走 2 号飞机，甲没有飞机，丙拿走 0 号飞机，派出乙、丙。
      // 乙不在名单里，记一次。丙在名单里，不记。旧办法的名单是甲、乙，所以漏记乙，并且误记丙
      expect(planRound(round, [0, 1, 2])).toEqual([
        { k: 0, drone: 2 },
        { k: 2, drone: 0 },
      ]);
      expect(planRound(round, ranked).sort((p, q) => p.k - q.k)).toEqual([
        { k: 1, drone: 2 },
        { k: 2, drone: 0 },
      ]);
      const result = dispatchRound(state);
      expect([...result.dispatched].sort((p, q) => p - q)).toEqual([b.id, c.id]);
      expect(result.early).toEqual([b.id]);
      expect(state.stats.early).toEqual([{ step: 150, order: b.id, rule: 'deadline', day: 0, peak: -1 }]);
      expect(c.early).toBe(false);
      expect(a.status).toBe(OrderStatus.Pending);
    });

    it('玩家点击插队的订单不计入，也不改变其他订单是否被记', () => {
      const run = (click: 'a' | 'b' | 'c' | null): { dispatched: number[]; early: number[] } => {
        const scene = threeOrders('deadline');
        if (click) expect(prioritizeOrder(scene.state, scene[click].id)).toBe(true);
        const { dispatched, early } = dispatchRound(scene.state);
        return { dispatched, early };
      };
      // 不点：乙排在甲前面，记一次（上一条）
      expect(run(null).early).toEqual([1]);
      // 点丙：丙排在最前，名单里也一样。丙不计入，乙仍然记一次
      expect(run('c')).toEqual({ dispatched: [2, 1], early: [1] });
      // 点乙：乙排在最前，名单里也一样，乙拿走 2 号飞机，甲没有飞机。乙是插队的，不计入，丙在名单里，没有订单被记
      expect(run('b')).toEqual({ dispatched: [1, 2], early: [] });
      // 点甲：甲排在最前，拿走 2 号飞机，乙没有飞机，名单与实际相同，没有订单被记
      expect(run('a')).toEqual({ dispatched: [0, 2], early: [] });
    });
  });

  describe('高峰小结', () => {
    /** 午高峰 [600, 1500) 里下的单，小结在第 1800 步生成。 */
    function noonState(): SimState {
      const state = createState(OPENING);
      for (const t of [100, 110]) addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50, tOrder: t }); // 订单 0、1：名单
      for (const t of [700, 800, 900]) addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50, tOrder: t }); // 订单 2、3、4
      state.step = 1000;
      recordEarlyDispatches(state, [0, 1], [2, 3]); // 订单 2、3 提前派出（步 1000）
      state.step = 1850;
      recordEarlyDispatches(state, [0, 1], [4, 0]); // 订单 4 提前派出，但在小结生成之后（步 1850）
      return state;
    }

    it('数量只算到小结生成的时刻，不含之后的', () => {
      const state = noonState();
      const summary = peakSummary(state, 0, 'noon');
      expect(summary.generatedAt).toBe(1800);
      expect(summary.early).toEqual({ count: 2, rules: ['fifo'], changedMidPeak: false });
      expect(windowStats(state, 600, 1500).nEarly).toBe(3); // 不设截止时刻时，之后的也算
      expect(windowStats(state, 600, 1500, 1800).nEarly).toBe(2);
      expect(peakSummary(state, 0, 'evening').early.count).toBe(0);
    });

    it.each([
      [599, false],
      [600, false], // 恰在高峰开始：自动切换到这一场的策略，不算中途
      [601, true],
      [1200, true],
      [1799, true],
      [1800, false], // 小结生成之后换的卡，属于下一场
    ])('第 %i 步换「调度策略」：中途换过 = %s，换过时不给数量', (step, changed) => {
      const state = noonState();
      state.step = step;
      setRules(state, { select: 'deadline' });
      const summary = peakSummary(state, 0, 'noon');
      expect(summary.early.changedMidPeak).toBe(changed);
      expect(summary.early.count).toBe(changed ? null : 2);
    });

    it('换的是别的栏，不影响数量', () => {
      const state = noonState();
      state.step = 1200;
      setRules(state, { zone: 'strict' });
      expect(peakSummary(state, 0, 'noon').early).toEqual({ count: 2, rules: ['fifo'], changedMidPeak: false });
    });

    it('状态还没有推进到生成的时刻时，标明没有准备好', () => {
      const state = createState(OPENING);
      expect(peakSummary(state, 0, 'noon').ready).toBe(false);
      state.step = 1800;
      expect(peakSummary(state, 0, 'noon').ready).toBe(true);
    });
  });
});

describe('派单的一轮', () => {
  /** 一座站、一架飞机，同一家店的两张订单：X 的楼近、Y 的楼远。Y 晚下单半秒，但路上更久，剩余时间更少。 */
  function twoOrders(select: string): { state: SimState; x: Order; y: Order } {
    const state = createState({ ...OPENING, drones: 1, rules: { select } });
    const shop = state.world.merchants[0] as { x: number; y: number };
    const distances = state.world.buildings.map((b) => dist(shop.x, shop.y, b.x, b.y));
    const near = distances.indexOf(Math.min(...distances));
    const far = distances.indexOf(Math.max(...distances));
    const x = addOrder(state, { merchant: 0, building: near, portion: 1, prepSteps: 40, tOrder: 100 });
    const y = addOrder(state, { merchant: 0, building: far, portion: 1, prepSteps: 40, tOrder: 105 });
    state.step = 150;
    return { state, x, y };
  }

  it('时限优先：派出剩余时间更少的订单，它比按下单顺序更早，记一次提前派出', () => {
    const { state, x, y } = twoOrders('deadline');
    // 独立算一遍剩余时间，确认这个例子成立
    const drone = state.drones[0] as { x: number; y: number };
    const shop = state.world.merchants[0] as { x: number; y: number };
    const slack = (o: Order): number =>
      o.tOrder * 0.1 + 30 - (Math.max(15 + dist(drone.x, drone.y, shop.x, shop.y) / SPEED, o.prepDone * 0.1) + PICK_SECONDS + o.dMB / SPEED + 1.2);
    expect(slack(y)).toBeGreaterThan(0);
    expect(slack(y)).toBeLessThan(slack(x));

    const result = dispatchRound(state);
    expect(result.dispatched).toEqual([y.id]);
    expect(result.early).toEqual([y.id]);
    expect(y.status).toBe(OrderStatus.Assigned);
    expect(x.status).toBe(OrderStatus.Pending);
    expect(y.early).toBe(true);
    expect(y.tAssign).toBe(150);
    expect(state.pending).toEqual([x.id]);
    expect(state.drones[0]?.state).toBe(DroneState.TakeoffQueue);
    expect(state.stats.early).toEqual([{ step: 150, order: y.id, rule: 'deadline', day: 0, peak: -1 }]);
  });

  it('先到先送：派出更早的订单，不记提前派出', () => {
    const { state, x } = twoOrders('fifo');
    const result = dispatchRound(state);
    expect(result.dispatched).toEqual([x.id]);
    expect(result.early).toEqual([]);
    expect(state.stats.early).toEqual([]);
  });

  it('玩家点击插队的订单先派出，不计入提前派出', () => {
    const { state, x, y } = twoOrders('fifo');
    expect(prioritizeOrder(state, y.id)).toBe(true);
    const result = dispatchRound(state);
    expect(result.dispatched).toEqual([y.id]);
    expect(result.early).toEqual([]);
    expect(x.status).toBe(OrderStatus.Pending);
    // 已经派出的订单不能再插队
    expect(prioritizeOrder(state, y.id)).toBe(false);
  });

  it('先点的先送', () => {
    const state = createState({ ...OPENING, drones: 2 });
    const orders = [0, 1, 2].map((i) => addOrder(state, { merchant: i, building: i, portion: 1, prepSteps: 40, tOrder: 100 + i }));
    state.step = 150;
    prioritizeOrder(state, 2);
    state.step = 152;
    prioritizeOrder(state, 1);
    state.step = 155;
    expect(dispatchRound(state).dispatched).toEqual([2, 1]);
    expect(orders[0]?.status).toBe(OrderStatus.Pending);
  });

  it('没有可用飞机时不派单；飞机在起降口排队也不算可用', () => {
    const { state, x, y } = twoOrders('fifo');
    expect(dispatchRound(state).dispatched).toEqual([x.id]);
    // 唯一的飞机已经接单（等起飞），剩下的订单继续等
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(y.status).toBe(OrderStatus.Pending);
  });

  it('候选情况：飞到店的用时、整趟用时，以及「仅限最近站点」只允许本站的飞机', () => {
    const state = createState({ scenario: 'threeDistricts', drones: 4, rules: { select: 'fifo', zone: 'strict' } });
    const station0 = state.stations[0] as { x: number; y: number };
    // 订单的店在老街，离 0 号站最近
    const shopIndex = state.world.merchants.findIndex((m) => m.district === 0);
    const buildingIndex = state.world.buildings.findIndex((b) => b.district === 1);
    const order = addOrder(state, { merchant: shopIndex, building: buildingIndex, portion: 1, prepSteps: 40 });
    expect(order.home).toBe(0);
    const shop = state.world.merchants[shopIndex] as { x: number; y: number };
    const home = state.world.buildings[buildingIndex] as { x: number; y: number };

    const strict = buildRound(state);
    // 两架飞机在 0 号站，两架在 1 号站；只有 0 号站的两架能接
    expect(strict.ctx.flyTime[0]).toBeCloseTo(dist(station0.x, station0.y, shop.x, shop.y) / SPEED, 12);
    expect(Array.from(strict.ok)).toEqual([1, 1, 0, 0]);
    expect(strict.available).toBe(2);
    expect(strict.eligible).toEqual([order.id]);
    // 整趟：站到店、店到楼、楼回站
    const trip = (dist(station0.x, station0.y, shop.x, shop.y) + order.dMB + dist(home.x, home.y, station0.x, station0.y)) / SPEED;
    expect(strict.ctx.tripTime()[0]).toBeCloseTo(trip, 12);

    setRules(state, { zone: 'global' });
    const global = buildRound(state);
    expect(Array.from(global.ok)).toEqual([1, 1, 1, 1]);
    expect(global.ctx.flyTime[0]).toBeCloseTo(dist(station0.x, station0.y, shop.x, shop.y) / SPEED, 12); // 仍是最近的站
  });

  it('电量不够送完这一趟再回站的飞机不接单', () => {
    const state = createState({ ...OPENING, drones: 2 });
    const order = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 40 });
    const [a, b] = state.drones as [SimState['drones'][number], SimState['drones'][number]];
    a.battery = 800; // 够不上悬停余量和保留电量
    expect(Array.from(buildRound(state).ok)).toEqual([0, 1]);
    b.battery = 800;
    expect(buildRound(state).eligible).toEqual([]);
    state.step = 5;
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(order.status).toBe(OrderStatus.Pending);
  });
});

describe('规则注册表', () => {
  afterEach(() => {
    delete (RULE_REGISTRY.select as Record<string, SelectRule>).newest;
    delete (RULE_REGISTRY.zone as Record<string, ZoneRule>).never;
    delete (RULE_REGISTRY.pool as Record<string, PoolRule>).probe;
  });

  it('每一栏列出已有的卡', () => {
    expect(ruleIds('select')).toEqual(['fifo', 'deadline', 'roundtrip', 'prioOld', 'prioOffice', 'prioCampus']);
    expect(ruleIds('zone')).toEqual(['global', 'hybrid', 'strict']);
    expect(ruleIds('pool')).toEqual(['single', 'same', 'any']);
  });

  it('未知的规则报错，不生效', () => {
    expect(() => getSelectRule('nope')).toThrow();
    expect(() => createState({ rules: { select: 'nope' } })).toThrow();
    const state = createState(OPENING);
    expect(() => setRules(state, { select: 'deadline', zone: 'nope' })).toThrow();
    expect(state.rules).toEqual({ select: 'fifo', zone: 'global', pool: 'single' }); // 整体不生效
    expect(state.stats.ruleChanges).toEqual([]);
  });

  it('换卡记下时刻和前后的卡；换成原来的卡不记', () => {
    const state = createState(OPENING);
    advance(state, 7);
    setRules(state, { select: 'deadline', zone: 'strict' });
    setRules(state, { select: 'deadline' });
    expect(state.stats.ruleChanges).toEqual([
      { step: 7, column: 'select', from: 'fifo', to: 'deadline' },
      { step: 7, column: 'zone', from: 'global', to: 'strict' },
    ]);
  });

  it('新增一张卡只需要在注册表里加一项：新规则可以直接选用并生效', () => {
    const newest: SelectRule = {
      id: 'newest',
      rank: (ctx) => ctx.pendingIds.map((_, k) => k).sort((a, b) => (ctx.state.orders[ctx.pendingIds[b] as number] as Order).tOrder - (ctx.state.orders[ctx.pendingIds[a] as number] as Order).tOrder),
    };
    const never: ZoneRule = { id: 'never', allows: () => false };
    const calls: number[] = [];
    const probe: PoolRule = {
      id: 'probe',
      usesBusyDrones: true,
      pushLimit: 60,
      accepts: (_state, _route, order) => {
        calls.push(order.id);
        return false;
      },
    };
    (RULE_REGISTRY.select as Record<string, SelectRule>).newest = newest;
    (RULE_REGISTRY.zone as Record<string, ZoneRule>).never = never;
    (RULE_REGISTRY.pool as Record<string, PoolRule>).probe = probe;
    expect(ruleIds('select')).toContain('newest');

    // 新的「调度策略」：最新的先送
    const state = createState({ ...OPENING, drones: 1, capacity: 2, rules: { select: 'newest', pool: 'probe' } });
    addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 40, tOrder: 100 });
    const later = addOrder(state, { merchant: 1, building: 1, portion: 1, prepSteps: 40, tOrder: 110 });
    state.step = 150;
    expect(dispatchRound(state).dispatched).toEqual([later.id]);
    // 新的「合单策略」：有路线可插时，对订单问一次能不能一起送。
    // 实际的方案里订单 1 先交给空闲飞机，之后才有路线，所以问了订单 0。
    // 比较名单按下单顺序再算一遍，订单 0 先交给空闲飞机，所以问了订单 1
    expect(calls).toEqual([0, 1]);
    // 没有空闲飞机的轮次也要走派单流程，因为订单可以插进已有任务的飞机
    state.step = 155;
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(calls).toEqual([0, 1, 0]);

    // 新的「协同策略」：谁也不能接
    const idle = createState({ ...OPENING, drones: 1, rules: { zone: 'never' } });
    addOrder(idle, { merchant: 0, building: 0, portion: 1, prepSteps: 40 });
    expect(dispatchRound(idle).dispatched).toEqual([]);
    setRules(idle, { zone: 'global' });
    expect(dispatchRound(idle).dispatched).toEqual([0]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DAY_STEPS,
  DroneState,
  OrderStatus,
  advance,
  createState,
  dayMetrics,
  dayOf,
  meanFromDay2,
  peakAt,
  peakSummary,
  peakWindow,
  runDays,
  runMetrics,
  stationStats,
  summaryStep,
  windowStats,
} from '../src/core/index.ts';
import type { DayMetrics } from '../src/core/index.ts';
import { addOrder } from '../src/core/index.ts';
import { dist } from '../src/core/world.ts';
import { CITY, OPENING, makeOrder, stepEach } from './helpers.ts';

describe('日程', () => {
  it('游戏日、高峰窗口和小结时刻', () => {
    expect(dayOf(0)).toBe(0);
    expect(dayOf(3599)).toBe(0);
    expect(dayOf(3600)).toBe(1);
    expect(peakWindow(0, 'noon')).toEqual({ start: 600, end: 1500 });
    expect(peakWindow(0, 'evening')).toEqual({ start: 2150, end: 3100 });
    expect(peakWindow(2, 'noon')).toEqual({ start: 7800, end: 8700 });
    expect(summaryStep(0, 'noon')).toBe(1800);
    expect(summaryStep(0, 'evening')).toBe(3400);
    expect(summaryStep(1, 'evening')).toBe(DAY_STEPS + 3400);
    expect([599, 600, 1499, 1500, 2149, 2150, 3099, 3100].map(peakAt)).toEqual([-1, 0, 0, -1, -1, 1, 1, -1]);
    expect(peakAt(DAY_STEPS + 700)).toBe(0);
  });
});

describe('时段统计和高峰小结：手工构造的订单', () => {
  // 午高峰是 [600, 1500)，小结在第 1800 步生成。0 到 5 号订单在时段内，6、7 号在时段外。
  function build(): ReturnType<typeof createState> {
    const state = createState({ scenario: 'threeDistricts', drones: 2 });
    const add = (o: Parameters<typeof makeOrder>[0]): void => {
      state.orders.push(makeOrder(o));
    };
    const delivered = { status: OrderStatus.Delivered };
    add({ id: 0, tOrder: 700, district: 0, ...delivered, tAssign: 720, gateWait: 12, tArrive: 800, tPick: 830, tDeliver: 950, rev: 12, tip: 1, home: 0, departed: 0 }); // 准时
    add({ id: 1, tOrder: 800, district: 0, ...delivered, tAssign: 860, gateWait: 20, tArrive: 1000, tPick: 1000, tDeliver: 1200, rev: 7, home: 0, departed: 1 }); // 超时送达，由别的站送
    add({ id: 2, tOrder: 900, district: 1, ...delivered, tAssign: 905, gateWait: 30, tArrive: 1500, tPick: 1520, tDeliver: 1850, rev: 3, home: 0, departed: 0 }); // 小结之后才送到
    add({ id: 3, tOrder: 1000, district: 1, status: OrderStatus.Cancelled, tCancel: 1900 }); // 小结之后才退单
    add({ id: 4, tOrder: 600, district: 0, status: OrderStatus.Cancelled, tCancel: 1500 }); // 小结之前退单，时段第一步
    add({ id: 5, tOrder: 1499, district: 2, ...delivered, tAssign: 1500, gateWait: 0, tArrive: 1600, tPick: 1600, tDeliver: 1700, rev: 5.5, home: 0, departed: 0 }); // 准时，时段最后一步
    add({ id: 6, tOrder: 1500, district: 0, ...delivered, tAssign: 1510, tArrive: 1550, tPick: 1560, tDeliver: 1600, rev: 99, home: 0, departed: 0 }); // 时段之外
    add({ id: 7, tOrder: 599, district: 0, ...delivered, tAssign: 610, tArrive: 650, tPick: 660, tDeliver: 700, rev: 99, home: 0, departed: 0 }); // 时段之外
    return state;
  }

  it('小结口径：时段内下的订单，生成时刻之后才发生的送达和退单都算尚未结束', () => {
    const w = windowStats(build(), 600, 1500, 1800);
    expect(w.nOrders).toBe(6);
    expect(w.nOnTime).toBe(2);
    expect(w.nLateDelivered).toBe(1);
    expect(w.nCancelled).toBe(1);
    expect(w.nUnresolved).toBe(2);
    expect(w.nOnTime + w.nLateDelivered + w.nCancelled + w.nUnresolved).toBe(w.nOrders);
    expect(w.onTimeRate).toBeCloseTo(2 / 6, 12);
    expect(w.cancelRate).toBeCloseTo(1 / 6, 12);
    expect(w.revenue).toBeCloseTo(24.5, 12);
    expect(w.tips).toBeCloseTo(1, 12);
    expect(w.durMean).toBeCloseTo((250 + 400 + 201) / 3 / 10, 9);
    expect(w.districts.map((d) => [d.nOrders, d.nOnTime, d.nCancelled])).toEqual([[3, 1, 1], [2, 0, 0], [1, 1, 0]]);
    expect(w.districts[0]?.onTimeRate).toBeCloseTo(1 / 3, 12);
    expect(w.nonNearestRate).toBeCloseTo(1 / 4, 12); // 派出的四张里有一张不是由最近的站配送
  });

  it('四段时间：等飞机、等起降、等出餐、路上，相加等于平均送达用时', () => {
    const s = windowStats(build(), 600, 1500, 1800).segments;
    expect(s.waitDrone).toBeCloseTo(2.7, 9); // (20 + 60 + 1) / 3 步
    expect(s.waitGate).toBeCloseTo(32 / 3 / 10, 9); // (12 + 20 + 0) / 3 步
    expect(s.waitPrep).toBeCloseTo(1, 9); // (30 + 0 + 0) / 3 步
    expect(s.road).toBeCloseTo(23.6, 9);
    expect(s.total).toBeCloseTo(851 / 30, 9);
    expect(s.waitDrone + s.waitGate + s.waitPrep + s.road).toBeCloseTo(s.total, 9);
  });

  it('不设截止时刻时按最终结局统计', () => {
    const w = windowStats(build(), 600, 1500);
    expect(w.nOnTime).toBe(2);
    expect(w.nLateDelivered).toBe(2);
    expect(w.nCancelled).toBe(2);
    expect(w.nUnresolved).toBe(0);
    expect(w.revenue).toBeCloseTo(27.5, 12);
  });

  it('高峰小结：来单、准时、超时、其中还没送到的、退单、进账', () => {
    const state = build();
    state.step = 1800;
    const summary = peakSummary(state, 0, 'noon');
    expect(summary.generatedAt).toBe(1800);
    expect(summary.ready).toBe(true);
    expect(summary).toMatchObject({ nOrders: 6, nOnTime: 2, nLate: 3, nLateOpen: 2, nCancelled: 1 });
    expect(summary.revenue).toBeCloseTo(24.5, 12);
    expect(summary.nOnTime + summary.nLate + summary.nCancelled).toBe(summary.nOrders);
    expect(summary.districts.map((d) => d.onTimeRate)).toEqual([1 / 3, 0, 1]);
    expect(summary.early).toEqual({ count: 0, rules: [], changedMidPeak: false });
  });

  it('没有订单的片区，比率是 NaN，不是 0', () => {
    const state = createState({ scenario: 'oldStreet', drones: 2 });
    const w = windowStats(state, 600, 1500);
    expect(w.nOrders).toBe(0);
    expect(w.onTimeRate).toBeNaN();
    expect(w.durMean).toBeNaN();
    expect(w.districts[1]?.onTimeRate).toBeNaN();
  });
});

describe('各站的统计：独立重数', () => {
  it('停机位空着的时间比例和平均等降落架数，与逐步重数的结果一致', () => {
    const state = createState({ ...CITY, peakRate: 110, layout: 'single', seed: 42 });
    const station = state.stations[0] as { bays: number; occupied: number };
    let waiting = 0;
    let empty = 0;
    const steps = 1800;
    stepEach(state, steps, (s) => {
      waiting += s.drones.filter((d) => d.state === DroneState.LandQueue).length;
      empty += station.bays - station.occupied;
    });
    const stats = stationStats(state, 0, steps)[0] as { landWaitAvg: number; bayEmptyShare: number };
    expect(stats.landWaitAvg).toBeCloseTo(waiting / steps, 12);
    expect(stats.bayEmptyShare).toBeCloseTo(empty / (station.bays * steps), 12);
    expect(waiting).toBeGreaterThan(0); // 过载时确有飞机在等降落
    expect(stats.bayEmptyShare).toBeGreaterThan(0.3);
  });

  it('没有订单时，停机位全部占用，没有飞机等降落', () => {
    const state = createState({ ...OPENING, peakRate: 0 });
    advance(state, 100);
    const s = stationStats(state, 0, 100)[0] as { landWaitAvg: number; bayEmptyShare: number };
    expect(s).toEqual({ landWaitAvg: 0, bayEmptyShare: 0 });
    const spare = createState({ ...OPENING, peakRate: 0, extraBays: 2 });
    advance(spare, 100);
    expect(stationStats(spare, 0, 100)[0]?.bayEmptyShare).toBeCloseTo(0.5, 12); // 四个停机位里两个空着
  });

  it('时段两端不是整秒时报错', () => {
    const state = createState(OPENING);
    advance(state, 50);
    expect(() => stationStats(state, 3, 50)).toThrow();
  });

  it('不是由离店最近的站配送的订单的比例：「只由最近的站送」为零，「哪座站都能送」大于零', () => {
    const strict = runDays({ ...CITY, rules: { select: 'deadline', zone: 'strict' } }, 2);
    const global = runDays({ ...CITY, rules: { select: 'deadline', zone: 'global' } }, 2);
    expect(windowStats(strict, 0, 7200).nonNearestRate).toBe(0);
    const rate = windowStats(global, 0, 7200).nonNearestRate;
    expect(rate).toBeGreaterThan(0.02);
    expect(rate).toBeLessThan(0.6);
  });
});

describe('第 2 天起的平均', () => {
  it('取第 2 天起各天的平均；只有一天时取第 1 天', () => {
    const state = runDays({ ...CITY, seed: 42 }, 3);
    const { daily, mean } = runMetrics(state, 3);
    expect(daily.length).toBe(3);
    expect(mean.day.nOrders).toBeCloseTo(((daily[1] as DayMetrics).day.nOrders + (daily[2] as DayMetrics).day.nOrders) / 2, 12);
    expect(mean.noon.onTimeRate).toBeCloseTo(((daily[1] as DayMetrics).noon.onTimeRate + (daily[2] as DayMetrics).noon.onTimeRate) / 2, 12);
    expect(mean.evening.stations[0]?.bayEmptyShare).toBeCloseTo(
      ((daily[1] as DayMetrics).evening.stations[0]!.bayEmptyShare + (daily[2] as DayMetrics).evening.stations[0]!.bayEmptyShare) / 2,
      12,
    );
    const one = runDays({ ...CITY, seed: 42 }, 1);
    expect(runMetrics(one, 1).mean.day.nOrders).toBe(dayMetrics(one, 0).day.nOrders);
    // 时段边界对平均没有意义，不在结果里
    expect('start' in mean.day).toBe(false);
  });

  it('比率里没有订单的那一天不参与平均；所有天都没有订单时仍是 NaN', () => {
    const state = runDays({ ...CITY, seed: 42 }, 3);
    const daily = [0, 1, 2].map((d) => dayMetrics(state, d));
    (daily[1] as DayMetrics).day.durMean = Number.NaN;
    expect(meanFromDay2(daily).day.durMean).toBeCloseTo((daily[2] as DayMetrics).day.durMean, 12);
    const old = runDays({ ...OPENING, seed: 42 }, 2);
    expect(runMetrics(old, 2).mean.day.districts[1]?.onTimeRate).toBeNaN();
  });
});

describe('片区的进账、同乘比例、按送达时刻的送达数：手工构造的订单', () => {
  // 与上面同样的八张订单。午高峰 [600, 1500)，小结在第 1800 步生成。
  function build(): ReturnType<typeof createState> {
    const state = createState({ scenario: 'threeDistricts', drones: 2 });
    const add = (o: Parameters<typeof makeOrder>[0]): void => {
      state.orders.push(makeOrder(o));
    };
    const delivered = { status: OrderStatus.Delivered };
    add({ id: 0, tOrder: 700, district: 0, ...delivered, tAssign: 720, tArrive: 800, tPick: 830, tDeliver: 950, rev: 12, tip: 1, shared: true });
    add({ id: 1, tOrder: 800, district: 0, ...delivered, tAssign: 860, tArrive: 1000, tPick: 1000, tDeliver: 1200, rev: 7, shared: true });
    add({ id: 2, tOrder: 900, district: 1, ...delivered, tAssign: 905, tArrive: 1500, tPick: 1520, tDeliver: 1850, rev: 3 }); // 小结之后才送到
    add({ id: 3, tOrder: 1000, district: 1, status: OrderStatus.Cancelled, tCancel: 1900 });
    add({ id: 4, tOrder: 600, district: 0, status: OrderStatus.Cancelled, tCancel: 1500 });
    add({ id: 5, tOrder: 1499, district: 2, ...delivered, tAssign: 1500, tArrive: 1600, tPick: 1600, tDeliver: 1700, rev: 5.5 });
    add({ id: 6, tOrder: 1500, district: 0, ...delivered, tAssign: 1510, tArrive: 1550, tPick: 1560, tDeliver: 1600, rev: 99 }); // 时段之外
    add({ id: 7, tOrder: 599, district: 0, ...delivered, tAssign: 610, tArrive: 650, tPick: 660, tDeliver: 700, rev: 99 }); // 时段之外
    return state;
  }

  it('各片区的进账：送到该片区、在时段内下单、在截止时刻之前送达的订单的进账，三个片区相加等于总进账', () => {
    const w = windowStats(build(), 600, 1500, 1800);
    expect(w.districts.map((d) => d.revenue)).toEqual([19, 0, 5.5]); // 订单 2 在 1850 才送到，不计
    expect(w.districts.reduce((sum, d) => sum + d.revenue, 0)).toBeCloseTo(w.revenue, 12);
    expect(windowStats(build(), 600, 1500).districts.map((d) => d.revenue)).toEqual([19, 3, 5.5]); // 不设截止时刻
  });

  it('没有送达订单的片区，进账是 0', () => {
    const state = createState({ scenario: 'threeDistricts', drones: 2 });
    expect(windowStats(state, 600, 1500).districts.map((d) => d.revenue)).toEqual([0, 0, 0]);
  });

  it('同乘的比例：送达的订单里同乘的占多少，没有送达的订单时是 NaN', () => {
    const w = windowStats(build(), 600, 1500, 1800);
    expect(w.sharedRate).toBeCloseTo(2 / 3, 12); // 送达的是订单 0、1、5，其中 0 和 1 同乘
    expect(windowStats(createState({ scenario: 'threeDistricts', drones: 2 }), 600, 1500).sharedRate).toBeNaN();
  });

  it('时段内送达的订单数按送达时刻算，不论订单是几点下的', () => {
    const state = build();
    // 送达时刻在 [600, 1500) 里的是订单 0（950）、1（1200）、7（700，599 下单，在时段之外下的）
    expect(windowStats(state, 600, 1500).nDeliveredInWindow).toBe(3);
    expect(windowStats(state, 600, 1500).nOrders).toBe(6); // 对比：时段内下的订单
    expect(windowStats(state, 600, 1500, 1000).nDeliveredInWindow).toBe(2); // 截止时刻 1000 之前送达的：订单 0 和 7
  });
});

describe('飞行距离', () => {
  /** 老街一座站、一架飞机、一张订单，送完回站。 */
  function oneTrip(): { state: ReturnType<typeof createState>; legs: { out: number; loaded: number; back: number } } {
    const state = createState({ ...OPENING, drones: 1, peakRate: 0 });
    const station = state.stations[0] as { x: number; y: number };
    const shop = state.world.merchants[0] as { x: number; y: number };
    const home = state.world.buildings[0] as { x: number; y: number };
    const order = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 40 });
    advance(state, 1500);
    expect(order.status).toBe(OrderStatus.Delivered);
    expect(state.drones[0]?.state).toBe(DroneState.Dock);
    return {
      state,
      legs: { out: dist(station.x, station.y, shop.x, shop.y), loaded: order.dMB, back: dist(home.x, home.y, station.x, station.y) },
    };
  }

  it('按游戏日累计：飞机飞过的距离，其中载货的是从店到楼的一段', () => {
    const { state, legs } = oneTrip();
    expect(state.stats.flightTotal.length).toBe(1);
    expect(state.stats.flightTotal[0]).toBeCloseTo(legs.out + legs.loaded + legs.back, 6);
    expect(state.stats.flightLoaded[0]).toBeCloseTo(legs.loaded, 6);
  });

  it('全天一栏给出每张送达订单对应的飞行距离和空飞占比，高峰两栏没有', () => {
    const { state, legs } = oneTrip();
    const m = dayMetrics(state, 0);
    const total = legs.out + legs.loaded + legs.back;
    expect(m.day.distTotal).toBeCloseTo(total, 6);
    expect(m.day.distLoaded).toBeCloseTo(legs.loaded, 6);
    expect(m.day.distPerOrder).toBeCloseTo(total, 6); // 当天送达一张订单
    expect(m.day.emptyShare).toBeCloseTo((legs.out + legs.back) / total, 9);
    for (const scope of [m.noon, m.evening]) {
      expect([scope.distTotal, scope.distLoaded, scope.distPerOrder, scope.emptyShare].every(Number.isNaN)).toBe(true);
    }
  });

  it('飞行距离按步归到那一步所在的游戏日', () => {
    const state = createState({ ...OPENING, drones: 1, peakRate: 0 });
    state.step = DAY_STEPS - 40; // 在第一天结束前 4 秒下单，飞行跨过日界
    const station = state.stations[0] as { x: number; y: number };
    const shop = state.world.merchants[0] as { x: number; y: number };
    const home = state.world.buildings[0] as { x: number; y: number };
    const order = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 40 });
    advance(state, 1500);
    expect(order.status).toBe(OrderStatus.Delivered);
    expect(state.stats.flightTotal.length).toBe(2);
    expect(state.stats.flightTotal[0]).toBeGreaterThan(0);
    expect(state.stats.flightTotal[1]).toBeGreaterThan(0);
    const all = dist(station.x, station.y, shop.x, shop.y) + order.dMB + dist(home.x, home.y, station.x, station.y);
    expect((state.stats.flightTotal[0] as number) + (state.stats.flightTotal[1] as number)).toBeCloseTo(all, 6);
  });

  it('每张送达订单对应的飞行距离按送达时刻归日：当天总飞行距离除以当天送达的订单数', () => {
    const state = createState({ scenario: 'threeDistricts', drones: 2 });
    state.stats.flightTotal = [1000, 600];
    state.stats.flightLoaded = [400, 300];
    const add = (o: Parameters<typeof makeOrder>[0]): void => {
      state.orders.push(makeOrder({ status: OrderStatus.Delivered, ...o }));
    };
    add({ id: 0, tOrder: 100, tDeliver: 500 });
    add({ id: 1, tOrder: 800, tDeliver: 900 });
    add({ id: 2, tOrder: 3500, tDeliver: 3590 });
    add({ id: 3, tOrder: 3590, tDeliver: 3700 }); // 第一天下的单，第二天才送到：计入第二天
    add({ id: 4, tOrder: 4000, tDeliver: 4100 });
    add({ id: 5, tOrder: 7200, tDeliver: 7300 }); // 第三天
    const day0 = dayMetrics(state, 0).day;
    const day1 = dayMetrics(state, 1).day;
    expect(day0.nDeliveredInWindow).toBe(3);
    expect(day1.nDeliveredInWindow).toBe(2);
    expect(day0.distPerOrder).toBeCloseTo(1000 / 3, 12);
    expect(day1.distPerOrder).toBeCloseTo(600 / 2, 12);
    expect(day0.emptyShare).toBeCloseTo(0.6, 12);
    expect(day1.emptyShare).toBeCloseTo(0.5, 12);
    expect(dayMetrics(state, 2).day.distTotal).toBe(0); // 第三天没有飞行记录
    expect(dayMetrics(state, 2).day.emptyShare).toBeNaN();
    // 第 2 天起的平均：两天时取第 2 天
    expect(meanFromDay2([dayMetrics(state, 0), dayMetrics(state, 1)]).day.distPerOrder).toBeCloseTo(300, 12);
  });

  it('没有送达订单的一天，每单飞行距离是 NaN，不是 0 或无穷', () => {
    const state = createState({ scenario: 'threeDistricts', drones: 2 });
    state.stats.flightTotal = [1000];
    state.stats.flightLoaded = [400];
    expect(dayMetrics(state, 0).day.distPerOrder).toBeNaN();
  });

  it('电量耗尽后降速飞行的距离也计入；载货飞行的距离不超过总距离', () => {
    const state = runDays({ ...CITY, peakRate: 110, seed: 42 }, 2);
    for (let day = 0; day < 2; day++) {
      const total = state.stats.flightTotal[day] as number;
      const loaded = state.stats.flightLoaded[day] as number;
      expect(total).toBeGreaterThan(100000);
      expect(loaded).toBeGreaterThan(0.2 * total);
      expect(loaded).toBeLessThanOrEqual(total);
    }
  });

  it('一起送让每单飞行距离变短：载量 2 加顺路的一起送，同样的订单，全天每单飞行距离比一趟送一单少', () => {
    const run = (config: Record<string, unknown>): number =>
      runMetrics(runDays({ ...CITY, peakRate: 82, seed: 42, ...config } as never, 3), 3).mean.day.distPerOrder;
    expect(run({ capacity: 2, rules: { pool: 'any' } })).toBeLessThan(run({}));
  });
});

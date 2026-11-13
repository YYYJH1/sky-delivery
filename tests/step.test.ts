import { describe, expect, it } from 'vitest';
import { DAY_STEPS, DECIDE_EVERY, DEFAULT_CONFIG, DRAIN_STEPS, STEP_MS, STEP_PHASES, advance, createState, makeConfig, runDays, step } from '../src/core/index.ts';
import { CITY, OPENING } from './helpers.ts';

/** 一天内 [a, b) 这段时间里下的订单数。 */
function inside(state: { orders: { tOrder: number }[] }, a: number, b: number): number {
  return state.orders.filter((o) => o.tOrder % DAY_STEPS >= a && o.tOrder % DAY_STEPS < b).length;
}

describe('一步的执行', () => {
  it('固定 100 毫秒一步，一个游戏日 3600 步', () => {
    expect(STEP_MS).toBe(100);
    expect(DAY_STEPS).toBe(3600);
    expect(DECIDE_EVERY).toBe(5);
    expect(DRAIN_STEPS).toBe(2400);
  });

  it('阶段的顺序：日程、产生订单、退单、派单、起降口、飞机、统计、便签（日程和便签只在经营模式里做事）', () => {
    expect(STEP_PHASES.map((p) => p.name)).toEqual(['daily', 'arrivals', 'expire', 'dispatch', 'gates', 'drones', 'stats', 'tips']);
  });

  it('每步让步数加一，观察者在每个阶段前后各调用一次', () => {
    const state = createState(OPENING);
    const log: string[] = [];
    step(state, {
      before: (phase) => log.push(`before ${phase}`),
      after: (phase) => log.push(`after ${phase}`),
    });
    expect(state.step).toBe(1);
    expect(log.length).toBe(2 * STEP_PHASES.length);
    expect(log.slice(0, 4)).toEqual(['before daily', 'after daily', 'before arrivals', 'after arrivals']);
    step(state);
    expect(state.step).toBe(2);
  });

  it('推进的步数必须是非负整数', () => {
    const state = createState(OPENING);
    expect(() => advance(state, -1)).toThrow();
    expect(() => advance(state, 1.5)).toThrow();
    expect(() => advance(state, Number.NaN)).toThrow();
    advance(state, 0);
    expect(state.step).toBe(0);
  });

  it('每 5 步派一次单：所有订单的派单时刻都是 5 的倍数', () => {
    const state = runDays({ ...CITY, seed: 42 }, 1);
    const assigned = state.orders.filter((o) => o.tAssign >= 0);
    expect(assigned.length).toBeGreaterThan(100);
    expect(assigned.filter((o) => o.tAssign % DECIDE_EVERY !== 0)).toEqual([]);
  });
});

describe('订单按步产生', () => {
  it('开局没有订单，也没有预先生成：随机数状态随时间前进', () => {
    const state = createState({ ...CITY, seed: 42 });
    expect(state.orders).toEqual([]);
    const before = structuredClone(state.rng.orders);
    advance(state, 1);
    expect(state.rng.orders).not.toEqual(before);
    advance(state, 1000);
    expect(state.orders.length).toBeGreaterThan(10);
    expect(state.orders.every((o) => o.tOrder < state.step)).toBe(true);
  });

  it('订单的下单时刻不早于创建它的那一步，并且按时间顺序排列', () => {
    const state = createState({ ...CITY, seed: 43 });
    advance(state, 2000);
    const times = state.orders.map((o) => o.tOrder);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(state.orders.map((o) => o.id)).toEqual(state.orders.map((_, i) => i));
  });

  it('到了停止产生订单的那一步，不再产生订单，也不再消耗订单随机数', () => {
    const state = createState({ ...CITY, seed: 42, orderEndStep: 1500 });
    advance(state, 1500);
    const count = state.orders.length;
    const rng = structuredClone(state.rng.orders);
    expect(count).toBeGreaterThan(30);
    advance(state, 2000);
    expect(state.orders.length).toBe(count);
    expect(state.rng.orders).toEqual(rng);
    expect(Math.max(...state.orders.map((o) => o.tOrder))).toBeLessThan(1500);
  });

  it('午高峰的订单最多：高峰时段的单量高于上午和午后', () => {
    const state = runDays({ ...CITY, seed: 42, peakRate: 60 }, 3);
    // 相对来单率：午高峰 [750, 1200) 取 1，上午 [0, 450) 约 0.15 到 0.25，午后 [1500, 2150) 约 0.3
    const perSecond = (a: number, b: number): number => inside(state, a, b) / ((b - a) / 10);
    expect(perSecond(750, 1200)).toBeGreaterThan(2 * perSecond(0, 450));
    expect(perSecond(750, 1200)).toBeGreaterThan(2 * perSecond(1500, 2150));
    expect(perSecond(2320, 2830)).toBeGreaterThan(2 * perSecond(1500, 2150));
  });

  it('送往各片区的订单比例随时段变化：午间偏向写字楼区，晚间偏向大学城', () => {
    const state = runDays({ ...CITY, seed: 42, peakRate: 120 }, 5);
    const share = (a: number, b: number, district: number): number => {
      const orders = state.orders.filter((o) => o.tOrder % DAY_STEPS >= a && o.tOrder % DAY_STEPS < b);
      return orders.filter((o) => o.district === district).length / orders.length;
    };
    expect(inside(state, 600, 1350)).toBeGreaterThan(500);
    expect(share(600, 1350, 1)).toBeGreaterThan(0.45); // 午间 55%
    expect(share(600, 1350, 1)).toBeLessThan(0.65);
    expect(share(2150, 2950, 2)).toBeGreaterThan(0.3); // 晚间 40%
    expect(share(2150, 2950, 2)).toBeLessThan(0.5);
    expect(share(2150, 2950, 1)).toBeLessThan(0.3); // 晚间写字楼区 20%
  });

  it('大单约占 15%，金额是普通订单的 1.8 倍，出餐时间 4 到 10 秒', () => {
    const state = runDays({ ...CITY, seed: 42, peakRate: 120 }, 3);
    const n = state.orders.length;
    const big = state.orders.filter((o) => o.portion === 2).length / n;
    expect(big).toBeGreaterThan(0.12);
    expect(big).toBeLessThan(0.18);
    for (const o of state.orders) {
      const prep = o.prepDone - o.tOrder;
      expect(prep).toBeGreaterThanOrEqual(40);
      expect(prep).toBeLessThanOrEqual(100);
      expect(o.amount).toBeCloseTo((5 + 0.004 * o.dMB) * (o.portion === 2 ? 1.8 : 1), 9);
    }
  });
});

describe('容量标定用的两项配置', () => {
  /** 这段时间里（步，不分天）下的订单数。 */
  const between = (state: { orders: { tOrder: number }[] }, a: number, b: number): number =>
    state.orders.filter((o) => o.tOrder >= a && o.tOrder < b).length;

  it('默认都是关，取值必须是真假', () => {
    expect(DEFAULT_CONFIG.constantRate).toBe(false);
    expect(DEFAULT_CONFIG.noonDestinations).toBe(false);
    expect(makeConfig().constantRate).toBe(false);
    expect(makeConfig().noonDestinations).toBe(false);
    expect(() => makeConfig({ constantRate: 1 as unknown as boolean })).toThrow();
    expect(() => makeConfig({ noonDestinations: 'yes' as unknown as boolean })).toThrow();
  });

  it('明确写成关，得到和不写完全相同的订单序列', () => {
    const plain = createState({ ...CITY, seed: 42 });
    const explicit = createState({ ...CITY, seed: 42, constantRate: false, noonDestinations: false });
    advance(plain, 2000);
    advance(explicit, 2000);
    expect(explicit.orders).toEqual(plain.orders);
    expect(explicit.rng.orders).toEqual(plain.rng.orders);
  });

  it('来单率恒定：每步的来单率与一天里的时刻无关', () => {
    const rate = { ...CITY, peakRate: 120, seed: 42, orderEndStep: 3000 };
    const flat = createState({ ...rate, constantRate: true });
    const curved = createState({ ...rate });
    advance(flat, 3000);
    advance(curved, 3000);
    // 每步的来单数期望是 120 / 60 * 0.1 = 0.2，每 600 步约 120 张
    for (let from = 0; from < 3000; from += 600) {
      const n = between(flat, from, from + 600);
      expect(n, `步 ${from} 起的 600 步`).toBeGreaterThan(85);
      expect(n, `步 ${from} 起的 600 步`).toBeLessThan(155);
    }
    // 对照：默认的到达曲线，开头 60 秒的来单率只有午高峰的零点几倍
    expect(between(curved, 0, 600)).toBeLessThan(0.5 * between(curved, 600, 1200));
  });

  it('来单率恒定时每步的期望来单数等于高峰每分钟订单数除以 60 乘 0.1', () => {
    const state = createState({ ...CITY, peakRate: 60, seed: 43, constantRate: true, orderEndStep: 3000 });
    advance(state, 3000);
    // 每步期望 0.1，3000 步 300 张，标准差约 17
    expect(state.orders.length).toBeGreaterThan(250);
    expect(state.orders.length).toBeLessThan(350);
  });

  it('目的片区固定用午间的比例：任何时段都是老街 30%、写字楼区 55%、大学城 15%', () => {
    const state = createState({ ...CITY, peakRate: 120, seed: 42, constantRate: true, noonDestinations: true, orderEndStep: 4 * DAY_STEPS });
    advance(state, 4 * DAY_STEPS);
    const share = (a: number, b: number, district: number): number => {
      const orders = state.orders.filter((o) => o.tOrder % DAY_STEPS >= a && o.tOrder % DAY_STEPS < b);
      return orders.filter((o) => o.district === district).length / orders.length;
    };
    // 默认下，晚间写字楼区只有 20%，夜间 10%。这里不分时段
    for (const [a, b] of [[0, 600], [2150, 2950], [2950, 3600]] as const) {
      expect(share(a, b, 1), `${a}-${b} 写字楼区`).toBeGreaterThan(0.45);
      expect(share(a, b, 1), `${a}-${b} 写字楼区`).toBeLessThan(0.65);
      expect(share(a, b, 2), `${a}-${b} 大学城`).toBeLessThan(0.25);
    }
  });

  it('两项配置互不影响：只开目的片区，来单率曲线不变；只开来单率，目的片区的时段变化不变', () => {
    const base = { ...CITY, peakRate: 120, seed: 42, orderEndStep: 2 * DAY_STEPS };
    const curve = createState({ ...base });
    const noon = createState({ ...base, noonDestinations: true });
    advance(curve, 2 * DAY_STEPS);
    advance(noon, 2 * DAY_STEPS);
    // 来单时刻与目的无关：用的随机数个数相同，所以下单时刻、店、楼的抽取顺序相同。订单总数和下单时刻相同
    expect(noon.orders.map((o) => o.tOrder)).toEqual(curve.orders.map((o) => o.tOrder));
    expect(noon.orders.map((o) => o.district)).not.toEqual(curve.orders.map((o) => o.district));

    const flat = createState({ ...base, constantRate: true });
    advance(flat, 2 * DAY_STEPS);
    const evening = flat.orders.filter((o) => o.tOrder % DAY_STEPS >= 2150 && o.tOrder % DAY_STEPS < 2950);
    expect(evening.filter((o) => o.district === 1).length / evening.length).toBeLessThan(0.3); // 晚间写字楼区仍是 20%
  });
});

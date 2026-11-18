// 推演：同一状态推演两次结果相同，不修改输入，共用复制和完整复制逐步一致，结论的门槛，无法推演的情形。
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SEQUENCES,
  advanceTo,
  applyOption,
  copyFull,
  copyShared,
  emptyTiming,
  forecast,
  forecastBatch,
  forecastEndStep,
  openCopy,
  sequenceSeed,
  signTestThreshold,
  summarizeForecast,
  verdictOf,
} from '../src/app/index.ts';
import type { ForecastDone, ForecastResult, StateCopier } from '../src/app/index.ts';
import { DAY_STEPS, OrderStatus, createRng, createState, hashState, quoteCommand, step } from '../src/core/index.ts';
import type { Command, SimState } from '../src/core/index.ts';
import { playGame } from '../tools/autoplay-lib.ts';
import { campaignOf, campaignState, quietState, withMoney } from './campaign-helpers.ts';

/** 第 6 天开始时的状态，和第 7 天午高峰中途（天内第 1000 步）的状态，种子 42，均衡玩法。后者有尚无结果的订单。 */
let dayStart: SimState;
let midPeak: SimState;

beforeAll(() => {
  dayStart = playGame('balanced', 42, { days: 6 }).state;
  playGame('balanced', 42, {
    days: 7,
    onStep: (s) => {
      if (s.step === 6 * DAY_STEPS + 1000) midPeak = structuredClone(s);
    },
  });
}, 120_000);

/** 推演用的几个选项：都能在第 6 天的局面上执行。 */
const GATE: Command = { type: 'upgradeGate', station: 0 };
const BOX: Command = { type: 'buyDoubleBox' };
const NEAREST: Command = { type: 'buyNearestLanding' };
const FIFO: Command = { type: 'setRules', rules: { select: 'fifo' } };

function done(result: ForecastResult): ForecastDone {
  if (!result.ok) throw new Error(`forecast unavailable: ${result.reason}`);
  return result;
}

describe('推演的确定性', () => {
  it('同一个状态推演两次，结果完全相同', () => {
    const a = forecast(midPeak, GATE, { sequences: 4 });
    const b = forecast(midPeak, GATE, { sequences: 4 });
    expect(a).toEqual(b);
    expect(done(a).onTimeDiffs).toHaveLength(4);
  });

  it('状态的深复制得到相同的结果，状态内容相同就够，不依赖对象本身', () => {
    const a = forecast(midPeak, BOX, { sequences: 3 });
    const b = forecast(structuredClone(midPeak), BOX, { sequences: 3 });
    expect(a).toEqual(b);
  });

  it('订单序列的种子只由 config.seed、step、盐和序列编号决定', () => {
    const base = sequenceSeed(midPeak, 0);
    expect(sequenceSeed(structuredClone(midPeak), 0)).toBe(base);
    expect(sequenceSeed(midPeak, 1)).not.toBe(base);
    expect(sequenceSeed(midPeak, 0, 1)).not.toBe(base);
    const later = structuredClone(midPeak);
    later.step += 1;
    expect(sequenceSeed(later, 0)).not.toBe(base);
    const other = structuredClone(midPeak);
    other.config.seed += 1;
    expect(sequenceSeed(other, 0)).not.toBe(base);
    // 同一步上先买了东西，种子不变：先后推演不同的选项用的是同一批序列
    const bought = structuredClone(midPeak);
    campaignOf(bought).money += 1000;
    expect(sequenceSeed(bought, 5)).toBe(sequenceSeed(midPeak, 5));
  });

  it('十六套序列的种子互不相同，盐不同时也不同', () => {
    const seeds = new Set<number>();
    for (const salt of [0, 1]) for (let r = 0; r < DEFAULT_SEQUENCES; r++) seeds.add(sequenceSeed(midPeak, r, salt));
    expect(seeds.size).toBe(2 * DEFAULT_SEQUENCES);
  });

  it('盐不同，订单序列不同，每套上的差也不同', () => {
    const a = done(forecast(midPeak, BOX, { sequences: 4, salt: 0 }));
    const b = done(forecast(midPeak, BOX, { sequences: 4, salt: 1 }));
    expect(a.onTimeDiffs).not.toEqual(b.onTimeDiffs);
  });

  it('一个选项推演八套，前四套与推演四套的结果相同，序列数只管用几套', () => {
    const eight = done(forecast(midPeak, BOX, { sequences: 8 }));
    const four = done(forecast(midPeak, BOX, { sequences: 4 }));
    expect(eight.onTimeDiffs.slice(0, 4)).toEqual(four.onTimeDiffs);
    expect(eight.revenueDiffs.slice(0, 4)).toEqual(four.revenueDiffs);
    const prefix = summarizeForecast(eight.onTimeDiffs.slice(0, 4), eight.revenueDiffs.slice(0, 4), { startStep: eight.startStep, endStep: eight.endStep, price: eight.price });
    expect(prefix).toEqual(four);
  });

  it('几个选项一起推演，每个选项的结果与单独推演的相同，无法推演的选项照样给出原因', () => {
    const options: Command[] = [GATE, { type: 'buyDrone', station: 99 }, BOX];
    const batch = forecastBatch(midPeak, options, { sequences: 3 });
    expect(batch).toHaveLength(3);
    expect(batch[0]).toEqual(forecast(midPeak, GATE, { sequences: 3 }));
    expect(batch[1]).toEqual({ ok: false, reason: 'unknownTarget' });
    expect(batch[2]).toEqual(forecast(midPeak, BOX, { sequences: 3 }));
  });
});

describe('推演不修改输入的状态', () => {
  it('推演之后状态的哈希、完整内容和订单对象都与推演之前相同', () => {
    const state = structuredClone(midPeak);
    const hash = hashState(state);
    const json = JSON.stringify(state);
    const orders = state.orders.slice();
    const results = forecastBatch(state, [GATE, BOX, NEAREST, FIFO], { sequences: 3 });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(hashState(state)).toBe(hash);
    expect(JSON.stringify(state)).toBe(json);
    expect(state.orders).toHaveLength(orders.length);
    expect(state.orders.every((o, i) => o === orders[i])).toBe(true);
  });

  it('余额不够的选项也能推演，输入的余额不变，价格照常给出', () => {
    const state = structuredClone(dayStart);
    campaignOf(state).money = 0;
    const result = done(forecast(state, GATE, { sequences: 2 }));
    expect(result.price).toBe(240);
    expect(campaignOf(state).money).toBe(0);
    expect(quoteCommand(state, GATE)).toMatchObject({ ok: false, reason: 'notEnoughMoney', price: 240 });
  });

  it('余额够不够，推演的结果相同，推演给的是订单序列上的差，不涉及余额', () => {
    const rich = structuredClone(dayStart);
    campaignOf(rich).money = 100_000;
    const poor = structuredClone(dayStart);
    campaignOf(poor).money = 0;
    expect(forecast(rich, GATE, { sequences: 2 })).toEqual(forecast(poor, GATE, { sequences: 2 }));
  });
});

describe('推进的终点', () => {
  it('从当前的步往后数第二个小结时刻，再加一', () => {
    const noon = 1800;
    const evening = 3400;
    // 午高峰开始之前：午高峰算第一场，晚高峰是第二场
    expect(forecastEndStep(1)).toBe(evening + 1);
    expect(forecastEndStep(600)).toBe(evening + 1);
    // 午高峰中，或者下单时段已过、小结还没生成：仍是第一场
    expect(forecastEndStep(1000)).toBe(evening + 1);
    expect(forecastEndStep(1700)).toBe(evening + 1);
    // 小结时刻就是现在：这一步还没有执行，小结还没有生成，算第一个
    expect(forecastEndStep(noon)).toBe(evening + 1);
    // 午高峰的小结已经生成：晚高峰是第一场，第二天的午高峰是第二场
    expect(forecastEndStep(noon + 1)).toBe(DAY_STEPS + noon + 1);
    expect(forecastEndStep(2200)).toBe(DAY_STEPS + noon + 1);
    expect(forecastEndStep(evening)).toBe(DAY_STEPS + noon + 1);
    // 晚高峰的小结已经生成
    expect(forecastEndStep(evening + 1)).toBe(DAY_STEPS + evening + 1);
    expect(forecastEndStep(DAY_STEPS - 1)).toBe(DAY_STEPS + evening + 1);
    // 隔天的同一时刻平移
    expect(forecastEndStep(7 * DAY_STEPS + 1000)).toBe(7 * DAY_STEPS + evening + 1);
  });

  it('推进之后正好多出两条小结记录，最后一条在终点的前一步生成', () => {
    for (const tick of [1, 601, 1000, 1700, 1800, 1801, 2200, 3400, 3401, 3599]) {
      const state = structuredClone(dayStart);
      const target = 6 * DAY_STEPS + tick;
      while (state.step < target) step(state);
      const before = campaignOf(state).peaks.length;
      const end = forecastEndStep(state.step);
      const copy = openCopy(state, sequenceSeed(state, 0));
      advanceTo(copy, end);
      const peaks = campaignOf(copy).peaks;
      expect(copy.step, `tick ${tick}`).toBe(end);
      expect(peaks.length - before, `tick ${tick}`).toBe(2);
      expect((peaks[peaks.length - 1] as { step: number }).step, `tick ${tick}`).toBe(end - 1);
    }
  }, 60_000);

  it('结果里的 startStep、endStep、steps 与推进一致', () => {
    const result = done(forecast(midPeak, GATE, { sequences: 2 }));
    expect(result.startStep).toBe(midPeak.step);
    expect(result.endStep).toBe(forecastEndStep(midPeak.step));
    expect(result.steps).toBe(result.endStep - result.startStep);
    expect(result.better + result.worse + result.tied).toBe(result.sequences);
  });
});

describe('两份状态是同一批订单上的配对比较', () => {
  it('订单随机数流换成同一套新序列，派单的随机数流不动，两份副本的新订单相同', () => {
    const seed = sequenceSeed(midPeak, 3);
    const base = openCopy(midPeak, seed);
    const option = openCopy(midPeak, seed);
    expect(base.rng.orders).toEqual(createRng(seed));
    expect(option.rng.orders).toEqual(base.rng.orders);
    expect(base.rng.orders).not.toEqual(midPeak.rng.orders);
    expect(base.rng.dispatch).toEqual(midPeak.rng.dispatch);
    expect(applyOption(option, BOX, 180, true)).toBeNull();
    const end = forecastEndStep(midPeak.step);
    advanceTo(base, end);
    advanceTo(option, end);
    const created = (s: SimState): number[][] => s.orders.slice(midPeak.orders.length).map((o) => [o.tOrder, o.merchant, o.building, o.portion]);
    expect(created(base).length).toBeGreaterThan(20);
    expect(created(option)).toEqual(created(base));
    // 输入的状态没有被推进
    expect(midPeak.step).toBe(6 * DAY_STEPS + 1000);
  });
});

describe('共用复制', () => {
  it('已有结果的订单与输入共用同一个对象，尚无结果的订单是新对象，订单数组是新的', () => {
    expect(midPeak.orders.some((o) => o.status < OrderStatus.Delivered)).toBe(true);
    const copy = copyShared(midPeak);
    expect(copy.orders).not.toBe(midPeak.orders);
    expect(copy.orders).toHaveLength(midPeak.orders.length);
    midPeak.orders.forEach((o, i) => {
      const c = copy.orders[i] as (typeof copy.orders)[number];
      if (o.status === OrderStatus.Delivered || o.status === OrderStatus.Cancelled) expect(c).toBe(o);
      else {
        expect(c).not.toBe(o);
        expect(c).toEqual(o);
      }
    });
    expect(copy).toEqual(midPeak);
    expect(hashState(copy)).toBe(hashState(midPeak));
    // 其余部分都不共用，统计里按秒累计的表也是各自一份
    expect(copy.campaign).not.toBe(midPeak.campaign);
    expect(copy.stats).not.toBe(midPeak.stats);
    expect(copy.stats.landWait).not.toBe(midPeak.stats.landWait);
    midPeak.stats.landWait.forEach((row, i) => expect(copy.stats.landWait[i]).not.toBe(row));
    midPeak.stats.bayEmpty.forEach((row, i) => expect(copy.stats.bayEmpty[i]).not.toBe(row));
    midPeak.stats.bayTotal.forEach((row, i) => expect(copy.stats.bayTotal[i]).not.toBe(row));
    expect(copy.drones).not.toBe(midPeak.drones);
    expect(Object.keys(copy)).toEqual(Object.keys(midPeak));
  });

  /**
   * 同一个选项、同一套序列，完整的 structuredClone 和共用复制各跑一遍，推进的每一步比较状态哈希。
   * 不带选项和带选项各比一对，共四份状态。
   */
  function lockstep(state: SimState, option: Command, seed: number): number {
    const quote = quoteCommand(state, option);
    expect(quote.ok || quote.reason === 'notEnoughMoney').toBe(true);
    const pairs = [false, true].map((withOption) => {
      const make = (copier: StateCopier): SimState => {
        const copy = openCopy(state, seed, copier);
        if (withOption) expect(applyOption(copy, option, quote.price, !quote.ok)).toBeNull();
        return copy;
      };
      return { name: withOption ? '带选项' : '不带选项', full: make(copyFull), shared: make(copyShared) };
    });
    for (const p of pairs) expect(hashState(p.shared), `${p.name}，开始时`).toBe(hashState(p.full));
    const end = forecastEndStep(state.step);
    let compared = 0;
    for (let s = state.step; s < end; s++) {
      for (const p of pairs) {
        step(p.full);
        step(p.shared);
        const a = hashState(p.full);
        const b = hashState(p.shared);
        if (a !== b) expect(b, `${p.name}，第 ${s} 步之后`).toBe(a);
        compared += 1;
      }
    }
    return compared;
  }

  it('每一步的状态哈希与完整复制相同：双层货箱，午高峰中途的局面', () => {
    const compared = lockstep(midPeak, BOX, sequenceSeed(midPeak, 0));
    expect(compared).toBe(2 * (forecastEndStep(midPeak.step) - midPeak.step));
  }, 120_000);

  it('每一步的状态哈希与完整复制相同：起降口升级，换一套序列，余额不够时补足', () => {
    const state = structuredClone(midPeak);
    campaignOf(state).money = 0;
    lockstep(state, GATE, sequenceSeed(state, 7, 1));
  }, 120_000);

  it('整个推演的结果与完整复制相同', () => {
    for (const option of [BOX, NEAREST, FIFO]) {
      expect(forecast(midPeak, option, { sequences: 3, copy: copyShared })).toEqual(forecast(midPeak, option, { sequences: 3, copy: copyFull }));
    }
  });

  it('共用的订单冻结之后整段推演，核心没有往已有结果的订单里写', () => {
    const state = structuredClone(midPeak);
    const frozen: StateCopier = (s) => {
      const copy = copyShared(s);
      for (const o of copy.orders) if (o.status === OrderStatus.Delivered || o.status === OrderStatus.Cancelled) Object.freeze(o);
      return copy;
    };
    const results = forecastBatch(state, [GATE, BOX, NEAREST, FIFO], { sequences: 2, copy: frozen });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(state.orders.some((o) => Object.isFrozen(o))).toBe(true);
    expect(results).toEqual(forecastBatch(midPeak, [GATE, BOX, NEAREST, FIFO], { sequences: 2, copy: copyFull }));
  });

  it('共用复制比完整复制快，耗时记在 timing 里', () => {
    const full = emptyTiming(() => performance.now());
    const shared = emptyTiming(() => performance.now());
    forecast(dayStart, GATE, { sequences: 2, copy: copyFull, timing: full });
    forecast(dayStart, GATE, { sequences: 2, copy: copyShared, timing: shared });
    expect(shared.copies).toBe(4);
    expect(shared.steps).toBe(4 * (forecastEndStep(dayStart.step) - dayStart.step));
    expect(shared.copyMs).toBeGreaterThan(0);
    expect(shared.advanceMs).toBeGreaterThan(0);
  });
});

describe('轻量推进', () => {
  // 推演的两份副本默认用轻量的一步（核心的 stepLight），不算「提前派出」的比较名单。推演只读准时单数和收入，结果必须与完整推进的逐位相同。
  // 状态逐步对比（去掉提前派出的记录之后哈希相同）见 dispatch-light.test.ts。
  it('午高峰中途的局面：四个选项，结果与 light: false（每一步用 step）的逐位相同，共用复制和完整复制各比一遍', () => {
    const options = [GATE, BOX, NEAREST, FIFO];
    for (const copy of [copyShared, copyFull]) {
      const light = forecastBatch(midPeak, options, { sequences: 3, copy });
      const full = forecastBatch(midPeak, options, { sequences: 3, copy, light: false });
      expect(light.every((r) => r.ok)).toBe(true);
      expect(light).toEqual(full);
    }
  });

  it('第 6 天开始的局面：策略换卡和购买，结果与 light: false 的逐位相同', () => {
    const options: Command[] = [GATE, BOX, { type: 'setRules', rules: { zone: 'strict' } }, { type: 'setRules', rules: { select: 'roundtrip' } }];
    const light = forecastBatch(dayStart, options, { sequences: 4 });
    const full = forecastBatch(dayStart, options, { sequences: 4, light: false });
    expect(light).toEqual(full);
  });

  it('advanceTo 缺省仍用 step：同一份副本推进到同一步，light 为真时只差提前派出的记录', () => {
    const a = openCopy(midPeak, sequenceSeed(midPeak, 0));
    const b = openCopy(midPeak, sequenceSeed(midPeak, 0));
    const end = forecastEndStep(midPeak.step);
    advanceTo(a, end);
    advanceTo(b, end, true);
    expect(b.stats.early).toHaveLength(midPeak.stats.early.length);
    expect(a.stats.early.length).toBeGreaterThan(midPeak.stats.early.length);
    const peaks = (s: SimState): unknown[] => campaignOf(s).peaks.slice(campaignOf(midPeak).peaks.length).map((p) => [p.onTime, p.late, p.lateOpen, p.cancelled, p.revenue]);
    expect(peaks(b)).toEqual(peaks(a));
  });
});

describe('结论的门槛', () => {
  it('16 套时门槛是 13，对应符号检验的双侧 5%', () => {
    expect(DEFAULT_SEQUENCES).toBe(16);
    expect(signTestThreshold(16)).toBe(13);
    // 13 次：双侧 2.13%，12 次：双侧 7.68%
    const tail = (n: number, k: number): bigint => {
      let sum = 0n;
      let choose = 1n;
      for (let j = 0; j <= n; j++) {
        if (j >= k) sum += choose;
        choose = (choose * BigInt(n - j)) / BigInt(j + 1);
      }
      return sum;
    };
    expect(tail(16, 13)).toBe(697n);
    expect(tail(16, 12)).toBe(2517n);
  });

  it('其他序列数的门槛用同一个检验算出：最小的 k 使 2 × P(X ≥ k) 不大于 5%', () => {
    for (let n = 1; n <= 120; n++) {
      // 用整数精确算：2 × tail / 2^n ≤ 1/20 等价于 40 × tail ≤ 2^n
      let want = n + 1;
      for (let k = n; k >= 1; k--) {
        let tail = 0n;
        let choose = 1n;
        for (let j = 0; j <= n; j++) {
          if (j >= k) tail += choose;
          choose = (choose * BigInt(n - j)) / BigInt(j + 1);
        }
        if (40n * tail > 2n ** BigInt(n)) break;
        want = k;
      }
      expect(signTestThreshold(n), `n = ${n}`).toBe(want);
    }
    // 几个常见的值
    expect(signTestThreshold(5)).toBe(6);
    expect(signTestThreshold(6)).toBe(6);
    expect(signTestThreshold(8)).toBe(8);
    expect(signTestThreshold(10)).toBe(9);
    expect(signTestThreshold(32)).toBe(23);
    expect(signTestThreshold(64)).toBe(41);
  });

  it('更好的次数不少于门槛为更好，更差的次数不少于门槛为更差，其余差别不明显', () => {
    expect(verdictOf(13, 0, 16)).toBe('better');
    expect(verdictOf(16, 0, 16)).toBe('better');
    expect(verdictOf(12, 0, 16)).toBe('unclear');
    expect(verdictOf(12, 4, 16)).toBe('unclear');
    expect(verdictOf(0, 13, 16)).toBe('worse');
    expect(verdictOf(3, 13, 16)).toBe('worse');
    expect(verdictOf(0, 12, 16)).toBe('unclear');
    expect(verdictOf(4, 12, 16)).toBe('unclear');
    expect(verdictOf(8, 8, 16)).toBe('unclear');
    // 持平的套数不算更好，也不算更差
    expect(verdictOf(12, 0, 16)).toBe('unclear');
    expect(verdictOf(0, 0, 16)).toBe('unclear');
    // 序列数不同时门槛不同
    expect(verdictOf(8, 0, 8)).toBe('better');
    expect(verdictOf(7, 0, 8)).toBe('unclear');
    expect(verdictOf(41, 0, 64)).toBe('better');
    expect(verdictOf(40, 0, 64)).toBe('unclear');
  });

  it('汇总：次数、平均值、结论和门槛', () => {
    const onTime = [3, 2, 0, -1, 4, 0, 5, 1, 2, 3, 1, 1, 2, 2, 6, 1];
    const revenue = onTime.map((d) => d * 4.5);
    const r = summarizeForecast(onTime, revenue, { startStep: 10, endStep: 3411, price: 240 });
    expect(r).toMatchObject({ sequences: 16, better: 13, worse: 1, tied: 2, verdict: 'better', threshold: 13, steps: 3401, price: 240 });
    expect(r.meanOnTime).toBeCloseTo(32 / 16, 12);
    expect(r.meanRevenue).toBeCloseTo((32 * 4.5) / 16, 12);
    const flipped = summarizeForecast(onTime.map((d) => -d), revenue.map((d) => -d), { startStep: 10, endStep: 3411, price: 0 });
    expect(flipped).toMatchObject({ better: 1, worse: 13, tied: 2, verdict: 'worse' });
  });

  it('真实状态上默认 16 套，结论与次数一致', () => {
    const r = done(forecast(dayStart, FIFO));
    expect(r.sequences).toBe(16);
    expect(r.threshold).toBe(13);
    expect(r.onTimeDiffs).toHaveLength(16);
    expect(r.revenueDiffs).toHaveLength(16);
    expect(r.verdict).toBe(verdictOf(r.better, r.worse, 16));
  }, 60_000);
});

describe('无法推演', () => {
  it('沙盒模式的状态：不是经营模式', () => {
    expect(forecast(createState({}), GATE, { sequences: 2 })).toEqual({ ok: false, reason: 'notCampaign' });
  });

  it('价签还没开放：买不了，也就没有推演', () => {
    const state = campaignState();
    expect(forecast(state, GATE, { sequences: 2 })).toEqual({ ok: false, reason: 'priceTagsLocked' });
    expect(forecast(state, BOX, { sequences: 2 })).toEqual({ ok: false, reason: 'priceTagsLocked' });
  });

  it('核心给出的各种失败原因原样返回，状态一点不变', () => {
    const state = withMoney(quietState());
    const hash = hashState(state);
    const cases: [Command, string][] = [
      [{ type: 'upgradeGate', station: 99 }, 'unknownTarget'],
      [{ type: 'buyNearestLanding' }, 'needTwoStations'],
      [{ type: 'setNearestLanding', on: true }, 'ruleLocked'],
      [{ type: 'buyDrone', station: 0 }, 'fleetFull'],
      [{ type: 'setRules', rules: { select: 'nope' } }, 'unknownRule'],
      [{ type: 'setRules', rules: { select: 'fifo' }, peak: 'noon' }, 'noRuleSets'],
      [{ type: 'openDistrict', district: 1 }, 'needStars'],
    ];
    for (const [option, reason] of cases) {
      expect(forecast(state, option, { sequences: 2 }), JSON.stringify(option)).toEqual({ ok: false, reason });
    }
    expect(hashState(state)).toBe(hash);
  });

  it('已经买过的、已到最高级的：不能推演', () => {
    const state = structuredClone(dayStart);
    state.capacity = 2;
    campaignOf(state).stations[0]!.gateLevel = 3;
    expect(forecast(state, BOX, { sequences: 2 })).toEqual({ ok: false, reason: 'alreadyOwned' });
    expect(forecast(state, GATE, { sequences: 2 })).toEqual({ ok: false, reason: 'gateMax' });
  });

  it('余额不够以外的原因优先：余额不够的选项才补足', () => {
    const state = structuredClone(dayStart);
    campaignOf(state).money = 0;
    expect(forecast(state, { type: 'buyDrone', station: 99 }, { sequences: 2 })).toEqual({ ok: false, reason: 'unknownTarget' });
  });

  it('选项的序列数不合法时抛错', () => {
    expect(() => forecast(dayStart, GATE, { sequences: 0 })).toThrow(RangeError);
    expect(() => forecast(dayStart, GATE, { sequences: 2.5 })).toThrow(RangeError);
  });

  it('一个选项也不能推演时，不复制状态，直接返回', () => {
    const timing = emptyTiming(() => performance.now());
    const result = forecast(dayStart, { type: 'upgradeGate', station: 99 }, { timing });
    expect(result.ok).toBe(false);
    expect(timing.copies).toBe(0);
  });
});

describe('没有订单的局面', () => {
  it('安静的状态：每套的差都是 0，差别不明显，不报错', () => {
    const state = withMoney(quietState());
    const r = done(forecast(state, { type: 'buyBay', station: 0 }, { sequences: 3 }));
    expect(r.onTimeDiffs).toEqual([0, 0, 0]);
    expect(r.revenueDiffs).toEqual([0, 0, 0]);
    expect(r).toMatchObject({ better: 0, worse: 0, tied: 3, verdict: 'unclear' });
  });
});

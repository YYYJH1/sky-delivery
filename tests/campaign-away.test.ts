// 离开期间的进账：公式的各种情况，余额和记录，不改别的状态，确定性。
import { describe, expect, it } from 'vitest';
import {
  AWAY_CAP_SECONDS,
  AWAY_DAY_SECONDS,
  AWAY_LOG_LIMIT,
  AWAY_PERCENT,
  DAY_STEPS,
  advance,
  createRng,
  createState,
  hashState,
  nextInt,
  quoteAway,
  settleAway,
} from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { awaySecondsSince } from '../src/app/index.ts';
import { playGame } from '../tools/autoplay-lib.ts';
import { campaignOf } from './campaign-helpers.ts';

/**
 * 摆一个经营模式状态：走到第 day 天（从 0 数起）的第 stepInDay 步，每个游戏日的订单进账由 income 给定。
 * 不推进模拟，只改步数和进账，公式只看这两样。
 */
function stateAt(day: number, income: number[], stepInDay = 0): SimState {
  const state = createState({ mode: 'campaign', seed: 1 });
  state.step = day * DAY_STEPS + stepInDay;
  campaignOf(state).income = income.slice();
  return state;
}

describe('常量：离开结算的几个数', () => {
  it('30%，上限 30 分钟，一个游戏日 360 秒，每秒进账看最近两个游戏日', () => {
    expect(AWAY_PERCENT).toBe(30);
    expect(AWAY_CAP_SECONDS).toBe(1800);
    expect(AWAY_DAY_SECONDS).toBe(360);
    // 上限相当于 1.5 个游戏日的进账：1800 × 30% = 540 秒 = 1.5 × 360
    expect((AWAY_CAP_SECONDS * AWAY_PERCENT) / 100 / AWAY_DAY_SECONDS).toBe(1.5);
  });
});

describe('公式：每秒进账 × 离开的秒数 × 30%', () => {
  it('两个完整的游戏日：合计 1440，每秒 2，离开 600 秒，得 2 × 600 × 30% = 360', () => {
    const state = stateAt(2, [1000, 440]);
    const quote = quoteAway(state, 600);
    expect(quote).toEqual({ days: 2, rate: 2, counted: 600, amount: 360 });
    const money = campaignOf(state).money;
    const record = settleAway(state, 600);
    expect(record).toEqual({ step: 2 * DAY_STEPS, seconds: 600, amount: 360 });
    expect(campaignOf(state).money).toBe(money + 360);
  });

  it('取最近的两个完整游戏日，更早的不算，正在过的这一天也不算', () => {
    // 第 3 天里：完整的是第 0、1、2 天，取第 1、2 天。第 3 天已经有进账，但还没结束
    const state = stateAt(3, [5000, 1000, 440, 99999], 1234);
    expect(quoteAway(state, 600)).toMatchObject({ days: 2, rate: 2, amount: 360 });
  });

  it('只完成了一个游戏日：用这一天，除以 360 秒', () => {
    // 第 1 天里：完整的只有第 0 天。第 1 天的进账还在累计，不算
    const state = stateAt(1, [720, 99999], 2000);
    const quote = quoteAway(state, 600);
    expect(quote).toEqual({ days: 1, rate: 2, counted: 600, amount: 360 });
    // 第 1 天刚好结束的那一步，第 0 天算完整，第 1 天还不算
    expect(quoteAway(stateAt(1, [720, 99999], 0), 600).days).toBe(1);
  });

  it('第二天刚结束时，才用两天', () => {
    expect(quoteAway(stateAt(2, [720, 720], 0), 600).days).toBe(2);
    expect(quoteAway(stateAt(2, [720, 720], DAY_STEPS - 1), 600).days).toBe(2);
    expect(quoteAway(stateAt(1, [720, 720], DAY_STEPS - 1), 600).days).toBe(1);
  });

  it('第一个游戏日还没结束：不结算，余额不变，没有记录', () => {
    for (const step of [0, 1, 1800, DAY_STEPS - 1]) {
      const state = stateAt(0, [], step);
      campaignOf(state).income = [5000];
      const before = JSON.stringify(state);
      expect(quoteAway(state, 600)).toMatchObject({ days: 0, amount: 0 });
      expect(settleAway(state, 600)).toBeNull();
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it('不扣除购买支出：只看订单进账，花了多少钱、余额是多少都不影响', () => {
    const rich = stateAt(2, [1000, 440]);
    const poor = stateAt(2, [1000, 440]);
    campaignOf(rich).money = 100_000;
    campaignOf(poor).money = 0;
    campaignOf(poor).spent = 50_000;
    expect(settleAway(rich, 600)?.amount).toBe(360);
    expect(settleAway(poor, 600)?.amount).toBe(360);
  });

  it('离开超过 30 分钟的部分不计：1800 秒是上限，再久也一样', () => {
    const cases: [number, number][] = [
      [1799, 1079],
      [1800, 1080],
      [1801, 1080],
      [3600, 1080],
      [86_400, 1080],
    ];
    for (const [seconds, amount] of cases) {
      const state = stateAt(2, [1000, 440]);
      const record = settleAway(state, seconds);
      expect(record?.amount, `${seconds} 秒`).toBe(amount);
      // 记录里记的是真实的离开时间，不是截断之后的
      expect(record?.seconds).toBe(seconds);
    }
    // 上限相当于 1.5 个游戏日的进账：两天各 720 时，一天是 720，上限是 1080
    expect(settleAway(stateAt(2, [720, 720]), 99_999)?.amount).toBe(1.5 * 720);
  });

  it('零秒、负数、不是有限数字：不结算', () => {
    for (const seconds of [0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const state = stateAt(2, [1000, 440]);
      const before = JSON.stringify(state);
      expect(settleAway(state, seconds), String(seconds)).toBeNull();
      expect(quoteAway(state, seconds).amount).toBe(0);
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it('系统时间被调回过去：离开的秒数算成 0，不发放', () => {
    const state = stateAt(2, [1000, 440]);
    const before = JSON.stringify(state);
    const saved = 1_731_400_000_000;
    // 现在的墙上时间早于存档里的保存时间
    expect(awaySecondsSince(saved, saved - 60_000)).toBe(0);
    expect(settleAway(state, awaySecondsSince(saved, saved - 60_000))).toBeNull();
    expect(settleAway(state, awaySecondsSince(saved, Number.NaN))).toBeNull();
    expect(JSON.stringify(state)).toBe(before);
    // 正常的情形：离开 10 分钟
    expect(settleAway(state, awaySecondsSince(saved, saved + 600_000))?.amount).toBe(360);
  });

  it('金额向下取整，不足一元的不结算也不记录', () => {
    // 一天进账 7，每秒 7/360，离开 600 秒：7/360 × 600 × 30% = 3.5，取 3
    const state = stateAt(1, [7]);
    expect(settleAway(state, 600)?.amount).toBe(3);
    // 每秒 1/360，离开 60 秒：0.05，不足一元
    const tiny = stateAt(1, [1]);
    const before = JSON.stringify(tiny);
    expect(quoteAway(tiny, 60).amount).toBe(0);
    expect(settleAway(tiny, 60)).toBeNull();
    expect(JSON.stringify(tiny)).toBe(before);
    // 刚好一元
    expect(settleAway(stateAt(1, [360]), 10 / 3 + 0.0001)?.amount).toBe(1);
  });

  it('两个游戏日都没有进账（没送出过订单）：没有可发的，不结算', () => {
    expect(settleAway(stateAt(2, [0, 0]), 600)).toBeNull();
    expect(settleAway(stateAt(2, []), 600)).toBeNull();
    // 进账数组比完整的天数短（最近的几天没有送达的订单，没来得及补零）：缺的按 0
    expect(quoteAway(stateAt(3, [720]), 600).amount).toBe(0);
    expect(quoteAway(stateAt(3, [720, 720]), 600)).toMatchObject({ days: 2, rate: 1, amount: 180 });
  });

  it('和精确的整数算术一致：随机的进账和秒数，不会因为浮点误差差一元', () => {
    // 进账、秒数都取整数时，金额是整数除法的结果：进账合计 × 秒数 × 30 ÷ (天数 × 360 × 100) 向下取整
    const rng = createRng(20261113);
    for (let i = 0; i < 3000; i++) {
      const days = 1 + nextInt(rng, 2);
      const income = [nextInt(rng, 5000), nextInt(rng, 5000)];
      const seconds = 1 + nextInt(rng, 2400);
      const state = stateAt(days, days === 1 ? [income[0] as number] : income);
      const sum = days === 1 ? (income[0] as number) : income[0]! + income[1]!;
      const counted = Math.min(seconds, AWAY_CAP_SECONDS);
      const exact = (BigInt(sum) * BigInt(counted) * 30n) / (BigInt(days) * 36_000n);
      expect(quoteAway(state, seconds).amount, `${JSON.stringify(income)} ${days} 天 ${seconds} 秒`).toBe(Number(exact));
    }
  });

  it('沙盒模式没有余额：什么也不做', () => {
    const sandbox = createState({ mode: 'sandbox' });
    sandbox.step = 5 * DAY_STEPS;
    const before = JSON.stringify(sandbox);
    expect(settleAway(sandbox, 600)).toBeNull();
    expect(quoteAway(sandbox, 600)).toEqual({ days: 0, rate: 0, counted: 0, amount: 0 });
    expect(JSON.stringify(sandbox)).toBe(before);
  });
});

describe('余额和记录', () => {
  it('进账加进余额，记一条记录：游戏内的步、离开的秒数、金额', () => {
    const state = stateAt(2, [1000, 440], 777);
    campaignOf(state).money = 12.5;
    const record = settleAway(state, 612.25);
    expect(record).toEqual({ step: 2 * DAY_STEPS + 777, seconds: 612.25, amount: 367 });
    expect(campaignOf(state).money).toBe(12.5 + 367);
    expect(campaignOf(state).away).toEqual([record]);
  });

  it('每次结算各记一条，按先后排；返回的是副本，改它不影响状态里的记录', () => {
    const state = stateAt(2, [1000, 440]);
    const a = settleAway(state, 600);
    state.step += 100;
    const b = settleAway(state, 1200);
    expect(campaignOf(state).away).toEqual([
      { step: 2 * DAY_STEPS, seconds: 600, amount: 360 },
      { step: 2 * DAY_STEPS + 100, seconds: 1200, amount: 720 },
    ]);
    (a as { amount: number }).amount = -1;
    (b as { seconds: number }).seconds = -1;
    expect(campaignOf(state).away.map((r) => [r.seconds, r.amount])).toEqual([
      [600, 360],
      [1200, 720],
    ]);
  });

  it('记录最多留最近的 100 条', () => {
    const state = stateAt(2, [1000, 440]);
    for (let i = 0; i < AWAY_LOG_LIMIT + 7; i++) {
      state.step += 1;
      expect(settleAway(state, 600)).not.toBeNull();
    }
    const log = campaignOf(state).away;
    expect(log).toHaveLength(AWAY_LOG_LIMIT);
    expect(log[0]?.step).toBe(2 * DAY_STEPS + 8);
    expect(log[log.length - 1]?.step).toBe(2 * DAY_STEPS + AWAY_LOG_LIMIT + 7);
  });

  it('开局的状态里记录是空的，进状态哈希：结算之后哈希变了', () => {
    const fresh = createState({ mode: 'campaign', seed: 1 });
    expect(campaignOf(fresh).away).toEqual([]);
    const state = stateAt(2, [1000, 440]);
    const before = hashState(state);
    settleAway(state, 600);
    expect(hashState(state)).not.toBe(before);
    // 只有记录不同的两个状态，哈希也不同（记录进了哈希，不只是余额）
    const a = stateAt(2, [1000, 440]);
    const b = stateAt(2, [1000, 440]);
    campaignOf(a).away.push({ step: 1, seconds: 2, amount: 3 });
    expect(hashState(a)).not.toBe(hashState(b));
  });
});

describe('不改别的：游戏内时间、口碑、订单、飞机、站点', () => {
  it('结算前后，除了余额和离开的记录，整个状态逐字段相同', () => {
    const { state } = playGame('balanced', 11, { days: 3 });
    const before = structuredClone(state);
    const record = settleAway(state, 900);
    expect(record).not.toBeNull();
    const after = structuredClone(state);
    // 把这两处改回去，其余必须一模一样
    campaignOf(after).money = campaignOf(before).money;
    campaignOf(after).away = campaignOf(before).away;
    expect(after).toEqual(before);
    expect(state.step).toBe(before.step);
  });

  it('结算之后接着运行：订单、飞机、口碑与不结算时完全相同，余额多出的正是这笔钱', () => {
    const { state } = playGame('balanced', 11, { days: 3 });
    const settled = structuredClone(state);
    const plain = structuredClone(state);
    const record = settleAway(settled, 900) as { amount: number };
    advance(settled, 2 * DAY_STEPS);
    advance(plain, 2 * DAY_STEPS);
    expect(settled.step).toBe(plain.step);
    expect(settled.orders).toEqual(plain.orders);
    expect(settled.drones).toEqual(plain.drones);
    expect(settled.stations).toEqual(plain.stations);
    expect(campaignOf(settled).districts).toEqual(campaignOf(plain).districts);
    expect(campaignOf(settled).days).toEqual(campaignOf(plain).days);
    expect(campaignOf(settled).income).toEqual(campaignOf(plain).income);
    expect(campaignOf(settled).money - campaignOf(plain).money).toBeCloseTo(record.amount, 6);
  });
});

describe('确定性', () => {
  it('同样的状态和秒数，得到同样的结果和同样的哈希', () => {
    const a = stateAt(2, [1000.5, 440.25]);
    const b = stateAt(2, [1000.5, 440.25]);
    for (const seconds of [1, 59.5, 600, 1799.9, 5000]) {
      expect(quoteAway(a, seconds)).toEqual(quoteAway(b, seconds));
      expect(settleAway(a, seconds)).toEqual(settleAway(b, seconds));
      expect(hashState(a)).toBe(hashState(b));
    }
  });

  it('只算不改：quoteAway 不动状态，连问几次答案一样', () => {
    const state = stateAt(2, [1000, 440]);
    const before = JSON.stringify(state);
    const first = quoteAway(state, 600);
    for (let i = 0; i < 5; i++) expect(quoteAway(state, 600)).toEqual(first);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('真实跑出来的进账：与直接从 income 算出来的相同', () => {
    const { state } = playGame('balanced', 7, { days: 5 });
    const income = campaignOf(state).income;
    const completed = Math.floor(state.step / DAY_STEPS);
    const sum = (income[completed - 1] ?? 0) + (income[completed - 2] ?? 0);
    const expected = Math.floor((sum * 800 * 0.3) / 720 + 1e-9);
    expect(sum).toBeGreaterThan(0);
    expect(expected).toBeGreaterThan(10);
    expect(settleAway(state, 800)?.amount).toBe(expected);
  });
});

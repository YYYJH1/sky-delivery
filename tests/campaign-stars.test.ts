// 日结和口碑：日结按结果产生的步归日，口碑按最近两个游戏日升星、掉星，升星后新店开张，片区纸条的数据，新店位置的方位。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { STARS_V1 } from '../src/content/stars_v1.ts';
import {
  DAY_STEPS,
  OrderStatus,
  STEP_PHASES,
  advance,
  createState,
  decideStar,
  districtLambda,
  districtNote,
  hashState,
  keepRule,
  meetsRule,
  newShopAt,
  pickNoteKind,
  placeDirection,
  refreshShops,
  settleDay,
  starRule,
  step,
  tallyResults,
  windowOfDay,
} from '../src/core/index.ts';
import type { ResultCounts, SimState, StepObserver } from '../src/core/index.ts';
import { batchOrders, campaignOf, campaignState, clickOpening, outcomeOrder, quietState, runningState } from './campaign-helpers.ts';
import { OPENING } from './helpers.ts';

/** 手写一组统计：n 张有结果，其中 onTime 张准时，cancelled 张退单，其余超时。 */
function counts(n: number, onTime: number, cancelled: number): ResultCounts {
  return { n, onTime, late: n - onTime - cancelled, cancelled };
}

describe('星级条件的内容表', () => {
  it('二星 55%（初值是 60%），三星 75% 且退单低于 8%，四星 85% 且低于 4%，五星 92% 且低于 2%', () => {
    expect(STARS_V1.rules).toEqual([
      { star: 2, onTimeMin: 55, cancelBelow: null },
      { star: 3, onTimeMin: 75, cancelBelow: 8 },
      { star: 4, onTimeMin: 85, cancelBelow: 4 },
      { star: 5, onTimeMin: 92, cancelBelow: 2 },
    ]);
    expect([STARS_V1.maxStar, STARS_V1.windowDays, STARS_V1.dropFromStar, STARS_V1.dropAfterMisses, STARS_V1.endingStar]).toEqual([5, 2, 3, 2, 4]);
  });

  it('最少样本：最近两天完成的订单少于 10 张，这次日结星级不变', () => {
    expect(STARS_V1.minSample).toBe(10);
  });

  it('保住星级要达到下面一档的升星条件：三星看二星，四星看三星，五星看四星，二星及以下不会掉星', () => {
    expect(keepRule(1)).toBeNull();
    expect(keepRule(2)).toBeNull();
    expect(keepRule(3)).toEqual(starRule(2));
    expect(keepRule(4)).toEqual(starRule(3));
    expect(keepRule(5)).toEqual(starRule(4));
    expect(starRule(1)).toBeNull();
    expect(starRule(6)).toBeNull();
  });
});

describe('条件的边界：整数比较，恰好达到算达到', () => {
  const two = starRule(2) as NonNullable<ReturnType<typeof starRule>>;
  const three = starRule(3) as NonNullable<ReturnType<typeof starRule>>;

  it('准时率不小于要求：60% 恰好算，差一张不算，二星不限退单率，没有订单不算达到', () => {
    expect(meetsRule(two, counts(10, 6, 4))).toBe(true);
    expect(meetsRule(two, counts(10, 5, 0))).toBe(false);
    expect(meetsRule(two, counts(5, 3, 0))).toBe(true); // 3 / 5 = 60%
    expect(meetsRule(two, counts(0, 0, 0))).toBe(false);
  });

  it('退单率要低于要求：恰好等于 8% 不算，7% 算；准时率差一张不算', () => {
    expect(meetsRule(three, counts(100, 75, 7))).toBe(true);
    expect(meetsRule(three, counts(100, 75, 8))).toBe(false);
    expect(meetsRule(three, counts(100, 74, 0))).toBe(false);
    expect(meetsRule(three, counts(25, 19, 1))).toBe(true); // 19 / 25 = 76%，1 / 25 = 4%
    expect(meetsRule(three, counts(25, 18, 0))).toBe(false); // 72%
  });

  it('用整数算，不受小数舍入影响：58 / 100 不小于 58%，29 / 50 也是', () => {
    const rule = { star: 9, onTimeMin: 58, cancelBelow: null };
    expect(meetsRule(rule, counts(100, 58, 0))).toBe(true);
    expect(meetsRule(rule, counts(50, 29, 0))).toBe(true);
    expect(meetsRule(rule, counts(100, 57, 0))).toBe(false);
    const cancel = { star: 9, onTimeMin: 0, cancelBelow: 7 };
    expect(meetsRule(cancel, counts(100, 0, 6))).toBe(true);
    expect(meetsRule(cancel, counts(100, 0, 7))).toBe(false);
  });
});

describe('升星和掉星：决定函数', () => {
  const decide = (star: number, c: ResultCounts, misses = 0, noUpgrade = 0): ReturnType<typeof decideStar> => decideStar(star, misses, noUpgrade, c);

  it('达到上一档的条件升一星，一次最多一星', () => {
    expect(decide(1, counts(10, 6, 0))).toMatchObject({ star: 2, kind: 'starUp', misses: 0, noUpgrade: 0 });
    expect(decide(1, counts(10, 10, 0))).toMatchObject({ star: 2, kind: 'starUp' }); // 全部准时也只升一星
    expect(decide(2, counts(100, 99, 0))).toMatchObject({ star: 3, kind: 'starUp' });
    expect(decide(3, counts(100, 99, 0))).toMatchObject({ star: 4, kind: 'starUp' });
    expect(decide(4, counts(100, 99, 0))).toMatchObject({ star: 5, kind: 'starUp' });
  });

  it('没达到条件不升星：一星差一张，二星退单率不低于 8%，三星退单率不低于 4%，四星准时率 91%', () => {
    expect(decide(1, counts(10, 5, 0))).toMatchObject({ star: 1, kind: 'starKept' });
    expect(decide(2, counts(100, 80, 8))).toMatchObject({ star: 2, kind: 'starKept' });
    expect(decide(3, counts(100, 90, 4))).toMatchObject({ star: 3, kind: 'starKept' });
    expect(decide(4, counts(100, 91, 0))).toMatchObject({ star: 4, kind: 'starKept' });
  });

  it('最高五星，到了五星不再升，达到四星的条件就保住', () => {
    expect(decide(5, counts(100, 100, 0))).toMatchObject({ star: 5, kind: 'starKept', misses: 0 });
    expect(decide(5, counts(100, 85, 3))).toMatchObject({ star: 5, kind: 'starKept' });
  });

  it('三星及以上没达到下面一档的条件：记一次，连续两次才掉一星，掉星之后计数清零，二星不会掉回一星', () => {
    const bad = counts(10, 5, 0); // 准时率 50%，不到二星的 55%
    const first = decide(3, bad);
    expect(first).toMatchObject({ star: 3, misses: 1, kind: 'dropByOnTime', needOnTimePct: 55, needCancelPct: null });
    const second = decide(3, bad, first.misses);
    expect(second).toMatchObject({ star: 2, misses: 0, kind: 'starDown' });
    expect(decide(2, bad, second.misses)).toMatchObject({ star: 2, misses: 0, kind: 'starKept' });
  });

  it('中间达到一次，计数清零：没达到、达到、没达到，不会掉星', () => {
    const bad = counts(10, 5, 0);
    const good = counts(10, 7, 0);
    const a = decide(3, bad);
    const b = decide(3, good, a.misses);
    const c = decide(3, bad, b.misses);
    expect([a.misses, b.misses, c.misses]).toEqual([1, 0, 1]);
    expect([a.star, b.star, c.star]).toEqual([3, 3, 3]);
    expect(b.kind).toBe('starKept');
  });

  it('升星清零计数：三星记过一次没达到，下一次达到四星的条件，升到四星，计数为 0', () => {
    const miss = decide(3, counts(10, 5, 0));
    expect(miss.misses).toBe(1);
    expect(decide(3, counts(100, 90, 0), miss.misses)).toMatchObject({ star: 4, misses: 0, kind: 'starUp' });
  });

  it('四星看三星的条件：准时率够、退单率不低于 8%，写退单率，要低于 8%；两项都没达到，写准时率，要保持在 75%', () => {
    expect(decide(4, counts(100, 80, 8))).toMatchObject({ star: 4, misses: 1, kind: 'dropByCancel', needOnTimePct: null, needCancelPct: 8 });
    expect(decide(4, counts(100, 70, 9))).toMatchObject({ misses: 1, kind: 'dropByOnTime', needOnTimePct: 75 });
  });

  it('五星看四星的条件：85% 且低于 4%', () => {
    expect(decide(5, counts(100, 84, 0))).toMatchObject({ star: 5, misses: 1, kind: 'dropByOnTime', needOnTimePct: 85 });
    expect(decide(5, counts(100, 90, 4))).toMatchObject({ star: 5, misses: 1, kind: 'dropByCancel', needCancelPct: 4 });
  });

  it('三星只看二星的条件：准时率 60%，退单率不限，所以三星不会因退单率记一次', () => {
    expect(decide(3, counts(10, 6, 4))).toMatchObject({ star: 3, misses: 0, kind: 'starKept' });
  });

  it('二星和一星不会掉星：计数一直是 0', () => {
    for (const star of [1, 2]) {
      expect(decide(star, counts(10, 0, 10), 0)).toMatchObject({ star, misses: 0, kind: 'starKept' });
    }
  });

  it('最近两天没有订单：星级和计数都不变，连续没有升星的次数加一', () => {
    expect(decide(3, counts(0, 0, 0), 1, 0)).toEqual({ star: 3, misses: 1, noUpgrade: 1, kind: 'noOrders', needOnTimePct: null, needCancelPct: null });
    expect(decide(1, counts(0, 0, 0), 0, 4)).toMatchObject({ star: 1, misses: 0, noUpgrade: 5, kind: 'noOrders' });
  });

  it('最少样本：完成的订单少于下限，星级和连续未达到的计数都不变，种类是 tooFewOrders，与没有订单的 noOrders 区分开', () => {
    const few = STARS_V1.minSample - 1;
    // 全部准时也不升星：刚开通的片区头一两天，一张准时的订单就是 100%
    expect(decide(1, counts(1, 1, 0))).toEqual({ star: 1, misses: 0, noUpgrade: 1, kind: 'tooFewOrders', needOnTimePct: null, needCancelPct: null });
    expect(decide(1, counts(few, few, 0))).toMatchObject({ star: 1, misses: 0, kind: 'tooFewOrders' });
    expect(decide(2, counts(few, few, 0))).toMatchObject({ star: 2, kind: 'tooFewOrders' });
    // 三星及以上，没达到当前星级下面一档的条件，也不记一次，计数停在原处，不会因为订单太少而掉星
    expect(decide(3, counts(few, 0, 0), 1, 0)).toEqual({ star: 3, misses: 1, noUpgrade: 1, kind: 'tooFewOrders', needOnTimePct: null, needCancelPct: null });
    expect(decide(4, counts(few, 0, few), 1, 2)).toMatchObject({ star: 4, misses: 1, noUpgrade: 3, kind: 'tooFewOrders' });
    // 恰好等于下限就照常判断
    expect(decide(1, counts(STARS_V1.minSample, STARS_V1.minSample, 0))).toMatchObject({ star: 2, kind: 'starUp' });
    expect(decide(3, counts(STARS_V1.minSample, 0, 0), 1, 0)).toMatchObject({ star: 2, kind: 'starDown' });
    // 没有订单仍是 noOrders
    expect(decide(1, counts(0, 0, 0)).kind).toBe('noOrders');
  });

  it('连续没有升星的次数：没升星加一，升星清零', () => {
    expect(decide(2, counts(10, 5, 0), 0, 1).noUpgrade).toBe(2);
    expect(decide(2, counts(10, 9, 0), 0, 3).noUpgrade).toBe(0);
  });
});

describe('统计范围：最近两个游戏日里完成的订单，按结果产生的步归日', () => {
  it('范围是今天和昨天，第一天只有今天', () => {
    expect(windowOfDay(0)).toEqual({ from: 0, to: DAY_STEPS });
    expect(windowOfDay(1)).toEqual({ from: 0, to: 2 * DAY_STEPS });
    expect(windowOfDay(5)).toEqual({ from: 4 * DAY_STEPS, to: 6 * DAY_STEPS });
  });

  it('跨日的订单：前一天下单、今天送达的算在今天，两天合并算', () => {
    const state = quietState();
    outcomeOrder(state, { district: 0, tOrder: DAY_STEPS - 100, delivered: DAY_STEPS + 50 }); // 昨天下单，今天送达，用时 150 步，准时
    outcomeOrder(state, { district: 0, tOrder: DAY_STEPS + 10, delivered: DAY_STEPS + 500 }); // 今天下单，今天送达，超时
    outcomeOrder(state, { district: 1, tOrder: DAY_STEPS + 20, cancelled: DAY_STEPS + 920 });
    const today = tallyResults(state, DAY_STEPS, 2 * DAY_STEPS);
    expect(today[0]).toEqual({ n: 2, onTime: 1, late: 1, cancelled: 0 });
    expect(today[1]).toEqual({ n: 1, onTime: 0, late: 0, cancelled: 1 });
    // 只看第一天：昨天下的单还没送到，不算
    expect(tallyResults(state, 0, DAY_STEPS)[0]).toEqual({ n: 0, onTime: 0, late: 0, cancelled: 0 });
  });

  it('结果产生的步在范围的边界上：[from, to)，到 to 这一步的结果不算，从 from 这一步起的算', () => {
    const state = quietState();
    outcomeOrder(state, { district: 0, tOrder: DAY_STEPS - 50, delivered: DAY_STEPS - 1 });
    outcomeOrder(state, { district: 0, tOrder: DAY_STEPS - 40, delivered: DAY_STEPS });
    expect(tallyResults(state, 0, DAY_STEPS)[0]?.n).toBe(1);
    expect(tallyResults(state, DAY_STEPS, 2 * DAY_STEPS)[0]?.n).toBe(1);
  });

  it('只扫最近的订单也和扫全部订单一样：跑四天，每隔一段时间与暴力统计对一次', () => {
    const state = campaignState({ seed: 31 });
    const naive = (from: number, to: number): ResultCounts[] => {
      const out = state.world.districts.map(() => ({ n: 0, onTime: 0, late: 0, cancelled: 0 }));
      for (const o of state.orders) {
        const r = o.tDeliver >= 0 ? o.tDeliver : o.tCancel;
        if (r < from || r >= to) continue;
        const c = out[o.district] as ResultCounts;
        c.n += 1;
        if (o.tDeliver < 0) c.cancelled += 1;
        else if (o.tDeliver - o.tOrder <= 300) c.onTime += 1;
        else c.late += 1;
      }
      return out;
    };
    let checked = 0;
    for (let i = 0; i < 4 * DAY_STEPS; i++) {
      clickOpening(state);
      step(state);
      if (i % 251 === 0 && state.step > DAY_STEPS) {
        const day = Math.floor(state.step / DAY_STEPS);
        const w = windowOfDay(day);
        expect(tallyResults(state, w.from, w.to)).toEqual(naive(w.from, w.to));
        expect(tallyResults(state, w.from, state.step + 1)).toEqual(naive(w.from, state.step + 1));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
    // 订单确实有送达也有退单，对照有意义
    expect(state.orders.some((o) => o.status === OrderStatus.Delivered)).toBe(true);
    expect(state.orders.some((o) => o.status === OrderStatus.Cancelled)).toBe(true);
    // 没有哪张订单从下单到有结果超过一个游戏日，所以只往前扫一个游戏日够用
    for (const o of state.orders) {
      const r = o.tDeliver >= 0 ? o.tDeliver : o.tCancel;
      if (r >= 0) expect(r - o.tOrder).toBeLessThan(DAY_STEPS);
    }
  });
});

describe('日结：数字', () => {
  /** 第 0 天的订单：老街 6 张准时、3 张超时、1 张退单，写字楼区 2 张准时。再放一张第 0 天下单、日结时还没完成的订单。 */
  function dayZero(): SimState {
    const state = quietState();
    batchOrders(state, 0, 0, { onTime: 6, late: 3, cancelled: 1 });
    batchOrders(state, 1, 0, { onTime: 2 });
    outcomeOrder(state, { district: 0, tOrder: DAY_STEPS - 120 }); // 还没有结果
    return state;
  }

  it('今天下单、今天有结果（准时送达、超时送达、退单，三项之和等于它）、还没有结果、今天的进账', () => {
    const state = dayZero();
    campaignOf(state).income[0] = 123.5;
    state.step = DAY_STEPS;
    const record = settleDay(state, 0);
    expect(record).toMatchObject({ day: 0, step: DAY_STEPS, ordered: 13, resolved: 12, onTime: 8, late: 3, cancelled: 1, pending: 1, income: 123.5 });
    expect(record.onTime + record.late + record.cancelled).toBe(record.resolved);
    expect(campaignOf(state).days).toEqual([record]);
  });

  it('前一天下单、今天才送达或退单的订单：算在今天有结果的里，不算今天下单的；已经生成的日结不会被追溯修改', () => {
    const state = dayZero();
    // 第 0 天日结时还没有结果的有两张：一张在第 1 天送达（用时 150 步，准时），另一张在第 1 天退单
    const carried = outcomeOrder(state, { district: 0, tOrder: DAY_STEPS - 30 });
    state.step = DAY_STEPS;
    const first = settleDay(state, 0);
    expect(first.pending).toBe(2);
    const snapshot = JSON.stringify(first);
    const earlier = state.orders.find((o) => o.tOrder === DAY_STEPS - 120);
    if (earlier === undefined) throw new Error('missing order');
    for (const order of [earlier, carried]) {
      state.pending.splice(state.pending.indexOf(order.id), 1);
      state.openQueue.splice(state.openQueue.indexOf(order.id), 1);
    }
    earlier.status = OrderStatus.Delivered;
    earlier.tDeliver = DAY_STEPS + 30;
    carried.status = OrderStatus.Cancelled;
    carried.tCancel = DAY_STEPS + 870;
    batchOrders(state, 0, 1, { onTime: 3 });
    state.step = 2 * DAY_STEPS;
    const second = settleDay(state, 1);
    expect(second).toMatchObject({ day: 1, ordered: 3, resolved: 5, onTime: 4, late: 0, cancelled: 1, pending: 0 });
    expect(JSON.stringify(campaignOf(state).days[0])).toBe(snapshot);
  });

  it('日结里每个开通的片区一行，没开通的片区没有：开局只有老街', () => {
    const state = dayZero();
    state.step = DAY_STEPS;
    expect(settleDay(state, 0).districts.map((d) => d.district)).toEqual([0]);
    const open = dayZero();
    campaignOf(open).districts[1]!.open = true;
    open.step = DAY_STEPS;
    expect(settleDay(open, 0).districts.map((d) => d.district)).toEqual([0, 1]);
  });

  it('每个片区的一行带最近两天的统计：完成的订单数、准时数、退单数、下取整的准时率和退单率', () => {
    const state = quietState();
    batchOrders(state, 0, 0, { onTime: 7, late: 2, cancelled: 1 }); // 70%，10%
    state.step = DAY_STEPS;
    const line = settleDay(state, 0).districts[0];
    expect(line).toMatchObject({ district: 0, n: 10, onTime: 7, cancelled: 1, onTimePct: 70, cancelPct: 10 });
  });

  it('日结只用结果产生在统计范围内的订单：三天前的结果不参与第三天的统计', () => {
    const state = quietState();
    batchOrders(state, 0, 0, { late: 10 }); // 第 0 天全部超时
    batchOrders(state, 0, 1, { late: 10 });
    batchOrders(state, 0, 2, { onTime: 10 });
    state.step = 3 * DAY_STEPS;
    const line = settleDay(state, 2).districts[0];
    // 第 2 天的统计范围是第 1 天和第 2 天：10 张超时、10 张准时
    expect(line).toMatchObject({ n: 20, onTime: 10, onTimePct: 50 });
  });
});

describe('日结：口碑和新店', () => {
  /** 做第 day 天的日结。 */
  function settle(state: SimState, day: number): ReturnType<typeof settleDay> {
    state.step = (day + 1) * DAY_STEPS;
    return settleDay(state, day);
  }

  it('升星：老街升二星，开张二星的两家店，记在这一行里，并带上位置', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    const before = campaign.shopOpen.slice();
    batchOrders(state, 0, 0, { onTime: 7, late: 3 });
    const line = settle(state, 0).districts[0];
    expect(line).toMatchObject({ kind: 'starUp', fromStar: 1, star: 2 });
    expect(campaign.districts[0]?.star).toBe(2);
    const opened = campaign.shopOpen.map((open, i) => (open && !before[i] ? i : -1)).filter((i) => i >= 0);
    expect(opened).toEqual(MAP_V1.shops.map((s, i) => (s.district === 0 && s.opensAtStar === 2 ? i : -1)).filter((i) => i >= 0));
    expect(line?.newShops).toEqual(opened.map((i) => newShopAt(i)));
    expect(line?.newShops.map((s) => s.direction)).toEqual(['west', 'south']);
  });

  it('日结在产生订单之前：第 3600 步的产生订单阶段看到的已经是新的星级，倍数是旧的 1.25 倍', () => {
    const state = quietState();
    batchOrders(state, 0, 0, { onTime: 8, late: 2 });
    advance(state, DAY_STEPS);
    expect(state.step).toBe(DAY_STEPS);
    expect(campaignOf(state).days.length).toBe(0);
    const seen: string[] = [];
    const observer: StepObserver = {
      before(phase, s) {
        if (s.step !== DAY_STEPS) return;
        if (phase === 'daily' || phase === 'arrivals') seen.push(`${phase} star ${campaignOf(s).districts[0]?.star} days ${campaignOf(s).days.length}`);
      },
    };
    step(state, observer);
    expect(seen).toEqual(['daily star 1 days 0', 'arrivals star 2 days 1']);
    expect(districtLambda(0, 0, 2)).toBeCloseTo(districtLambda(0, 0, 1) * 1.25, 12);
  });

  it('掉星：三星的老街连续两次日结没有达到二星的条件，掉一星，已经开张的店不关', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.districts[0]!.star = 3;
    refreshShops(state);
    const shops = campaign.shopOpen.slice();
    expect(shops.filter(Boolean).length).toBe(9 + 3); // 一、二、三星开张的店
    batchOrders(state, 0, 0, { onTime: 5, late: 5 }); // 50%，不到二星的条件
    const first = settle(state, 0).districts[0];
    expect(first).toMatchObject({ kind: 'dropByOnTime', star: 3, needOnTimePct: 55, onTimePct: 50 });
    expect(campaign.rating[0]?.misses).toBe(1);
    batchOrders(state, 0, 1, { onTime: 4, late: 6 }); // 第 1 天的统计范围是前两天：9 / 20 = 45%
    const second = settle(state, 1).districts[0];
    expect(second).toMatchObject({ kind: 'starDown', fromStar: 3, star: 2 });
    expect(campaign.rating[0]?.misses).toBe(0);
    expect(campaign.shopOpen).toEqual(shops);
    expect(second?.newShops).toEqual([]);
  });

  it('星级不变：没升也没记一次，一星不会掉', () => {
    const state = quietState();
    batchOrders(state, 0, 0, { onTime: 4, late: 6 }); // 40%，一星达不到二星
    state.step = DAY_STEPS;
    const line = settleDay(state, 0).districts[0];
    expect(line).toMatchObject({ kind: 'starKept', fromStar: 1, star: 1, n: 10 });
    expect(campaignOf(state).districts[0]?.star).toBe(1);
  });

  it('最近两天没有完成的订单：星级不变，计数也不变，写明没有订单', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.districts[0]!.star = 3;
    campaign.rating[0]!.misses = 1;
    state.step = DAY_STEPS;
    const line = settleDay(state, 0).districts[0];
    expect(line).toMatchObject({ kind: 'noOrders', star: 3, n: 0, onTimePct: null, cancelPct: null });
    expect(campaign.rating[0]).toEqual({ misses: 1, noUpgrade: 1 });
  });

  it('订单太少：三星的老街只有 9 张订单，全部超时也不记一次；日结记录是 tooFewOrders，数字照常记，只有连续没有升星的次数加一', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.districts[0]!.star = 3;
    campaign.rating[0]!.misses = 1;
    batchOrders(state, 0, 0, { late: STARS_V1.minSample - 1 });
    state.step = DAY_STEPS;
    const line = settleDay(state, 0).districts[0];
    expect(line).toMatchObject({ kind: 'tooFewOrders', fromStar: 3, star: 3, n: 9, onTime: 0, onTimePct: 0, cancelled: 0, needOnTimePct: null, needCancelPct: null, newShops: [] });
    expect(campaign.districts[0]?.star).toBe(3);
    expect(campaign.rating[0]).toEqual({ misses: 1, noUpgrade: 1 });
  });

  it('订单太少不升星：刚开通的写字楼区 9 张订单全部准时，星级不变，老街 10 张订单照常升星，两个片区各记各的', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.districts[1]!.open = true;
    refreshShops(state);
    const shops = campaign.shopOpen.slice();
    batchOrders(state, 0, 0, { onTime: 8, late: 2 });
    batchOrders(state, 1, 0, { onTime: STARS_V1.minSample - 1 });
    state.step = DAY_STEPS;
    const lines = settleDay(state, 0).districts;
    expect(lines.map((l) => [l.district, l.kind, l.star])).toEqual([[0, 'starUp', 2], [1, 'tooFewOrders', 1]]);
    expect(lines[1]).toMatchObject({ n: 9, onTime: 9, onTimePct: 100 });
    expect(campaign.districts[1]?.star).toBe(1);
    // 写字楼区没有新店，老街升星开了新店
    expect(campaign.shopOpen.filter((open, i) => open && !shops[i] && MAP_V1.shops[i]?.district === 1)).toEqual([]);
  });

  it('两天合并才够数：第一天 6 张、第二天 5 张，第一天的日结订单太少，第二天的日结合计 11 张，照常升星', () => {
    const state = quietState();
    batchOrders(state, 0, 0, { onTime: 6 });
    state.step = DAY_STEPS;
    expect(settleDay(state, 0).districts[0]).toMatchObject({ kind: 'tooFewOrders', star: 1, n: 6 });
    batchOrders(state, 0, 1, { onTime: 5 });
    state.step = 2 * DAY_STEPS;
    expect(settleDay(state, 1).districts[0]).toMatchObject({ kind: 'starUp', fromStar: 1, star: 2, n: 11 });
  });

  it('各个片区互不影响：写字楼区升星，老街不变，两行各记各的，新店只列升星的片区的', () => {
    const state = quietState();
    const campaign = campaignOf(state);
    campaign.districts[1]!.open = true;
    refreshShops(state);
    batchOrders(state, 0, 0, { onTime: 4, late: 6 });
    batchOrders(state, 1, 0, { onTime: 9, late: 1 });
    state.step = DAY_STEPS;
    const lines = settleDay(state, 0).districts;
    expect(lines.map((l) => [l.district, l.kind, l.star])).toEqual([[0, 'starKept', 1], [1, 'starUp', 2]]);
    expect(lines[0]?.newShops).toEqual([]);
    expect(lines[1]?.newShops.map((s) => s.shop)).toEqual([MAP_V1.shops.findIndex((s) => s.district === 1 && s.opensAtStar === 2)]);
  });

  it('升一星订单量乘 1.25，掉一星除以 1.25：一天的期望来单数相差两成半', () => {
    const lambdaDay = (star: number): number => {
      let sum = 0;
      for (let t = 0; t < DAY_STEPS; t++) sum += districtLambda(0, t, star);
      return sum;
    };
    expect(lambdaDay(2) / lambdaDay(1)).toBeCloseTo(1.25, 10);
    expect(lambdaDay(1) / lambdaDay(2)).toBeCloseTo(0.8, 10);
  });
});

describe('日结的执行时机', () => {
  it('第 d 天的日结在第 (d + 1) × 3600 步开始时做：推进到第 3600 步之前没有记录，执行第 3600 步之后有', () => {
    const state = runningState(5);
    advance(state, DAY_STEPS);
    expect(state.step).toBe(DAY_STEPS);
    expect(campaignOf(state).days).toEqual([]);
    step(state);
    expect(campaignOf(state).days.length).toBe(1);
    expect(campaignOf(state).days[0]?.step).toBe(DAY_STEPS);
    advance(state, DAY_STEPS - 1);
    expect(campaignOf(state).days.length).toBe(1);
    step(state);
    expect(campaignOf(state).days.map((d) => [d.day, d.step])).toEqual([[0, DAY_STEPS], [1, 2 * DAY_STEPS]]);
  });

  it('日结在产生订单之前：第 3600 步产生的订单不算今天下单的，也不算还没有结果的', () => {
    const state = runningState(6);
    advance(state, DAY_STEPS);
    let ordered = -1;
    let pending = -1;
    let afterDaily = -1;
    const observer: StepObserver = {
      before(phase, s) {
        if (phase === 'daily') {
          ordered = s.orders.length;
          pending = s.orders.filter((o) => o.tDeliver < 0 && o.tCancel < 0).length;
        }
        if (phase === 'arrivals') afterDaily = s.orders.length;
      },
    };
    step(state, observer);
    expect(afterDaily).toBe(ordered);
    const record = campaignOf(state).days[0];
    expect(record?.ordered).toBe(ordered);
    expect(record?.pending).toBe(pending);
  });

  it('沙盒模式下日程阶段和便签阶段什么也不做：跳过这两个阶段推进，两天多之后状态逐项相同', () => {
    const a = createState({ ...OPENING, seed: 7 });
    const b = createState({ ...OPENING, seed: 7 });
    for (let i = 0; i < 2 * DAY_STEPS + 100; i++) {
      step(a);
      for (const phase of STEP_PHASES) if (phase.name !== 'daily' && phase.name !== 'tips') phase.run(b);
      b.step += 1;
    }
    expect(a.campaign).toBeNull();
    expect(hashState(a)).toBe(hashState(b));
    expect(a).toEqual(b);
  });

  it('跑几天的日结记录：每天一条，下标就是游戏日，三项之和等于完成的订单数，进账与按送达订单重算的相同', () => {
    const state = campaignState({ seed: 44 });
    for (let i = 0; i < 4 * DAY_STEPS + 1; i++) {
      clickOpening(state);
      step(state);
    }
    const days = campaignOf(state).days;
    expect(days.map((d) => d.day)).toEqual([0, 1, 2, 3]);
    for (const d of days) {
      expect(d.onTime + d.late + d.cancelled).toBe(d.resolved);
      expect(d.ordered).toBeGreaterThan(10);
      expect(d.income).toBeCloseTo(campaignOf(state).income[d.day] as number, 9);
    }
    const byDay = [0, 0, 0, 0];
    for (const o of state.orders) {
      if (o.tDeliver >= 0 && o.tDeliver < 4 * DAY_STEPS) byDay[Math.floor(o.tDeliver / DAY_STEPS)] = (byDay[Math.floor(o.tDeliver / DAY_STEPS)] as number) + o.rev;
    }
    days.forEach((d, i) => expect(d.income).toBeCloseTo(byDay[i] as number, 6));
    // 独立的账：按订单重算每天下单数和完成的订单数
    days.forEach((d, i) => {
      const from = i * DAY_STEPS;
      const to = from + DAY_STEPS;
      expect(d.ordered).toBe(state.orders.filter((o) => o.tOrder >= from && o.tOrder < to).length);
      expect(d.resolved).toBe(state.orders.filter((o) => (o.tDeliver >= from && o.tDeliver < to) || (o.tDeliver < 0 && o.tCancel >= from && o.tCancel < to)).length);
    });
  });
});

describe('片区纸条的数据', () => {
  /** 把状态的步数直接设到第 day 天的第 tick 步，不推进。 */
  function atDay(state: SimState, day: number, tick = 100): void {
    state.step = day * DAY_STEPS + tick;
  }

  /** 最少样本，各组订单按它的倍数放，这样下限改了，这些测试仍然有足够的订单。 */
  const M = STARS_V1.minSample;

  it('游戏的第一天：只看今天，一星，目标二星', () => {
    const state = quietState();
    batchOrders(state, 0, 0, { onTime: 3 * M, late: 2 * M });
    atDay(state, 0, 2000);
    const note = districtNote(state, 0);
    expect(note).toMatchObject({ district: 0, open: true, star: 1, firstDay: true, n: 5 * M, onTime: 3 * M, onTimePct: 60, cancelPct: 0, kind: 'firstDay', atRisk: false });
    expect(note.next).toEqual(starRule(2));
    expect(note.keep).toBeNull();
  });

  it('一星的第二天起：最近两天，写升二星的条件', () => {
    const state = quietState();
    batchOrders(state, 0, 0, { onTime: 3 * M, late: 2 * M });
    batchOrders(state, 0, 1, { onTime: M, late: 3 * M });
    atDay(state, 1, 3000);
    expect(districtNote(state, 0)).toMatchObject({ firstDay: false, n: 9 * M, onTime: 4 * M, onTimePct: 44, kind: 'toTwoStars' });
  });

  it('二星到四星：写下一星的准时率和退单率条件，三星起带保住星级的条件', () => {
    const state = quietState();
    campaignOf(state).districts[0]!.star = 3;
    batchOrders(state, 0, 1, { onTime: 80, late: 12, cancelled: 8 });
    atDay(state, 1, 3000);
    const note = districtNote(state, 0);
    expect(note).toMatchObject({ star: 3, n: 100, onTimePct: 80, cancelPct: 8, kind: 'toNextStar', atRisk: false });
    expect(note.next).toEqual(starRule(4));
    expect(note.keep).toEqual(starRule(2));
  });

  it('已经五星：没有下一档，写已经是五星', () => {
    const state = quietState();
    campaignOf(state).districts[0]!.star = 5;
    batchOrders(state, 0, 0, { onTime: M });
    atDay(state, 0, 3000);
    const note = districtNote(state, 0);
    expect(note).toMatchObject({ star: 5, kind: 'maxStars', next: null });
    expect(note.keep).toEqual(starRule(4));
  });

  it('处在可能掉星的状态：计数为 1，而且最近两天的统计现在还没有达到要保住的线，准时率没达到写准时率，其次写退单率', () => {
    const first = quietState();
    campaignOf(first).districts[0]!.star = 4;
    campaignOf(first).rating[0]!.misses = 1;
    batchOrders(first, 0, 1, { onTime: 70, late: 22, cancelled: 8 });
    atDay(first, 1, 100);
    expect(districtNote(first, 0)).toMatchObject({ atRisk: true, kind: 'dropByOnTime', onTimePct: 70 }); // 要保持在三星的准时率线以上
    const second = quietState();
    campaignOf(second).districts[0]!.star = 4;
    campaignOf(second).rating[0]!.misses = 1;
    batchOrders(second, 0, 1, { onTime: 80, late: 12, cancelled: 8 });
    atDay(second, 1, 100);
    expect(districtNote(second, 0)).toMatchObject({ atRisk: true, kind: 'dropByCancel', cancelPct: 8 }); // 要低于三星的退单率线
  });

  it('计数为 1，但最近两天的统计现在已经达到要保住的线：仍标记在风险里，写的是升星的那一条', () => {
    const state = quietState();
    campaignOf(state).districts[0]!.star = 4;
    campaignOf(state).rating[0]!.misses = 1;
    batchOrders(state, 0, 1, { onTime: 90, late: 8, cancelled: 2 });
    atDay(state, 1, 100);
    expect(districtNote(state, 0)).toMatchObject({ atRisk: true, kind: 'toNextStar' });
  });

  it('还没有完成的订单：比率为 null，写 noData；没开通的片区 open 为 false，片区不存在时报错', () => {
    const state = quietState();
    atDay(state, 0);
    expect(districtNote(state, 0)).toMatchObject({ n: 0, onTimePct: null, cancelPct: null, kind: 'noData' });
    expect(districtNote(state, 2)).toMatchObject({ open: false, star: 1 });
    expect(() => districtNote(state, 3)).toThrow();
  });

  it('完成的订单少于下限：写 tooFew，不写升星的条件；恰好等于下限就照常写。第一天和第二天都一样', () => {
    const few = quietState();
    batchOrders(few, 0, 0, { onTime: M - 1 });
    atDay(few, 0, 2000);
    expect(districtNote(few, 0)).toMatchObject({ n: M - 1, onTimePct: 100, firstDay: true, kind: 'tooFew' });
    const enough = quietState();
    batchOrders(enough, 0, 0, { onTime: M });
    atDay(enough, 0, 2000);
    expect(districtNote(enough, 0)).toMatchObject({ n: M, kind: 'firstDay' });
    const second = quietState();
    batchOrders(second, 0, 1, { onTime: M - 1 });
    atDay(second, 1, 2000);
    expect(districtNote(second, 0)).toMatchObject({ n: M - 1, firstDay: false, kind: 'tooFew' });
    // 二星到五星也一样：订单不够时日结不改星级，纸条就不写升星的条件
    for (const star of [2, 3, 5]) {
      const state = quietState();
      campaignOf(state).districts[0]!.star = star;
      batchOrders(state, 0, 1, { onTime: M - 1 });
      atDay(state, 1, 2000);
      expect(districtNote(state, 0).kind, `star ${star}`).toBe('tooFew');
    }
  });

  it('可能掉星的两条优先于 tooFew 和升星的条件：订单够数时，处在风险里而且没达到，写掉星', () => {
    const state = quietState();
    campaignOf(state).districts[0]!.star = 3;
    campaignOf(state).rating[0]!.misses = 1;
    batchOrders(state, 0, 1, { onTime: M, late: 3 * M });
    atDay(state, 1, 100);
    expect(districtNote(state, 0)).toMatchObject({ atRisk: true, n: 4 * M, kind: 'dropByOnTime' });
  });

  it('处在风险里，但订单不够数：日结不判断掉星，不写「会掉一星」，写 tooFew；一张订单也没有时写 noData', () => {
    const few = quietState();
    campaignOf(few).districts[0]!.star = 3;
    campaignOf(few).rating[0]!.misses = 1;
    batchOrders(few, 0, 1, { late: M - 1 });
    atDay(few, 1, 100);
    expect(districtNote(few, 0)).toMatchObject({ atRisk: true, n: M - 1, kind: 'tooFew' });
    const none = quietState();
    campaignOf(none).districts[0]!.star = 3;
    campaignOf(none).rating[0]!.misses = 1;
    atDay(none, 1, 100);
    expect(districtNote(none, 0)).toMatchObject({ atRisk: true, n: 0, kind: 'noData' });
  });

  it('只统计最近两天：三天前的结果不算', () => {
    const state = quietState();
    batchOrders(state, 0, 0, { late: M });
    batchOrders(state, 0, 2, { onTime: M });
    atDay(state, 2, 3000);
    expect(districtNote(state, 0)).toMatchObject({ n: M, onTime: M, onTimePct: 100 });
  });
});

describe('片区纸条用哪一条：pickNoteKind', () => {
  const M = STARS_V1.minSample;
  /** 一组完成的订单：n 张，其中 onTime 张准时，cancelled 张退单。 */
  const c = counts;

  it('没有订单写 noData，不到下限写 tooFew，不论星级和第几天', () => {
    for (const star of [1, 2, 3, 4, 5]) {
      for (const today of [0, 1, 7]) {
        expect(pickNoteKind(star, today, 0, c(0, 0, 0)), `star ${star} day ${today}`).toBe('noData');
        expect(pickNoteKind(star, today, 0, c(1, 1, 0)), `star ${star} day ${today}`).toBe('tooFew');
        expect(pickNoteKind(star, today, 0, c(M - 1, M - 1, 0)), `star ${star} day ${today}`).toBe('tooFew');
      }
    }
  });

  it('订单够数时按星级写：一星第一天 firstDay，一星以后 toTwoStars，二星到四星 toNextStar，五星 maxStars', () => {
    expect(pickNoteKind(1, 0, 0, c(M, M, 0))).toBe('firstDay');
    expect(pickNoteKind(1, 1, 0, c(M, M, 0))).toBe('toTwoStars');
    expect(pickNoteKind(1, 9, 0, c(M, 0, 0))).toBe('toTwoStars');
    for (const star of [2, 3, 4]) expect(pickNoteKind(star, 3, 0, c(M, M, 0)), `star ${star}`).toBe('toNextStar');
    expect(pickNoteKind(5, 3, 0, c(M, M, 0))).toBe('maxStars');
  });

  it('只有第一天的一星写 firstDay：二星起第一天也写升到下一星', () => {
    expect(pickNoteKind(2, 0, 0, c(M, M, 0))).toBe('toNextStar');
    expect(pickNoteKind(5, 0, 0, c(M, M, 0))).toBe('maxStars');
  });

  it('可能掉星：三星及以上，计数不小于 1，订单够数，现在没达到要保住的线，准时率优先于退单率', () => {
    const hold = keepRule(4)!; // 四星要保住三星的条件：准时率和退单率都有要求
    const n = 100;
    const late = n - hold.onTimeMin + 1; // 准时率差一点
    expect(pickNoteKind(4, 3, 1, c(n, n - late, 0))).toBe('dropByOnTime');
    const cancelled = hold.cancelBelow as number; // 准时率够，退单率恰好不低于要求
    expect(pickNoteKind(4, 3, 1, c(n, n - cancelled, cancelled))).toBe('dropByCancel');
    // 两样都没达到，写准时率
    expect(pickNoteKind(4, 3, 1, c(n, 0, cancelled))).toBe('dropByOnTime');
  });

  it('可能掉星的条件缺一不可：计数为 0、二星及以下、现在已经达到要保住的线，都写升星的条件', () => {
    const hold = keepRule(4)!;
    const n = 100;
    expect(pickNoteKind(4, 3, 0, c(n, 0, 0))).toBe('toNextStar'); // 计数为 0
    expect(pickNoteKind(2, 3, 1, c(n, 0, 0))).toBe('toNextStar'); // 二星不会掉星
    expect(pickNoteKind(1, 3, 1, c(n, 0, 0))).toBe('toTwoStars');
    expect(pickNoteKind(4, 3, 1, c(n, hold.onTimeMin, 0))).toBe('toNextStar'); // 现在已经达到，日结不会掉星
  });

  it('可能掉星的两条优先于升星的条件，但订单不够数时让位给 noData 和 tooFew', () => {
    expect(pickNoteKind(3, 3, 1, c(M, 0, 0))).toBe('dropByOnTime');
    expect(pickNoteKind(3, 3, 1, c(M - 1, 0, 0))).toBe('tooFew');
    expect(pickNoteKind(3, 3, 1, c(0, 0, 0))).toBe('noData');
  });
});

describe('新店的位置：片区加方位', () => {
  const RECT = { x0: 0, x1: 1000, y0: 0, y1: 500 };

  it('相对片区中心取东、南、西、北：x 向右是东，y 向下是南', () => {
    expect(placeDirection(900, 250, RECT)).toBe('east');
    expect(placeDirection(100, 250, RECT)).toBe('west');
    expect(placeDirection(500, 480, RECT)).toBe('south');
    expect(placeDirection(500, 20, RECT)).toBe('north');
  });

  it('偏移先按半边长折算：片区宽扁，下偏 200 比右偏 300 偏得多，算南', () => {
    // 中心 (500, 250)，半宽 500，半高 250：向右偏 300 折算 0.6，向下偏 200 折算 0.8
    expect(placeDirection(800, 450, RECT)).toBe('south');
    expect(placeDirection(800, 350, RECT)).toBe('east'); // 0.6 对 0.4
  });

  it('离中心较近写中间：折算后的距离不超过 0.4，恰好 0.4 也算中间', () => {
    expect(placeDirection(500, 250, RECT)).toBe('middle');
    expect(placeDirection(600, 300, RECT)).toBe('middle'); // 折算 (0.2, 0.2)，距离 0.28
    expect(placeDirection(700, 250, RECT, 0.4)).toBe('middle'); // 折算 (0.4, 0)，恰好 0.4
    expect(placeDirection(701, 250, RECT, 0.4)).toBe('east');
    expect(placeDirection(560, 250, RECT, 0)).toBe('east'); // 半径 0：只有正中心是中间
    expect(placeDirection(500, 250, RECT, 0)).toBe('middle');
  });

  it('两个方向偏得一样多时取东西；矩形没有面积时写中间', () => {
    expect(placeDirection(750, 375, RECT, 0.1)).toBe('east'); // 折算 (0.5, 0.5)
    expect(placeDirection(250, 125, RECT, 0.1)).toBe('west');
    expect(placeDirection(5, 5, { x0: 0, x1: 0, y0: 0, y1: 10 })).toBe('middle');
  });

  it('地图 v1 里升星才开张的店：老街朝西、南、南、北、西，写字楼区朝北、东、南，大学城朝西、西、西、中间', () => {
    const late = (district: number): string[] =>
      MAP_V1.shops.map((s, i) => ({ shop: i, star: s.opensAtStar, district: s.district })).filter((s) => s.district === district && s.star > 1).map((s) => newShopAt(s.shop).direction);
    expect(late(0)).toEqual(['west', 'south', 'south', 'north', 'west']);
    expect(late(1)).toEqual(['north', 'east', 'south']);
    expect(late(2)).toEqual(['west', 'west', 'west', 'middle']);
    expect(() => newShopAt(99)).toThrow();
  });
});

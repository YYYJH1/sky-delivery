// 口碑：统计最近两个游戏日里有结果的、送往各片区的订单，按星级条件决定升星、掉星，以及片区纸条要显示的数据。
// 订单按结果产生的那一步归日（送达看 tDeliver，退单看 tCancel），不按下单的日期。
// 比较用整数算：准时率不小于 N% 写成 100 × 准时数 不小于 N × 有结果数，不用小数，边界上不会有舍入误差。
// 显示用的百分数一律下取整：显示的数字达到要求线，真实的比率一定也达到，不会出现「59.6% 显示成 60%」的矛盾。
import { STARS_V1 } from '../../content/stars_v1.ts';
import { DAY_STEPS, PROMISE_STEPS } from '../constants.ts';
import type { DayLineKind, Order, SimState } from '../types.ts';
import type { StarRuleV1 } from '../../content/table_types.ts';

/**
 * 没有哪张订单从下单到有结果会超过一个游戏日：不到 90 秒没人取就退单，取走之后飞到楼不过几十秒。
 * 订单的编号按下单的步不减，所以从后往前扫，遇到比统计范围早一个游戏日以上的订单就可以停。
 */
export const MAX_ORDER_LIFE = DAY_STEPS;

/** 一个片区在统计范围内完成的订单。n 等于 onTime + late + cancelled。 */
export interface ResultCounts {
  n: number;
  onTime: number; // 承诺时间内送达
  late: number; // 超过承诺时间才送达
  cancelled: number;
}

export function emptyCounts(): ResultCounts {
  return { n: 0, onTime: 0, late: 0, cancelled: 0 };
}

/** 订单有结果的那一步：送达或退单。还没有结果为 -1。 */
export function resultStep(o: Order): number {
  return o.tDeliver >= 0 ? o.tDeliver : o.tCancel;
}

/** 结果产生在 [from, to) 内的订单，按送达的片区分别计数，下标是片区编号。 */
export function tallyResults(state: SimState, from: number, to: number): ResultCounts[] {
  const out = state.world.districts.map(emptyCounts);
  const orders = state.orders;
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i] as Order;
    if (o.tOrder < from - MAX_ORDER_LIFE) break;
    const r = resultStep(o);
    if (r < from || r >= to) continue;
    const c = out[o.district] as ResultCounts;
    c.n += 1;
    if (o.tDeliver < 0) c.cancelled += 1;
    else if (o.tDeliver - o.tOrder <= PROMISE_STEPS) c.onTime += 1;
    else c.late += 1;
  }
  return out;
}

/** 第 day 天的日结统计的范围：今天和昨天（第一天只有今天），结果产生在 [from, to) 内。 */
export function windowOfDay(day: number): { from: number; to: number } {
  return { from: Math.max(0, day - (STARS_V1.windowDays - 1)) * DAY_STEPS, to: (day + 1) * DAY_STEPS };
}

/** 比率的下取整百分数，分母为 0 时为 null。 */
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.floor((100 * part) / whole) : null;
}

/** 升到 star 星的条件，star 不在二星到五星之间时为 null。 */
export function starRule(star: number): StarRuleV1 | null {
  return STARS_V1.rules.find((r) => r.star === star) ?? null;
}

/** 三星及以上要保住现在的星级，要达到下面一档的升星条件。二星及以下不会掉星，为 null。 */
export function keepRule(star: number): StarRuleV1 | null {
  return star >= STARS_V1.dropFromStar ? starRule(star - 1) : null;
}

/** 准时率不小于要求，完成的订单为 0 时不算达到。 */
export function meetsOnTime(rule: StarRuleV1, c: ResultCounts): boolean {
  return c.n > 0 && 100 * c.onTime >= rule.onTimeMin * c.n;
}

/** 退单率低于要求，没有退单率要求时恒为真，完成的订单为 0 时不算达到。 */
export function meetsCancel(rule: StarRuleV1, c: ResultCounts): boolean {
  return c.n > 0 && (rule.cancelBelow === null || 100 * c.cancelled < rule.cancelBelow * c.n);
}

export function meetsRule(rule: StarRuleV1, c: ResultCounts): boolean {
  return meetsOnTime(rule, c) && meetsCancel(rule, c);
}

// ---- 日结时的升星和掉星 ----

export interface StarDecision {
  star: number; // 日结之后的星级
  misses: number; // 日结之后的连续未达到次数
  noUpgrade: number; // 日结之后连续没有升星的次数
  kind: DayLineKind;
  needOnTimePct: number | null; // dropByOnTime 要保持的准时率
  needCancelPct: number | null; // dropByCancel 要低于的退单率
}

/**
 * 一个开通的片区在一次日结里的星级决定。
 * - 最近两天没有完成的订单：星级不变，连续未达到的次数也不变。
 * - 完成的订单少于下限（STARS_V1.minSample）：同样星级和连续未达到的次数都不变，记录里写 tooFewOrders，与没有订单区分开。
 *   刚开通的片区头一两天订单很少，一张准时的订单就是 100%，不设下限会直接升星。
 * - 达到上一档的条件：升一星，一次最多一星，最高五星，连续未达到的次数清零。
 * - 三星及以上没有升星：没有达到当前星级下面一档的条件，记一次，连续两次就掉一星并清零。达到了则清零。
 * - 二星及以下：不会掉星。
 * noUpgrade 是连续没有升星的日结次数，没有订单和订单太少的日结也算没有升星。
 */
export function decideStar(star: number, misses: number, noUpgrade: number, c: ResultCounts): StarDecision {
  const base: StarDecision = { star, misses, noUpgrade: noUpgrade + 1, kind: 'noOrders', needOnTimePct: null, needCancelPct: null };
  if (c.n === 0) return base;
  if (c.n < STARS_V1.minSample) return { ...base, kind: 'tooFewOrders' };
  const next = star < STARS_V1.maxStar ? starRule(star + 1) : null;
  if (next !== null && meetsRule(next, c)) return { ...base, star: star + 1, misses: 0, noUpgrade: 0, kind: 'starUp' };
  const hold = keepRule(star);
  if (hold === null || meetsRule(hold, c)) return { ...base, misses: 0, kind: 'starKept' };
  const missed = misses + 1;
  if (missed >= STARS_V1.dropAfterMisses) return { ...base, star: star - 1, misses: 0, kind: 'starDown' };
  // 这一次没有达到，计数记一次：写明是准时率还是退单率没有达到，准时率优先
  if (!meetsOnTime(hold, c)) return { ...base, misses: missed, kind: 'dropByOnTime', needOnTimePct: hold.onTimeMin };
  return { ...base, misses: missed, kind: 'dropByCancel', needCancelPct: hold.cancelBelow };
}

// ---- 片区纸条 ----

/**
 * 片区纸条用的写法，对应词表 hud.districtNote 的几条：
 * firstDay（游戏的第一天，只看今天，目标二星）、toTwoStars（一星，目标二星）、toNextStar（二星到四星，目标高一星）、
 * maxStars（已经五星）、dropByOnTime 和 dropByCancel（处在「可能掉星」的状态，而且最近两天的统计现在还没有达到要保住的线）、
 * noData（还没有完成的订单）、tooFew（完成的订单少于下限，日结时星级不变）。
 */
export type NoteKind = 'firstDay' | 'toTwoStars' | 'toNextStar' | 'maxStars' | 'dropByOnTime' | 'dropByCancel' | 'noData' | 'tooFew';

export interface DistrictNote {
  district: number;
  open: boolean;
  star: number;
  firstDay: boolean;
  /** 最近两天（第一天只有今天）有结果的、送往这个片区的订单，到现在为止 */
  n: number;
  onTime: number;
  cancelled: number;
  onTimePct: number | null; // 准时率，下取整的百分数，没有订单为 null
  cancelPct: number | null; // 退单率
  next: StarRuleV1 | null; // 升到下一星的条件，已经五星为 null
  keep: StarRuleV1 | null; // 保住现在的星级要达到的条件，三星以下为 null
  atRisk: boolean; // 处在「可能掉星」的状态：三星及以上，上一次日结没有达到 keep，计数为 1
  /** 最近两天的准时率比保住星级的线高几个百分点，负数是低。没有保星线（三星以下）或完成的订单不到下限时为 null */
  margin: number | null;
  /**
   * 从现在起还要连续准时几单，最近两天的准时率才到下一星的线：(准时 + x) / (完成 + x) 不低于升星线，
   * x = (升星线 × 完成的订单数 - 100 × 准时的订单数) / (100 - 升星线)，向上取整。
   * 已经五星、已经达到、完成的订单不到下限时为 null
   */
  shortfall: number | null;
  kind: NoteKind;
}

/**
 * 片区纸条用哪一条，按下面的顺序取第一个满足的。c 是最近两天（第一天只有今天）完成的订单，misses 是连续没有达到要保住的线的日结次数。
 * 1 处在「可能掉星」的状态（三星及以上，次数不小于 1），订单够数，而且现在的统计还没有达到要保住的线：写掉星的两条之一，准时率优先。
 * 2 还没有完成的订单：noData。
 * 3 完成的订单少于下限（STARS_V1.minSample）：tooFew。日结遇到这种情形星级不变，所以不写升星的条件。
 * 4 其余按星级写：一星是 firstDay（游戏的第一天）或 toTwoStars，已经五星是 maxStars，其余是 toNextStar。
 * 第 1 条要求订单够数，因为订单不够时日结不判断掉星（decideStar），那时写「会掉一星」就不是实话。
 * 一般情况下次数为 1 是一次订单够数的日结留下的，两条不会冲突。
 * 处在「可能掉星」的状态时，如果现在的统计已经达到要保住的线，写第 4 条，因为日结不会再掉星。
 */
export function pickNoteKind(star: number, today: number, misses: number, c: ResultCounts): NoteKind {
  const keep = keepRule(star);
  const enough = c.n > 0 && c.n >= STARS_V1.minSample;
  if (keep !== null && misses >= 1 && enough) {
    if (!meetsOnTime(keep, c)) return 'dropByOnTime';
    if (!meetsCancel(keep, c)) return 'dropByCancel';
  }
  if (c.n === 0) return 'noData';
  if (!enough) return 'tooFew';
  if (star === 1) return today === 0 ? 'firstDay' : 'toTwoStars';
  return star < STARS_V1.maxStar && starRule(star + 1) !== null ? 'toNextStar' : 'maxStars';
}

/**
 * 某个片区现在的片区纸条数据。最近两天的统计只扫最近的订单，每次调用的开销与这三天的订单数成正比，
 * 界面每秒调用几次没有问题。已经五星时没有 next，三星以下没有 keep。
 * 处在「可能掉星」的状态时，如果最近两天的统计现在已经达到 keep，仍写升星的那条，因为明天日结不会再掉星。
 * 用哪一条见 pickNoteKind：还没有完成的订单写 noData，不到下限写 tooFew，这两种情形下纸条不写准时率和升星的条件。
 */
export function districtNote(state: SimState, district: number): DistrictNote {
  const campaign = state.campaign;
  const info = campaign?.districts[district];
  if (campaign === null || info === undefined) throw new RangeError(`no district ${String(district)}`);
  const today = Math.floor(state.step / DAY_STEPS);
  const span = windowOfDay(today);
  const c = (tallyResults(state, span.from, span.to)[district] as ResultCounts | undefined) ?? emptyCounts();
  const star = info.star;
  const next = star < STARS_V1.maxStar ? starRule(star + 1) : null;
  const keep = keepRule(star);
  const misses = (campaign.rating[district] as { misses: number } | undefined)?.misses ?? 0;
  const atRisk = keep !== null && misses >= 1;
  const counted = c.n > 0 && c.n >= STARS_V1.minSample;
  const rate = pct(c.onTime, c.n);
  const margin = keep !== null && counted && rate !== null ? rate - keep.onTimeMin : null;
  // 准时率线乘订单数是百分点乘张数。每多一单准时，准时的一边加 100，线的一边加升星线，差距缩小 100 - 升星线
  const gap = next === null ? 0 : next.onTimeMin * c.n - 100 * c.onTime;
  const per = next === null ? 0 : 100 - next.onTimeMin;
  const shortfall = counted && gap > 0 && per > 0 ? Math.floor((gap + per - 1) / per) : null;
  return {
    district,
    open: info.open,
    star,
    firstDay: today === 0,
    n: c.n,
    onTime: c.onTime,
    cancelled: c.cancelled,
    onTimePct: pct(c.onTime, c.n),
    cancelPct: pct(c.cancelled, c.n),
    next,
    keep,
    atRisk,
    margin,
    shortfall,
    kind: pickNoteKind(star, today, misses, c),
  };
}

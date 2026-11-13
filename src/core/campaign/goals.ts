// 每场高峰的目标线。高峰开始时，给每个开通的片区算一个这一场要达到的准时率，小结按它写达没达标。
// 日结时要达到的星级线是 R，最近两天里已完成的订单是 N 张，其中准时 P 张，这一场预计送往这个片区 m 张订单，
// 这一场要达到的准时率是 (R × (N + m) - P) / m。式子把这一场当作日结之前的最后一批订单。
// m 取昨天同一场送往这个片区的订单数，乘今天和昨天星级倍数的比。没有昨天的记录时不设线。
// 算出的值分四种情形：
// - 在 0 到 100 之间：取整数百分点，向上取整，作为这一场的目标线（line）
// - 超过 100：这一场全部准时，日结时的准时率也到不了星级线。目标线改用星级线本身（capped）
// - 不大于 0：这一场一单也不准时，日结时的准时率也已经够了。不设线（enough）
// - N 加 m 不到最少样本：日结时星级不会变，不设线
// 星级线：五星和「可能掉星」的片区用保住现在星级的线，其余用升到下一星的线。目标线只看准时率，退单由小结的整场标记另行看。
// 计算用浮点数，比较时留 1e-9 的余量，边界上不会因为舍入差一个百分点。判有没有达到目标线用整数比较。
import { STAR_MULTIPLIER_V1 } from '../../content/districts_v1.ts';
import { GOALS_V1 } from '../../content/goals_v1.ts';
import { STARS_V1 } from '../../content/stars_v1.ts';
import type { StarRuleV1 } from '../../content/table_types.ts';
import { PROMISE_STEPS } from '../constants.ts';
import { dayOf, peakInProgress, peakWindow } from '../systems/schedule.ts';
import type { PeakName } from '../systems/schedule.ts';
import type { CampaignState, DistrictGoal, GoalBasis, Order, PeakGoals, SimState } from '../types.ts';
import { keepRule, starRule, tallyResults, windowOfDay } from './rating.ts';
import type { ResultCounts } from './rating.ts';

const EPS = 1e-9;

/** 今天的星级倍数相对昨天的星级倍数的比。 */
function starRatio(today: number, yesterday: number): number {
  const at = (star: number): number => STAR_MULTIPLIER_V1[Math.min(Math.max(star, 1), STAR_MULTIPLIER_V1.length) - 1] as number;
  return at(today) / at(yesterday);
}

/** 这个片区这一场的目标线按哪条星级线反推：五星和可能掉星的用保星线，其余用升星线。没有这样的线时为 null。 */
export function goalRule(star: number, misses: number): { basis: GoalBasis; rule: StarRuleV1 } | null {
  const keep = keepRule(star);
  if (star >= STARS_V1.maxStar || (keep !== null && misses >= 1)) return keep === null ? null : { basis: 'keep', rule: keep };
  const next = starRule(star + 1);
  return next === null ? null : { basis: 'next', rule: next };
}

/** 昨天同一场送往这个片区的订单数，以及昨天这个片区的星级。没有记录时为 null。 */
function yesterdayOf(campaign: CampaignState, day: number, peak: PeakName, district: number): { orders: number; star: number } | null {
  if (day < 1) return null;
  const row = campaign.peaks.find((p) => p.day === day - 1 && p.peak === peak)?.districts.find((d) => d.district === district);
  const line = campaign.days[day - 1]?.districts.find((d) => d.district === district);
  return row === undefined || line === undefined ? null : { orders: row.n, star: line.fromStar };
}

/** 一个片区这一场的目标，tally 是最近两天各片区完成的订单。没有设线（没有昨天的记录、订单太少）时为 null。 */
function goalFor(state: SimState, tally: readonly ResultCounts[], day: number, peak: PeakName, district: number): DistrictGoal | null {
  const campaign = state.campaign;
  const info = campaign?.districts[district];
  if (campaign === null || info === undefined || !info.open) return null;
  const picked = goalRule(info.star, campaign.rating[district]?.misses ?? 0);
  const y = yesterdayOf(campaign, day, peak, district);
  if (picked === null || y === null || y.orders <= 0) return null;
  const m = y.orders * starRatio(info.star, y.star);
  const n = tally[district]?.n ?? 0;
  const onTime = tally[district]?.onTime ?? 0;
  if (n + m < STARS_V1.minSample) return null;
  const need = (picked.rule.onTimeMin * (n + m) - 100 * onTime) / m;
  if (need <= EPS) return { district, kind: 'enough', line: null, basis: picked.basis };
  if (need > 100 + EPS) return { district, kind: 'capped', line: picked.rule.onTimeMin, basis: picked.basis };
  return { district, kind: 'line', line: Math.min(100, Math.ceil(need - EPS)), basis: picked.basis };
}

/** 某一天某场高峰里一个片区的目标，按现在的状态算。高峰开始时算出的才是这一场的目标，见 recordPeakGoals。 */
export function districtGoal(state: SimState, day: number, peak: PeakName, district: number): DistrictGoal | null {
  const span = windowOfDay(day);
  return goalFor(state, tallyResults(state, span.from, span.to), day, peak, district);
}

/** 某一天某场高峰里各个开通的片区的目标，没有设线的片区不在里面。 */
export function peakGoals(state: SimState, day: number, peak: PeakName): PeakGoals {
  const campaign = state.campaign;
  if (campaign === null) throw new Error('peak goals are only for the campaign mode');
  const span = windowOfDay(day);
  const tally = tallyResults(state, span.from, span.to);
  const goals: DistrictGoal[] = [];
  campaign.districts.forEach((info, k) => {
    if (!info.open) return;
    const goal = goalFor(state, tally, day, peak, k);
    if (goal !== null) goals.push(goal);
  });
  return { day, peak, step: peakWindow(day, peak).start, goals };
}

/** 高峰的第一步调用：算出这一场各片区的目标，存进 campaign.goals，换掉上一场的。 */
export function recordPeakGoals(state: SimState, day: number, peak: PeakName): void {
  const campaign = state.campaign;
  if (campaign === null) return;
  campaign.goals = peakGoals(state, day, peak);
}

/** campaign.goals 里这一天这一场高峰中一个片区的目标。记着的不是这一场，或者这个片区没有设线，为 null。 */
export function goalOf(campaign: CampaignState, day: number, peak: PeakName, district: number): DistrictGoal | null {
  const goals = campaign.goals;
  if (goals === null || goals.day !== day || goals.peak !== peak) return null;
  return goals.goals.find((g) => g.district === district) ?? null;
}

/** 这一场送往一个片区的订单够不够多，能判这个片区达没达标。 */
export function judgeable(orders: number): boolean {
  return orders >= GOALS_V1.minJudgedOrders;
}

/** 准时率达到目标线。准时的订单数乘 100 不小于目标线乘订单数，用整数比较。 */
export function reachesLine(line: number, orders: number, onTime: number): boolean {
  return 100 * onTime >= line * orders;
}

// ---- 高峰进行中 ----

/** 一个片区在高峰进行中的结果：这一场里已经完成的订单。 */
export interface LiveRow {
  district: number;
  onTime: number; // 承诺时间内送达
  late: number; // 超过承诺时间才送达，或者下单已经超过承诺时间还没送到
  cancelled: number;
  goal: DistrictGoal | null;
}

export interface LiveView {
  peak: PeakName;
  rows: LiveRow[]; // 每个开通的片区一行，按片区编号
}

/**
 * 现在正在进行的这一场高峰里，各个开通的片区的结果。从高峰下单时段的第一步到小结生成的那一步之前都有。
 * 下单还不到承诺时间、还没送到的订单现在还说不上准时或超时，不在任何一项里。不在高峰里为 null。
 */
export function liveRows(state: SimState): LiveView | null {
  const campaign = state.campaign;
  const peak = peakInProgress(state.step);
  if (campaign === null || peak === null) return null;
  const day = dayOf(state.step);
  const period = peakWindow(day, peak);
  const counts = campaign.districts.map(() => ({ onTime: 0, late: 0, cancelled: 0 }));
  for (let i = state.orders.length - 1; i >= 0; i--) {
    const o = state.orders[i] as Order;
    if (o.tOrder < period.start) break;
    if (o.tOrder >= period.end) continue;
    const c = counts[o.district];
    if (c === undefined) continue;
    if (o.tDeliver >= 0) {
      if (o.tDeliver - o.tOrder <= PROMISE_STEPS) c.onTime += 1;
      else c.late += 1;
    } else if (o.tCancel >= 0) {
      c.cancelled += 1;
    } else if (state.step - o.tOrder > PROMISE_STEPS) {
      c.late += 1;
    }
  }
  const rows: LiveRow[] = [];
  campaign.districts.forEach((info, k) => {
    if (!info.open) return;
    const c = counts[k] as { onTime: number; late: number; cancelled: number };
    rows.push({ district: k, onTime: c.onTime, late: c.late, cancelled: c.cancelled, goal: goalOf(campaign, day, peak, k) });
  });
  return { peak, rows };
}

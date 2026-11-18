// 小结的对照：同一批订单、同样的购买，只把「调度策略」和「协同策略」换成开局的卡，这一场会是什么结果。
// 订单的随机数流和派单的随机数流互相独立，一场高峰里来什么订单与用什么卡无关，所以两份状态上的订单完全相同，
// 两个结果是同一批订单上的配对比较，差别只来自策略。
//
// 做法：每场高峰开始时复制一份状态，叫副本。副本的「调度策略」和「协同策略」设成开局的卡，「合单策略」与主状态相同。
// 这一场里玩家的建站、购买、就近降落的开关、退回、开通片区，在同一步原样做给副本。换卡和点击订单插队不做给副本。
// 小结时刻副本推进到同一步，用同一个 peakSummary 算出结果，补进这一场的记录。
// 副本不属于主状态，不进状态哈希和存档。复制状态和一步一步推进副本由会话层做（src/app/play.ts），这里是各步用到的纯函数。
// 副本里失败的命令（例如副本里的飞机还在路上，退不了）会让这一场的副本和主状态不再对得上，这一场没有对照。
import { GOALS_V1 } from '../../content/goals_v1.ts';
import { peakSummary } from '../metrics.ts';
import { peakWindow, summaryStep } from '../systems/schedule.ts';
import type { PeakName } from '../systems/schedule.ts';
import type { PeakBaseline, PeakBaselineRow, SimState } from '../types.ts';
import { applyCommand, quoteCommand } from './commands.ts';
import type { Command, CommandType } from './commands.ts';
import { pct } from './rating.ts';
import { peakRecord } from './summary.ts';

/** 一场高峰的副本。 */
export interface Shadow {
  readonly day: number;
  readonly peak: PeakName;
  /** 开局的卡之下推进的那一份状态。 */
  readonly state: SimState;
  /** 做给副本的命令在副本里失败过：这一场的副本和主状态对不上了，没有对照。 */
  diverged: boolean;
}

/** 副本算出的结果，还没有补进记录。 */
export interface BaselineDraft {
  day: number;
  peak: PeakName;
  orders: number;
  onTime: number;
  late: number;
  lateOpen: number;
  cancelled: number;
  revenue: number;
  districts: PeakBaselineRow[];
  /** 订单平均等飞机的秒数，没有送达的订单时为 NaN。 */
  waitDroneSeconds: number;
}

/** 玩家的命令里，改变运力、降落规则和片区的那几种：做给副本。换卡、点击订单插队、便签已读、使用推演不做，推演只扣一次推演次数，不影响模拟。 */
const FORWARDED: ReadonlySet<CommandType> = new Set<CommandType>([
  'buildStation',
  'buyDrone',
  'buyBay',
  'upgradeGate',
  'buyDoubleBox',
  'buyNearestLanding',
  'setNearestLanding', // 就近降落的开关属于购买的一部分，对照里只有策略卡不同，所以开关也做给副本
  'openDistrict',
  'refundDrone',
  'refundBay',
  'refundStation',
]);

/** 这条命令要不要做给副本。 */
export function isForwarded(command: Command): boolean {
  return FORWARDED.has(command.type);
}

/**
 * 把一份刚复制出来的状态变成这一场的副本：「调度策略」和「协同策略」换成开局的卡，
 * 已经分成午晚两套策略时，两套都换，所以到晚高峰第一步切换策略时也是开局的卡。「合单策略」不动。
 */
export function openShadow(copy: SimState, day: number, peak: PeakName): Shadow {
  const opening = copy.config.rules;
  const sets = copy.campaign?.ruleSets ?? null;
  for (const rules of sets === null ? [copy.rules] : [copy.rules, sets.noon, sets.evening]) {
    rules.select = opening.select;
    rules.zone = opening.zone;
  }
  return { day, peak, state: copy, diverged: false };
}

/**
 * 玩家的一条命令在主状态里成功之后，在一份副本状态上重做一遍，返回在副本里是不是也成功了。两种副本都用它：
 * 小结对照的副本（下面的 forwardToShadow）和效果记录里不购买的副本（src/app/twins.ts）。
 * 副本里的余额和价签的开放可能与主状态不同（订单的结果不同，进账就不同，没做过的购买也没有花钱），买东西不能因此失败：
 * 价签和双层货箱（它们一起开放）在主状态里已经开放时副本也开放，余额不够时补到刚好够。其余原因失败了，副本就和主状态对不上了。
 * 失败的命令不改副本的状态，只有补开放和补余额这两处已经做了。
 */
export function replayOnCopy(copy: SimState, main: SimState, command: Command): boolean {
  const target = copy.campaign;
  const origin = main.campaign;
  if (target === null || origin === null) return false;
  for (const key of ['priceTags', 'doubleBox'] as const) {
    if (origin.unlocks[key] >= 0 && target.unlocks[key] < 0) target.unlocks[key] = origin.unlocks[key];
  }
  const quote = quoteCommand(copy, command);
  if (!quote.ok && quote.reason === 'notEnoughMoney') target.money = quote.price;
  return applyCommand(copy, command).ok;
}

/**
 * 玩家的一条命令在主状态里成功之后，在同一步做给副本。不在名单里的命令什么也不做。
 * 做法见 replayOnCopy。在副本里失败了，副本就和主状态对不上了。
 */
export function forwardToShadow(shadow: Shadow, main: SimState, command: Command): void {
  if (shadow.diverged || !FORWARDED.has(command.type)) return;
  if (!replayOnCopy(shadow.state, main, command)) shadow.diverged = true;
}

/**
 * 副本推进到小结时刻之后，算出这一场的结果。口径和小结的记录相同：同一个 peakSummary，只列开通的片区。
 * 副本和主状态对不上，或者副本不在小结时刻（主状态在这一步生成小结），为 null。
 */
export function finishShadow(shadow: Shadow): BaselineDraft | null {
  const copy = shadow.state;
  const campaign = copy.campaign;
  if (shadow.diverged || campaign === null || copy.step !== summaryStep(shadow.day, shadow.peak)) return null;
  const s = peakSummary(copy, shadow.day, shadow.peak);
  const districts: PeakBaselineRow[] = [];
  campaign.districts.forEach((info, k) => {
    if (!info.open) return;
    const d = s.districts[k];
    const n = d === undefined ? 0 : d.nOrders;
    const onTime = d === undefined ? 0 : d.nOnTime;
    districts.push({ district: k, n, onTime, pct: pct(onTime, n) });
  });
  return {
    day: shadow.day,
    peak: shadow.peak,
    orders: s.nOrders,
    onTime: s.nOnTime,
    late: s.nLate,
    lateOpen: s.nLateOpen,
    cancelled: s.nCancelled,
    revenue: s.revenue,
    districts,
    waitDroneSeconds: s.segments.waitDrone,
  };
}

/** 这一场里「调度策略」和「协同策略」一直是开局的卡：副本和主状态的结果必然相同，没有什么可比的。 */
function usedOpeningRules(state: SimState, day: number, peak: PeakName): boolean {
  const opening = state.config.rules;
  if (state.rules.select !== opening.select || state.rules.zone !== opening.zone) return false;
  const start = peakWindow(day, peak).start;
  const end = summaryStep(day, peak);
  return !state.stats.ruleChanges.some((c) => (c.column === 'select' || c.column === 'zone') && c.step > start && c.step < end);
}

/**
 * 把副本的结果补进这一场的小结记录，返回补上没有。主状态要已经生成了这一场的小结。
 * 这一场整场用的是开局的卡，或者两份状态里的订单数对不上，不补，记录里的 baseline 仍是 null。
 * 订单不多于运力的判断：两种策略下订单平均等飞机的秒数都低于内容表里的数。
 */
export function attachBaseline(state: SimState, draft: BaselineDraft): boolean {
  const record = peakRecord(state, draft.day, draft.peak);
  if (record === null || record.baseline !== null || draft.orders !== record.orders) return false;
  if (usedOpeningRules(state, draft.day, draft.peak)) return false;
  const waits = [peakSummary(state, draft.day, draft.peak).segments.waitDrone, draft.waitDroneSeconds].filter((w) => !Number.isNaN(w));
  const baseline: PeakBaseline = {
    orders: draft.orders,
    onTime: draft.onTime,
    late: draft.late,
    lateOpen: draft.lateOpen,
    cancelled: draft.cancelled,
    revenue: draft.revenue,
    districts: draft.districts,
    lowLoad: waits.length > 0 && waits.every((w) => w < GOALS_V1.lowLoadWaitSeconds),
  };
  record.baseline = baseline;
  return true;
}

// 高峰小结的记录和说明句。
// 在每场高峰的小结时刻（summaryStep，高峰结束 30 秒后）生成一条记录，存进 campaign.peaks，之后不再修改。
// 五个数、各片区准时率、一张订单的四段时间、提前派出的订单数都沿用 metrics.ts 的 peakSummary 的口径。
// 说明句由一个主句和最多一个附加句组成，各有一张按顺序判断的条件表。这里只返回句子的编号和要填的参数，
// 编号就是词表 summary.main 和 summary.extra 的键，参数名与词表一致，中文由界面从词表取。
// 各片区一行里还写这一场的目标线和有没有达到（目标线在高峰开始时算好，见 goals.ts），小结的对照由 shadow.ts 在生成之后补进记录。
import { MAP_V1 } from '../../content/map_v1.ts';
import { NOTES_V1 } from '../../content/notes_v1.ts';
import { UNLOCKS_V1 } from '../../content/unlocks_v1.ts';
import { peakSummary } from '../metrics.ts';
import { dayOf } from '../systems/schedule.ts';
import type { PeakName } from '../systems/schedule.ts';
import type { ExtraSentence, MainSentence, PeakDistrictRow, PeakRecord, PeakSegments, SimState } from '../types.ts';
import { goalOf, judgeable, reachesLine } from './goals.ts';
import { bayCap } from './prices.ts';
import { pct } from './rating.ts';
import { pushTip } from './tips.ts';
import { unlock } from './unlocks.ts';

/** 秒数的平均值里，差别小于这个数的当作并列（真实的差别至少是 0.1 秒除以订单数）。 */
const TIE = 1e-9;

/** 比率的下取整百分数。比率是除法的结果，乘 100 前加一个极小量，防止 0.58 变成 57.99999999999999。 */
function floorRatio(ratio: number): number {
  return Math.floor(ratio * 100 + 1e-9);
}

// ---- 说明句 ----

/** 选说明句用的数据，都是一场高峰的统计，不含已退回的站。 */
export interface SentenceInput {
  nOrders: number; // 来单
  nDelivered: number; // 其中到小结时刻已经送达的，不含超时后还没送到的
  nOnTime: number; // 准时
  /** 已经送达的订单的四段平均用时（秒）。没有送达的订单时为 null */
  segments: { waitDrone: number; waitGate: number; waitPrep: number; road: number } | null;
  /** 没退回的站在这一场的平均等降落架数，和停机位空着的时间比例（没有停机位时为 NaN） */
  stations: { id: number; landWaitAvg: number; bayEmptyShare: number }[];
  /** 已派出的订单里不是离店最近的站配送的比例，没有已派出的订单时为 NaN */
  nonNearestRate: number;
  /** 各片区这一场的订单数和其中准时送达的 */
  districts: { district: number; n: number; onTime: number }[];
}

export interface Sentences {
  main: MainSentence;
  extra: ExtraSentence | null;
}

/** 主句的第 4 到 7 条按这个顺序排，四段并列最长时取靠前的一条。 */
const LONGEST_ORDER = ['waitDrone', 'waitGate', 'road', 'waitPrep'] as const;

/**
 * 主句，取条件表里第一个满足的：
 * 1 这一场没有订单，2 没有送达的订单，3 准时率不小于 90%，4 等飞机最长，5 等起降最长，6 路上最长，7 等出餐最长。
 * 「90% 以上」按不小于算，准时率是准时数除以来单（含退单）。
 */
export function pickMain(input: SentenceInput): MainSentence {
  if (input.nOrders === 0) return { id: 'noOrders' };
  if (input.nDelivered === 0 || input.segments === null) return { id: 'noDelivered' };
  if (100 * input.nOnTime >= NOTES_V1.onTimeHigh * input.nOrders) {
    return { id: 'onTimeHigh', onTime: Math.floor((100 * input.nOnTime) / input.nOrders) };
  }
  let best: (typeof LONGEST_ORDER)[number] = LONGEST_ORDER[0];
  for (const id of LONGEST_ORDER) {
    if ((input.segments[id] as number) > (input.segments[best] as number) + TIE) best = id;
  }
  return { id: best };
}

/**
 * 附加句，最多一条。同时满足多条时取下表靠前的一条，同一条有多座站或多个片区满足时取数值最大的一个，数值相同取编号小的：
 * 1 某座站平均有不少于 1 架飞机等降落，
 * 2 主句是等飞机，并且某座站的停机位有一半以上的时间是空的，
 * 3 主句是路上，并且不少于三成的订单不是由离店最近的站配送的，
 * 4 某个片区的准时率比全城低 20 个百分点以上。
 * 「不少于」「一半以上」「以上」都按不小于算。
 */
export function pickExtra(input: SentenceInput, main: MainSentence): ExtraSentence | null {
  let landQueue: { id: number; avg: number } | null = null;
  for (const s of input.stations) {
    if (s.landWaitAvg >= NOTES_V1.landQueueMin && (landQueue === null || s.landWaitAvg > landQueue.avg)) landQueue = { id: s.id, avg: s.landWaitAvg };
  }
  if (landQueue !== null) return { id: 'landQueue', station: landQueue.id, count: Math.round(landQueue.avg * 10) / 10 };

  if (main.id === 'waitDrone') {
    let idle: { id: number; share: number } | null = null;
    for (const s of input.stations) {
      if (s.bayEmptyShare >= NOTES_V1.bayIdleShare / 100 && (idle === null || s.bayEmptyShare > idle.share)) idle = { id: s.id, share: s.bayEmptyShare };
    }
    if (idle !== null) return { id: 'bayIdle', station: idle.id, percent: floorRatio(idle.share) };
  }

  if (main.id === 'road' && input.nonNearestRate >= NOTES_V1.notNearestShare / 100) {
    return { id: 'notNearest', percent: floorRatio(input.nonNearestRate) };
  }

  // 片区的准时率比全城低这么多个百分点以上：全城 a/N，片区 o/n，a/N - o/n 不小于 gap/100。
  // 全城的比率是同一个数，所以差最大的就是准时率最低的片区
  let low: { district: number; n: number; onTime: number } | null = null;
  for (const d of input.districts) {
    if (d.n === 0) continue;
    if (100 * (input.nOnTime * d.n - d.onTime * input.nOrders) < NOTES_V1.districtLowGap * input.nOrders * d.n) continue;
    if (low === null || d.onTime * low.n < low.onTime * d.n) low = d;
  }
  if (low !== null) return { id: 'districtLow', district: low.district, onTime: Math.floor((100 * low.onTime) / low.n) };
  return null;
}

export function pickSentences(input: SentenceInput): Sentences {
  const main = pickMain(input);
  return { main, extra: pickExtra(input, main) };
}

// ---- 四段时间的百分数 ----

/** 把几个非负数折成加起来是 100 的整数百分数，按最大余数法分配，余数相同的靠前的先得。 */
export function sharesOf100(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (!(total > 0)) return values.map(() => 0);
  const raw = values.map((v) => (100 * Math.max(0, v)) / total);
  const out = raw.map((r) => Math.floor(r));
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rest: r - Math.floor(r) })).sort((p, q) => q.rest - p.rest || p.i - q.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = (out[i] as number) + 1;
    left -= 1;
  }
  return out;
}

// ---- 记录 ----

/** 有没有哪座站的停机位已经到了屋顶的上限。 */
export function anyStationAtCap(state: SimState): boolean {
  const campaign = state.campaign;
  if (campaign === null) return false;
  return state.stations.some((s) => {
    if (s.removed) return false;
    const roof = MAP_V1.roofs[(campaign.stations[s.id] as { roof: number }).roof];
    return roof !== undefined && s.bays >= bayCap(roof.size);
  });
}

/** 找一场高峰的记录。 */
export function peakRecord(state: SimState, day: number, peak: PeakName): PeakRecord | null {
  return state.campaign?.peaks.find((p) => p.day === day && p.peak === peak) ?? null;
}

/**
 * 在小结时刻生成一场高峰的记录，存进 campaign.peaks，并检查靠小结触发的三件事：
 * - 超时的订单（含还没送到的）超过来单的一定比例（内容表 UNLOCKS_V1.selectLateAbove）：「调度策略」一栏开放
 * - 主句是等飞机，并且有站的停机位已经到了屋顶的上限：双层货箱开放
 * - 有站平均有不少于 1 架飞机等降落：放出「起降口忙不过来」的便签，参数是这座站的编号
 * 要在高峰的小结时刻（状态推进到 summaryStep）调用，早了统计口径不对。
 */
export function recordPeakSummary(state: SimState, day: number, peak: PeakName): PeakRecord {
  const campaign = state.campaign;
  if (campaign === null) throw new Error('peak records are only for the campaign mode');
  const s = peakSummary(state, day, peak);
  const nDelivered = s.nOnTime + (s.nLate - s.nLateOpen);
  const previous = peakRecord(state, day - 1, peak);

  const districts: PeakDistrictRow[] = [];
  campaign.districts.forEach((info, k) => {
    if (!info.open) return;
    const d = s.districts[k];
    const n = d === undefined ? 0 : d.nOrders;
    const onTime = d === undefined ? 0 : d.nOnTime;
    const rate = pct(onTime, n);
    const before = previous?.districts.find((row) => row.district === k)?.pct ?? null;
    // 目标线是高峰开始时算好的。这一场送往这个片区的订单不够多时不判
    const line = goalOf(campaign, day, peak, k)?.line ?? null;
    const met = line !== null && judgeable(n) ? reachesLine(line, n, onTime) : null;
    districts.push({ district: k, n, onTime, pct: rate, delta: rate !== null && before !== null ? rate - before : null, line, met });
  });
  // 判过的片区全部达标，并且这一场没有退单，整张小结有一个标记
  const judged = districts.filter((row) => row.met !== null);
  const cleared = judged.length === 0 ? null : judged.every((row) => row.met === true) && s.nCancelled === 0;

  const live = state.stations.filter((st) => !st.removed);
  const input: SentenceInput = {
    nOrders: s.nOrders,
    nDelivered,
    nOnTime: s.nOnTime,
    segments: nDelivered > 0 ? { waitDrone: s.segments.waitDrone, waitGate: s.segments.waitGate, waitPrep: s.segments.waitPrep, road: s.segments.road } : null,
    stations: live.map((st) => {
      const stats = s.stations[st.id];
      return { id: st.id, landWaitAvg: stats === undefined ? 0 : stats.landWaitAvg, bayEmptyShare: stats === undefined ? Number.NaN : stats.bayEmptyShare };
    }),
    nonNearestRate: s.nonNearestRate,
    districts: districts.map((row) => ({ district: row.district, n: row.n, onTime: row.onTime })),
  };
  const { main, extra } = pickSentences(input);

  let segments: PeakSegments | null = null;
  if (input.segments !== null) {
    const [waitDrone, waitGate, waitPrep, road] = sharesOf100([input.segments.waitDrone, input.segments.waitGate, input.segments.waitPrep, input.segments.road]) as [number, number, number, number];
    segments = { waitDrone, waitGate, waitPrep, road };
  }

  const record: PeakRecord = {
    day,
    peak,
    step: state.step,
    orders: s.nOrders,
    onTime: s.nOnTime,
    late: s.nLate,
    lateOpen: s.nLateOpen,
    cancelled: s.nCancelled,
    revenue: s.revenue,
    districts,
    segments,
    select: state.rules.select,
    early: s.early.count,
    changedMidPeak: s.early.changedMidPeak,
    main,
    extra,
    cleared,
    baseline: null,
  };
  campaign.peaks.push(record);

  if (s.nOrders > 0 && 100 * s.nLate > UNLOCKS_V1.selectLateAbove * s.nOrders) unlock(state, 'selectColumn');
  if (main.id === 'waitDrone' && anyStationAtCap(state)) unlock(state, 'doubleBox');
  if (extra !== null && extra.id === 'landQueue') pushTip(state, 'gateBusy', extra.station);
  return record;
}

// ---- 调度台白板底部的小票条 ----

/** 白板底部「昨天{高峰}　准时 {a}%　退单 {n}　进账 ¥{金额}」要填的数。 */
export interface PeakTicket {
  day: number; // 记录是哪一天的
  peak: PeakName;
  onTimePct: number | null; // 准时率，下取整的百分数，这一场没有订单时为 null
  cancelled: number;
  revenue: number;
}

/**
 * 前一天同一场高峰的准时率、退单数和进账，取自小结的记录。today 缺省为现在的游戏日。
 * 没有记录（第一天，或者前一天的小结还没生成）时为 null，界面写「还没有昨天这场高峰的记录」。
 */
export function lastPeakTicket(state: SimState, peak: PeakName, today: number = dayOf(state.step)): PeakTicket | null {
  const record = peakRecord(state, today - 1, peak);
  if (record === null) return null;
  return { day: record.day, peak, onTimePct: pct(record.onTime, record.orders), cancelled: record.cancelled, revenue: record.revenue };
}

// 高峰小结的记录和说明句。
// 在每场高峰的小结时刻（summaryStep，高峰结束 30 秒后）生成一条记录，存进 campaign.peaks，之后不再修改。
// 五个数、各片区准时率、一张订单的四段时间、提前派出的订单数都沿用 metrics.ts 的 peakSummary 的口径。
// 说明句由一个主句和最多一个附加句组成，各有一张按顺序判断的条件表。这里只返回句子的编号和要填的参数，
// 编号就是词表 summary.main 和 summary.extra 的键，参数名与词表一致，中文由界面从词表取。
// 各片区一行里还写这一场的目标线和有没有达到（目标线在高峰开始时算好，见 goals.ts），小结的对照由 shadow.ts 在生成之后补进记录。
// 记录里还有机队时间构成、回站飞行占比和各站的一行：数取自 campaign.tally 里当场高峰的计数（fleet.ts），生成记录时读出并清零。
// 生成记录时数据员的推演次数加一次（内容表 FORECAST_V1），攒到上限为止。
import { FORECAST_V1 } from '../../content/forecast_v1.ts';
import { NOTES_V1 } from '../../content/notes_v1.ts';
import { UNLOCKS_V1 } from '../../content/unlocks_v1.ts';
import { STEPS_PER_SECOND } from '../constants.ts';
import { peakSummary } from '../metrics.ts';
import type { StationStats } from '../metrics.ts';
import { dayOf, peakWindow, summaryStep } from '../systems/schedule.ts';
import type { PeakName } from '../systems/schedule.ts';
import type { ExtraSentence, MainSentence, Order, PeakDistrictRow, PeakFleet, PeakRecord, PeakSegments, PeakStationRow, SimState } from '../types.ts';
import { FLEET_CLASSES, resetPeakTally } from './fleet.ts';
import { goalOf, judgeable, reachesLine } from './goals.ts';
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
  /**
   * 没退回的站在这一场的平均等降落架数，和停机位空着的时间比例（没有停机位时为 NaN），
   * 以及至少有 1 架无人机等待起飞的时间占这一场的百分数（下取整，没有计数时缺省为 0）
   */
  stations: { id: number; landWaitAvg: number; bayEmptyShare: number; takeoffWaitPct?: number }[];
  /** 全部无人机空载飞行的时间占机队时间的百分数，取自机队时间构成（PeakRecord.fleet.empty）。没有机队时间构成时为 null，缺省也按 null */
  emptyFlightPct?: number | null;
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
 * 1 某座站至少有 1 架无人机等待起飞的时间占这一场的比例不小于内容表的 takeoffWaitPct，
 * 2 某座站平均有不少于 1 架飞机等降落，
 * 3 主句是等飞机，并且某座站的停机位有一半以上的时间是空的，
 * 4 全部无人机空载飞行的时间占机队时间的比例不小于内容表的 emptyFlightPct，
 * 5 主句是路上，并且不少于三成的订单不是由离店最近的站配送的，
 * 6 某个片区的准时率比全城低 20 个百分点以上。
 * 「不少于」「不小于」「一半以上」「以上」都按不小于算。
 */
export function pickExtra(input: SentenceInput, main: MainSentence): ExtraSentence | null {
  let takeoffWait: { id: number; pct: number } | null = null;
  for (const s of input.stations) {
    const pct = s.takeoffWaitPct ?? 0;
    if (pct < NOTES_V1.takeoffWaitPct) continue;
    if (takeoffWait === null || pct > takeoffWait.pct || (pct === takeoffWait.pct && s.id < takeoffWait.id)) takeoffWait = { id: s.id, pct };
  }
  if (takeoffWait !== null) return { id: 'takeoffWait', station: takeoffWait.id, percent: takeoffWait.pct };

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

  const emptyFlight = input.emptyFlightPct ?? null;
  if (emptyFlight !== null && emptyFlight >= NOTES_V1.emptyFlightPct) return { id: 'emptyFlight', percent: emptyFlight };

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

// ---- 机队时间构成和各站的一行 ----

/** 机队时间构成：五类的架·步数折成加起来是 100 的整数百分数。没有计数（没有无人机，或者这一场没有计过步）时为 null。 */
function fleetShares(counts: readonly number[] | undefined): PeakFleet | null {
  const row = Array.from({ length: FLEET_CLASSES }, (_, i) => counts?.[i] ?? 0);
  if (!(row.reduce((a, b) => a + b, 0) > 0)) return null;
  const [loaded, empty, work, queue, parked] = sharesOf100(row) as [number, number, number, number, number];
  return { loaded, empty, work, queue, parked };
}

/**
 * 回站飞行占机队时间的百分数：回站飞行的「架·步」数乘 100，除以五类的「架·步」数之和，下取整。
 * 分母与 fleetShares 相同，没有计数时为 null，与机队时间构成同时为 null。
 * 分子和分母都是整数，商不是整数时与相邻整数的差不小于 1 除以架·步数，浮点误差碰不到取整的边界。
 */
function backShare(back: number, counts: readonly number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  return total > 0 ? Math.floor((100 * back) / total) : null;
}

/**
 * 这一场里已经送达的订单，按订单从哪座站起飞（order.departed）分组，起降排队（order.gateWait）的平均秒数，下标是站的编号。
 * 订单的范围和送达的截止与 peakSummary 相同：这一场下单的时段内下的单，到小结时刻之前送达的。没有这样的订单的站为 null。
 */
function gateWaitSeconds(state: SimState, day: number, peak: PeakName): (number | null)[] {
  const { start, end } = peakWindow(day, peak);
  const cut = summaryStep(day, peak);
  const steps = new Array<number>(state.stations.length).fill(0);
  const delivered = new Array<number>(state.stations.length).fill(0);
  for (const o of state.orders as readonly Order[]) {
    if (o.tOrder < start || o.tOrder >= end || o.tDeliver < 0 || o.tDeliver >= cut) continue;
    if (o.departed < 0 || o.departed >= steps.length) continue;
    steps[o.departed] = (steps[o.departed] as number) + o.gateWait;
    delivered[o.departed] = (delivered[o.departed] as number) + 1;
  }
  return steps.map((total, i) => ((delivered[i] as number) > 0 ? total / (delivered[i] as number) / STEPS_PER_SECOND : null));
}

/** 各站的一行、机队时间构成、回站飞行占比，以及便签要用的原始计数：计数覆盖的步数，和各行的站至少有 1 架无人机排队的步数（下标与 stations 对齐）。 */
interface StationRows {
  fleet: PeakFleet | null;
  fleetBack: number | null;
  stations: PeakStationRow[];
  steps: number;
  queueSteps: number[];
}

/**
 * 小结里没有退回的站，一站一行，按编号排，以及全部这些站合计的机队时间构成和回站飞行占比。取当场高峰的计数，取完清零。
 * 回站飞行占比的分子和机队时间构成的五类一样，只合计没有退回的站，所以分子是分母的一部分。
 * 两个时间占比的分母是计数覆盖的步数，一般就是这一场高峰的时长。从旧存档迁移之后的第一场高峰可能只覆盖了后半段。
 * 记录里的百分数下取整，起降拥堵便签要按真实的占比判断，所以原始的步数一并返回。
 */
function stationRows(state: SimState, day: number, peak: PeakName, stats: readonly StationStats[]): StationRows {
  const campaign = state.campaign;
  if (campaign === null) throw new Error('peak records are only for the campaign mode');
  const tally = campaign.tally.peak;
  const gateWait = gateWaitSeconds(state, day, peak);
  const all = new Array<number>(FLEET_CLASSES).fill(0);
  let back = 0;
  const stations: PeakStationRow[] = [];
  const queueSteps: number[] = [];
  for (const st of state.stations) {
    if (st.removed) continue;
    const counts = tally.fleet[st.id];
    for (let i = 0; i < FLEET_CLASSES; i++) all[i] = (all[i] as number) + (counts?.[i] ?? 0);
    back += tally.back[st.id] ?? 0;
    const landWait = stats[st.id];
    stations.push({
      station: st.id,
      gateWait: gateWait[st.id] ?? null,
      landWaitAvg: landWait === undefined ? 0 : landWait.landWaitAvg,
      takeoffWaitPct: pct(tally.takeoffWait[st.id] ?? 0, tally.steps) ?? 0,
      queuePct: pct(tally.queue[st.id] ?? 0, tally.steps) ?? 0,
      sorties: tally.sorties[st.id] ?? 0,
      fleet: fleetShares(counts),
    });
    queueSteps.push(tally.queue[st.id] ?? 0);
  }
  const steps = tally.steps;
  resetPeakTally(state);
  return { fleet: fleetShares(all), fleetBack: backShare(back, all), stations, steps, queueSteps };
}

// ---- 记录 ----

/** 找一场高峰的记录。 */
export function peakRecord(state: SimState, day: number, peak: PeakName): PeakRecord | null {
  return state.campaign?.peaks.find((p) => p.day === day && p.peak === peak) ?? null;
}

/**
 * 在小结时刻生成一场高峰的记录，存进 campaign.peaks，并检查靠小结触发的两件事：
 * - 超时的订单（含还没送到的）超过来单的一定比例（内容表 UNLOCKS_V1.selectLateAbove）：「调度策略」一栏开放
 * - 有站至少有 1 架无人机排队（等待起飞或等待降落）的时间占这一场的比例大于内容表的 gateBusyPct：
 *   放出「起降口忙不过来」的便签，参数是这个比例最大的站的编号，相同取编号小的。
 *   比例用排队的步数和这一场的步数直接比，不取记录里下取整的百分数：10.9% 记为 10，下取整之后不大于 10，实际已经超过了一成
 * 双层货箱不在这里开放，它随价签一起开放，见 unlocks.ts。
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

  // 各站的一行和机队时间构成，读出当场高峰的计数，读完清零
  const rows = stationRows(state, day, peak, s.stations);
  const input: SentenceInput = {
    nOrders: s.nOrders,
    nDelivered,
    nOnTime: s.nOnTime,
    segments: nDelivered > 0 ? { waitDrone: s.segments.waitDrone, waitGate: s.segments.waitGate, waitPrep: s.segments.waitPrep, road: s.segments.road } : null,
    stations: rows.stations.map((row) => {
      const stats = s.stations[row.station];
      return { id: row.station, landWaitAvg: row.landWaitAvg, bayEmptyShare: stats === undefined ? Number.NaN : stats.bayEmptyShare, takeoffWaitPct: row.takeoffWaitPct };
    }),
    emptyFlightPct: rows.fleet === null ? null : rows.fleet.empty,
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
    fleet: rows.fleet,
    fleetBack: rows.fleetBack,
    stations: rows.stations,
  };
  campaign.peaks.push(record);
  // 推演次数从开局起就累积，不看数据员到岗没有：到岗时已经有几次可用
  campaign.forecast.charges = Math.min(FORECAST_V1.maxCharges, campaign.forecast.charges + FORECAST_V1.chargesPerPeak);

  if (s.nOrders > 0 && 100 * s.nLate > UNLOCKS_V1.selectLateAbove * s.nOrders) unlock(state, 'selectColumn');
  // 「起降口忙不过来」的便签。排队的步数乘 100 大于内容表的百分数乘这一场的步数，整数运算，没有浮点误差。
  // 各站的行按编号从小到大，比例相同时留下先遇到的，也就是编号小的。这一场没有计数时步数为 0，不会触发
  let busiest = -1;
  let busiestSteps = 0;
  rows.stations.forEach((row, i) => {
    const queued = rows.queueSteps[i] as number;
    if (100 * queued > NOTES_V1.gateBusyPct * rows.steps && (busiest < 0 || queued > busiestSteps)) {
      busiest = row.station;
      busiestSteps = queued;
    }
  });
  if (busiest >= 0) pushTip(state, 'gateBusy', busiest);
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

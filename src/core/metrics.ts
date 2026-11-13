// 统计：按下单时刻归属的订单结果，以及高峰小结用的指标。
// 订单类指标统计「这个时段里下的单」自己的结局，所以模拟结束后要多跑一段不再来单的时间。
import { DAY_STEPS, DT, PROMISE_STEPS, STEPS_PER_SECOND } from './constants.ts';
import { peakId, peakWindow, summaryStep } from './systems/schedule.ts';
import type { PeakName } from './systems/schedule.ts';
import type { SimState } from './types.ts';

export type ScopeName = 'day' | 'noon' | 'evening';

export interface DistrictStats {
  nOrders: number;
  nOnTime: number;
  nCancelled: number;
  onTimeRate: number;
  cancelRate: number;
  revenue: number; // 送到这个片区的订单的进账
}

/** 一张订单从下单到送达的平均用时（秒），分四段，四段相加等于总用时。 */
export interface Segments {
  waitDrone: number; // 等飞机：下单到派单
  waitGate: number; // 等起降：派单到起飞开始
  waitPrep: number; // 等出餐：飞机到店到取餐开始
  road: number; // 路上：其余，含起飞、飞行、取餐和送达动作
  total: number;
}

export interface WindowStats {
  start: number;
  end: number;
  cutoff: number | null; // 只统计这一步之前发生的事件，null 表示不限
  nOrders: number;
  nOnTime: number;
  nLateDelivered: number; // 超过承诺时间才送到
  nUnresolved: number; // 还没有送达也没有退单
  nCancelled: number;
  onTimeRate: number;
  cancelRate: number;
  durMean: number; // 送达订单的平均用时（秒）
  revenue: number;
  tips: number;
  districts: DistrictStats[]; // 按送达片区
  segments: Segments;
  nonNearestRate: number; // 已派出的订单里，不是由离店最近的站配送的比例
  nEarly: number; // 记为提前派出的订单数
  sharedRate: number; // 送达的订单里，取餐之后机上同时有别的订单（同乘）的比例
  nDeliveredInWindow: number; // 这个时段内送达的订单数，按送达时刻算，不论订单是哪天下的
}

export interface StationStats {
  landWaitAvg: number; // 平均有几架飞机在上空等降落
  bayEmptyShare: number; // 停机位是空的时间比例
}

export interface ScopeMetrics extends WindowStats {
  stations: StationStats[];
  // 飞行距离按游戏日累计，所以只有全天一栏有值，午、晚两个高峰一栏是 NaN
  distTotal: number; // 全部飞机的飞行距离
  distLoaded: number; // 其中载货飞行的距离
  emptyShare: number; // 空飞（没有载货）的距离占比
  distPerOrder: number; // 每张送达订单对应的飞行距离：当天的飞行距离除以当天送达的订单数
}

export type DayMetrics = Record<ScopeName, ScopeMetrics>;

const NAN = Number.NaN;

function ratio(a: number, b: number): number {
  return b > 0 ? a / b : NAN;
}

/** 一个时段 [start, end) 内下的订单的结局。cutoff 给出时，只算在这一步之前发生的送达和退单。 */
export function windowStats(state: SimState, start: number, end: number, cutoff: number | null = null): WindowStats {
  const cut = cutoff ?? Infinity;
  const nDistricts = state.world.districts.length;
  const dn = new Array<number>(nDistricts).fill(0);
  const dOnTime = new Array<number>(nDistricts).fill(0);
  const dCancelled = new Array<number>(nDistricts).fill(0);
  const dRevenue = new Array<number>(nDistricts).fill(0);
  let nOrders = 0;
  let nOnTime = 0;
  let nLate = 0;
  let nCancelled = 0;
  let nUnresolved = 0;
  let nDelivered = 0;
  let revenue = 0;
  let tips = 0;
  let durSum = 0;
  let waitDrone = 0;
  let waitGate = 0;
  let waitPrep = 0;
  let nAssigned = 0;
  let nNonNearest = 0;
  let nShared = 0;
  let nDeliveredInWindow = 0;
  const inWindow = new Set<number>();

  for (const o of state.orders) {
    if (o.tDeliver >= start && o.tDeliver < end && o.tDeliver < cut) nDeliveredInWindow++;
    if (o.tOrder < start || o.tOrder >= end) continue;
    inWindow.add(o.id);
    nOrders++;
    dn[o.district] = (dn[o.district] as number) + 1;
    if (o.tDeliver >= 0 && o.tDeliver < cut) {
      const dur = o.tDeliver - o.tOrder;
      nDelivered++;
      durSum += dur;
      revenue += o.rev;
      dRevenue[o.district] = (dRevenue[o.district] as number) + o.rev;
      tips += o.tip;
      if (o.shared) nShared++;
      waitDrone += o.tAssign - o.tOrder;
      waitGate += o.gateWait;
      waitPrep += o.tPick - o.tArrive;
      if (dur <= PROMISE_STEPS) {
        nOnTime++;
        dOnTime[o.district] = (dOnTime[o.district] as number) + 1;
      } else {
        nLate++;
      }
    } else if (o.tCancel >= 0 && o.tCancel < cut) {
      nCancelled++;
      dCancelled[o.district] = (dCancelled[o.district] as number) + 1;
    } else {
      nUnresolved++;
    }
    if (o.tAssign >= 0 && o.tAssign < cut) {
      nAssigned++;
      if (o.departed !== o.home) nNonNearest++;
    }
  }

  const durMean = nDelivered > 0 ? (durSum / nDelivered) * DT : NAN;
  const mean = (sum: number): number => (nDelivered > 0 ? (sum / nDelivered) * DT : NAN);
  const wd = mean(waitDrone);
  const wg = mean(waitGate);
  const wp = mean(waitPrep);
  let nEarly = 0;
  for (const e of state.stats.early) {
    if (e.step < cut && inWindow.has(e.order)) nEarly++;
  }
  return {
    start,
    end,
    cutoff,
    nOrders,
    nOnTime,
    nLateDelivered: nLate,
    nUnresolved,
    nCancelled,
    onTimeRate: ratio(nOnTime, nOrders),
    cancelRate: ratio(nCancelled, nOrders),
    durMean,
    revenue,
    tips,
    districts: dn.map((n, k) => ({
      nOrders: n,
      nOnTime: dOnTime[k] as number,
      nCancelled: dCancelled[k] as number,
      onTimeRate: ratio(dOnTime[k] as number, n),
      cancelRate: ratio(dCancelled[k] as number, n),
      revenue: dRevenue[k] as number,
    })),
    segments: { waitDrone: wd, waitGate: wg, waitPrep: wp, road: durMean - wd - wg - wp, total: durMean },
    nonNearestRate: ratio(nNonNearest, nAssigned),
    nEarly,
    sharedRate: ratio(nShared, nDelivered),
    nDeliveredInWindow,
  };
}

/** 一个时段内各站的起降口和停机位情况。时段两端必须是整秒。 */
export function stationStats(state: SimState, start: number, end: number): StationStats[] {
  if (start % STEPS_PER_SECOND !== 0 || end % STEPS_PER_SECOND !== 0) {
    throw new RangeError('station statistics are kept per second; period edges must be whole seconds');
  }
  const s0 = start / STEPS_PER_SECOND;
  const s1 = end / STEPS_PER_SECOND;
  return state.stations.map((s) => {
    const sum = (rows: number[][]): number => {
      const row = rows[s.id] as number[];
      let total = 0;
      for (let sec = s0; sec < s1; sec++) total += row[sec] ?? 0;
      return total;
    };
    return {
      landWaitAvg: sum(state.stats.landWait) / (end - start),
      bayEmptyShare: ratio(sum(state.stats.bayEmpty), sum(state.stats.bayTotal)),
    };
  });
}

function scopeWindow(day: number, scope: ScopeName): { start: number; end: number } {
  if (scope === 'day') return { start: day * DAY_STEPS, end: (day + 1) * DAY_STEPS };
  return peakWindow(day, scope);
}

/** 某一天全天、午高峰、晚高峰三个时段的指标。 */
export function dayMetrics(state: SimState, day: number): DayMetrics {
  const one = (scope: ScopeName): ScopeMetrics => {
    const w = scopeWindow(day, scope);
    const stats = windowStats(state, w.start, w.end);
    // 飞行距离按游戏日累计，只有全天一栏有。每张送达订单对应的飞行距离按送达时刻归日，除以当天送达的订单数
    const total = scope === 'day' ? (state.stats.flightTotal[day] ?? 0) : NAN;
    const loaded = scope === 'day' ? (state.stats.flightLoaded[day] ?? 0) : NAN;
    return {
      ...stats,
      stations: stationStats(state, w.start, w.end),
      distTotal: total,
      distLoaded: loaded,
      emptyShare: ratio(total - loaded, total),
      distPerOrder: ratio(total, stats.nDeliveredInWindow),
    };
  };
  return { day: one('day'), noon: one('noon'), evening: one('evening') };
}

// ---- 取第 2 天起的平均 ----
type Tree = number | null | string | Tree[] | { [key: string]: Tree };

function meanTree(items: readonly Tree[]): Tree {
  const first = items[0];
  if (typeof first === 'number') {
    const values = (items as number[]).filter((v) => !Number.isNaN(v));
    return values.length === 0 ? NAN : values.reduce((a, b) => a + b, 0) / values.length;
  }
  if (Array.isArray(first)) {
    return first.map((_, i) => meanTree((items as Tree[][]).map((arr) => arr[i] as Tree)));
  }
  if (first !== null && typeof first === 'object') {
    const out: { [key: string]: Tree } = {};
    for (const key of Object.keys(first)) {
      out[key] = meanTree((items as { [key: string]: Tree }[]).map((obj) => obj[key] as Tree));
    }
    return out;
  }
  return first ?? null;
}

/** 平均后的指标：时段边界和截止步对多天的平均没有意义，去掉。 */
export type ScopeValues = Omit<ScopeMetrics, 'start' | 'end' | 'cutoff'>;
export type MeanMetrics = Record<ScopeName, ScopeValues>;

function withoutWindow(m: ScopeMetrics): ScopeValues {
  const { start: _start, end: _end, cutoff: _cutoff, ...values } = m;
  return values;
}

/** 第 2 天起各天指标的平均；只有一天时取第 1 天。比率里没有订单的天（NaN）不参与平均。 */
export function meanFromDay2(daily: readonly DayMetrics[]): MeanMetrics {
  const days = daily.length > 1 ? daily.slice(1) : daily;
  const stripped = days.map((d) => ({
    day: withoutWindow(d.day),
    noon: withoutWindow(d.noon),
    evening: withoutWindow(d.evening),
  }));
  return meanTree(stripped as unknown as Tree[]) as unknown as MeanMetrics;
}

/** 多个种子的平均，逐项计算，比率里没有订单的（NaN）不参与。 */
export function averageMetrics(list: readonly MeanMetrics[]): MeanMetrics {
  return meanTree(list as unknown as Tree[]) as unknown as MeanMetrics;
}

// ---- 高峰小结 ----
export interface PeakSummary {
  day: number;
  peak: PeakName;
  period: { start: number; end: number }; // 高峰的下单时段 [start, end)
  generatedAt: number; // 时段结束 30 秒后
  ready: boolean; // 状态是否已经推进到生成的时刻
  nOrders: number;
  nOnTime: number;
  nLate: number; // 超时：超过承诺时间才送到，加上到生成时刻还没有送到的
  nLateOpen: number; // 超时的订单里还没有送到的
  nCancelled: number; // 到生成时刻为止的退单
  revenue: number;
  districts: DistrictStats[];
  segments: Segments;
  early: {
    count: number | null; // 提前派出的订单数。这一场中途换过「先送哪张单」时为 null
    rules: string[]; // 记数时生效过的「先送哪张单」
    changedMidPeak: boolean; // 这一场中途换过「先送哪张单」
  };
  stations: StationStats[];
  nonNearestRate: number;
}

/**
 * 某一天某场高峰的小结。统计在该高峰时段内下单的订单，口径取生成时刻（时段结束 30 秒后）：
 * 这时每张订单是否准时已经确定，没有送到的计入超时并单独列出，退单只算到这一刻为止。
 */
export function peakSummary(state: SimState, day: number, peak: PeakName): PeakSummary {
  const period = peakWindow(day, peak);
  const generatedAt = summaryStep(day, peak);
  const w = windowStats(state, period.start, period.end, generatedAt);
  const id = peakId(peak);
  const events = state.stats.early.filter((e) => e.day === day && e.peak === id && e.step < generatedAt);
  const changed = state.stats.ruleChanges.some(
    (c) => c.column === 'select' && c.step > period.start && c.step < generatedAt,
  );
  return {
    day,
    peak,
    period,
    generatedAt,
    ready: state.step >= generatedAt,
    nOrders: w.nOrders,
    nOnTime: w.nOnTime,
    nLate: w.nLateDelivered + w.nUnresolved,
    nLateOpen: w.nUnresolved,
    nCancelled: w.nCancelled,
    revenue: w.revenue,
    districts: w.districts,
    segments: w.segments,
    early: {
      count: changed ? null : events.length,
      rules: [...new Set(events.map((e) => e.rule))],
      changedMidPeak: changed,
    },
    stations: stationStats(state, period.start, period.end),
    nonNearestRate: w.nonNearestRate,
  };
}

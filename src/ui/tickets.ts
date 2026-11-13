// 高峰小结和日结两张长小票的数据。
// 核心已经把数字、说明句的编号和参数记进了 campaign.peaks 和 campaign.days，这里只排版：
// 每一行写什么，哪一列要不要显示，提前派出那一段有几种写法，说明句从词表取哪一条。
// 纯函数，不碰 DOM 和状态。
import { STARS_V1 } from '../content/stars_v1.ts';
import { SHOPS, STR, districtName, fmt, peakName, placeName, ruleName, stationNumeral, starNumeral } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import { dayOf } from '../core/index.ts';
import type { DayDistrictRecord, DayRecord, ExtraSentence, MainSentence, PeakDistrictRow, PeakRecord, PeakSegments, SimState } from '../core/index.ts';
import { isRuleId } from './board.ts';
import { wholeMoney } from './money.ts';
import { peakClockRange } from './schedule.ts';

/** 小票上的一行：左边是名称，右边是数。indent 为真时缩进，写在上一行的下面。 */
export interface TicketRow {
  readonly label: string;
  readonly value: string;
  readonly indent: boolean;
}

function row(label: string, value: string | number, indent = false): TicketRow {
  return { label, value: String(value), indent };
}

function money(amount: number): string {
  return fmt(STR.common.money, { amount: wholeMoney(amount) });
}

function percent(value: number): string {
  return fmt(STR.common.percent, { value });
}

// ---- 高峰小结 ----

/**
 * 各片区一行：片区名，准时率，十格的条，比昨天。
 * 这个片区这一场没有订单时，准时率那一列写「没有订单」（noOrders 为真），没有条，也没有比昨天。
 */
export interface SummaryDistrictLine {
  readonly name: string;
  readonly pct: string;
  readonly bar: string;
  readonly delta: string;
  /** 这一场这个片区没有订单。 */
  readonly noOrders: boolean;
}

/** 一张单的四段时间里的一段。longest 为真时是说明里点名的那一段，画圈。 */
export interface SegmentItem {
  readonly id: keyof PeakSegments;
  readonly text: string;
  /** 这一段占的百分数，四段加起来是 100。四段拼成的横杠按它画。 */
  readonly share: number;
  readonly longest: boolean;
}

/** 「提前派出」那一段：先写卡名，再写下面几行。中途换过规矩时没有卡名，只有一行。 */
export interface EarlyBlock {
  readonly name: string | null;
  readonly lines: readonly string[];
}

export interface SummaryView {
  /** 这是哪一天哪一场的小结，下标是 campaign.peaks 里的位置。 */
  readonly index: number;
  readonly title: string;
  readonly period: string;
  readonly rows: readonly TicketRow[];
  readonly districtHeader: string;
  /** 第一天没有前一天的数据，没有这一列。 */
  readonly deltaHeader: string | null;
  readonly districts: readonly SummaryDistrictLine[];
  /** 没有送达的订单时没有四段时间。 */
  readonly timeHeader: string;
  readonly segments: readonly SegmentItem[] | null;
  /** 当前的卡是「先下单的先送」时没有这一段。 */
  readonly early: EarlyBlock | null;
  /** 说明：主句，加最多一条附加句。 */
  readonly sentences: readonly string[];
  /** 底部的「打开调度台」，调度台还没开放时为 null。 */
  readonly openBoard: string | null;
  readonly next: string;
}

/** 准时率的十格条：每满 10% 一格实心。没有订单时为空。 */
export function tenCells(pct: number | null): string {
  if (pct === null) return '';
  const on = Math.min(10, Math.max(0, Math.floor(pct / 10)));
  return '■'.repeat(on) + '□'.repeat(10 - on);
}

/** 比昨天的变化，带正负号：+5，-3，0。 */
export function signedDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

function summaryDistricts(rows: readonly PeakDistrictRow[], withDelta: boolean): SummaryDistrictLine[] {
  return rows.map((r) => {
    const name = districtName(r.district as DistrictIndex);
    // 没有订单就没有准时率，也就没有可比的昨天和十格的条
    if (r.n === 0 || r.pct === null) return { name, pct: STR.summary.districtNoOrders, bar: '', delta: '', noOrders: true };
    return { name, pct: percent(r.pct), bar: tenCells(r.pct), delta: withDelta && r.delta !== null ? signedDelta(r.delta) : '', noOrders: false };
  });
}

/** 四段时间里，说明的主句点名的那一段。主句不是说哪一段最长时为 null。 */
function longestOf(main: MainSentence): keyof PeakSegments | null {
  return main.id === 'waitDrone' || main.id === 'waitGate' || main.id === 'waitPrep' || main.id === 'road' ? main.id : null;
}

function segmentItems(segments: PeakSegments, main: MainSentence): SegmentItem[] {
  const longest = longestOf(main);
  const item = (id: keyof PeakSegments, text: string): SegmentItem => ({ id, text, share: segments[id], longest: longest === id });
  return [
    item('waitDrone', fmt(STR.summary.segments.waitDrone, { share: segments.waitDrone })),
    item('waitGate', fmt(STR.summary.segments.waitGate, { share: segments.waitGate })),
    item('waitPrep', fmt(STR.summary.segments.waitPrep, { share: segments.waitPrep })),
    item('road', fmt(STR.summary.segments.road, { share: segments.road })),
  ];
}

/**
 * 「提前派出」那一段，三种情况：
 * - 这一场中途换过「先送哪张单」：只写「这一场中途换过规矩」，没有数可写
 * - 现在的卡是「先下单的先送」：不显示这一段，它按下单顺序派，数恒为 0
 * - 其余：卡名，有几张订单，比按下单顺序更早派出
 * 中途换过卡并且最后换成了「先下单的先送」时，也写「这一场中途换过规矩」：前半场用过别的卡，数不是 0，只是没法算。
 */
export function earlyBlock(record: PeakRecord): EarlyBlock | null {
  if (record.changedMidPeak) return { name: null, lines: [STR.summary.early.switched] };
  if (record.select === 'fifo' || record.early === null) return null;
  return {
    name: isRuleId(record.select) ? ruleName(record.select) : null,
    lines: [fmt(STR.summary.early.count, { count: record.early }), STR.summary.early.suffix],
  };
}

/** 说明的主句。 */
export function mainSentence(main: MainSentence): string {
  switch (main.id) {
    case 'noOrders':
      return STR.summary.main.noOrders;
    case 'noDelivered':
      return STR.summary.main.noDelivered;
    case 'onTimeHigh':
      return fmt(STR.summary.main.onTimeHigh, { onTime: main.onTime });
    case 'waitDrone':
      return STR.summary.main.waitDrone;
    case 'waitGate':
      return STR.summary.main.waitGate;
    case 'road':
      return STR.summary.main.road;
    case 'waitPrep':
      return STR.summary.main.waitPrep;
  }
}

/** 说明的附加句。站号是核心里的编号加一，写成汉字。 */
export function extraSentence(extra: ExtraSentence): string {
  switch (extra.id) {
    case 'landQueue':
      return fmt(STR.summary.extra.landQueue, { station: stationNumeral(extra.station + 1), count: extra.count });
    case 'bayIdle':
      return fmt(STR.summary.extra.bayIdle, { station: stationNumeral(extra.station + 1), percent: extra.percent });
    case 'notNearest':
      return fmt(STR.summary.extra.notNearest, { percent: extra.percent });
    case 'districtLow':
      return fmt(STR.summary.extra.districtLow, { district: districtName(extra.district as DistrictIndex), onTime: extra.onTime });
  }
}

/** 一场高峰小结的长小票。index 是它在 campaign.peaks 里的位置。 */
export function summaryTicket(record: PeakRecord, index: number, hasBoard: boolean): SummaryView {
  const range = peakClockRange(record.peak);
  const withDelta = record.day > 0 && record.districts.some((d) => d.delta !== null);
  const sentences = [mainSentence(record.main)];
  if (record.extra !== null) sentences.push(extraSentence(record.extra));
  return {
    index,
    title: fmt(STR.summary.title, { peak: peakName(record.peak) }),
    period: fmt(STR.summary.period, { day: record.day + 1, start: range.start, end: range.end }),
    rows: [
      row(STR.summary.rows.orders, record.orders),
      row(STR.summary.rows.onTime, record.onTime),
      row(STR.summary.rows.late, record.late),
      row(STR.summary.rows.lateOpen, record.lateOpen, true),
      row(STR.summary.rows.cancelled, record.cancelled),
      row(STR.summary.rows.revenue, money(record.revenue)),
    ],
    districtHeader: STR.summary.districtHeader,
    deltaHeader: withDelta ? STR.summary.deltaHeader : null,
    districts: summaryDistricts(record.districts, withDelta),
    timeHeader: STR.summary.timeHeader,
    segments: record.segments === null ? null : segmentItems(record.segments, record.main),
    early: earlyBlock(record),
    sentences,
    openBoard: hasBoard ? STR.summary.actions.openBoard : null,
    next: STR.summary.actions.next,
  };
}

/** 最近的小结，只在它是今天的时候返回：日结出现之后，小结的内容并入日结，不再从小票的位置打开。 */
export function latestSummary(state: SimState, hasBoard: boolean): SummaryView | null {
  const peaks = state.campaign?.peaks ?? [];
  const index = peaks.length - 1;
  const record = peaks[index];
  if (record === undefined || record.day !== dayOf(state.step)) return null;
  return summaryTicket(record, index, hasBoard);
}

// ---- 日结 ----

export interface DayEndView {
  /** 第几天的日结，下标是 campaign.days 里的位置。 */
  readonly index: number;
  readonly title: string;
  readonly day: string;
  readonly rows: readonly TicketRow[];
  /** 各片区的一行，升星的片区后面跟着新店的几行。 */
  readonly lines: readonly string[];
  readonly next: string;
}

/** 日结里一个片区写的几行：一行星级变化，升星时后面是新开的店。 */
export function dayLines(line: DayDistrictRecord): string[] {
  const district = districtName(line.district as DistrictIndex);
  switch (line.kind) {
    case 'starUp':
      return [
        fmt(STR.dayEnd.starUp, { district, star: starNumeral(line.star) }),
        ...line.newShops.map((shop) =>
          fmt(STR.dayEnd.newShop, {
            place: placeName(line.district as DistrictIndex, shop.direction),
            shop: SHOPS[shop.shop]?.name ?? '',
          }),
        ),
      ];
    case 'starDown':
      return [fmt(STR.dayEnd.starDown, { district, star: starNumeral(line.star) })];
    case 'starKept':
      return [fmt(STR.dayEnd.starKept, { district, star: starNumeral(line.star) })];
    case 'noOrders':
      return [fmt(STR.dayEnd.noOrders, { district })];
    case 'tooFewOrders':
      return [fmt(STR.dayEnd.tooFewOrders, { district, min: STARS_V1.minSample })];
    case 'dropByOnTime':
      return [fmt(STR.dayEnd.dropByOnTime, { district, onTime: line.onTimePct ?? 0, needOnTime: line.needOnTimePct ?? 0 })];
    case 'dropByCancel':
      return [fmt(STR.dayEnd.dropByCancel, { district, cancelRate: line.cancelPct ?? 0, needCancelRate: line.needCancelPct ?? 0 })];
  }
}

/** 一次日结的小票。 */
export function dayEndTicket(record: DayRecord, index: number): DayEndView {
  return {
    index,
    title: STR.dayEnd.title,
    day: fmt(STR.dayEnd.day, { day: record.day + 1 }),
    rows: [
      row(STR.dayEnd.rows.ordered, record.ordered),
      row(STR.dayEnd.rows.resolved, record.resolved),
      row(STR.dayEnd.rows.onTime, record.onTime, true),
      row(STR.dayEnd.rows.late, record.late, true),
      row(STR.dayEnd.rows.cancelled, record.cancelled, true),
      row(STR.dayEnd.rows.pending, record.pending),
      row(STR.dayEnd.rows.revenue, money(record.income)),
    ],
    lines: record.districts.flatMap(dayLines),
    next: STR.summary.actions.next,
  };
}

/** 最近一次日结的小票，还没有日结时为 null。 */
export function latestDayEnd(state: SimState): DayEndView | null {
  const days = state.campaign?.days ?? [];
  const index = days.length - 1;
  const record = days[index];
  return record === undefined ? null : dayEndTicket(record, index);
}

// 高峰小结和日结两张长小票的数据。
// 核心已经把数字、说明句的编号和参数记进了 campaign.peaks 和 campaign.days，这里只排版：
// 每一行写什么，目标线和达标写在哪一行，与开局策略的对照写什么，纪录的小字，说明句从词表取哪一条。
// 纯函数，不碰 DOM 和状态。
import { GOALS_V1 } from '../content/goals_v1.ts';
import { STARS_V1 } from '../content/stars_v1.ts';
import { SHOPS, STR, districtName, fmt, peakName, placeName, ruleName, stationNumeral, starNumeral } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import { DEFAULT_CONFIG, dayOf, gainTotal, incomeStanding, peakStanding } from '../core/index.ts';
import type { DayDistrictRecord, DayRecord, EffectLine, ExtraSentence, MainSentence, PeakBaseline, PeakDistrictRow, PeakFleet, PeakRecord, PeakSegments, PeakStanding, SimState, Standing } from '../core/index.ts';
import { isRuleId } from './board.ts';
import { wholeMoney } from './money.ts';
import { peakClockRange } from './schedule.ts';

/** 数后面的小字：纪录。fresh 为真时是新破的纪录，画得显眼一些。 */
export interface RecordNote {
  readonly text: string;
  readonly fresh: boolean;
}

/** 小票上的一行：左边是名称，右边是数，数后面可以有一句纪录的小字。indent 为真时缩进，写在上一行的下面。 */
export interface TicketRow {
  readonly label: string;
  readonly value: string;
  readonly indent: boolean;
  readonly record: RecordNote | null;
}

function row(label: string, value: string | number, indent = false, record: RecordNote | null = null): TicketRow {
  return { label, value: String(value), indent, record };
}

function money(amount: number): string {
  return fmt(STR.common.money, { amount: wholeMoney(amount) });
}

function percent(value: number): string {
  return fmt(STR.common.percent, { value });
}

/**
 * 纪录的小字。破了纪录写「新纪录」，没破写「纪录」和之前的最好成绩（成绩与它相同时也是它）。
 * 之前没有同类的成绩（第一次）没有可比的，不写。asMoney 为真时成绩是金额。
 */
export function recordNote(standing: Standing | null, asMoney = false): RecordNote | null {
  if (standing === null || standing.best === null) return null;
  if (standing.broken) return { text: STR.metrics.record.broken, fresh: true };
  const text = asMoney ? fmt(STR.metrics.record.bestMoney, { amount: wholeMoney(standing.best) }) : fmt(STR.metrics.record.best, { value: standing.best });
  return { text, fresh: false };
}

// ---- 高峰小结 ----

/** 小结里各片区一行的达标：达标或没达标，带着写在行里的文字。 */
export interface GoalMark {
  readonly met: boolean;
  readonly text: string;
}

/**
 * 各片区一行：片区名，准时率，十格的条，这一场的目标和达标。
 * 这个片区这一场没有订单时，准时率那一列写「没有订单」（noOrders 为真），没有条，也没有目标。
 * goal 是这一场的目标线，没有设线时为 null。mark 是达没达标，没有设线或订单不够判时为 null。
 */
export interface SummaryDistrictLine {
  readonly name: string;
  readonly pct: string;
  readonly bar: string;
  /** 这一场这个片区没有订单。 */
  readonly noOrders: boolean;
  readonly goal: string | null;
  readonly mark: GoalMark | null;
}

/** 一张单的四段时间里的一段。longest 为真时是说明里点名的那一段，画圈。 */
export interface SegmentItem {
  readonly id: keyof PeakSegments;
  readonly text: string;
  /** 这一段占的百分数，四段加起来是 100。四段拼成的横杠按它画。 */
  readonly share: number;
  readonly longest: boolean;
}

/** 机队时间构成里的一段，写法和样式与一张单的四段时间相同。longest 为真时是五段里最长的一段，画圈。 */
export interface FleetItem {
  readonly id: keyof PeakFleet;
  readonly text: string;
  /** 这一段占的百分数，五段加起来是 100。五段拼成的横杠按它画。 */
  readonly share: number;
  readonly longest: boolean;
}

/** 机队时间构成：标题和五段，小结和站点小卡用同一组文字。 */
export interface FleetBlock {
  readonly header: string;
  readonly items: readonly FleetItem[];
}

/** 与开局策略的对照：同一批订单、同样的购买，「调度策略」和「协同策略」用开局的卡的结果。 */
export interface CompareBlock {
  readonly header: string;
  /** 开局策略用的两张卡的名称。 */
  readonly cards: string;
  readonly row: string;
  /** 比开局策略多准时或少准时几单，差不为 0 而小于门槛时句末加「差别不明显」。订单不多于运力、两套策略准时单数相同时写一句说明。 */
  readonly gain: string;
  /** 比开局策略多准时的纪录，只在多准时并且句末没有加「差别不明显」的时候写。 */
  readonly record: RecordNote | null;
  /** 开局策略下各片区的准时率，没有目标和达标。 */
  readonly districts: readonly SummaryDistrictLine[];
}

export interface SummaryView {
  /** 这是哪一天哪一场的小结，下标是 campaign.peaks 里的位置。 */
  readonly index: number;
  readonly title: string;
  readonly period: string;
  readonly rows: readonly TicketRow[];
  readonly districtHeader: string;
  readonly districts: readonly SummaryDistrictLine[];
  /** 判过的片区全部达标并且没有退单时的标记，其余为 null。 */
  readonly cleared: string | null;
  /** 连续达标的场数，没有判过目标，或者还没有达标过时为 null。 */
  readonly streak: string | null;
  /** 没有送达的订单时没有四段时间。 */
  readonly timeHeader: string;
  readonly segments: readonly SegmentItem[] | null;
  /** 机队时间构成，写在四段时间下面。没有无人机，或者是存档格式 3 以前的记录时为 null。 */
  readonly fleet: FleetBlock | null;
  /** 这一场没有对照时为 null。 */
  readonly compare: CompareBlock | null;
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

/** 准时率那一列：百分数和十格的条，没有订单时写「没有订单」。 */
function rateLine(district: number, n: number, pct: number | null): Pick<SummaryDistrictLine, 'name' | 'pct' | 'bar' | 'noOrders'> {
  const name = districtName(district as DistrictIndex);
  // 没有订单就没有准时率，也就没有十格的条
  if (n === 0 || pct === null) return { name, pct: STR.summary.districtNoOrders, bar: '', noOrders: true };
  return { name, pct: percent(pct), bar: tenCells(pct), noOrders: false };
}

function summaryDistricts(rows: readonly PeakDistrictRow[]): SummaryDistrictLine[] {
  return rows.map((r) => {
    const rate = rateLine(r.district, r.n, r.pct);
    const goal = r.line === null || rate.noOrders ? null : fmt(STR.metrics.summary.goal, { line: r.line });
    const mark: GoalMark | null = r.met === null ? null : { met: r.met, text: r.met ? STR.metrics.summary.met : STR.metrics.summary.missed };
    return { ...rate, goal, mark };
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

/** 机队时间构成的五段，按载货飞行、空载飞行、作业、排队、停放的顺序。 */
const FLEET_ORDER = ['loaded', 'empty', 'work', 'queue', 'parked'] as const;

/**
 * 机队时间构成：标题和五段。最长的一段（并列时取靠前的）带 longest 标记。没有构成时为 null。
 * 一场高峰的小结和一座站的小卡都用它，数取自核心记录里的 PeakFleet。
 */
export function fleetBlock(fleet: PeakFleet | null): FleetBlock | null {
  if (fleet === null) return null;
  let longest: keyof PeakFleet = FLEET_ORDER[0];
  for (const id of FLEET_ORDER) if (fleet[id] > fleet[longest]) longest = id;
  return {
    header: STR.summary.fleetHeader,
    items: FLEET_ORDER.map((id) => ({ id, text: fmt(STR.summary.fleet[id], { share: fleet[id] }), share: fleet[id], longest: id === longest })),
  };
}

/** 开局策略用的两张卡的名称，取自开局的配置。 */
function openingCards(): string {
  const { select, zone } = DEFAULT_CONFIG.rules;
  return fmt(STR.metrics.compare.cards, {
    select: isRuleId(select) ? ruleName(select) : select,
    zone: isRuleId(zone) ? ruleName(zone) : zone,
  });
}

/**
 * 小结对照里写「差别不明显」的门槛：来单数的平方根乘内容表里的系数，向上取整。orders 是这一场小结记录里的来单。
 * 准时单数的差不为 0，并且绝对值小于它，就照写差几单，句末加「差别不明显」。
 * 单场的差的标准差约与来单数的平方根成正比（多套订单序列的模拟里约为 0.5 × √来单数），来单多的场次里，同样的差更可能只来自订单的随机。
 */
export function compareThreshold(orders: number): number {
  return Math.ceil(GOALS_V1.compareUnclearK * Math.sqrt(orders));
}

/**
 * 小结里与开局策略的对照。这一场没有对照时为 null。
 * 比开局策略多准时或少准时几单，差的绝对值小于 compareThreshold(来单数) 时句末加「差别不明显」。
 * 两套策略准时的单数相同时，订单不多于运力就写一句说明，否则写相同。
 * 多准时的纪录小字只在句末没有加「差别不明显」时写：差别不明显的多准时不算纪录。核心里的纪录（peakStanding）不变，只是这里不显示。
 */
export function compareBlock(record: PeakRecord, standing: PeakStanding | null): CompareBlock | null {
  const baseline: PeakBaseline | null = record.baseline;
  if (baseline === null) return null;
  const gain = record.onTime - baseline.onTime;
  const unclear = gain !== 0 && Math.abs(gain) < compareThreshold(record.orders);
  let text: string;
  if (gain > 0) text = fmt(unclear ? STR.metrics.compare.moreUnclear : STR.metrics.compare.more, { count: gain });
  else if (gain < 0) text = fmt(unclear ? STR.metrics.compare.lessUnclear : STR.metrics.compare.less, { count: -gain });
  else text = baseline.lowLoad ? STR.metrics.compare.lowLoad : STR.metrics.compare.same;
  return {
    header: STR.metrics.compare.header,
    cards: openingCards(),
    row: fmt(STR.metrics.compare.row, { onTime: baseline.onTime, cancelled: baseline.cancelled, revenue: wholeMoney(baseline.revenue) }),
    gain: text,
    record: gain > 0 && !unclear ? recordNote(standing?.gain ?? null) : null,
    districts: baseline.districts.map((d) => ({ ...rateLine(d.district, d.n, d.pct), goal: null, mark: null })),
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
    case 'takeoffWait':
      return fmt(STR.summary.extra.takeoffWait, { station: stationNumeral(extra.station + 1), percent: extra.percent });
    case 'landQueue':
      return fmt(STR.summary.extra.landQueue, { station: stationNumeral(extra.station + 1), count: extra.count });
    case 'bayIdle':
      return fmt(STR.summary.extra.bayIdle, { station: stationNumeral(extra.station + 1), percent: extra.percent });
    case 'emptyFlight':
      return fmt(STR.summary.extra.emptyFlight, { percent: extra.percent });
    case 'notNearest':
      return fmt(STR.summary.extra.notNearest, { percent: extra.percent });
    case 'districtLow':
      return fmt(STR.summary.extra.districtLow, { district: districtName(extra.district as DistrictIndex), onTime: extra.onTime });
  }
}

/** 一场高峰小结的长小票。index 是它在 campaign.peaks 里的位置，standing 是这一场的成绩和纪录，不给就不写纪录和连续达标。 */
export function summaryTicket(record: PeakRecord, index: number, hasBoard: boolean, standing: PeakStanding | null = null): SummaryView {
  const range = peakClockRange(record.peak);
  const sentences = [mainSentence(record.main)];
  if (record.extra !== null) sentences.push(extraSentence(record.extra));
  return {
    index,
    title: fmt(STR.summary.title, { peak: peakName(record.peak) }),
    period: fmt(STR.summary.period, { day: record.day + 1, start: range.start, end: range.end }),
    rows: [
      row(STR.summary.rows.orders, record.orders),
      row(STR.summary.rows.onTime, record.onTime, false, recordNote(standing?.onTime ?? null)),
      row(STR.summary.rows.late, record.late),
      row(STR.summary.rows.lateOpen, record.lateOpen, true),
      row(STR.summary.rows.cancelled, record.cancelled),
      row(STR.summary.rows.revenue, money(record.revenue)),
    ],
    districtHeader: STR.summary.districtHeader,
    districts: summaryDistricts(record.districts),
    cleared: record.cleared === true ? STR.metrics.summary.cleared : null,
    streak: record.cleared === null || standing === null || standing.streak.best === 0 ? null : fmt(STR.metrics.summary.streak, { now: standing.streak.now, best: standing.streak.best }),
    timeHeader: STR.summary.timeHeader,
    segments: record.segments === null ? null : segmentItems(record.segments, record.main),
    fleet: fleetBlock(record.fleet),
    compare: compareBlock(record, standing),
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
  return summaryTicket(record, index, hasBoard, peakStanding(peaks, index));
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
  /** 效果记录：购买改装之后的几次日结里，每笔购买一条，每条两句：先写改装的名称，再写这项改装对应的指标现在的数值和不购买时的数值。接在星级的几行后面，没有时为空。 */
  readonly effects: readonly string[];
  /** 今天达标的场数，和累计比开局策略多准时或少准时的单数。没有可写的时候为空。 */
  readonly metrics: readonly string[];
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

/** 保留一位小数。不是有限数时按 0 写，免得小票和小卡上出现 NaN。 */
export function oneDecimal(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(1);
}

/**
 * 效果记录里的一句，文字取词表 dayEnd.effect 里与 kind 同名的一条，写现在的数（after）和不购买时的数（twin），购买前的数不写。
 * 起降排队的秒数和每趟单数保留一位小数，回站飞行的百分数取整数，起降口一句的站号是核心里的编号加一，写成汉字。
 * 起降口一句缺站号或等级时（核心不会这样记）不写，返回 null。
 */
export function effectText(line: EffectLine): string | null {
  switch (line.kind) {
    case 'gate':
      if (line.station === null || line.level === null) return null;
      return fmt(STR.dayEnd.effect.gate, { station: stationNumeral(line.station + 1), level: line.level, after: oneDecimal(line.after), twin: oneDecimal(line.twin) });
    case 'doubleBox':
      return fmt(STR.dayEnd.effect.doubleBox, { after: oneDecimal(line.after), twin: oneDecimal(line.twin) });
    case 'nearest':
      return fmt(STR.dayEnd.effect.nearest, { after: Math.round(line.after), twin: Math.round(line.twin) });
  }
}

/**
 * 一句话按句号分成几句，句号留在句尾。效果记录每笔两句：改装的名称，现在的数和不购买时的数。日结小票很窄，一笔排不进一行，
 * 按句分行，不让一句话在数和单位中间折断。句号写成转义，代码里不出现中文标点。
 */
export function sentenceLines(text: string): string[] {
  return text.split(/(?<=\u3002)/u).filter((part) => part !== '');
}

/** 一次日结的效果记录，按购买的先后。 */
export function effectLines(lines: readonly EffectLine[]): string[] {
  return lines.flatMap((line) => {
    const text = effectText(line);
    return text === null ? [] : [text];
  });
}

/** 累计比开局策略多准时或少准时的单数那一句。没有对照过，或者多少相抵为 0 时为 null。 */
export function gainTotalLine(total: number, peaks: number): string | null {
  if (peaks === 0 || total === 0) return null;
  return total > 0 ? fmt(STR.metrics.dayEnd.gainMore, { count: total }) : fmt(STR.metrics.dayEnd.gainLess, { count: -total });
}

/**
 * 一次日结的小票。income 是今天的进账和之前各天的最好成绩，gain 是累计的对照，不给就不写纪录和累计。
 * 今天判过目标的高峰，写判了几场、其中几场全部达标。
 */
export function dayEndTicket(record: DayRecord, index: number, income: Standing | null = null, gain: { total: number; peaks: number } | null = null): DayEndView {
  const metrics: string[] = [];
  if (record.peaksJudged > 0) metrics.push(fmt(STR.metrics.dayEnd.goals, { judged: record.peaksJudged, cleared: record.peaksCleared }));
  const total = gain === null ? null : gainTotalLine(gain.total, gain.peaks);
  if (total !== null) metrics.push(total);
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
      row(STR.dayEnd.rows.revenue, money(record.income), false, recordNote(income, true)),
    ],
    lines: record.districts.flatMap(dayLines),
    effects: effectLines(record.effects),
    metrics,
    next: STR.summary.actions.next,
  };
}

/** 最近一次日结的小票，还没有日结时为 null。 */
export function latestDayEnd(state: SimState): DayEndView | null {
  const days = state.campaign?.days ?? [];
  const index = days.length - 1;
  const record = days[index];
  if (record === undefined) return null;
  return dayEndTicket(record, index, incomeStanding(days, index), gainTotal(state.campaign?.peaks ?? []));
}

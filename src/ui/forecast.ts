// 数据员的推演在界面里的样子：哪些东西旁边有「推演」按钮，推演的选项叫什么，推演单上每一行写什么，数怎样取整。
// 推演本身在应用层算（app/forecast.ts），推演次数在核心里（campaign.forecast.charges），这里只排版。
// 一个入口推演哪个选项用 ForecastOption 描述：它能换成核心的一条命令（forecastCommand），也有自己的名称（forecastOptionName）。
// 纯函数，不碰 DOM 和状态。
import { STR, fmt, peakName, ruleName, stationNumeral } from '../content/strings.zh.ts';
import type { RuleColumnKey, RuleId } from '../content/strings.zh.ts';
import { FORECAST_V1, isUnlocked } from '../core/index.ts';
import type { Command, SimState } from '../core/index.ts';
import type { ForecastDone } from '../app/index.ts';
import { ruleCommand } from './board.ts';
import type { PeakKey } from './schedule.ts';
import type { UpgradeItem } from './tags.ts';

/** 推演的选项：对应一个入口，能换成核心的一条命令。station 是核心里的站编号，从 0 起。 */
export type ForecastOption =
  | { readonly kind: 'addBay'; readonly station: number }
  | { readonly kind: 'addDrone'; readonly station: number }
  /** 起降口升到 level 级 */
  | { readonly kind: 'gate'; readonly station: number; readonly level: number }
  | { readonly kind: 'doubleBox' }
  /** 买下就近降落 */
  | { readonly kind: 'nearestBuy' }
  /** 买过之后切换开关 */
  | { readonly kind: 'nearestOn' }
  | { readonly kind: 'nearestOff' }
  /** 把一栏改成一张卡。分成午晚两套时 peak 是推演哪一套，没分成两套时为 null */
  | { readonly kind: 'card'; readonly column: RuleColumnKey; readonly rule: RuleId; readonly peak: PeakKey | null };

/** 选项换成核心的命令，推演用它在副本上执行。 */
export function forecastCommand(option: ForecastOption): Command {
  switch (option.kind) {
    case 'addBay':
      return { type: 'buyBay', station: option.station };
    case 'addDrone':
      return { type: 'buyDrone', station: option.station };
    case 'gate':
      return { type: 'upgradeGate', station: option.station };
    case 'doubleBox':
      return { type: 'buyDoubleBox' };
    case 'nearestBuy':
      return { type: 'buyNearestLanding' };
    case 'nearestOn':
      return { type: 'setNearestLanding', on: true };
    case 'nearestOff':
      return { type: 'setNearestLanding', on: false };
    case 'card':
      return ruleCommand(option.column, option.rule, option.peak);
  }
}

/** 选项的名称，写在推演单的标题里。站号是核心里的编号加一，写成汉字。 */
export function forecastOptionName(option: ForecastOption): string {
  const text = STR.hud.forecast.option;
  switch (option.kind) {
    case 'addBay':
      return fmt(text.addBay, { station: stationNumeral(option.station + 1) });
    case 'addDrone':
      return fmt(text.addDrone, { station: stationNumeral(option.station + 1) });
    case 'gate':
      return fmt(text.gate, { station: stationNumeral(option.station + 1), level: option.level });
    case 'doubleBox':
      return text.doubleBox;
    case 'nearestBuy':
      return text.nearestBuy;
    case 'nearestOn':
      return text.nearestOn;
    case 'nearestOff':
      return text.nearestOff;
    case 'card': {
      const column = STR.board.columns[option.column];
      const card = ruleName(option.rule);
      return option.peak === null ? fmt(text.card, { column, card }) : fmt(text.cardInPeak, { peak: peakName(option.peak), column, card });
    }
  }
}

/**
 * 改装单里一个节点的推演选项：点这一行会执行命令的节点才能推演，也就是没买过并且已经开放的节点（资金不足也可以），
 * 以及买过之后的就近降落（推演切换开关）。已经买过、没开放、没选站点的节点不能推演，返回 null。
 * 起降口的两行用 key 区分升到几级，命令里的站编号是改装单当前选中的那座站。
 */
export function upgradeForecast(item: UpgradeItem): ForecastOption | null {
  const click = item.click;
  if (click.kind !== 'run') return null;
  const command = click.command;
  switch (command.type) {
    case 'buyDoubleBox':
      return { kind: 'doubleBox' };
    case 'buyNearestLanding':
      return { kind: 'nearestBuy' };
    case 'setNearestLanding':
      return { kind: command.on ? 'nearestOn' : 'nearestOff' };
    case 'upgradeGate':
      return { kind: 'gate', station: command.station, level: item.key === 'gate3' ? 3 : 2 };
    default:
      return null;
  }
}

// ---- 推演次数和按钮 ----

/** 数据员开放之后才有：还剩几次，最多几次。 */
export interface ForecastInfo {
  readonly charges: number;
  readonly max: number;
}

/** 数据员没到岗时为 null，所有入口都不显示。次数取自核心，上限取自内容表。 */
export function forecastInfo(state: SimState): ForecastInfo | null {
  const campaign = state.campaign;
  if (campaign === null || !isUnlocked(state, 'dataClerk')) return null;
  return { charges: campaign.forecast.charges, max: FORECAST_V1.maxCharges };
}

/** 改装单顶部的一行：推演次数 {count}/{max}。 */
export function chargesText(info: ForecastInfo): string {
  return fmt(STR.hud.forecast.charges, { count: info.charges, max: info.max });
}

/** 一个「推演」按钮：写什么字，次数用完了变淡，推演进行中写「推演中」、不能再点。 */
export interface ForecastButtonView {
  readonly text: string;
  readonly dim: boolean;
  readonly busy: boolean;
}

/**
 * 一个入口的按钮。数据员没到岗（info 为 null）或者这个入口没有可推演的选项（option 为 null）时不显示，返回 null。
 * 推演进行中所有按钮都写「推演中」。次数为 0 时按钮变淡，点击时仍然有反应：提示推演次数不足。
 */
export function forecastButton(info: ForecastInfo | null, option: ForecastOption | null, busy: boolean): ForecastButtonView | null {
  if (info === null || option === null) return null;
  if (busy) return { text: STR.hud.forecast.running, dim: false, busy: true };
  return { text: STR.hud.forecast.button, dim: info.charges < 1, busy: false };
}

// ---- 推演单 ----

/** 每次对照的记号：这一套订单序列上，带选项比不带选项准时的单数更多、更少、一样。 */
export type ForecastMark = 'better' | 'worse' | 'tie';

export interface ForecastRunningView {
  readonly phase: 'running';
  readonly title: string;
  readonly running: string;
}

export interface ForecastFailedView {
  readonly phase: 'failed';
  readonly title: string;
  readonly failed: string;
}

export interface ForecastDoneView {
  readonly phase: 'done';
  readonly title: string;
  /** 每套订单序列一个记号，更好的在前，持平的居中，更差的在后。 */
  readonly marks: readonly ForecastMark[];
  readonly tally: string;
  readonly onTime: string;
  readonly revenue: string;
  /** 结论是差别不明显时才有。 */
  readonly unclear: string | null;
  readonly scope: string;
}

export type ForecastSheetView = ForecastRunningView | ForecastFailedView | ForecastDoneView;

/** 现在开着的推演单。id 每次推演加一，推演单按它换新。host 是它贴在哪个物件旁边（改装单、站点小卡、调度台的 data-part）。 */
export interface ForecastSheetState {
  readonly id: number;
  readonly host: string | null;
  readonly view: ForecastSheetView;
}

/** 准时订单的平均值，绝对值小于这个数（单）写持平。 */
export const ON_TIME_EVEN = 0.05;
/** 收入的平均值，绝对值小于这个数（元）写持平。 */
export const REVENUE_EVEN = 0.5;

/** 准时订单平均多几单、少几单，或者持平。多少保留一位小数。 */
export function onTimeText(mean: number): string {
  const text = STR.hud.forecast;
  if (!Number.isFinite(mean) || Math.abs(mean) < ON_TIME_EVEN) return text.onTimeSame;
  const count = Math.abs(mean).toFixed(1);
  return mean > 0 ? fmt(text.onTimeMore, { count }) : fmt(text.onTimeLess, { count });
}

/** 收入平均增加、减少多少元，或者持平。金额取整数。 */
export function revenueText(mean: number): string {
  const text = STR.hud.forecast;
  if (!Number.isFinite(mean) || Math.abs(mean) < REVENUE_EVEN) return text.revenueSame;
  const amount = Math.round(Math.abs(mean));
  return mean > 0 ? fmt(text.revenueMore, { amount }) : fmt(text.revenueLess, { amount });
}

/** 每套订单序列上准时单数的差，换成记号：更好的在前，持平的居中，更差的在后。 */
export function forecastMarks(diffs: readonly number[]): ForecastMark[] {
  const better = diffs.filter((d) => d > 0).length;
  const worse = diffs.filter((d) => d < 0).length;
  const tie = diffs.length - better - worse;
  return [...Array<ForecastMark>(better).fill('better'), ...Array<ForecastMark>(tie).fill('tie'), ...Array<ForecastMark>(worse).fill('worse')];
}

function titleOf(option: ForecastOption): string {
  return fmt(STR.hud.forecast.title, { option: forecastOptionName(option) });
}

/** 推演进行中的推演单：标题和「推演中」。 */
export function runningView(option: ForecastOption): ForecastRunningView {
  return { phase: 'running', title: titleOf(option), running: STR.hud.forecast.running };
}

/** 无法推演的推演单：标题和「无法推演　{原因}」。原因是命令失败的提示文字。 */
export function failedView(option: ForecastOption, reason: string): ForecastFailedView {
  return { phase: 'failed', title: titleOf(option), failed: fmt(STR.hud.forecast.failed, { reason }) };
}

/**
 * 有结果的推演单，从上到下：标题，每套订单序列一个记号，更好和更差的次数，准时订单一行，收入一行，
 * 结论是差别不明显时加一行，最后一行小字写统计范围。
 */
export function doneView(option: ForecastOption, result: ForecastDone): ForecastDoneView {
  return {
    phase: 'done',
    title: titleOf(option),
    marks: forecastMarks(result.onTimeDiffs),
    tally: fmt(STR.hud.forecast.tally, { runs: result.sequences, better: result.better, worse: result.worse }),
    onTime: onTimeText(result.meanOnTime),
    revenue: revenueText(result.meanRevenue),
    unclear: result.verdict === 'unclear' ? STR.hud.forecast.unclear : null,
    scope: STR.hud.forecast.scope,
  };
}

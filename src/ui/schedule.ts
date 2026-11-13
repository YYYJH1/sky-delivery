// 日程纸条用到的时刻换算：游戏内一天 360 秒（3600 步）对应 9:30 到 21:30，两个高峰在纸条上各占一段。
// 纯函数，只由步数决定，不读系统时钟，不碰 DOM。
import { DAY_STEPS, EVENING_WINDOW, NOON_WINDOW, PeakId, peakAt } from '../core/index.ts';

/** 一天从 9:30 开始，单位是分钟。 */
export const DAY_START_MINUTES = 9 * 60 + 30;
/** 一天有 12 小时，到 21:30。 */
export const DAY_LENGTH_MINUTES = 12 * 60;
/** 每个游戏分钟对应的步数：3600 步对应 720 分钟。 */
export const STEPS_PER_MINUTE = DAY_STEPS / DAY_LENGTH_MINUTES;

/** 第几天，从 1 起。 */
export function dayNumber(step: number): number {
  return Math.floor(step / DAY_STEPS) + 1;
}

/** 当天过去了多少个游戏分钟，0 到 719，不满一分钟的部分舍去。 */
export function minuteOfDay(step: number): number {
  return Math.floor((step % DAY_STEPS) / STEPS_PER_MINUTE);
}

/** 游戏内的时刻，写成 12:05 这样。一天的最后一分钟是 21:29，再过一步就是第二天的 9:30。 */
export function clockText(step: number): string {
  const total = DAY_START_MINUTES + minuteOfDay(step);
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

/** 当前时刻在一天里的位置，0 到 1，不含 1。日程纸条上的标记按它摆。 */
export function dayFraction(step: number): number {
  return (step % DAY_STEPS) / DAY_STEPS;
}

export type PeakKey = 'noon' | 'evening';

export interface PeakBand {
  readonly key: PeakKey;
  /** 起止位置，占一天的比例。 */
  readonly from: number;
  readonly to: number;
}

/** 两个高峰在纸条上的位置，取自核心的高峰窗口。 */
export const PEAK_BANDS: readonly PeakBand[] = [
  { key: 'noon', from: NOON_WINDOW.start / DAY_STEPS, to: NOON_WINDOW.end / DAY_STEPS },
  { key: 'evening', from: EVENING_WINDOW.start / DAY_STEPS, to: EVENING_WINDOW.end / DAY_STEPS },
];

/** 当前落在哪个高峰里，不在高峰里为 null。进入高峰时，纸条上这一段加深。 */
export function activePeak(step: number): PeakKey | null {
  const id = peakAt(step);
  return id === PeakId.Noon ? 'noon' : id === PeakId.Evening ? 'evening' : null;
}

/** 一场高峰的起止时刻，写成 11:30 这样。高峰小结标题下面的一行用它。 */
export function peakClockRange(peak: PeakKey): { readonly start: string; readonly end: string } {
  const span = peak === 'noon' ? NOON_WINDOW : EVENING_WINDOW;
  return { start: clockText(span.start), end: clockText(span.end) };
}

export interface TickMark {
  /** 在一天里的位置，0 到 1。 */
  readonly at: number;
  /** 整点的小时数。 */
  readonly hour: number;
}

/** 刻度：每隔两个小时一格，从 10 点到 20 点。 */
export const TICK_MARKS: readonly TickMark[] = [10, 12, 14, 16, 18, 20].map((hour) => ({
  hour,
  at: (hour * 60 - DAY_START_MINUTES) / DAY_LENGTH_MINUTES,
}));

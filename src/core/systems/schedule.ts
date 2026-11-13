// 日程：游戏日、高峰窗口和小结时刻。
import { DAY_STEPS, EVENING_WINDOW, NOON_WINDOW, PeakId, SUMMARY_DELAY } from '../constants.ts';

export type PeakName = 'noon' | 'evening';

const WINDOWS = [NOON_WINDOW, EVENING_WINDOW] as const;

export function dayOf(step: number): number {
  return Math.floor(step / DAY_STEPS);
}

/** 这一步落在哪个高峰（PeakId）内，不在高峰内为 -1。 */
export function peakAt(step: number): number {
  const tick = step % DAY_STEPS;
  for (let id = 0; id < WINDOWS.length; id++) {
    const w = WINDOWS[id] as { start: number; end: number };
    if (tick >= w.start && tick < w.end) return id;
  }
  return -1;
}

export function peakId(name: PeakName): number {
  return name === 'noon' ? PeakId.Noon : PeakId.Evening;
}

/** 某一天某场高峰的下单时段 [start, end)，用绝对步表示。 */
export function peakWindow(day: number, peak: PeakName): { start: number; end: number } {
  const w = WINDOWS[peakId(peak)] as { start: number; end: number };
  return { start: day * DAY_STEPS + w.start, end: day * DAY_STEPS + w.end };
}

/** 高峰小结生成的步：时段结束 30 秒后。 */
export function summaryStep(day: number, peak: PeakName): number {
  return peakWindow(day, peak).end + SUMMARY_DELAY;
}

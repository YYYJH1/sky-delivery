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

/** 这一步是某场高峰下单时段的第一步时，返回这场高峰，其余为 null。 */
export function peakStartingAt(step: number): PeakName | null {
  const tick = step % DAY_STEPS;
  if (tick === NOON_WINDOW.start) return 'noon';
  if (tick === EVENING_WINDOW.start) return 'evening';
  return null;
}

/**
 * 这一步落在哪场高峰里，从下单时段的第一步到生成小结的那一步之前。
 * 下单时段结束之后还有 30 秒，这时这一场的订单还在陆续有结果，所以也算在内。不在任何一场里为 null。
 */
export function peakInProgress(step: number): PeakName | null {
  const day = dayOf(step);
  for (const peak of ['noon', 'evening'] as const) {
    if (step >= peakWindow(day, peak).start && step < summaryStep(day, peak)) return peak;
  }
  return null;
}

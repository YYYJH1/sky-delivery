// 纪录：午高峰和晚高峰各自的准时单数最多，单日进账最多，比开局策略多准时的单数单场最多，连续达标的场数。
// 都由小结和日结的记录算出来，不另存。「破纪录」是比这一场（这一天）之前的最好成绩多，第一次出现没有可比的，不算破。
import type { DayRecord, PeakRecord } from '../types.ts';

/** 一项成绩和它之前的最好成绩。 */
export interface Standing {
  value: number;
  /** 这一场（这一天）之前的最好成绩，之前没有同类的成绩为 null。 */
  best: number | null;
  /** 比之前的最好成绩多。 */
  broken: boolean;
}

function standing(value: number, earlier: readonly number[]): Standing {
  const best = earlier.length === 0 ? null : Math.max(...earlier);
  return { value, best, broken: best !== null && value > best };
}

/** 这一场比开局策略多准时的单数。这一场没有对照时为 null。 */
export function peakGain(record: PeakRecord): number | null {
  return record.baseline === null ? null : record.onTime - record.baseline.onTime;
}

export interface PeakStanding {
  /** 准时的订单数，同是午高峰或同是晚高峰的几场之间比。 */
  onTime: Standing;
  /** 比开局策略多准时的单数，所有有对照的场次之间比。这一场没有对照为 null。 */
  gain: Standing | null;
  /** 到这一场为止，连续全部达标的场数：现在的和最多的。没有判过目标的场次不算断，判过但没有全部达标的场次算断。 */
  streak: { now: number; best: number };
}

/** campaign.peaks 里第 index 场的成绩。index 越界时为 null。 */
export function peakStanding(peaks: readonly PeakRecord[], index: number): PeakStanding | null {
  const record = peaks[index];
  if (record === undefined) return null;
  const before = peaks.slice(0, index);
  const gain = peakGain(record);
  const gains = before.flatMap((p) => {
    const g = peakGain(p);
    return g === null ? [] : [g];
  });
  let now = 0;
  let best = 0;
  for (const p of peaks.slice(0, index + 1)) {
    if (p.cleared === true) {
      now += 1;
      best = Math.max(best, now);
    } else if (p.cleared === false) {
      now = 0;
    }
  }
  return {
    onTime: standing(record.onTime, before.filter((p) => p.peak === record.peak).map((p) => p.onTime)),
    gain: gain === null ? null : standing(gain, gains),
    streak: { now, best },
  };
}

/** campaign.days 里第 index 天的进账，和之前各天的最好成绩比。index 越界时为 null。 */
export function incomeStanding(days: readonly DayRecord[], index: number): Standing | null {
  const record = days[index];
  return record === undefined ? null : standing(record.income, days.slice(0, index).map((d) => d.income));
}

/** 到现在为止，每一场的准时订单数比开局策略多的单数之和（有的场次是负数），以及有对照的场数。 */
export function gainTotal(peaks: readonly PeakRecord[]): { total: number; peaks: number } {
  let total = 0;
  let counted = 0;
  for (const p of peaks) {
    const g = peakGain(p);
    if (g === null) continue;
    total += g;
    counted += 1;
  }
  return { total, peaks: counted };
}

// 高峰进行中的结果：日程纸条下面每个开通的片区一行，准时、超时、取消各几张，和这一场的目标。
// 离目标线最远的一行突出。核心的 liveRows 给出数，这里按词表写成文字，决定哪一行突出。
// 纯函数，不碰 DOM 和状态。
import { GOALS_V1 } from '../content/goals_v1.ts';
import { STR, districtName, fmt } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import { liveRows } from '../core/index.ts';
import type { DistrictGoal, LiveRow, SimState } from '../core/index.ts';

export interface LiveRowView {
  readonly district: number;
  readonly name: string;
  /** 「老街　准时 12　超时 3　取消 0」 */
  readonly counts: string;
  /** 这一场的目标，没有设线时为 null。 */
  readonly goal: string | null;
  /** 在设了线的片区里离目标线最远，并且已经低于目标线。 */
  readonly farthest: boolean;
}

export interface LiveView {
  readonly rows: readonly LiveRowView[];
}

/** 一个片区这一场的目标写成文字。没有设线为 null。 */
export function goalText(goal: DistrictGoal | null): string | null {
  if (goal === null) return null;
  const up = goal.basis === 'next';
  switch (goal.kind) {
    case 'line':
      return fmt(STR.metrics.live.goal, { line: goal.line ?? 0 });
    case 'capped':
      return fmt(up ? STR.metrics.live.goalCappedUp : STR.metrics.live.goalCappedKeep, { line: goal.line ?? 0 });
    case 'enough':
      return up ? STR.metrics.live.enoughUp : STR.metrics.live.enoughKeep;
  }
}

/**
 * 离目标线最远的一行：已经完成的订单达到下限（内容表 GOALS_V1.minLiveOrders），目标线减去现在的准时率最大，并且大于 0。
 * 现在的准时率是准时的订单占已完成的订单的比例。差一样大时取片区编号小的。没有这样的行为 null。
 */
export function farthestRow(rows: readonly LiveRow[]): number | null {
  let best: { district: number; gap: number } | null = null;
  for (const r of rows) {
    const line = r.goal?.line ?? null;
    const decided = r.onTime + r.late + r.cancelled;
    if (line === null || decided < GOALS_V1.minLiveOrders) continue;
    const gap = line - (100 * r.onTime) / decided;
    if (gap > 0 && (best === null || gap > best.gap)) best = { district: r.district, gap };
  }
  return best === null ? null : best.district;
}

/** 现在要不要显示、显示什么。不在高峰里为 null。 */
export function liveView(state: SimState): LiveView | null {
  const view = liveRows(state);
  if (view === null || view.rows.length === 0) return null;
  const far = farthestRow(view.rows);
  return {
    rows: view.rows.map((r) => {
      const name = districtName(r.district as DistrictIndex);
      return {
        district: r.district,
        name,
        counts: fmt(STR.metrics.live.row, { district: name, onTime: r.onTime, late: r.late, cancelled: r.cancelled }),
        goal: goalText(r.goal),
        farthest: far === r.district,
      };
    }),
  };
}

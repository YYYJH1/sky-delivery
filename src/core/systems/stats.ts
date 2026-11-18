// 每步的统计累计：各站每秒有多少架飞机在等降落、有多少停机位是空的。
// 经营模式里还累计机队时间和排队的计数（campaign/fleet.ts），沙盒模式不做。
import { recordFleet } from '../campaign/fleet.ts';
import { DroneState, STEPS_PER_SECOND } from '../constants.ts';
import type { SimState } from '../types.ts';

/** 补齐站的行数（新建的站从这一刻起才有记录）和到当前秒为止的列。 */
function ensureCells(rows: number[][], stationCount: number, second: number): void {
  while (rows.length < stationCount) rows.push([]);
  for (const row of rows) {
    while (row.length <= second) row.push(0);
  }
}

/** 统计阶段：在这一步结束时记录。已退回的站不再产生统计。 */
export function recordStats(state: SimState): void {
  const { stats, stations } = state;
  const second = Math.floor(state.step / STEPS_PER_SECOND);
  ensureCells(stats.landWait, stations.length, second);
  ensureCells(stats.bayEmpty, stations.length, second);
  ensureCells(stats.bayTotal, stations.length, second);
  for (const d of state.drones) {
    if (d.state === DroneState.LandQueue) {
      const row = stats.landWait[d.station] as number[];
      row[second] = (row[second] as number) + 1;
    }
  }
  for (const s of stations) {
    if (s.removed) continue;
    const empty = stats.bayEmpty[s.id] as number[];
    const total = stats.bayTotal[s.id] as number[];
    empty[second] = (empty[second] as number) + (s.bays - s.occupied);
    total[second] = (total[second] as number) + s.bays;
  }
  recordFleet(state);
}

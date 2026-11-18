// 机队时间和排队的计数。只在经营模式里做，只读状态，不影响派单、飞行、起降、充电的任何决定。
// 统计阶段每一步给每架没有退回的无人机分一类，累加到 campaign.tally：
// - 高峰窗口内（peakWindow，午、晚两场的下单时段）：按无人机的归属站累计五类的「架·步」数，
//   另外按归属站累计回站飞行的「架·步」数（飞行并且在回站，是空载飞行的一部分，五类的数不变），
//   以及每座站「至少有 1 架无人机等待起飞」和「至少有 1 架无人机排队」的步数，站按无人机所在的站（station）归属。
//   放行起飞的架次由起降口阶段调用 recordSortie 累加。
// - 全天：按时刻分 24 段，累计全部无人机和其中占用的「架·步」数。占用指不是停放，或者停放但电量没有充满、正在充电。
// 每一步只做与「无人机数加站数」同级的工作：扫描一遍无人机，扫描一遍站，不碰订单列表。
// 小结时刻读出当场高峰的计数（summary.ts），日结时读出当天的计数（settle.ts），读完清零。
import { BUSY_SEGMENTS, BUSY_SEGMENT_STEPS, DAY_STEPS, DroneState, RANGE } from '../constants.ts';
import { peakAt } from '../systems/schedule.ts';
import type { DayTally, Drone, FleetTally, PeakTally, SimState } from '../types.ts';

/** 机队时间的五类，也是计数行里五项的顺序。作业包括等待出餐。 */
export const FleetClass = { Loaded: 0, Empty: 1, Work: 2, Queue: 3, Parked: 4 } as const;
export const FLEET_CLASSES = 5;

function zeroRow(): number[] {
  return new Array<number>(FLEET_CLASSES).fill(0);
}

/** 站数为 stations 的当场高峰计数，全零。 */
export function emptyPeakTally(stations: number): PeakTally {
  return {
    steps: 0,
    fleet: Array.from({ length: stations }, zeroRow),
    back: new Array<number>(stations).fill(0),
    takeoffWait: new Array<number>(stations).fill(0),
    queue: new Array<number>(stations).fill(0),
    sorties: new Array<number>(stations).fill(0),
  };
}

/** 当天的计数，全零。 */
export function emptyDayTally(): DayTally {
  return { drones: new Array<number>(BUSY_SEGMENTS).fill(0), used: new Array<number>(BUSY_SEGMENTS).fill(0) };
}

export function emptyTally(stations: number): FleetTally {
  return { peak: emptyPeakTally(stations), day: emptyDayTally() };
}

/** 新建的站从建成之后的第一次累加起补上一行。 */
function growPeak(peak: PeakTally, stations: number): void {
  while (peak.fleet.length < stations) peak.fleet.push(zeroRow());
  while (peak.back.length < stations) peak.back.push(0);
  while (peak.takeoffWait.length < stations) peak.takeoffWait.push(0);
  while (peak.queue.length < stations) peak.queue.push(0);
  while (peak.sorties.length < stations) peak.sorties.push(0);
}

/** 一架没有退回的无人机这一步属于机队时间的哪一类。 */
export function fleetClassOf(d: Drone): number {
  switch (d.state) {
    case DroneState.Fly:
      // 载货飞行：不在回站，并且机上有货。其余的飞行是空载：去店铺取餐，送完回站
      return !d.returning && d.onboard.length > 0 ? FleetClass.Loaded : FleetClass.Empty;
    case DroneState.Takeoff:
    case DroneState.Land:
    case DroneState.Pick:
    case DroneState.Drop:
    case DroneState.Prep:
      return FleetClass.Work;
    case DroneState.TakeoffQueue:
    case DroneState.LandQueue:
      return FleetClass.Queue;
    case DroneState.Dock:
      // 停在机位上但已经接单，还没进起降口的队列，也算排队
      return d.route.length > 0 ? FleetClass.Queue : FleetClass.Parked;
    default:
      return FleetClass.Parked;
  }
}

/**
 * 回站飞行：飞行并且在回站，也就是送完单飞回站点的这一段。它属于空载飞行，fleetClassOf 把它归在空载飞行里，
 * 去店铺取餐的飞行不算回站。回站的无人机降落之前在上空等降落，那是排队，不算回站飞行。
 */
export function isBackFlight(d: Drone): boolean {
  return d.state === DroneState.Fly && d.returning;
}

/** 这一步落在哪一段，从 0 数起。 */
export function busySegmentOf(step: number): number {
  return Math.floor((step % DAY_STEPS) / BUSY_SEGMENT_STEPS);
}

/**
 * 统计阶段每一步最后调用。沙盒模式什么也不做。
 * 订单不参与，所以每一步的工作量只随无人机数和站数增加。
 */
export function recordFleet(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null) return;
  const tally = campaign.tally;
  const peak = tally.peak;
  const stations = state.stations.length;
  const inPeak = peakAt(state.step) >= 0;
  // 这一步里每座站有没有无人机在等待起飞、在排队。只在高峰窗口内用
  let waiting: Uint8Array | null = null;
  let queued: Uint8Array | null = null;
  if (inPeak) {
    growPeak(peak, stations);
    waiting = new Uint8Array(stations);
    queued = new Uint8Array(stations);
  }

  let all = 0;
  let used = 0;
  for (const d of state.drones) {
    if (d.removed) continue;
    const cls = fleetClassOf(d);
    all += 1;
    if (cls !== FleetClass.Parked || d.battery < RANGE) used += 1;
    if (waiting === null || queued === null) continue;
    const row = peak.fleet[d.home] as number[];
    row[cls] = (row[cls] ?? 0) + 1;
    if (isBackFlight(d)) peak.back[d.home] = (peak.back[d.home] ?? 0) + 1;
    if (cls === FleetClass.Queue && d.station >= 0 && d.station < stations) {
      queued[d.station] = 1;
      if (d.state !== DroneState.LandQueue) waiting[d.station] = 1;
    }
  }

  const segment = busySegmentOf(state.step);
  tally.day.drones[segment] = (tally.day.drones[segment] ?? 0) + all;
  tally.day.used[segment] = (tally.day.used[segment] ?? 0) + used;

  if (waiting === null || queued === null) return;
  peak.steps += 1;
  for (let s = 0; s < stations; s++) {
    if (waiting[s] === 1) peak.takeoffWait[s] = (peak.takeoffWait[s] ?? 0) + 1;
    if (queued[s] === 1) peak.queue[s] = (peak.queue[s] ?? 0) + 1;
  }
}

/** 起降口放行一架无人机起飞时调用，高峰窗口内才计。 */
export function recordSortie(state: SimState, station: number): void {
  const campaign = state.campaign;
  if (campaign === null || peakAt(state.step) < 0) return;
  const peak = campaign.tally.peak;
  growPeak(peak, state.stations.length);
  peak.sorties[station] = (peak.sorties[station] ?? 0) + 1;
}

/** 当场高峰的计数读完之后清零，保留每座站的行。小结时刻调用。 */
export function resetPeakTally(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null) return;
  const peak = campaign.tally.peak;
  peak.steps = 0;
  for (const row of peak.fleet) row.fill(0);
  peak.back.fill(0);
  peak.takeoffWait.fill(0);
  peak.queue.fill(0);
  peak.sorties.fill(0);
}

/**
 * 读出当天每一段的占用百分数，再把当天的计数清零。日结时调用。
 * 一段的百分数是占用的架·步数除以全部的架·步数，下取整。这一段没有无人机时是 0。
 * 用整数除法算：分子是整数乘 100，除下来的商与整数相差至少 1 除以架·步数，浮点误差碰不到取整的边界。
 */
export function takeDayBusy(state: SimState): number[] {
  const campaign = state.campaign;
  if (campaign === null) return [];
  const day = campaign.tally.day;
  const busy: number[] = [];
  for (let i = 0; i < BUSY_SEGMENTS; i++) {
    const total = day.drones[i] ?? 0;
    busy.push(total > 0 ? Math.floor((100 * (day.used[i] ?? 0)) / total) : 0);
  }
  day.drones.fill(0);
  day.used.fill(0);
  return busy;
}

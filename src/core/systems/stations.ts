// 站点：停机位和起降口。每座站一个起降口，起飞和降落共用一个先到先办的队列。
import { DroneState, LAND_STEPS, LOW_BATTERY, RANGE, STEPS_PER_SECOND, TAKEOFF_STEPS } from '../constants.ts';
import type { Drone, Order, SimConfig, SimState, Station } from '../types.ts';
import { dist } from '../world.ts';
import type { StationPlan } from '../world.ts';

export function createStations(plans: readonly StationPlan[], config: SimConfig): Station[] {
  const gateInterval = Math.max(1, Math.round(config.gateInterval * STEPS_PER_SECOND));
  return plans.map((p, id) => ({
    id,
    x: p.x,
    y: p.y,
    bays: p.bays,
    occupied: p.drones,
    queue: [],
    gateFree: 0,
    gateInterval,
    removed: false,
  }));
}

/** 从队列里挑下一架：电量低于 15% 的降落排到最前，其余先到先办；停机位满时不放降落。返回队列下标。 */
function pickFromQueue(state: SimState, s: Station): number {
  const full = s.occupied >= s.bays;
  const limit = LOW_BATTERY * RANGE;
  if (!full) {
    for (let i = 0; i < s.queue.length; i++) {
      const d = state.drones[s.queue[i] as number] as Drone;
      if (d.state === DroneState.LandQueue && d.battery < limit) return i;
    }
  }
  for (let i = 0; i < s.queue.length; i++) {
    const d = state.drones[s.queue[i] as number] as Drone;
    if (d.state === DroneState.LandQueue && full) continue;
    return i;
  }
  return -1;
}

/** 起降口阶段：每座站的起降口空闲时，放行队列里的下一架，并在间隔之后才办下一个。 */
export function runGates(state: SimState): void {
  const now = state.step;
  for (const s of state.stations) {
    if (s.removed || s.queue.length === 0 || now < s.gateFree) continue;
    const at = pickFromQueue(state, s);
    if (at < 0) continue;
    const d = state.drones[s.queue.splice(at, 1)[0] as number] as Drone;
    s.gateFree = now + s.gateInterval;
    if (d.state === DroneState.TakeoffQueue) {
      d.state = DroneState.Takeoff;
      d.tEnd = now + TAKEOFF_STEPS;
      for (const stop of d.route) {
        const order = state.orders[stop.order] as Order;
        order.gateWait = now - order.tAssign;
      }
    } else {
      d.state = DroneState.Land;
      d.tEnd = now + LAND_STEPS;
      d.returning = false;
      d.target = -1;
      s.occupied += 1;
    }
  }
}

// ---- 站点和飞机的计数 ----
// 已退回的站和飞机不计入。归属站跟着飞机最后一次降落的站走（就近降落时会变），所以飞机数按归属站数。

/** 还在使用的站的数量。 */
export function stationCount(state: SimState): number {
  let n = 0;
  for (const s of state.stations) if (!s.removed) n++;
  return n;
}

/** 一座站的飞机数：归属站是这座站的、没有退回的飞机。 */
export function fleetOf(state: SimState, station: number): number {
  let n = 0;
  for (const d of state.drones) if (!d.removed && d.home === station) n++;
  return n;
}

/** 已经预约了这座站、正在飞来或在上空等降落的飞机数。降落开始时预约取消，占用数加一。 */
export function inboundTo(state: SimState, station: number): number {
  let n = 0;
  for (const d of state.drones) if (!d.removed && d.returning && d.target === station) n++;
  return n;
}

/** 离 (x, y) 最近的、还在使用的站的距离，不管停机位满没满。没有站时为 Infinity。 */
export function nearestStationDistance(state: SimState, x: number, y: number): number {
  let best = Infinity;
  for (const s of state.stations) {
    if (s.removed) continue;
    const d = dist(x, y, s.x, s.y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 送完一单、从 (x, y) 处回站的距离，派单前的电量检查用。
 * 回原站时是到这架飞机归属站的距离，就近降落时是到最近的站的距离。
 */
export function backDistance(state: SimState, d: Pick<Drone, 'home'>, x: number, y: number): number {
  if (state.returnRule === 'nearest') return nearestStationDistance(state, x, y);
  const home = state.stations[d.home] as Station;
  return dist(x, y, home.x, home.y);
}

/**
 * 就近降落：飞机现在所在的位置离哪座站最近，就飞去哪座，但这座站的停机位不能满（占用数加预约数小于停机位数）。
 * 最近的站满了就依次找下一座，都满了回归属站。距离相同取编号小的。
 */
export function nearestFreeStation(state: SimState, d: Drone): number {
  let best = -1;
  let bestDist = Infinity;
  for (const s of state.stations) {
    if (s.removed) continue;
    if (s.occupied + inboundTo(state, s.id) >= s.bays) continue;
    const away = dist(d.x, d.y, s.x, s.y);
    if (away < bestDist) {
      best = s.id;
      bestDist = away;
    }
  }
  return best >= 0 ? best : d.home;
}

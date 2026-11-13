// 合单策略的插入：把一张订单插进另一架已有任务的飞机的路线。
// 做法（每趟送完都回站）：
// - 在每架飞机的路线里试所有的插入位置，取餐点和送达点各插一处，路线开头已经锁定的点不动。
// - 只接受同乘的插入：新订单在机上的这一段里，机上同时有别的订单。
// - 路线上已经没有取餐点的飞机不再接受插入。
// - 载量、已有订单的推迟、电量三项检查都要通过，站点分工按这一趟的出发站判断。
// - 在所有可行的插入里选路线完成时间增加最少的，增加量相同时取先试到的。
// 全部在试算上计算。试算记着各架飞机在本轮方案里的路线，路线改变时换成新数组，状态里的路线不会被改动。
import { DROP_STEPS, DroneState, HOVER_MARGIN, PICK_STEPS, RESERVE, STEP_DIST, StopKind, TAKEOFF_STEPS } from '../constants.ts';
import { backDistance } from '../systems/stations.ts';
import type { Drone, Order, RouteStop, SimState } from '../types.ts';
import { dist } from '../world.ts';
import type { PoolRule, ZoneRule } from './types.ts';

/** 沿一条路线预测的结果。时刻都用步，不要求是整数。 */
interface Forecast {
  /** 路线完成的时刻 */
  finish: number;
  /** 路线上每张订单的预计送达时刻：orders[i] 的送达在 times[i] */
  orders: number[];
  times: number[];
}

/** 一架飞机在本轮派单试算里的样子：路线可能已经被本轮前面派出的订单改过。路线数组只替换，不修改。 */
export interface DraftDrone {
  drone: Drone;
  route: readonly RouteStop[];
  /** 这一趟从哪座站出发。只带这一项，供「协同策略」判断 */
  from: { station: number };
  /** 当前试算路线的预测，路线改变时清掉 */
  forecast: Forecast | null;
}

/** 给每架飞机做一份试算。飞机停在停机位上时，出发站就是它所在的站。 */
export function makeDrafts(state: SimState): DraftDrone[] {
  return state.drones.map((d) => ({
    drone: d,
    route: d.route,
    from: { station: d.departed >= 0 ? d.departed : d.station },
    forecast: null,
  }));
}

/** 订单交给一架停在停机位上的飞机：试算里它的路线变成这张订单的取点和送点。 */
export function draftAssign(draft: DraftDrone, order: Order): void {
  draft.route = [
    { kind: StopKind.Pickup, order: order.id },
    { kind: StopKind.Drop, order: order.id },
  ];
  draft.forecast = null;
}

/** 订单插进一架飞机的路线：试算里它的路线换成算好的新路线。 */
export function draftInsert(draft: DraftDrone, route: RouteStop[]): void {
  draft.route = route;
  draft.forecast = null;
}

/** 机上份量：订单份量和载量的较小值，保证单张订单一定送得动。 */
function unitsOf(state: SimState, order: Order): number {
  return Math.min(order.portion, state.capacity);
}

/** 路线预测的起点：起始时刻和路线开头已经锁定的点数。锁定的是正在等出餐、正在取餐或送达的那一个。 */
function routeStart(state: SimState, d: Drone, route: readonly RouteStop[], now: number): { t0: number; locked: number } {
  switch (d.state) {
    case DroneState.Dock:
    case DroneState.TakeoffQueue:
      return { t0: now + TAKEOFF_STEPS, locked: 0 }; // 要先起飞，不计起降口的排队
    case DroneState.Takeoff:
      return { t0: d.tEnd, locked: 0 };
    case DroneState.Prep: {
      const order = state.orders[(route[0] as RouteStop).order] as Order;
      return { t0: Math.max(now, order.prepDone) + PICK_STEPS, locked: 1 };
    }
    case DroneState.Pick:
    case DroneState.Drop:
      return { t0: d.tEnd, locked: 1 };
    default:
      return { t0: now, locked: 0 };
  }
}

/** 订单交给这架停在停机位上的飞机时的预计送达时刻。 */
export function predictIdle(state: SimState, d: Drone, order: Order, now: number): number {
  const shop = state.world.merchants[order.merchant] as { x: number; y: number };
  let t = now + TAKEOFF_STEPS + dist(d.x, d.y, shop.x, shop.y) / STEP_DIST;
  if (t < order.prepDone) t = order.prepDone;
  return t + PICK_STEPS + order.dMB / STEP_DIST + DROP_STEPS;
}

/** 沿路线预测各个送达点的完成时刻，不做任何检查。 */
function forecastRoute(state: SimState, d: Drone, route: readonly RouteStop[], t0: number, locked: number): Forecast {
  const { merchants, buildings } = state.world;
  let x = d.x;
  let y = d.y;
  let t = t0;
  const orders: number[] = [];
  const times: number[] = [];
  for (let idx = 0; idx < route.length; idx++) {
    const stop = route[idx] as RouteStop;
    const order = state.orders[stop.order] as Order;
    const pickup = stop.kind === StopKind.Pickup;
    const place = pickup ? (merchants[order.merchant] as { x: number; y: number }) : (buildings[order.building] as { x: number; y: number });
    if (idx >= locked) {
      t += dist(x, y, place.x, place.y) / STEP_DIST;
      if (pickup) {
        if (t < order.prepDone) t = order.prepDone;
        t += PICK_STEPS;
      } else {
        t += DROP_STEPS;
      }
      x = place.x;
      y = place.y;
    }
    if (!pickup) {
      orders.push(order.id);
      times.push(t);
    }
  }
  return { finish: t, orders, times };
}

/**
 * 沿新路线预测，同时检查：载量不超、已有订单的预计送达推迟不超过 pushLimit、电量够飞完整条路线再回站。
 * 可行时返回路线完成的时刻和新订单的预计送达时刻，不可行返回 null。
 */
function checkRoute(
  state: SimState,
  d: Drone,
  route: readonly RouteStop[],
  t0: number,
  locked: number,
  base: Forecast,
  newId: number,
  pushLimit: number,
): { finish: number; arrival: number } | null {
  const { merchants, buildings } = state.world;
  const capacity = state.capacity;
  let x = d.x;
  let y = d.y;
  let t = t0;
  let load = d.load;
  let travel = 0;
  let arrival = Number.NaN;
  let lastDrop: Order | null = null;
  for (let idx = 0; idx < route.length; idx++) {
    const stop = route[idx] as RouteStop;
    const order = state.orders[stop.order] as Order;
    const pickup = stop.kind === StopKind.Pickup;
    const place = pickup ? (merchants[order.merchant] as { x: number; y: number }) : (buildings[order.building] as { x: number; y: number });
    if (idx >= locked) {
      const leg = dist(x, y, place.x, place.y);
      travel += leg;
      t += leg / STEP_DIST;
      if (pickup) {
        if (t < order.prepDone) t = order.prepDone;
        t += PICK_STEPS;
      } else {
        t += DROP_STEPS;
      }
      x = place.x;
      y = place.y;
    }
    if (pickup) {
      load += unitsOf(state, order);
      if (load > capacity) return null;
    } else {
      load -= unitsOf(state, order);
      lastDrop = order;
      if (order.id === newId) arrival = t;
      const known = base.orders.indexOf(order.id);
      if (known >= 0 && t - (base.times[known] as number) > pushLimit) return null;
    }
  }
  // 电量：新路线的总距离，加上最后一个送达点回站的距离（回归属站，买了就近降落之后是最近的站）、悬停余量和保留电量
  const end = state.world.buildings[(lastDrop as Order).building] as { x: number; y: number };
  if (travel + backDistance(state, d, end.x, end.y) + HOVER_MARGIN + RESERVE > d.battery) return null;
  return { finish: t, arrival };
}

/**
 * 新订单在机上的这一段里，机上是否同时有别的订单。
 * 否则它只是排在别的订单送完之后的顺序追加，不算一起送。
 */
export function ridesWithOthers(d: Pick<Drone, 'onboard'>, route: readonly RouteStop[], orderId: number): boolean {
  let aboard = d.onboard.length;
  let riding = false;
  for (const stop of route) {
    if (stop.order === orderId) {
      if (stop.kind === StopKind.Pickup) {
        if (aboard > 0) return true;
        riding = true;
      } else {
        return false;
      }
    } else if (riding && stop.kind === StopKind.Pickup) {
      return true;
    }
    aboard += stop.kind === StopKind.Pickup ? 1 : -1;
  }
  return false;
}

/** 这架飞机的路线根本不接受这张订单：路线里没有取餐点了，或者这张卡不让一起送，或者出发站不被分工允许。 */
function blocked(state: SimState, draft: DraftDrone, order: Order, now: number, pool: PoolRule, zone: ZoneRule): boolean {
  const route = draft.route;
  if (!route.some((stop) => stop.kind === StopKind.Pickup)) return true;
  if (!pool.accepts(state, route, order)) return true;
  return !zone.allows(state, now, draft.from, order);
}

/** 最便宜的插入：插进哪架飞机、新路线，以及新订单在新路线里的预计送达时刻。 */
export interface InsertionChoice {
  droneId: number;
  route: RouteStop[];
  /** 新订单在新路线里的预计送达时刻（步） */
  arrival: number;
  /** 路线完成时刻比原来晚了多少步 */
  increase: number;
}

/**
 * 在所有飞机的试算路线里，找让路线完成时间增加最少的可行插入。没有可行的插入时返回 null。
 * 飞机按编号试，每架飞机里按取点位置、送点位置的先后试，增加量相同时留下先试到的。
 */
export function bestInsertion(
  state: SimState,
  drafts: readonly DraftDrone[],
  order: Order,
  now: number,
  pool: PoolRule,
  zone: ZoneRule,
): InsertionChoice | null {
  const pickup: RouteStop = { kind: StopKind.Pickup, order: order.id };
  const drop: RouteStop = { kind: StopKind.Drop, order: order.id };
  let best: InsertionChoice | null = null;
  let bestIncrease = Infinity;
  for (const draft of drafts) {
    const route = draft.route;
    if (route.length === 0 || blocked(state, draft, order, now, pool, zone)) continue;
    const d = draft.drone;
    const { t0, locked } = routeStart(state, d, route, now);
    const base = draft.forecast ?? (draft.forecast = forecastRoute(state, d, route, t0, locked));
    for (let i = locked; i <= route.length; i++) {
      for (let j = i; j <= route.length; j++) {
        const next = [...route.slice(0, i), pickup, ...route.slice(i, j), drop, ...route.slice(j)];
        if (!ridesWithOthers(d, next, order.id)) continue;
        const checked = checkRoute(state, d, next, t0, locked, base, order.id, pool.pushLimit);
        if (checked === null) continue;
        const increase = checked.finish - base.finish;
        if (best === null || increase < bestIncrease) {
          best = { droneId: d.id, route: next, arrival: checked.arrival, increase };
          bestIncrease = increase;
        }
      }
    }
  }
  return best;
}

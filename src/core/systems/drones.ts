// 飞机：状态机。每趟送完回自己的站，回到停机位之后才能再接单。
import {
  DAY_STEPS,
  DROP_STEPS,
  DroneState,
  EMPTY_SPEED_FACTOR,
  HOVER_COST,
  OrderStatus,
  PICK_STEPS,
  RANGE,
  STEPS_PER_SECOND,
  STEP_DIST,
  StopKind,
} from '../constants.ts';
import { creditOrder, deliverOrder } from './settlement.ts';
import { nearestFreeStation } from './stations.ts';
import type { Drone, Order, RouteStop, SimState, Station } from '../types.ts';
import type { StationPlan } from '../world.ts';

/** 开局的飞机：各站的飞机停在自己的站上，满电。编号按站的顺序排。 */
export function createDrones(plans: readonly StationPlan[]): Drone[] {
  const drones: Drone[] = [];
  plans.forEach((plan, station) => {
    for (let i = 0; i < plan.drones; i++) {
      drones.push({
        id: drones.length,
        x: plan.x,
        y: plan.y,
        battery: RANGE,
        home: station,
        state: DroneState.Dock,
        station,
        route: [],
        onboard: [],
        load: 0,
        tx: 0,
        ty: 0,
        tEnd: 0,
        returning: false,
        target: -1,
        queuedAt: 0,
        stranded: false,
        departed: -1,
        removed: false,
      });
    }
  });
  return drones;
}

/** 可以接新单的飞机：停在停机位上，手上没有任务。在空中、盘旋等降落的都不能接，已退回的也不能接。 */
export function isAvailable(d: Drone): boolean {
  return !d.removed && d.state === DroneState.Dock && d.route.length === 0;
}

function orderOf(state: SimState, id: number): Order {
  return state.orders[id] as Order;
}

/** 把一张待派订单交给一架停在停机位上的飞机：它进入起降口队列等起飞。 */
export function assignToDockedDrone(state: SimState, d: Drone, order: Order): void {
  if (!isAvailable(d)) throw new Error('orders can only be assigned to a drone docked on a bay');
  const station = state.stations[d.station] as Station;
  order.units = Math.min(order.portion, state.capacity);
  order.status = OrderStatus.Assigned;
  order.tAssign = state.step;
  order.drone = d.id;
  order.departed = d.station;
  state.pending.splice(state.pending.indexOf(order.id), 1);
  d.route = [
    { kind: StopKind.Pickup, order: order.id },
    { kind: StopKind.Drop, order: order.id },
  ];
  d.departed = d.station;
  d.state = DroneState.TakeoffQueue;
  d.queuedAt = state.step;
  station.queue.push(d.id);
}

/**
 * 把一张待派订单插进一架已有任务的飞机的路线。新路线 route 由派单算好，沿用原有的路线点，只加入这张订单的取点和送点。
 * 飞机正在飞往路线上的第一个点时，立刻朝新的第一个点转向。
 */
export function insertIntoRoute(state: SimState, d: Drone, order: Order, route: RouteStop[]): void {
  if (d.route.length === 0) throw new Error('orders can only be inserted into the route of a drone that has a task');
  order.units = Math.min(order.portion, state.capacity);
  order.status = OrderStatus.Assigned;
  order.tAssign = state.step;
  order.drone = d.id;
  order.departed = d.departed;
  state.pending.splice(state.pending.indexOf(order.id), 1);
  d.route = route;
  if (d.state === DroneState.Fly) startLeg(state, d, state.step);
}

// ---- 状态机 ----

/** 飞回哪座站。默认回自己的站，买了就近降落之后去最近的、停机位没满的站。 */
function returnStation(state: SimState, d: Drone): number {
  return state.returnRule === 'nearest' ? nearestFreeStation(state, d) : d.home;
}

function hover(d: Drone): void {
  const b = d.battery - HOVER_COST;
  d.battery = b > 0 ? b : 0;
}

/** 这一步飞过的距离计入当天的飞行距离，载货飞行的另记一份。 */
function recordFlight(state: SimState, moved: number, loaded: boolean): void {
  const { flightTotal, flightLoaded } = state.stats;
  const day = Math.floor(state.step / DAY_STEPS);
  while (flightTotal.length <= day) {
    flightTotal.push(0);
    flightLoaded.push(0);
  }
  flightTotal[day] = (flightTotal[day] as number) + moved;
  if (loaded) flightLoaded[day] = (flightLoaded[day] as number) + moved;
}

/** 朝目标飞一步。电量耗尽后速度降到两成，并记一次耗尽。 */
function move(state: SimState, d: Drone): void {
  const dx = d.tx - d.x;
  const dy = d.ty - d.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const reach = d.battery > 0 ? STEP_DIST : STEP_DIST * EMPTY_SPEED_FACTOR;
  let moved: number;
  let arrived: boolean;
  if (dist <= reach) {
    moved = dist;
    d.x = d.tx;
    d.y = d.ty;
    arrived = true;
  } else {
    const f = reach / dist;
    d.x += dx * f;
    d.y += dy * f;
    moved = reach;
    arrived = false;
  }
  let b = d.battery - moved;
  if (b <= 0) {
    b = 0;
    if (!d.stranded) {
      d.stranded = true;
      state.stats.stranded += 1;
    }
  }
  d.battery = b;
  recordFlight(state, moved, d.load > 0);
  if (arrived) onArrive(state, d, state.step + 1);
}

/** 到达当前目标。t 是到达的时刻（本步结束时即下一步）。 */
function onArrive(state: SimState, d: Drone, t: number): void {
  const stop = d.route[0];
  if (stop) {
    const order = orderOf(state, stop.order);
    if (stop.kind === StopKind.Pickup) {
      order.tArrive = t;
      if (t >= order.prepDone) beginPick(d, order, t);
      else d.state = DroneState.Prep;
    } else {
      d.state = DroneState.Drop;
      d.tEnd = t + DROP_STEPS;
    }
  } else if (d.returning) {
    // 回到站点上空，进入起降口队列盘旋等待
    d.state = DroneState.LandQueue;
    d.station = d.target;
    d.queuedAt = t;
    (state.stations[d.target] as Station).queue.push(d.id);
  } else {
    throw new Error(`drone ${d.id} arrived without a target`);
  }
}

function beginPick(d: Drone, order: Order, t: number): void {
  d.state = DroneState.Pick;
  d.tEnd = t + PICK_STEPS;
  order.tPick = t;
  order.status = OrderStatus.Picked;
}

/** 朝路线上的下一个点飞。距离为零则当场到达。 */
function startLeg(state: SimState, d: Drone, now: number): void {
  const stop = d.route[0] as RouteStop;
  const order = orderOf(state, stop.order);
  const target =
    stop.kind === StopKind.Pickup ? state.world.merchants[order.merchant] : state.world.buildings[order.building];
  if (!target) throw new Error('order refers to a missing merchant or building');
  d.tx = target.x;
  d.ty = target.y;
  d.state = DroneState.Fly;
  if (d.x === d.tx && d.y === d.ty) onArrive(state, d, now);
}

/** 手上的任务做完：回站，途中不接单。 */
function finishMission(state: SimState, d: Drone, now: number): void {
  const target = returnStation(state, d);
  const s = state.stations[target] as Station;
  d.target = target;
  d.returning = true;
  d.tx = s.x;
  d.ty = s.y;
  d.state = DroneState.Fly;
  if (d.x === d.tx && d.y === d.ty) onArrive(state, d, now);
}

function afterTakeoff(state: SimState, d: Drone, now: number): void {
  (state.stations[d.station] as Station).occupied -= 1;
  d.station = -1;
  if (d.route.length > 0) startLeg(state, d, now);
  else finishMission(state, d, now);
}

function afterPick(state: SimState, d: Drone, now: number): void {
  const stop = d.route.shift() as RouteStop;
  const order = orderOf(state, stop.order);
  d.onboard.push(order.id);
  d.load += order.units;
  if (d.onboard.length >= 2) {
    for (const id of d.onboard) orderOf(state, id).shared = true; // 机上同时有两张订单：同乘
  }
  startLeg(state, d, now);
}

function afterDrop(state: SimState, d: Drone, now: number): void {
  const stop = d.route.shift() as RouteStop;
  const order = orderOf(state, stop.order);
  d.onboard.splice(d.onboard.indexOf(order.id), 1);
  d.load -= order.units;
  deliverOrder(order, now);
  creditOrder(state, order);
  if (d.route.length > 0) startLeg(state, d, now);
  else finishMission(state, d, now);
}

function afterLand(state: SimState, d: Drone): void {
  d.state = DroneState.Dock;
  d.stranded = false;
  d.departed = -1;
  // 就近降落：落在哪座站，归属站就改成哪座，价格和停机位按新的归属站算
  if (state.returnRule === 'nearest') d.home = d.station;
}

/** 一架飞机推进一步。动作做完后立刻进入下一个状态，同一步内可以连续转换。 */
function tickDrone(state: SimState, d: Drone): void {
  const now = state.step;
  for (;;) {
    switch (d.state) {
      case DroneState.Fly:
        move(state, d);
        return;
      case DroneState.Dock:
      case DroneState.TakeoffQueue: {
        // 停在机位上充电，包括等起飞的时候
        if (d.battery < RANGE) {
          const b = d.battery + RANGE / (state.config.chargeTime * STEPS_PER_SECOND);
          d.battery = b > RANGE ? RANGE : b;
        }
        return;
      }
      case DroneState.Prep: {
        const order = orderOf(state, (d.route[0] as RouteStop).order);
        if (now >= order.prepDone) {
          beginPick(d, order, now);
          continue;
        }
        hover(d);
        return;
      }
      case DroneState.Pick:
        if (now >= d.tEnd) {
          afterPick(state, d, now);
          continue;
        }
        return;
      case DroneState.Drop:
        if (now >= d.tEnd) {
          afterDrop(state, d, now);
          continue;
        }
        return;
      case DroneState.Takeoff:
        if (now >= d.tEnd) {
          afterTakeoff(state, d, now);
          continue;
        }
        return;
      case DroneState.Land:
        if (now >= d.tEnd) {
          afterLand(state, d);
          continue;
        }
        return;
      case DroneState.LandQueue:
        hover(d);
        return;
      default:
        throw new Error(`unknown drone state ${d.state}`);
    }
  }
}

/** 飞机阶段：按编号逐架推进，已退回的飞机不动。 */
export function tickDrones(state: SimState): void {
  for (const d of state.drones) {
    if (!d.removed) tickDrone(state, d);
  }
}

/**
 * 订单在取走之前被取消：把它的取点和送点从路线上拿掉。
 * 没有别的任务时，排队等起飞的回到停机位，正在飞的转为回站。
 */
export function dropFromRoute(state: SimState, d: Drone, orderId: number, now: number): void {
  const first = d.route[0];
  d.route = d.route.filter((stop) => stop.order !== orderId);
  if (d.route.length === 0) {
    if (d.state === DroneState.TakeoffQueue) {
      const queue = (state.stations[d.station] as Station).queue;
      queue.splice(queue.indexOf(d.id), 1);
      d.state = DroneState.Dock;
      d.departed = -1;
    } else if (d.state === DroneState.Fly || d.state === DroneState.Prep) {
      finishMission(state, d, now);
    }
  } else if (d.route[0] !== first && (d.state === DroneState.Fly || d.state === DroneState.Prep)) {
    startLeg(state, d, now);
  }
}

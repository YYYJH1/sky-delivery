// 合单策略的插入：把一张订单插进另一架已有任务的飞机的路线。
// 做法（每趟送完都回站）：
// - 在每架飞机的路线里试所有的插入位置，取餐点和送达点各插一处，路线开头已经锁定的点不动。
// - 只接受同乘的插入：新订单在机上的这一段里，机上同时有别的订单。
// - 路线上已经没有取餐点的飞机不再接受插入。
// - 载量、已有订单的推迟、电量三项检查都要通过，站点分工按这一趟的出发站判断。
// - 在所有可行的插入里选路线完成时间增加最少的，增加量相同时取先试到的。
// 全部在试算上计算。试算记着各架飞机在本轮方案里的路线，路线改变时换成新数组，状态里的路线不会被改动。
//
// 实现：一个插入位置的做法是生成新路线，沿整条路线预测一遍，同时检查三项条件。逐个位置这样做是派单里最重的计算，
// 而且绝大多数位置都不可行（载量超的占六成，已有订单推迟过多的占两成多，真正可行的不到千分之二）。
// 这里的算法与逐个位置生成路线、沿路线预测的做法给出完全相同的结果，选中哪架飞机的哪个位置、预计送达时刻、增加量都逐位相同
// （tests/dispatch-insertion.test.ts 里有逐个位置的参照实现，沿真实的运行逐轮对照），只是不再重复算相同的部分，也不再为淘汰的位置建数组：
// - 与新订单无关的部分只算一次。飞机在每个点之前的位置、时刻、已飞距离、机上份量，各点的位置和份量，已有送达点的预计时刻，
//   都存在 analyzeRoute 算好的表里，路线改变时和试算一起清掉。
// - 新路线里取点之前的部分与原路线完全相同，直接取表。取点之后按原来的先后逐点累加，每一步的加法、除法和比较与沿新路线预测时逐位相同，
//   所以每一个浮点数的运算次序和结果都与逐个位置沿路线预测时一样。
// - 取点的位置固定时，送点的位置从前往后试。取点和送点之间的某个点让载量超了或让已有订单推迟过多，更靠后的送点位置会包含同一个点，也不可行，不用再试。
// - 同乘只与取点之前机上有几张订单、取点之后有没有别的取餐点有关（见 ridesWithOthers），不用生成路线就能判断。
// - 只为最后选中的位置生成路线数组。
import { DROP_STEPS, DroneState, HOVER_MARGIN, PICK_STEPS, RESERVE, STEP_DIST, StopKind, TAKEOFF_STEPS } from '../constants.ts';
import { backDistance } from '../systems/stations.ts';
import type { Drone, Order, RouteStop, SimState } from '../types.ts';
import { dist } from '../world.ts';
import type { PoolRule, ZoneRule } from './types.ts';

// ---- 一条路线的表 ----
// 表是一个数的数组，分成若干段，每段 L + 1 项（L 是路线上的点数）。用普通数组而不是 Float64Array，因为表很小，Float64Array 的分配要在堆外开一块内存，一张表的分配时间是普通数组的十几倍。段的编号如下：
// 前六段的第 k 项是第 k 个点之前的量（k 从 0 到 L），最后一项（k 等于 L）是整条路线走完之后的量。
const X = 0; // 飞机的位置 x
const Y = 1; // 飞机的位置 y
const TIME = 2; // 时刻
const TRAVEL = 3; // 已飞的距离，锁定的点不计
const LOAD = 4; // 机上份量
const ABOARD = 5; // 机上订单数
// 后面各段只有前 L 项，第 k 项属于第 k 个点
const PX = 6; // 这个点的位置：取餐点是店，送达点是楼
const PY = 7;
const PICK = 8; // 取餐点为 1，送达点为 0
const UNITS = 9; // 这个点的订单的机上份量
const PREP = 10; // 这个点的订单出餐完成的步
const DONE = 11; // 送达点在原路线上的预计送达时刻
const LEG = 12; // 从上一个点飞到这个点的距离，第 locked 个点之后（不含）才有：它们的上一个点也是实际飞到过的
const NEXT_PICK = 13; // 第 k 个点及以后第一个取餐点的编号，没有时是 L（k 等于 L 时也是 L）
const SEGMENTS = 14;

/** 一条路线的预测，以及插入的计算用得到的、与新订单无关的量。时刻都用步，不要求是整数。 */
interface RouteTable {
  /** 路线完成的时刻 */
  finish: number;
  /** 路线上的点数 L */
  length: number;
  /** 路线开头已经锁定的点数 */
  locked: number;
  /** 沿原路线走，机上份量超过载量的第一个取餐点的编号，没有时等于 L。取点放在它之后的位置都不可行 */
  overloadAt: number;
  /** 路线上最后一个送达点的编号，没有时为 -1 */
  lastDrop: number;
  /** 从最后一个送达点回站的距离，用到时才算，没算时为 NaN */
  back: number;
  tab: number[];
}

/** 一架飞机在本轮派单试算里的样子：路线可能已经被本轮前面派出的订单改过。路线数组只替换，不修改。 */
export interface DraftDrone {
  drone: Drone;
  route: readonly RouteStop[];
  /** 这一趟从哪座站出发。只带这一项，供「协同策略」判断 */
  from: { station: number };
  /** 当前试算路线的表，路线改变时清掉 */
  forecast: RouteTable | null;
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

/**
 * 沿一条路线预测，同时记下插入的计算要用的量，做成表。不做任何检查。
 * 每一步的运算与沿新路线预测时的完全相同：锁定的点不动，其余的点先飞过去（距离除以每步飞行距离加到时刻上），
 * 取餐点要等出餐完成再加取餐的步数，送达点加送达的步数。
 */
function analyzeRoute(state: SimState, d: Drone, route: readonly RouteStop[], now: number): RouteTable {
  const { t0, locked } = routeStart(state, d, route, now);
  const { merchants, buildings } = state.world;
  const capacity = state.capacity;
  const L = route.length;
  const S = L + 1;
  const tab = new Array<number>(SEGMENTS * S).fill(0);
  let x = d.x;
  let y = d.y;
  let t = t0;
  let travel = 0;
  let load = d.load;
  let aboard = d.onboard.length;
  let overloadAt = L;
  let lastDrop = -1;
  for (let k = 0; k < L; k++) {
    tab[X * S + k] = x;
    tab[Y * S + k] = y;
    tab[TIME * S + k] = t;
    tab[TRAVEL * S + k] = travel;
    tab[LOAD * S + k] = load;
    tab[ABOARD * S + k] = aboard;
    const stop = route[k] as RouteStop;
    const order = state.orders[stop.order] as Order;
    const pickup = stop.kind === StopKind.Pickup;
    const place = pickup ? (merchants[order.merchant] as { x: number; y: number }) : (buildings[order.building] as { x: number; y: number });
    const units = unitsOf(state, order);
    tab[PX * S + k] = place.x;
    tab[PY * S + k] = place.y;
    tab[PICK * S + k] = pickup ? 1 : 0;
    tab[UNITS * S + k] = units;
    tab[PREP * S + k] = order.prepDone;
    if (k >= locked) {
      const leg = dist(x, y, place.x, place.y);
      if (k > locked) tab[LEG * S + k] = leg;
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
      load += units;
      aboard += 1;
      if (load > capacity && overloadAt === L) overloadAt = k;
    } else {
      load -= units;
      aboard -= 1;
      lastDrop = k;
      tab[DONE * S + k] = t;
    }
  }
  tab[X * S + L] = x;
  tab[Y * S + L] = y;
  tab[TIME * S + L] = t;
  tab[TRAVEL * S + L] = travel;
  tab[LOAD * S + L] = load;
  tab[ABOARD * S + L] = aboard;
  let nextPick = L;
  tab[NEXT_PICK * S + L] = L;
  for (let k = L - 1; k >= 0; k--) {
    if (tab[PICK * S + k] === 1) nextPick = k;
    tab[NEXT_PICK * S + k] = nextPick;
  }
  return { finish: t, length: L, locked, overloadAt, lastDrop, back: Number.NaN, tab };
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
  let hasPickup = false;
  for (let k = 0; k < route.length; k++) {
    if ((route[k] as RouteStop).kind === StopKind.Pickup) {
      hasPickup = true;
      break;
    }
  }
  if (!hasPickup) return true;
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

/** 一次 bestInsertion 里新订单的量，和到现在为止选中的位置。模块里只有这一份，bestInsertion 不会重入。 */
const scan = {
  mx: 0,
  my: 0,
  bx: 0,
  by: 0,
  units: 0,
  prepDone: 0,
  capacity: 0,
  pushLimit: 0,
  /** 选中的位置：drafts 里的下标（没有为 -1）、取点和送点各插在原路线的哪个点之前 */
  draft: -1,
  i: 0,
  j: 0,
  increase: Infinity,
  arrival: 0,
};

/**
 * 在一架飞机的试算路线里找增加量最小的可行插入，比 scan 里已有的更小才替换。
 * 取点插在第 i 个点之前，送点插在第 j 个点之前（i 不大于 j，j 等于 L 是放在最后），先按 i 再按 j 从小到大试，所以增加量相同时留下先试到的。
 */
function scanDraft(state: SimState, index: number, d: Drone, table: RouteTable): void {
  const { mx, my, bx, by, units, prepDone, capacity, pushLimit } = scan;
  const L = table.length;
  const S = L + 1;
  const tab = table.tab;
  const iEnd = table.overloadAt < L ? table.overloadAt : L;
  let backNew = Number.NaN; // 新订单的送达点回站的距离，用到时才算
  for (let i = table.locked; i <= iEnd; i++) {
    // 取点之前的部分与原路线相同。机上份量再加上新订单的份量不能超过载量
    const loadBefore = tab[LOAD * S + i];
    if (loadBefore + units > capacity) continue;
    // 同乘：取点之前机上已经有订单，或者取点和送点之间有别的取餐点
    const together = tab[ABOARD * S + i] > 0;
    const nextPick = tab[NEXT_PICK * S + i];
    if (!together && nextPick >= L) continue;
    let leg = dist(tab[X * S + i], tab[Y * S + i], mx, my);
    let travel = tab[TRAVEL * S + i] + leg;
    let t = tab[TIME * S + i] + leg / STEP_DIST;
    if (t < prepDone) t = prepDone;
    t += PICK_STEPS;
    let load = loadBefore + units;
    // 取点和送点之间走过原路线的第 i 到 j - 1 个点：travel、t、load 是走完这些点之后的量，(px, py) 是飞机的位置
    let px = mx;
    let py = my;
    for (let j = i; ; j++) {
      if (together || nextPick < j) {
        // 送点插在第 j 个点之前，再沿原路线剩下的点（第 j 到 L - 1 个）走完
        let dl = dist(px, py, bx, by);
        let dTravel = travel + dl;
        let dTime = t + dl / STEP_DIST;
        dTime += DROP_STEPS;
        const arrival = dTime;
        let dLoad = load - units;
        let feasible = true;
        for (let s = j; s < L; s++) {
          dl = s === j ? dist(bx, by, tab[PX * S + s], tab[PY * S + s]) : tab[LEG * S + s];
          dTravel += dl;
          dTime += dl / STEP_DIST;
          if (tab[PICK * S + s] === 1) {
            const prep = tab[PREP * S + s];
            if (dTime < prep) dTime = prep;
            dTime += PICK_STEPS;
            dLoad += tab[UNITS * S + s];
            if (dLoad > capacity) {
              feasible = false;
              break;
            }
          } else {
            dTime += DROP_STEPS;
            dLoad -= tab[UNITS * S + s];
            if (dTime - tab[DONE * S + s] > pushLimit) {
              feasible = false;
              break;
            }
          }
        }
        if (feasible) {
          // 电量：新路线的总距离，加上最后一个送达点回站的距离（回归属站，买了就近降落之后是最近的站）、悬停余量和保留电量
          let back: number;
          if (table.lastDrop >= j) {
            if (Number.isNaN(table.back)) table.back = backDistance(state, d, tab[PX * S + table.lastDrop], tab[PY * S + table.lastDrop]);
            back = table.back;
          } else {
            if (Number.isNaN(backNew)) backNew = backDistance(state, d, bx, by);
            back = backNew;
          }
          if (!(dTravel + back + HOVER_MARGIN + RESERVE > d.battery)) {
            const increase = dTime - table.finish;
            if (scan.draft < 0 || increase < scan.increase) {
              scan.draft = index;
              scan.i = i;
              scan.j = j;
              scan.increase = increase;
              scan.arrival = arrival;
            }
          }
        }
      }
      if (j === L) break;
      // 把原路线的第 j 个点放进取点和送点之间：载量超了或让已有订单推迟过多，更靠后的送点位置也不可行
      leg = j === i ? dist(mx, my, tab[PX * S + j], tab[PY * S + j]) : tab[LEG * S + j];
      travel += leg;
      t += leg / STEP_DIST;
      if (tab[PICK * S + j] === 1) {
        const prep = tab[PREP * S + j];
        if (t < prep) t = prep;
        t += PICK_STEPS;
        load += tab[UNITS * S + j];
        if (load > capacity) break;
      } else {
        t += DROP_STEPS;
        load -= tab[UNITS * S + j];
        if (t - tab[DONE * S + j] > pushLimit) break;
      }
      px = tab[PX * S + j];
      py = tab[PY * S + j];
    }
  }
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
  const shop = state.world.merchants[order.merchant] as { x: number; y: number };
  const home = state.world.buildings[order.building] as { x: number; y: number };
  scan.mx = shop.x;
  scan.my = shop.y;
  scan.bx = home.x;
  scan.by = home.y;
  scan.units = unitsOf(state, order);
  scan.prepDone = order.prepDone;
  scan.capacity = state.capacity;
  scan.pushLimit = pool.pushLimit;
  scan.draft = -1;
  scan.increase = Infinity;
  for (let n = 0; n < drafts.length; n++) {
    const draft = drafts[n] as DraftDrone;
    if (draft.route.length === 0 || blocked(state, draft, order, now, pool, zone)) continue;
    const table = draft.forecast ?? (draft.forecast = analyzeRoute(state, draft.drone, draft.route, now));
    scanDraft(state, n, draft.drone, table);
  }
  if (scan.draft < 0) return null;
  const draft = drafts[scan.draft] as DraftDrone;
  const route = draft.route;
  const pickup: RouteStop = { kind: StopKind.Pickup, order: order.id };
  const drop: RouteStop = { kind: StopKind.Drop, order: order.id };
  const next = [...route.slice(0, scan.i), pickup, ...route.slice(scan.i, scan.j), drop, ...route.slice(scan.j)];
  return { droneId: draft.drone.id, route: next, arrival: scan.arrival, increase: scan.increase };
}

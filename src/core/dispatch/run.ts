// 一轮派单：先选订单，再按站点分工挑飞机，载量不小于 2 且这一趟允许一起送时，还要试着把订单插进别的飞机的路线。
// 流程：只在停机位上的可用飞机里找 → 按「协同策略」和电量检查筛出每张订单能用的飞机
// → 按「调度策略」排序 → 依次给每张订单挑从它所在的站飞到店最快的一架，或者插进另一架飞机的路线。
// 「提前派出」的统计要一份比较名单：同一批飞机、同样的条件，按下单顺序排一遍会派出哪些订单。
// 实际派单和比较名单都由 planRound 在一份试算上算出一串动作，选飞机和插入的办法是同一段代码。
// 实际派单再执行这串动作，名单只取动作里的订单编号。
// 只读结果的副本（推演、小结的对照、效果记录里不购买的副本）用轻量派单，不算比较名单，见 dispatchRound 的 light 参数。
import { HOVER_MARGIN, RESERVE, SPEED } from '../constants.ts';
import { assignToDockedDrone, insertIntoRoute, isAvailable } from '../systems/drones.ts';
import { backDistance } from '../systems/stations.ts';
import type { Building, Drone, Merchant, Order, RouteStop, SimState } from '../types.ts';
import { dist } from '../world.ts';
import { recordEarlyDispatches } from './early.ts';
import { bestInsertion, draftAssign, draftInsert, makeDrafts, predictIdle } from './insert.ts';
import type { DraftDrone } from './insert.ts';
import { getPoolRule, getSelectRule, getZoneRule } from './registry.ts';
import { fifoRule } from './select.ts';
import type { DispatchContext, SelectRule } from './types.ts';

/** 一轮派单开始时的候选情况：哪些飞机可用，每张待派订单有哪些飞机能接。 */
export interface Round {
  ctx: DispatchContext;
  free: Drone[]; // 停在停机位上的可用飞机
  orders: Order[]; // 与 ctx.pendingIds 一一对应
  fly: Float64Array; // [飞机 × 订单] 飞机到店的距离
  ok: Uint8Array; // [飞机 × 订单] 这架飞机能接这张单：电量够，并且「协同策略」允许
  eligible: number[]; // 至少有一架可用飞机能接的订单编号
  available: number; // 至少能接一张订单的飞机数
}

/**
 * 本轮可以派的订单编号，按下单顺序。经营模式的开局阶段自动派单是关着的，只派玩家点击过的订单。
 * 沙盒模式和开局结束之后，全部待派订单都可以派。
 */
export function dispatchable(state: SimState): number[] {
  const { campaign } = state;
  if (campaign !== null && !campaign.opening.done) {
    return state.pending.filter((id) => (state.orders[id] as Order).manualAt >= 0);
  }
  return state.pending.slice();
}

/** 整理本轮的候选情况。不修改状态。 */
export function buildRound(state: SimState): Round {
  const now = state.step;
  const zone = getZoneRule(state.rules.zone);
  const free = state.drones.filter(isAvailable);
  const pend = dispatchable(state);
  const nf = free.length;
  const nw = pend.length;
  const orders = pend.map((id) => state.orders[id] as Order);
  const fly = new Float64Array(nf * nw);
  const ret = new Float64Array(nf * nw); // 楼回飞机归属站的距离
  const ok = new Uint8Array(nf * nw);
  const flyTime: number[] = new Array<number>(nw).fill(Infinity);
  const eligible: number[] = [];
  const useful = new Uint8Array(nf);

  for (let k = 0; k < nw; k++) {
    const order = orders[k] as Order;
    const m = state.world.merchants[order.merchant] as Merchant;
    const b = state.world.buildings[order.building] as Building;
    const tail = order.dMB + HOVER_MARGIN + RESERVE; // 店到楼、悬停余量、保留电量
    let any = false;
    for (let i = 0; i < nf; i++) {
      const d = free[i] as Drone;
      const toShop = dist(d.x, d.y, m.x, m.y);
      const toHome = backDistance(state, d, b.x, b.y);
      fly[i * nw + k] = toShop;
      ret[i * nw + k] = toHome;
      // 电量检查：送完这一趟还能飞回自己的站
      if (toShop + tail + toHome <= d.battery && zone.allows(state, now, d, order)) {
        ok[i * nw + k] = 1;
        useful[i] = 1;
        any = true;
        const t = toShop / SPEED;
        if (t < (flyTime[k] as number)) flyTime[k] = t;
      }
    }
    if (any) eligible.push(order.id);
  }
  let available = 0;
  for (let i = 0; i < nf; i++) available += useful[i] as number;

  let trip: number[] | null = null;
  const ctx: DispatchContext = {
    state,
    now,
    pendingIds: pend,
    flyTime,
    tripTime() {
      if (trip) return trip;
      const result = new Array<number>(nw).fill(Infinity);
      for (let k = 0; k < nw; k++) {
        const order = orders[k] as Order;
        for (let i = 0; i < nf; i++) {
          if (!ok[i * nw + k]) continue;
          const t = (fly[i * nw + k] as number) / SPEED + (order.dMB + (ret[i * nw + k] as number)) / SPEED;
          if (t < (result[k] as number)) result[k] = t;
        }
      }
      trip = result;
      return result;
    },
  };
  return { ctx, free, orders, fly, ok, eligible, available };
}

/** 方案里的一项：订单 k（round.orders 的下标）交给可用飞机 drone（round.free 的下标）。 */
export interface Assignment {
  k: number;
  drone: number;
}

/** 方案里的一项：订单 k 插进已有任务的飞机 droneId（飞机编号），飞机的路线改成 route。 */
export interface Insertion {
  k: number;
  droneId: number;
  route: RouteStop[];
}

export type PlanItem = Assignment | Insertion;

/** 这一栏的卡允许一起送，并且载量够两份：订单才有可能插进别的飞机的路线。载量为 1 时一起送插不进任何订单。 */
export function canPool(state: SimState): boolean {
  return getPoolRule(state.rules.pool).usesBusyDrones && state.capacity >= 2;
}

/**
 * 按给定的排序算出这一轮的派单方案：一串动作，按排序的先后列出。不修改状态。
 * 对排序里的每张订单，依次：
 * - 取排序里靠前、有飞机能接的订单，最多「有单可接的飞机数」张。给它在允许的、还没被占用的可用飞机里选从它所在的站飞到店最快的一架，
 *   用时相同取编号小的。被排在前面的订单占走了能接它的全部飞机时，这张订单没有候选的空闲飞机。
 * - 允许一起送且载量不小于 2 时，对每张订单（不管有没有候选的空闲飞机）找最便宜的插入。有候选的空闲飞机时，
 *   插入的预计送达时刻比交给它更早才采纳，没有时只要可行就采纳。采纳了插入，候选的空闲飞机留给后面的订单。
 * - 都没有采纳时，有候选的空闲飞机就交给它。
 * 插入和后面订单的选择都在试算上进行：前面订单交给空闲飞机或插入之后，路线的变化后面的订单看得到，
 * 与逐张订单在真实状态上执行的结果相同。
 * 实际派单和「提前派出」的比较名单都由这个函数算出，所以选飞机和插入的办法、条件完全相同。
 */
export function planRound(round: Round, sequence: readonly number[]): PlanItem[] {
  const { ctx, free, orders, fly, ok, available } = round;
  const { state, now } = ctx;
  const nf = free.length;
  const nw = orders.length;
  const pooling = canPool(state);
  const pool = getPoolRule(state.rules.pool);
  const zone = getZoneRule(state.rules.zone);
  const drafts = pooling ? makeDrafts(state) : [];

  const selected = new Uint8Array(nw);
  let picked = 0;
  for (const k of sequence) {
    if (picked >= available) break;
    if (ctx.flyTime[k] !== Infinity) {
      selected[k] = 1;
      picked++;
    }
  }

  const used = new Uint8Array(nf);
  const plan: PlanItem[] = [];
  for (const k of sequence) {
    if (!pooling && !selected[k]) continue;
    const order = orders[k] as Order;
    let best = -1;
    if (selected[k]) {
      let bestTime = Infinity;
      for (let i = 0; i < nf; i++) {
        if (!ok[i * nw + k] || used[i]) continue;
        const t = (fly[i * nw + k] as number) / SPEED;
        if (t < bestTime) {
          bestTime = t;
          best = i;
        }
      }
    }
    if (pooling) {
      const bound = best >= 0 ? predictIdle(state, free[best] as Drone, order, now) : Infinity;
      const choice = bestInsertion(state, drafts, order, now, pool, zone);
      if (choice !== null && choice.arrival < bound) {
        plan.push({ k, droneId: choice.droneId, route: choice.route });
        draftInsert(drafts[choice.droneId] as DraftDrone, choice.route);
        continue;
      }
    }
    if (best >= 0) {
      used[best] = 1;
      plan.push({ k, drone: best });
      if (pooling) draftAssign(drafts[(free[best] as Drone).id] as DraftDrone, order);
    }
  }
  return plan;
}

/** 玩家点击插队的订单排在最前（先点的先送），其余订单保持 rest 里的先后。rest 是全部订单下标的一个排序。 */
function manualFirst(orders: readonly Order[], rest: readonly number[]): number[] {
  const manual = rest.filter((k) => (orders[k] as Order).manualAt >= 0);
  manual.sort((p, q) => (orders[p] as Order).manualAt - (orders[q] as Order).manualAt || p - q);
  return [...manual, ...rest.filter((k) => (orders[k] as Order).manualAt < 0)];
}

/**
 * 本轮的派单先后：玩家点击插队的订单在最前（先点的先送），其余按这一栏选中的「调度策略」。
 * 返回 round.orders 的下标。实际派单和只读的派单预览（ranking.ts）都从这里取，所以两边的先后一致。
 */
export function roundSequence(round: Round, select: SelectRule): number[] {
  const ranked = select.rank(round.ctx);
  if (ranked.length !== round.orders.length) throw new Error('a select rule must rank every pending order');
  return manualFirst(round.orders, ranked);
}

function sameSequence(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((k, j) => k === b[j]);
}

export interface DispatchResult {
  /** 本轮派出（含插入）的订单编号，按派出顺序 */
  dispatched: number[];
  /** 本轮新记为提前派出的订单 */
  early: number[];
}

/**
 * 一轮派单。每 5 步调用一次。
 * light 为真时是轻量派单，只给不进存档、也不看「提前派出」统计的副本用（见 step.ts 的 stepLight）：
 * 不算按下单顺序的比较名单，不记「提前派出」，order.early 和 stats.early 不变，返回的 early 为空。
 * 其余步骤与不轻量时完全相同：排序、方案、哪张订单交给哪架飞机、插进哪条路线都一样。
 * planRound 和 fifoRule.rank 都不修改状态，所以跳过它们不影响状态的其他部分。
 */
export function dispatchRound(state: SimState, light = false): DispatchResult {
  const select = getSelectRule(state.rules.select);
  const result: DispatchResult = { dispatched: [], early: [] };
  if (state.pending.length === 0) return result;
  if (state.campaign !== null && dispatchable(state).length === 0) return result;
  if (!canPool(state) && !state.drones.some(isAvailable)) return result;

  const round = buildRound(state);
  const { ctx, free, orders } = round;

  // 排序：玩家点击插队的订单在最前（先点的先送），其余按「调度策略」
  const sequence = roundSequence(round, select);
  const plan = planRound(round, sequence);

  // 比较名单：用同一批飞机、同样的条件（站点分工、电量、一起送的限制）和同样的选飞机办法，
  // 把订单按下单顺序再排一遍（插队的订单仍在最前），算出这一轮会派出哪些订单。
  // 实际的排序与下单顺序相同时，直接用实际的方案。轻量派单不算
  let roster: number[] | null = null;
  if (!light) {
    const placed = manualFirst(orders, fifoRule.rank(ctx));
    const placedPlan = sameSequence(sequence, placed) ? plan : planRound(round, placed);
    roster = placedPlan.map((a) => ctx.pendingIds[a.k] as number);
  }

  // 按方案派单：交给空闲飞机，或者插进已有任务的飞机的路线
  for (const item of plan) {
    const order = state.orders[ctx.pendingIds[item.k] as number] as Order;
    if ('route' in item) insertIntoRoute(state, state.drones[item.droneId] as Drone, order, item.route);
    else assignToDockedDrone(state, free[item.drone] as Drone, order);
    result.dispatched.push(order.id);
  }

  if (roster !== null) result.early = recordEarlyDispatches(state, roster, result.dispatched);
  return result;
}

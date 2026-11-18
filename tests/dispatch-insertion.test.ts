// 合单插入的算法：bestInsertion 与逐个位置生成新路线、沿路线预测的参照实现，选中的飞机、路线、预计送达时刻和增加量逐位相同。
// 参照实现是 insert.ts 重写之前的做法（提交 9fefd06，下面的 referenceInsertion 及其辅助函数照抄那一版）：
// 对每架飞机的每一对取点和送点位置生成整条新路线，检查同乘，沿路线预测并检查载量、已有订单的推迟和电量，增加量最小的留下，相同时留先试到的。
// 对照沿真实的运行取状态：每一轮派单按真实的排序逐张订单调用两种实现，两边的选择相同时按 planRound 的规则采纳，试算随之演变，
// 所以连续插入之后路线变长、试算被改过的情形也在其中。最后整轮的方案与真实的 planRound 逐项相同。
import { describe, expect, it } from 'vitest';
import { DROP_STEPS, DroneState, HOVER_MARGIN, PICK_STEPS, RESERVE, SPEED, STEP_DIST, StopKind, TAKEOFF_STEPS, createState, dayOf, step } from '../src/core/index.ts';
import type { ConfigOverrides, Drone, Order, RouteStop, SimState } from '../src/core/index.ts';
import { buildRound, canPool, planRound, roundSequence } from '../src/core/dispatch/run.ts';
import type { PlanItem, Round } from '../src/core/dispatch/run.ts';
import { bestInsertion, draftAssign, draftInsert, makeDrafts, predictIdle, ridesWithOthers } from '../src/core/dispatch/insert.ts';
import type { DraftDrone, InsertionChoice } from '../src/core/dispatch/insert.ts';
import { getPoolRule, getSelectRule, getZoneRule } from '../src/core/dispatch/registry.ts';
import type { PoolRule, ZoneRule } from '../src/core/dispatch/types.ts';
import { backDistance } from '../src/core/systems/stations.ts';
import { dist } from '../src/core/world.ts';
import { playGame } from '../tools/autoplay-lib.ts';
import { CITY } from './helpers.ts';

// ---- 参照实现：重写之前的 insert.ts ----

interface RefForecast {
  finish: number;
  orders: number[];
  times: number[];
}

function unitsOf(state: SimState, order: Order): number {
  return Math.min(order.portion, state.capacity);
}

function routeStart(state: SimState, d: Drone, route: readonly RouteStop[], now: number): { t0: number; locked: number } {
  switch (d.state) {
    case DroneState.Dock:
    case DroneState.TakeoffQueue:
      return { t0: now + TAKEOFF_STEPS, locked: 0 };
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

function forecastRoute(state: SimState, d: Drone, route: readonly RouteStop[], t0: number, locked: number): RefForecast {
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

function checkRoute(
  state: SimState,
  d: Drone,
  route: readonly RouteStop[],
  t0: number,
  locked: number,
  base: RefForecast,
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
  const end = state.world.buildings[(lastDrop as Order).building] as { x: number; y: number };
  if (travel + backDistance(state, d, end.x, end.y) + HOVER_MARGIN + RESERVE > d.battery) return null;
  return { finish: t, arrival };
}

function referenceBlocked(state: SimState, draft: DraftDrone, order: Order, now: number, pool: PoolRule, zone: ZoneRule): boolean {
  const route = draft.route;
  if (!route.some((stop) => stop.kind === StopKind.Pickup)) return true;
  if (!pool.accepts(state, route, order)) return true;
  return !zone.allows(state, now, draft.from, order);
}

/** 重写之前的 bestInsertion，没有缓存预测，每次重算。 */
function referenceInsertion(state: SimState, drafts: readonly DraftDrone[], order: Order, now: number, pool: PoolRule, zone: ZoneRule): InsertionChoice | null {
  const pickup: RouteStop = { kind: StopKind.Pickup, order: order.id };
  const drop: RouteStop = { kind: StopKind.Drop, order: order.id };
  let best: InsertionChoice | null = null;
  let bestIncrease = Infinity;
  for (const draft of drafts) {
    const route = draft.route;
    if (route.length === 0 || referenceBlocked(state, draft, order, now, pool, zone)) continue;
    const d = draft.drone;
    const { t0, locked } = routeStart(state, d, route, now);
    const base = forecastRoute(state, d, route, t0, locked);
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

// ---- 对照 ----

/** 两个选择逐位相同：数用 Object.is 比较，路线逐点比较种类和订单。不同时抛出带说明的错误。 */
function assertSame(a: InsertionChoice | null, b: InsertionChoice | null, where: string): void {
  if (a === null || b === null) {
    if (a !== b) throw new Error(`${where}：一边没有可行的插入，另一边有：${JSON.stringify(a)} 对 ${JSON.stringify(b)}`);
    return;
  }
  const sameRoute = a.route.length === b.route.length && a.route.every((stop, k) => stop.kind === (b.route[k] as RouteStop).kind && stop.order === (b.route[k] as RouteStop).order);
  if (a.droneId !== b.droneId || !sameRoute || !Object.is(a.arrival, b.arrival) || !Object.is(a.increase, b.increase)) {
    throw new Error(`${where}：选择不同：${JSON.stringify(a)} 对 ${JSON.stringify(b)}`);
  }
}

interface Tally {
  rounds: number;
  calls: number;
  found: number;
  adopted: number;
  longest: number;
}

/**
 * 与 run.ts 的 planRound 做同样的事，但每张订单的插入同时用两种实现算，在两套各自演变的试算上逐位对照。
 * 返回方案，调用方再与真实的 planRound 逐项比较。
 */
function planWithBoth(round: Round, sequence: readonly number[], tally: Tally): PlanItem[] {
  const { ctx, free, orders, fly, ok, available } = round;
  const { state, now } = ctx;
  const nf = free.length;
  const nw = orders.length;
  const pooling = canPool(state);
  const pool = getPoolRule(state.rules.pool);
  const zone = getZoneRule(state.rules.zone);
  const drafts = pooling ? makeDrafts(state) : [];
  const refDrafts = pooling ? makeDrafts(state) : [];
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
      const expected = referenceInsertion(state, refDrafts, order, now, pool, zone);
      assertSame(choice, expected, `第 ${state.step} 步，订单 ${order.id}`);
      tally.calls += 1;
      if (choice !== null && expected !== null) {
        tally.found += 1;
        tally.longest = Math.max(tally.longest, choice.route.length);
        if (choice.arrival < bound) {
          tally.adopted += 1;
          plan.push({ k, droneId: choice.droneId, route: choice.route });
          draftInsert(drafts[choice.droneId] as DraftDrone, choice.route);
          draftInsert(refDrafts[expected.droneId] as DraftDrone, expected.route);
          continue;
        }
      }
    }
    if (best >= 0) {
      used[best] = 1;
      plan.push({ k, drone: best });
      if (pooling) {
        draftAssign(drafts[(free[best] as Drone).id] as DraftDrone, order);
        draftAssign(refDrafts[(free[best] as Drone).id] as DraftDrone, order);
      }
    }
  }
  return plan;
}

/** 这一刻做一轮派单：用两种实现逐张订单对照，整轮的方案与真实的 planRound 相同。状态不被修改。 */
function checkRound(state: SimState, tally: Tally): void {
  if (state.pending.length === 0) return;
  const round = buildRound(state);
  if (round.orders.length === 0) return;
  const sequence = roundSequence(round, getSelectRule(state.rules.select));
  const both = planWithBoth(round, sequence, tally);
  const real = planRound(round, sequence);
  expect(real, `第 ${state.step} 步的方案`).toEqual(both);
  tally.rounds += 1;
}

function emptyTally(): Tally {
  return { rounds: 0, calls: 0, found: 0, adopted: 0, longest: 0 };
}

/** 沙盒：载量、合单策略、协同策略、调度策略、回站规则各取几种，每个配置跑一个游戏日，每一轮派单前对照。 */
const SANDBOX: ConfigOverrides[] = [
  { ...CITY, capacity: 2, rules: { select: 'deadline', zone: 'global', pool: 'any' } },
  { ...CITY, capacity: 2, rules: { select: 'fifo', zone: 'global', pool: 'same' } },
  { ...CITY, capacity: 3, drones: 8, peakRate: 90, rules: { select: 'roundtrip', zone: 'global', pool: 'any' } },
  { ...CITY, capacity: 4, drones: 6, peakRate: 90, rules: { select: 'deadline', zone: 'hybrid', pool: 'any' } },
  { ...CITY, capacity: 3, drones: 10, peakRate: 68, rules: { select: 'prioOffice', zone: 'strict', pool: 'any' } },
  { ...CITY, capacity: 2, drones: 12, peakRate: 68, returnRule: 'nearest', rules: { select: 'deadline', zone: 'global', pool: 'any' } },
  { ...CITY, capacity: 3, drones: 6, peakRate: 90, returnRule: 'nearest', rules: { select: 'prioCampus', zone: 'hybrid', pool: 'same' } },
  { scenario: 'sparseOffice', layout: 'three', drones: 9, peakRate: 60, capacity: 3, rules: { select: 'deadline', zone: 'global', pool: 'any' } },
  { scenario: 'oldStreet', drones: 3, peakRate: 40, capacity: 2, rules: { select: 'roundtrip', zone: 'global', pool: 'any' } },
  { ...CITY, capacity: 1, rules: { select: 'deadline', zone: 'global', pool: 'any' } },
];

describe('bestInsertion 与逐个位置枚举的参照实现', () => {
  it.each(SANDBOX.map((config, i) => ({ config, i })))('沙盒配置 $i：一个游戏日里每一轮派单，逐张订单的选择、整轮的方案都与参照实现逐位相同', ({ config }) => {
    const state = createState(config);
    const tally = emptyTally();
    for (let s = 0; s < 3600; s++) {
      if (state.step % 5 === 0) checkRound(state, tally);
      step(state);
    }
    expect(tally.rounds).toBeGreaterThan(100);
    // 配置里没有一起送的（载量 1）不调用 bestInsertion
    if (canPool(state)) expect(tally.calls).toBeGreaterThan(0);
  }, 120_000);

  it('沙盒：载量大、飞机少、订单多的配置里，插入确实被采纳，路线长到四个点以上', () => {
    const state = createState(SANDBOX[3] as ConfigOverrides);
    const tally = emptyTally();
    for (let s = 0; s < 3600; s++) {
      if (state.step % 5 === 0) checkRound(state, tally);
      step(state);
    }
    expect(tally.found).toBeGreaterThan(20);
    expect(tally.adopted).toBeGreaterThan(5);
    expect(tally.longest).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it('经营模式：均衡玩法的自动玩家，游戏日编号（dayOf）8 到 11 和 20 以后的每一轮派单都与参照实现逐位相同', () => {
    const tally = emptyTally();
    playGame('balanced', 42, {
      days: 22,
      onStep: (state) => {
        const day = dayOf(state.step);
        if (state.step % 5 === 0 && ((day >= 8 && day < 12) || day >= 20)) checkRound(state, tally);
      },
    });
    expect(tally.rounds).toBeGreaterThan(2000);
    expect(tally.found).toBeGreaterThan(200);
    expect(tally.longest).toBeGreaterThanOrEqual(4);
  }, 600_000);

  it('经营模式：均衡玩法的另一个种子，游戏日编号 6 以后的每一轮派单都与参照实现逐位相同', () => {
    const tally = emptyTally();
    playGame('balanced', 45, {
      days: 12,
      onStep: (state) => {
        const day = dayOf(state.step);
        if (state.step % 5 === 0 && day >= 6) checkRound(state, tally);
      },
    });
    expect(tally.rounds).toBeGreaterThan(1000);
    expect(tally.found).toBeGreaterThan(20);
  }, 600_000);
});

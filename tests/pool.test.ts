// 一趟送几单的卡：同一家店的一起送、顺路的一起送。插入的每一条限制各有一个手工摆出的局面。
// 地图是手工摆的：店和楼都在一条横线附近，站在原点，飞机一步飞 11，取餐、送达各 12 步，起飞 8 步。
import { describe, expect, it } from 'vitest';
import {
  DroneState,
  OrderStatus,
  StopKind,
  addOrder,
  advance,
  buildRound,
  createState,
  dispatchRound,
  hashState,
  runDays,
} from '../src/core/index.ts';
import type { ConfigOverrides, Drone, Order, SimState } from '../src/core/index.ts';
import { canPool, planRound } from '../src/core/dispatch/run.ts';
import { bestInsertion, makeDrafts, ridesWithOthers } from '../src/core/dispatch/insert.ts';
import { getPoolRule, getSelectRule, getZoneRule } from '../src/core/dispatch/registry.ts';
import { cancelOrder } from '../src/core/systems/expiry.ts';
import { dist } from '../src/core/world.ts';
import { customWorld, placeStations } from './helpers.ts';

// 店：M0 和 M1 相距 110，M2 在 B0 附近
const M0 = [1100, 0] as [number, number];
const M1 = [1100, 110] as [number, number];
const M2 = [2200, 110] as [number, number];
// 楼：B0 在 M0 正东 1100，B1 在 M0 正北 1100，B2 在 B0 以北 110，B3 在 B2 以北 110
const B0 = [2200, 0] as [number, number];
const B1 = [1100, 1100] as [number, number];
const B2 = [2200, 110] as [number, number];
const B3 = [2200, 220] as [number, number];
const MERCHANT = { m0: 0, m1: 1, m2: 2 };
const BUILDING = { b0: 0, b1: 1, b2: 2, b3: 3 };

/** 一座站在原点、一架飞机（默认）、载量 2、顺路的一起送、先下单的先送、哪座站都能送。 */
function lineScene(overrides: ConfigOverrides = {}): { state: SimState; drone: Drone } {
  const state = createState(
    { scenario: 'oldStreet', drones: 1, capacity: 2, peakRate: 0, gateInterval: 0.8, rules: { pool: 'any' }, ...overrides },
    customWorld('oldStreet', [M0, M1, M2], [B0, B1, B2, B3]),
  );
  placeStations(state, [[0, 0]]);
  return { state, drone: state.drones[0] as Drone };
}

function send(state: SimState, merchant: number, building: number, prepSteps: number, portion = 1): Order {
  return addOrder(state, { merchant, building, portion, prepSteps });
}

function advanceUntil(state: SimState, done: () => boolean, limit = 4000): void {
  for (let i = 0; i < limit && !done(); i++) advance(state, 1);
  expect(done()).toBe(true);
}

/** 订单 a 派给唯一的飞机，飞机飞往 M0 的途中（已经起飞，还没有到店）。 */
function flyingToM0(overrides: ConfigOverrides = {}, aPortion = 1): { state: SimState; drone: Drone; a: Order } {
  const { state, drone } = lineScene(overrides);
  const a = send(state, MERCHANT.m0, BUILDING.b0, 10, aPortion);
  expect(dispatchRound(state).dispatched).toEqual([a.id]);
  advanceUntil(state, () => drone.state === DroneState.Fly);
  expect(drone.x).toBeLessThan(M0[0] - 100);
  return { state, drone, a };
}

const stops = (d: Drone): string[] => d.route.map((s) => `${s.kind === StopKind.Pickup ? 'P' : 'D'}${s.order}`);

describe('插入：基本做法', () => {
  it('订单插进正在飞往取餐点的飞机的路线：记为已派出，出发站和飞机沿用原来的，之后两张订单同乘送达', () => {
    const { state, drone, a } = flyingToM0();
    const b = send(state, MERCHANT.m1, BUILDING.b2, 10);
    const result = dispatchRound(state);
    expect(result.dispatched).toEqual([b.id]);
    expect(b.status).toBe(OrderStatus.Assigned);
    expect([b.drone, b.departed, b.units, b.tAssign]).toEqual([0, 0, 1, state.step]);
    expect(state.pending).toEqual([]);
    expect(drone.route.length).toBe(4);
    expect(new Set(stops(drone))).toEqual(new Set([`P${a.id}`, `D${a.id}`, `P${b.id}`, `D${b.id}`]));
    // 两张订单的取点都在送点之前
    for (const o of [a, b]) expect(stops(drone).indexOf(`P${o.id}`)).toBeLessThan(stops(drone).indexOf(`D${o.id}`));
    advanceUntil(state, () => a.status === OrderStatus.Delivered && b.status === OrderStatus.Delivered);
    expect([a.shared, b.shared]).toEqual([true, true]);
    expect(drone.load).toBe(0);
  });

  it('只有一架飞机且在送单时，没有空闲飞机的轮次也要走派单流程', () => {
    const { state } = flyingToM0();
    expect(state.drones.some((d) => d.state === DroneState.Dock && d.route.length === 0)).toBe(false);
    const b = send(state, MERCHANT.m1, BUILDING.b2, 10);
    expect(dispatchRound(state).dispatched).toEqual([b.id]);
  });

  it('算方案不修改状态：方案里是插入的动作和新路线，执行之后与方案一致', () => {
    const { state, drone } = flyingToM0();
    const b = send(state, MERCHANT.m1, BUILDING.b2, 10);
    const round = buildRound(state);
    const before = hashState(state);
    const plan = planRound(round, [0]);
    expect(hashState(state)).toBe(before);
    expect(plan.length).toBe(1);
    const item = plan[0] as { k: number; droneId: number; route: { kind: number; order: number }[] };
    expect([item.k, item.droneId, item.route.length]).toEqual([0, 0, 4]);
    dispatchRound(state);
    expect(drone.route).toEqual(item.route);
    expect(b.status).toBe(OrderStatus.Assigned);
  });

  it('飞机正在飞往路线上的第一个点时，插入之后立刻朝新的第一个点转向', () => {
    // 飞机从原点飞往 M0。B 的店也在 M0，出餐比 A 早：先取 B 的餐，路线以 B 的取点开头。目标仍是 M0，位置相同，所以只检查路线
    const { state, drone, a } = flyingToM0();
    const arrive = state.step + dist(drone.x, drone.y, M0[0], M0[1]) / 11;
    // A 的餐很晚才好，B 的餐早就好了
    a.prepDone = Math.ceil(arrive) + 100;
    const b = send(state, MERCHANT.m0, BUILDING.b2, 0);
    dispatchRound(state);
    expect(stops(drone)[0]).toBe(`P${b.id}`);
    expect([drone.tx, drone.ty]).toEqual(M0);
  });
});

describe('插入：只接受同乘', () => {
  const route = (...text: string[]): { kind: number; order: number }[] =>
    text.map((t) => ({ kind: t[0] === 'P' ? StopKind.Pickup : StopKind.Drop, order: Number(t.slice(1)) }));

  it.each([
    ['新订单单独送完再送原有订单', [], route('P9', 'D9', 'P1', 'D1'), false],
    ['新订单排在原有订单送完之后，顺序追加', [], route('P1', 'D1', 'P9', 'D9'), false],
    ['新订单上机时原有订单已经在机上', [], route('P1', 'P9', 'D9', 'D1'), true],
    ['新订单先上机，原有订单随后上机', [], route('P9', 'P1', 'D1', 'D9'), true],
    ['原有订单已经取走在机上，新订单上机', [1], route('P9', 'D1', 'D9'), true],
    ['原有订单已经取走在机上，新订单在它送完之后才取', [1], route('D1', 'P9', 'D9'), false],
    ['原有订单在机上，新订单取完立刻送到，期间仍与原有订单同乘', [1], route('P9', 'D9', 'D1'), true],
  ] as const)('%s：同乘 = %s', (_name, onboard, newRoute, expected) => {
    expect(ridesWithOthers({ onboard: [...onboard] }, newRoute, 9)).toBe(expected);
  });

  it('原有订单是大单、占满载量：新订单不能同乘，只能排在它送完之后。这样的顺序追加不接受', () => {
    // B 的店在 A 的送点附近：排在 A 送完之后，推迟 0 步、电量也够，除了不是同乘以外没有别的问题
    const { state, drone, a } = flyingToM0({}, 2);
    expect(a.units).toBe(2);
    expect(drone.route.length).toBe(2);
    const b = send(state, MERCHANT.m2, BUILDING.b3, 10);
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(b.status).toBe(OrderStatus.Pending);
    expect(drone.route.length).toBe(2);
  });

  it('同一轮里先派出的订单，后面的订单可以插进它的路线', () => {
    const { state, drone } = lineScene();
    const a = send(state, MERCHANT.m0, BUILDING.b0, 10);
    const b = send(state, MERCHANT.m1, BUILDING.b2, 10);
    expect(dispatchRound(state).dispatched).toEqual([a.id, b.id]);
    expect([a.drone, b.drone, a.tAssign === b.tAssign, b.departed]).toEqual([0, 0, true, 0]);
    expect(drone.route.length).toBe(4);
    expect(drone.state).toBe(DroneState.TakeoffQueue);
    // 一趟送一单：后面的订单只能等
    const single = lineScene({ rules: { pool: 'single' } });
    const a1 = send(single.state, MERCHANT.m0, BUILDING.b0, 10);
    const b1 = send(single.state, MERCHANT.m1, BUILDING.b2, 10);
    expect(dispatchRound(single.state).dispatched).toEqual([a1.id]);
    expect(b1.status).toBe(OrderStatus.Pending);
  });
});

describe('插入：路线里已经没有取餐点就不再接受', () => {
  it('取走原有订单之后，它的路线里只剩送达点，同样的订单不再插进去，取走之前插得进', () => {
    // 对照：取走之前，同样的订单（M0 取餐，只比原有订单多取一份）插得进
    const before = flyingToM0();
    const control = send(before.state, MERCHANT.m0, BUILDING.b1, 0);
    expect(dispatchRound(before.state).dispatched).toEqual([control.id]);

    const { state, drone } = lineScene();
    const a = send(state, MERCHANT.m0, BUILDING.b0, 10);
    dispatchRound(state);
    advanceUntil(state, () => drone.onboard.length === 1);
    expect(stops(drone)).toEqual([`D${a.id}`]);
    expect(Math.abs(drone.x - M0[0])).toBeLessThan(20); // 刚取完餐，离店只有一步
    // 这张订单的店就在飞机下面，同乘，推迟十几步，电量也够。若没有这条限制，它会被插进去
    const b = send(state, MERCHANT.m0, BUILDING.b1, 0);
    expect(drone.battery).toBeGreaterThan(5100); // 电量够飞这一趟，挡住它的不是电量
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(b.status).toBe(OrderStatus.Pending);
    expect(stops(drone)).toEqual([`D${a.id}`]);
  });

  it('直接问插入的计算：只剩送点的路线没有可行的插入', () => {
    const { state, drone } = lineScene();
    const a = send(state, MERCHANT.m0, BUILDING.b0, 0);
    dispatchRound(state);
    advanceUntil(state, () => drone.onboard.length === 1);
    expect(drone.route.some((s) => s.kind === StopKind.Pickup)).toBe(false);
    const b = send(state, MERCHANT.m0, BUILDING.b2, 0);
    expect(bestInsertion(state, makeDrafts(state), b, state.step, getPoolRule('any'), getZoneRule('global'))).toBeNull();
    expect(a.status).toBe(OrderStatus.Picked);
  });
});

describe('插入：一起送的范围', () => {
  it('顺路的一起送不同的店也能一起送，同一家店的一起送不同的店不能一起送、同一家店可以', () => {
    const run = (pool: string, merchant: number): number => {
      const { state } = flyingToM0({ rules: { pool } });
      const b = send(state, merchant, BUILDING.b2, 10);
      dispatchRound(state);
      return b.status;
    };
    expect(run('any', MERCHANT.m1)).toBe(OrderStatus.Assigned);
    expect(run('same', MERCHANT.m1)).toBe(OrderStatus.Pending);
    expect(run('same', MERCHANT.m0)).toBe(OrderStatus.Assigned);
    expect(run('any', MERCHANT.m0)).toBe(OrderStatus.Assigned);
  });

  it('同一家店的一起送：路线上已有两张订单时，要求它们都和新订单同一家店', () => {
    const state = createState(
      { scenario: 'oldStreet', drones: 1, capacity: 3, peakRate: 0, rules: { pool: 'same' } },
      customWorld('oldStreet', [M0, M1, M2], [B0, B1, B2, B3]),
    );
    placeStations(state, [[0, 0]]);
    const drone = state.drones[0] as Drone;
    const a = send(state, MERCHANT.m0, BUILDING.b0, 10);
    dispatchRound(state);
    advanceUntil(state, () => drone.state === DroneState.Fly);
    const b = send(state, MERCHANT.m0, BUILDING.b2, 10);
    dispatchRound(state);
    expect(b.drone).toBe(0);
    const c = send(state, MERCHANT.m1, BUILDING.b2, 10); // 另一家店：同一家店的一起送不让它上
    dispatchRound(state);
    expect(c.status).toBe(OrderStatus.Pending);
    expect(new Set(drone.route.map((s) => s.order))).toEqual(new Set([a.id, b.id]));
  });

  it('载量为 1 时，顺路的一起送和同一家店的一起送都插不进任何订单，没有空闲飞机的轮次直接结束', () => {
    for (const pool of ['any', 'same']) {
      const { state, drone } = lineScene({ capacity: 1, rules: { pool } });
      expect(canPool(state)).toBe(false);
      send(state, MERCHANT.m0, BUILDING.b0, 10);
      dispatchRound(state);
      advanceUntil(state, () => drone.state === DroneState.Fly);
      const b = send(state, MERCHANT.m0, BUILDING.b2, 10);
      expect(dispatchRound(state)).toEqual({ dispatched: [], early: [] });
      expect(b.status).toBe(OrderStatus.Pending);
    }
    // 一趟送一单在任何载量下都不插入
    const { state, drone } = lineScene({ rules: { pool: 'single' } });
    expect(canPool(state)).toBe(false);
    send(state, MERCHANT.m0, BUILDING.b0, 10);
    dispatchRound(state);
    advanceUntil(state, () => drone.state === DroneState.Fly);
    const b = send(state, MERCHANT.m0, BUILDING.b2, 10);
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(b.status).toBe(OrderStatus.Pending);
  });

  it('一趟送一单：载量 1 和载量 2、3 的结果完全相同，载量只在一起送时起作用', () => {
    const outcome = (capacity: number): unknown[] => {
      const state = runDays({ scenario: 'threeDistricts', drones: 16, peakRate: 82, gateInterval: 0.8, seed: 42, capacity, rules: { select: 'deadline', pool: 'single' } }, 2);
      return state.orders.map((o) => [o.tAssign, o.tArrive, o.tPick, o.tDeliver, o.tCancel, o.drone, o.departed, o.gateWait, o.rev, o.shared]);
    };
    const one = outcome(1);
    expect(one.length).toBeGreaterThan(300);
    expect(outcome(2)).toEqual(one);
    expect(outcome(3)).toEqual(one);
  });
});

describe('插入：载量按机上份量检查', () => {
  it('载量 2：普通订单加普通订单是 2 份，可以。普通订单加大单是 3 份，不可以', () => {
    const { state } = flyingToM0();
    const big = send(state, MERCHANT.m1, BUILDING.b2, 10, 2);
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(big.status).toBe(OrderStatus.Pending);
    const normal = send(state, MERCHANT.m1, BUILDING.b2, 10);
    expect(dispatchRound(state).dispatched).toEqual([normal.id]);
  });

  it('载量 3：普通订单加大单是 3 份，可以，大单占 2 份，机上份量不超过载量', () => {
    const { state, drone } = flyingToM0({ capacity: 3 });
    const big = send(state, MERCHANT.m1, BUILDING.b2, 10, 2);
    expect(dispatchRound(state).dispatched).toEqual([big.id]);
    expect(big.units).toBe(2);
    let most = 0;
    advanceUntil(state, () => {
      most = Math.max(most, drone.load);
      return big.status === OrderStatus.Delivered;
    });
    expect(most).toBe(3);
  });
});

describe('插入：已有订单被推迟不超过 6 秒', () => {
  /** B 的餐在飞机到店之后 delay 步才做好：B 和 A 同一家店，A 的餐飞机到店时早已做好。 */
  function lateFood(delay: number): { b: Order; assigned: boolean } {
    const { state, drone } = flyingToM0();
    const arrive = state.step + dist(drone.x, drone.y, M0[0], M0[1]) / 11; // 预计到店的步
    const b = send(state, MERCHANT.m0, BUILDING.b2, Math.round(arrive - state.step + delay));
    dispatchRound(state);
    return { b, assigned: b.status === OrderStatus.Assigned };
  }

  it('B 的餐比飞机到店晚 50 步（5 秒）：A 最多晚 50 步送到，没超过 60 步，插得进', () => {
    expect(lateFood(50).assigned).toBe(true);
  });

  it('B 的餐比飞机到店晚 75 步（7.5 秒）：不管怎么排，A 都要晚 75 步以上，超过 60 步，插不进', () => {
    expect(lateFood(75).assigned).toBe(false);
  });
});

describe('插入：电量', () => {
  it('新路线的总距离，加回站的距离、悬停余量和保留电量，不超过当前电量才插得进', () => {
    // A：M0 到 B0。B 在 M0 取餐，送到 B1（离 B0 很远），只有「同乘 + B 在 A 之后送」一种路线的推迟不超过 6 秒
    const need = (state: SimState, drone: Drone): number => {
      const home = state.stations[0] as { x: number; y: number };
      return (
        dist(drone.x, drone.y, M0[0], M0[1]) + dist(M0[0], M0[1], B0[0], B0[1]) + dist(B0[0], B0[1], B1[0], B1[1]) +
        dist(B1[0], B1[1], home.x, home.y) + 150 + 700
      );
    };
    const outcome = (delta: number): boolean => {
      const { state, drone } = flyingToM0();
      const b = send(state, MERCHANT.m0, BUILDING.b1, 0);
      drone.battery = need(state, drone) + delta;
      dispatchRound(state);
      return b.status === OrderStatus.Assigned;
    };
    expect(outcome(+1)).toBe(true);
    expect(outcome(-1)).toBe(false);
  });
});

describe('插入：路线开头已经锁定的点不能被插到前面', () => {
  it('正在飞往取餐点：B 的餐先好，先取 B 的餐，B 的取点排在最前', () => {
    const { state, drone, a } = flyingToM0();
    const arrive = state.step + dist(drone.x, drone.y, M0[0], M0[1]) / 11;
    a.prepDone = Math.ceil(arrive) + 100; // A 的餐到店之后 100 步才好
    const b = send(state, MERCHANT.m0, BUILDING.b2, 0); // B 的餐现在就好
    dispatchRound(state);
    expect(stops(drone)[0]).toBe(`P${b.id}`);
  });

  it('已经在店里悬停等出餐：正在等的取点锁定，B 的取点只能排在它后面', () => {
    const { state, drone, a } = flyingToM0();
    a.prepDone = state.step + 400; // A 的餐很晚才好
    advanceUntil(state, () => drone.state === DroneState.Prep);
    expect(stops(drone)).toEqual([`P${a.id}`, `D${a.id}`]);
    const b = send(state, MERCHANT.m0, BUILDING.b2, 0); // B 的餐现在就好，若不锁定，先取 B 的餐更省时间
    expect(dispatchRound(state).dispatched).toEqual([b.id]);
    expect(stops(drone)[0]).toBe(`P${a.id}`);
    expect(new Set(stops(drone))).toEqual(new Set([`P${a.id}`, `D${a.id}`, `P${b.id}`, `D${b.id}`]));
  });

  it('正在取餐和正在送达的点同样锁定', () => {
    const { state, drone } = lineScene();
    const a = send(state, MERCHANT.m0, BUILDING.b0, 10);
    dispatchRound(state);
    advanceUntil(state, () => drone.state === DroneState.Pick);
    const b = send(state, MERCHANT.m0, BUILDING.b2, 0);
    expect(dispatchRound(state).dispatched).toEqual([b.id]);
    expect(stops(drone)[0]).toBe(`P${a.id}`);
  });
});

describe('插入：站点分工按这一趟的出发站判断', () => {
  /** 两座站：0 号在原点，1 号在 (2400, 0)。A 的店 M0 离 0 号站近，B 的店 MB 离 1 号站近，两家店相距 200。1 号站的飞机在空中，不可用。 */
  function twoStations(zone: string): { state: SimState; drone: Drone; b: Order } {
    const state = createState(
      { scenario: 'threeDistricts', drones: 2, capacity: 2, peakRate: 0, gateInterval: 0.8, rules: { pool: 'any', zone } },
      customWorld('threeDistricts', [M0, [1300, 0]], [B0, B2]),
    );
    placeStations(state, [[0, 0], [2400, 0]]);
    const [d0, d1] = state.drones as [Drone, Drone];
    d1.state = DroneState.Fly;
    const a = send(state, 0, 0, 10);
    expect(dispatchRound(state).dispatched).toEqual([a.id]);
    expect(a.home).toBe(0);
    advanceUntil(state, () => d0.state === DroneState.Fly);
    const b = send(state, 1, 1, 10);
    expect(b.home).toBe(1);
    return { state, drone: d0, b };
  }

  it('哪座站都能送：别的站的订单也能插进 0 号站飞机的路线', () => {
    const { state, drone, b } = twoStations('global');
    expect(dispatchRound(state).dispatched).toEqual([b.id]);
    expect([b.drone, b.departed, b.home]).toEqual([drone.id, 0, 1]);
  });

  it('只由最近的站送：本站是 1 号站的订单，不能插进 0 号站出发的飞机', () => {
    const { state, b } = twoStations('strict');
    expect(dispatchRound(state).dispatched).toEqual([]);
    expect(b.status).toBe(OrderStatus.Pending);
  });

  it('只由最近的站送：本站的飞机路线可以插，哪怕飞机已经在空中', () => {
    const { state, drone } = twoStations('strict');
    const c = send(state, 0, 1, 10); // 本站是 0 号站
    expect(c.home).toBe(0);
    expect(dispatchRound(state).dispatched).toEqual([c.id]);
    expect(c.drone).toBe(drone.id);
  });

  it('等 10 秒再帮：下单后 99 步不能插进别的站出发的飞机，满 100 步可以', () => {
    const { state, b } = twoStations('hybrid');
    state.step = b.tOrder + 99;
    expect(dispatchRound(state).dispatched).toEqual([]);
    state.step = b.tOrder + 100;
    expect(dispatchRound(state).dispatched).toEqual([b.id]);
    expect(b.departed).toBe(0);
  });
});

describe('插入：与交给空闲飞机比较', () => {
  /**
   * 两架飞机在同一座站。A 派给 0 号飞机，A 的餐很晚才好，0 号飞机悬停在店里等。
   * B 和 A 同一家店，餐现在就好。1 号飞机是空闲的，从站飞到店需要 shopSteps 步。
   */
  function waiting(shopDistance: number): { state: SimState; b: Order } {
    const state = createState(
      { scenario: 'oldStreet', drones: 2, capacity: 2, peakRate: 0, gateInterval: 0.8, rules: { pool: 'any' } },
      customWorld('oldStreet', [[shopDistance, 0]], [[shopDistance, 550], [shopDistance, 660]]),
    );
    placeStations(state, [[0, 0]]);
    const d0 = state.drones[0] as Drone;
    send(state, 0, 0, 300);
    dispatchRound(state);
    advanceUntil(state, () => d0.state === DroneState.Prep);
    advance(state, 20);
    expect(d0.state).toBe(DroneState.Prep);
    expect(state.step).toBeLessThan(300);
    return { state, b: send(state, 0, 1, 0) };
  }

  it('空闲飞机离店很远：插入的预计送达比交给它早，采纳插入，空闲飞机留着', () => {
    const { state, b } = waiting(2400);
    expect(Array.from(buildRound(state).ok)).toEqual([1]); // 空闲的 1 号飞机电量够送，是候选
    expect(dispatchRound(state).dispatched).toEqual([b.id]);
    expect(b.drone).toBe(0);
    expect((state.drones[1] as Drone).route).toEqual([]);
  });

  it('空闲飞机离店很近：插入的预计送达不比交给它早，交给空闲飞机', () => {
    const { state, b } = waiting(110);
    expect(Array.from(buildRound(state).ok)).toEqual([1]);
    expect(dispatchRound(state).dispatched).toEqual([b.id]);
    expect(b.drone).toBe(1);
    expect((state.drones[0] as Drone).route.length).toBe(2);
  });
});

describe('插入：最便宜的插入', () => {
  it('在所有飞机里选路线完成时间增加最少的，增加量相同时取编号小的飞机', () => {
    // 两架飞机各送一张订单：0 号飞机的送点很远，1 号飞机的送点在 B 的送点附近
    const world = customWorld('oldStreet', [M0, M0], [[2700, 0], B0, B2]);
    const state = createState({ scenario: 'oldStreet', drones: 2, capacity: 2, peakRate: 0, gateInterval: 0.8, rules: { pool: 'any' } }, world);
    placeStations(state, [[0, 0]]);
    const [d0, d1] = state.drones as [Drone, Drone];
    const a0 = send(state, 0, 0, 10); // 送到 (2700, 0)
    const a1 = send(state, 1, 1, 10); // 送到 B0
    expect(dispatchRound(state).dispatched).toEqual([a0.id, a1.id]);
    expect([a0.drone, a1.drone]).toEqual([0, 1]);
    advanceUntil(state, () => d0.state === DroneState.Fly && d1.state === DroneState.Fly);
    const b = send(state, 0, 2, 10); // 在 M0 取餐，送到 B2
    const drafts = makeDrafts(state);
    const pool = getPoolRule('any');
    const zone = getZoneRule('global');
    const only0 = bestInsertion(state, [drafts[0] as (typeof drafts)[number]], b, state.step, pool, zone);
    const only1 = bestInsertion(state, [drafts[1] as (typeof drafts)[number]], b, state.step, pool, zone);
    const both = bestInsertion(state, drafts, b, state.step, pool, zone);
    expect(only0).not.toBeNull();
    expect(only1).not.toBeNull();
    expect(both).not.toBeNull();
    expect((only0 as { increase: number }).increase).not.toBe((only1 as { increase: number }).increase);
    const cheaper = (only0 as { increase: number }).increase <= (only1 as { increase: number }).increase ? only0 : only1;
    expect(both?.droneId).toBe(cheaper?.droneId);
    expect(both?.increase).toBe(cheaper?.increase);
    expect(both?.arrival).toBe(cheaper?.arrival);
  });
});

describe('插入：订单被退单', () => {
  it('同一趟里的一张订单被退单：路线上拿掉它的取点和送点，另一张订单照常送达', () => {
    const { state, drone, a } = flyingToM0();
    const b = send(state, MERCHANT.m1, BUILDING.b2, 10);
    dispatchRound(state);
    expect(drone.route.length).toBe(4);
    cancelOrder(state, b, state.step);
    expect(stops(drone)).toEqual([`P${a.id}`, `D${a.id}`]);
    expect(b.status).toBe(OrderStatus.Cancelled);
    advanceUntil(state, () => a.status === OrderStatus.Delivered);
    advance(state, 600);
    expect(drone.state).toBe(DroneState.Dock);
    expect(a.shared).toBe(false); // 退单之后没有同乘
    expect(drone.load).toBe(0);
  });

  it('路线上第一张订单被退单：飞机转向下一张订单的取点', () => {
    const { state, drone, a } = flyingToM0();
    const b = send(state, MERCHANT.m1, BUILDING.b2, 10);
    dispatchRound(state);
    cancelOrder(state, a, state.step);
    expect(stops(drone)).toEqual([`P${b.id}`, `D${b.id}`]);
    expect([drone.tx, drone.ty]).toEqual(M1);
    advanceUntil(state, () => b.status === OrderStatus.Delivered);
  });
});

describe('提前派出的名单算上插入', () => {
  // 一座站、两架飞机：0 号飞机在送订单 A（飞往 M0），1 号飞机空闲。
  // X 先下单，店在站的正北 1100，楼就在店边上：离 A 的路线太远，插不进去，剩余时间长。
  // Y 后下单 0.5 秒，店在 M1，楼在 B1，路上要 9 秒：剩余时间短，也能插进 A 的路线。
  function scene(select: string): { state: SimState; x: Order; y: Order } {
    const state = createState(
      { scenario: 'oldStreet', drones: 2, capacity: 2, peakRate: 0, gateInterval: 0.8, rules: { select, pool: 'any' } },
      customWorld('oldStreet', [M0, M1, [0, 1100]], [B0, B1, [0, 1210]]),
    );
    placeStations(state, [[0, 0]]);
    const drone = state.drones[0] as Drone;
    const a = send(state, MERCHANT.m0, BUILDING.b0, 10);
    expect(dispatchRound(state).dispatched).toEqual([a.id]);
    advanceUntil(state, () => drone.state === DroneState.Fly);
    const x = addOrder(state, { merchant: 2, building: 2, portion: 1, prepSteps: 10, tOrder: state.step });
    const y = addOrder(state, { merchant: 1, building: 1, portion: 1, prepSteps: 10, tOrder: state.step + 5 });
    state.step += 10;
    return { state, x, y };
  }

  it('按下单顺序的方案里有插入：先下单的 X 交给空闲飞机，Y 没有空闲飞机，插进 0 号飞机的路线', () => {
    const { state, y } = scene('deadline');
    const round = buildRound(state);
    const before = hashState(state);
    const plan = planRound(round, [0, 1]);
    expect(hashState(state)).toBe(before); // 算名单不修改状态
    expect(plan.length).toBe(2);
    expect(plan[0]).toEqual({ k: 0, drone: 0 });
    expect(plan[1]).toMatchObject({ k: 1, droneId: 0 });
    expect('route' in (plan[1] as object)).toBe(true);
    expect(round.orders[1]?.id).toBe(y.id);
  });

  it('快超时的先送把 Y 排在 X 前面，实际派出 Y。Y 在按下单顺序的名单里（靠插入），不记为提前派出', () => {
    const { state, x, y } = scene('deadline');
    const round = buildRound(state);
    expect(getSelectRule('deadline').rank(round.ctx)).toEqual([1, 0]);
    const result = dispatchRound(state);
    // 实际：Y 先挑，空闲飞机比插入更早，交给空闲飞机，X 没有飞机也插不进去
    // 名单：X 拿走空闲飞机，Y 插进 0 号飞机的路线。Y 在名单里
    expect(result.dispatched).toEqual([y.id]);
    expect(y.drone).toBe(1);
    expect(result.early).toEqual([]);
    expect(y.early).toBe(false);
    expect(x.status).toBe(OrderStatus.Pending);
  });

  it('名单里确实有 Y：不把插入算进名单的旧办法会得到只有 X 的名单，把 Y 误记为提前派出', () => {
    const { state, x, y } = scene('deadline');
    const round = buildRound(state);
    const roster = planRound(round, [0, 1]).map((item) => round.ctx.pendingIds[item.k]);
    expect(roster).toEqual([x.id, y.id]);
  });
});

// 回站模式的不变量测试：确定性之外的守恒、时间顺序、起降口、停机位、电量、派单范围和分工、提前派出的统计。
import { describe, expect, it } from 'vitest';
import {
  CANCEL_STEPS,
  DAY_STEPS,
  DECIDE_EVERY,
  DRAIN_STEPS,
  DROP_STEPS,
  DroneState,
  LAND_STEPS,
  OrderStatus,
  PICK_STEPS,
  PROMISE_STEPS,
  RANGE,
  STEPS_PER_SECOND,
  STEP_PHASES,
  StopKind,
  TAKEOFF_STEPS,
  addOrder,
  advance,
  buildRound,
  createRng,
  createState,
  nextInt,
  prioritizeOrder,
  ruleIds,
  runDays,
  runMetrics,
  setRules,
  windowStats,
} from '../src/core/index.ts';
import type { ConfigOverrides, Drone, Order, SimState, Station } from '../src/core/index.ts';
import { dist } from '../src/core/world.ts';
import { AIRBORNE, CITY, OPENING, snapshotDrones, stepEach } from './helpers.ts';

/** 不经过统计模块，直接按订单字段数一遍。 */
function tally(state: SimState): { ontime: number; late: number; cancelled: number; open: number } {
  const t = { ontime: 0, late: 0, cancelled: 0, open: 0 };
  for (const o of state.orders) {
    if (o.status === OrderStatus.Delivered) {
      if (o.tDeliver - o.tOrder <= PROMISE_STEPS) t.ontime++;
      else t.late++;
    } else if (o.status === OrderStatus.Cancelled) {
      t.cancelled++;
    } else {
      t.open++;
    }
  }
  return t;
}

/** 订单量远超运力。 */
const OVERLOAD: ConfigOverrides = { ...CITY, peakRate: 110 };

function runPhase(state: SimState, name: string): void {
  const phase = STEP_PHASES.find((p) => p.name === name);
  if (!phase) throw new Error(`no phase ${name}`);
  phase.run(state);
}

describe('订单守恒', () => {
  it('下单数等于准时、超时送达、退单、未完成之和，任何时刻都成立', () => {
    const state = createState({ ...CITY, seed: 42 });
    for (const until of [900, 1500, 1900, 3000]) {
      advance(state, until - state.step);
      const t = tally(state);
      expect(t.ontime + t.late + t.cancelled + t.open).toBe(state.orders.length);
      expect(t.open).toBeGreaterThan(0); // 运行中途一定有尚未结束的订单
      const w = windowStats(state, 0, state.step + 1);
      expect(w.nOrders).toBe(state.orders.length);
      expect(w.nOnTime).toBe(t.ontime);
      expect(w.nLateDelivered).toBe(t.late);
      expect(w.nCancelled).toBe(t.cancelled);
      expect(w.nUnresolved).toBe(t.open);
    }
  });

  it('多跑一段不再来单的时间后，每张订单都有结局', () => {
    for (const config of [CITY, OVERLOAD, OPENING]) {
      const state = runDays({ ...config, seed: 43 }, 2);
      const t = tally(state);
      expect(t.open).toBe(0);
      expect(t.ontime + t.late + t.cancelled).toBe(state.orders.length);
      expect(state.orders.length).toBeGreaterThan(50);
      expect(windowStats(state, 0, 7200).nUnresolved).toBe(0);
    }
  });
});

describe('订单的时间顺序', () => {
  it('取餐不早于出餐完成，送达晚于取餐，取走的订单一定送达，退单恰在 90 秒', () => {
    for (const config of [OVERLOAD, { ...OPENING, peakRate: 30 }]) {
      const state = runDays({ ...config, seed: 42 }, 2);
      const bad: string[] = [];
      let picked = 0;
      let cancelled = 0;
      for (const o of state.orders) {
        if (o.tAssign >= 0 && o.tAssign < o.tOrder) bad.push(`${o.id} assigned before ordered`);
        if (o.tPick >= 0) {
          picked++;
          if (o.tPick < o.prepDone) bad.push(`${o.id} picked before the food was ready`);
          if (o.tPick < o.tAssign) bad.push(`${o.id} picked before assigned`);
          if (o.tDeliver < 0) bad.push(`${o.id} picked but never delivered`);
          if (o.tDeliver < o.tPick + PICK_STEPS + DROP_STEPS) bad.push(`${o.id} delivered too soon after pickup`);
          if (o.tCancel >= 0) bad.push(`${o.id} picked and cancelled`);
        }
        if (o.status === OrderStatus.Cancelled) {
          cancelled++;
          if (o.tPick >= 0) bad.push(`${o.id} cancelled after pickup`);
          if (o.tCancel - o.tOrder !== CANCEL_STEPS) bad.push(`${o.id} cancelled at ${o.tCancel - o.tOrder} steps`);
        }
      }
      expect(bad).toEqual([]);
      expect(picked).toBeGreaterThan(40);
      expect(cancelled).toBeGreaterThan(0);
    }
  });

  it('订单的四段时间相加等于送达用时', () => {
    const state = runDays({ ...CITY, seed: 44 }, 2);
    const w = windowStats(state, 3600, 7200);
    const s = w.segments;
    expect(s.waitDrone + s.waitGate + s.waitPrep + s.road).toBeCloseTo(s.total, 9);
    expect(s.total).toBeCloseTo(w.durMean, 9);
    expect(s.waitDrone).toBeGreaterThan(0);
    expect(s.road).toBeGreaterThan(5);
  });
});

describe('起降口', () => {
  it.each([0.4, 0.8, 1.2])('同一座站两次起降动作的开始时刻相差不小于设定的间隔：%s 秒', (interval) => {
    const state = createState({ ...OVERLOAD, gateInterval: interval, seed: 42 });
    const gap = Math.round(interval * STEPS_PER_SECOND);
    expect(state.stations[0]?.gateInterval).toBe(gap);
    const starts: number[][] = state.stations.map(() => []);
    let before: number[] = [];
    let takeoffs = 0;
    let landings = 0;
    const bad: string[] = [];
    stepEach(state, 3600, () => undefined, {
      before(phase, s) {
        if (phase === 'gates') before = s.drones.map((d) => d.state);
      },
      after(phase, s) {
        if (phase !== 'gates') return;
        s.drones.forEach((d, i) => {
          const was = before[i];
          if (was === DroneState.TakeoffQueue && d.state === DroneState.Takeoff) {
            starts[d.station]?.push(s.step);
            takeoffs++;
            if (d.tEnd - s.step !== TAKEOFF_STEPS) bad.push('takeoff duration');
          } else if (was === DroneState.LandQueue && d.state === DroneState.Land) {
            starts[d.station]?.push(s.step);
            landings++;
            if (d.tEnd - s.step !== LAND_STEPS) bad.push('landing duration');
          }
        });
      },
    });
    expect(bad).toEqual([]);
    expect(takeoffs + landings).toBeGreaterThan(200);
    expect(landings).toBeGreaterThan(50);
    let minGap = Infinity;
    for (const list of starts) {
      for (let i = 1; i < list.length; i++) minGap = Math.min(minGap, (list[i] as number) - (list[i - 1] as number));
    }
    expect(minGap).toBeGreaterThanOrEqual(gap);
    expect(minGap).toBe(gap); // 过载时起降口一直忙，间隔恰好等于设定值
  });

  it('电量低于 15% 的降落排到队首，其余先到先办，每次动作之间隔一个间隔', () => {
    const state = createState({ ...OPENING, drones: 3 });
    const station = state.stations[0] as Station;
    const [a, b, c] = state.drones as [Drone, Drone, Drone];
    const pending = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50 });
    // a、c 在空中盘旋等降落，b 已接单、停在停机位上等起飞
    for (const d of [a, c]) d.state = DroneState.LandQueue;
    station.occupied = 1;
    a.battery = 5000;
    c.battery = 500; // 低于满电的 15%
    b.state = DroneState.TakeoffQueue;
    b.route = [{ kind: 0, order: pending.id }];
    station.queue = [a.id, b.id, c.id];
    state.step = 10;

    runPhase(state, 'gates');
    expect(c.state).toBe(DroneState.Land); // 低电量的越过前面的 a 和 b
    expect(station.queue).toEqual([a.id, b.id]);
    expect(station.occupied).toBe(2);
    state.step += station.gateInterval - 1;
    runPhase(state, 'gates');
    expect(station.queue).toEqual([a.id, b.id]); // 间隔内不办下一个
    state.step += 1;
    runPhase(state, 'gates');
    expect(a.state).toBe(DroneState.Land); // 先到先办
    expect(station.queue).toEqual([b.id]);
  });

  it('停机位已满时不放降落，起飞的先办', () => {
    const state = createState({ ...OPENING, drones: 2 });
    const station = state.stations[0] as Station;
    const [x, y] = state.drones as [Drone, Drone];
    const pending = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 50 });
    x.state = DroneState.LandQueue;
    y.state = DroneState.TakeoffQueue;
    y.route = [{ kind: 0, order: pending.id }];
    station.occupied = station.bays;
    station.queue = [x.id, y.id];
    runPhase(state, 'gates');
    expect(y.state).toBe(DroneState.Takeoff);
    expect(x.state).toBe(DroneState.LandQueue);
    expect(station.queue).toEqual([x.id]);
  });
});

describe('停机位', () => {
  it.each([
    ['默认两座站', { ...OVERLOAD }],
    ['一座大站', { ...OVERLOAD, layout: 'single' as const }],
    ['三座站，每站多一个停机位', { ...OVERLOAD, layout: 'three' as const, drones: 15, extraBays: 1 }],
    ['起降口很慢', { ...OVERLOAD, gateInterval: 2.5 }],
  ])('任何时刻一座站占用的停机位不超过它的数量：%s', (_name, config) => {
    const state = createState({ ...config, seed: 42 });
    const bad: string[] = [];
    let mostOccupied = 0;
    stepEach(state, 3600, (s) => {
      for (const station of s.stations) {
        // 独立重数：在机位上、等起飞、起飞中、降落中的飞机占着机位
        const recount = s.drones.filter(
          (d) =>
            d.station === station.id &&
            (d.state === DroneState.Dock ||
              d.state === DroneState.TakeoffQueue ||
              d.state === DroneState.Takeoff ||
              d.state === DroneState.Land),
        ).length;
        if (recount !== station.occupied) bad.push(`step ${s.step} station ${station.id}: recount ${recount} vs ${station.occupied}`);
        if (station.occupied > station.bays) bad.push(`step ${s.step} station ${station.id}: ${station.occupied} > ${station.bays}`);
        mostOccupied = Math.max(mostOccupied, station.occupied);
      }
    });
    expect(bad.slice(0, 5)).toEqual([]);
    // 停机位是实实在在被占用的：飞机全在站里时占满飞机数那么多
    expect(mostOccupied).toBeGreaterThanOrEqual(Math.min(...state.stations.map((s) => s.bays - (config.extraBays ?? 0))));
  });
});

describe('电量', () => {
  it.each([
    ['三片区 快超时 哪座站都能送', { ...CITY, peakRate: 45 }],
    ['三片区 快超时 只由最近的站送', { ...CITY, peakRate: 68, rules: { select: 'deadline', zone: 'strict' } }],
    ['三片区 先下单 哪座站都能送', { ...CITY, peakRate: 68, rules: { select: 'fifo', zone: 'global' } }],
    ['一座大站过载', { ...OVERLOAD, layout: 'single' as const }],
    ['写字楼区店很少', { ...CITY, scenario: 'sparseOffice' as const, peakRate: 60 }],
    ['两座站向外移', { ...CITY, layout: 'edge' as const, peakRate: 68 }],
    ['老街开局', OPENING],
  ])('没有飞机耗尽电量：%s', (_name, config) => {
    for (const seed of [42, 43]) {
      const state = createState({ ...config, seed, orderEndStep: 2 * 3600 });
      let lowest = RANGE;
      stepEach(state, 2 * 3600 + 2400, (s) => {
        for (const d of s.drones) lowest = Math.min(lowest, d.battery);
      });
      expect(state.stats.stranded).toBe(0);
      expect(lowest).toBeGreaterThan(0);
      expect(state.orders.length).toBeGreaterThan(50);
    }
  });
});

describe('订单量很低时', () => {
  it.each([
    ['fifo', 'global'],
    ['deadline', 'global'],
    ['fifo', 'strict'],
    ['deadline', 'strict'],
  ])('退单率低于 2%%：先送哪张单 %s，别的站帮不帮 %s', (select, zone) => {
    for (const seed of [42, 43, 44, 45, 46]) {
      const state = runDays({ ...CITY, peakRate: 0.3 * 45, seed, rules: { select, zone } }, 3);
      const mean = runMetrics(state, 3).mean;
      expect(mean.day.cancelRate).toBeLessThan(0.02);
      expect(mean.day.nOrders).toBeGreaterThan(20);
    }
  });
});

describe('换规则时订单完全相同', () => {
  const fixed = (o: Order): unknown[] => [o.id, o.tOrder, o.merchant, o.building, o.district, o.portion, o.amount, o.dMB, o.prepDone, o.home];

  it('订单序列只由种子、地图和订单量决定，与派单规则无关', () => {
    const configs: ConfigOverrides[] = [
      { ...CITY, seed: 42, rules: { select: 'fifo', zone: 'global' } },
      { ...CITY, seed: 42, rules: { select: 'deadline', zone: 'strict' } },
      { ...CITY, seed: 42, rules: { select: 'deadline', zone: 'global' } },
    ];
    const states = configs.map((c) => runDays(c, 2));
    const base = states[0] as SimState;
    expect(base.orders.length).toBeGreaterThan(300);
    for (const other of states.slice(1)) {
      expect(other.orders.map(fixed)).toEqual(base.orders.map(fixed));
      expect(other.rng.orders).toEqual(base.rng.orders);
    }
    // 规则确实改变了派单结果，所以上面的相同不是因为什么都没发生
    const assigned = (s: SimState): number[] => s.orders.map((o) => o.tAssign);
    expect(assigned(states[1] as SimState)).not.toEqual(assigned(base));
    expect(assigned(states[2] as SimState)).not.toEqual(assigned(states[1] as SimState));
  });

  it('运行中途换规则，订单也不变', () => {
    const plain = createState({ ...CITY, seed: 42 });
    const switched = createState({ ...CITY, seed: 42 });
    advance(plain, 2400);
    advance(switched, 1000);
    switched.rules.select = 'fifo';
    switched.rules.zone = 'strict';
    advance(switched, 1400);
    expect(switched.orders.map(fixed)).toEqual(plain.orders.map(fixed));
    expect(switched.rng.orders).toEqual(plain.rng.orders);
  });
});

describe('派单只派停在停机位上的飞机', () => {
  it.each([
    ['快超时 哪座站都能送', OVERLOAD],
    ['先下单 只由最近的站送', { ...OVERLOAD, rules: { select: 'fifo', zone: 'strict' } }],
    ['老街开局', { ...OPENING, peakRate: 30 }],
  ])('在空中、盘旋等降落、已接单等起飞的飞机不会被派单：%s', (_name, config) => {
    const state = createState({ ...config, seed: 42 });
    let before: { state: number; routeLength: number }[] = [];
    let pendingBefore: number[] = [];
    let busyRounds = 0;
    let assignments = 0;
    const bad: string[] = [];
    stepEach(state, 3600, () => undefined, {
      before(phase, s) {
        if (phase !== 'dispatch' || s.step % 5 !== 0) return;
        before = snapshotDrones(s);
        pendingBefore = s.pending.slice();
        // 有订单在等，同时有飞机在空中或盘旋：这一轮才真正检验了「不派给不在停机位上的飞机」
        if (pendingBefore.length > 0 && before.some((d) => AIRBORNE.includes(d.state))) busyRounds++;
      },
      after(phase, s) {
        if (phase !== 'dispatch' || s.step % 5 !== 0) return;
        s.drones.forEach((d, i) => {
          const was = before[i] as { state: number; routeLength: number };
          if (d.route.length > was.routeLength) {
            assignments++;
            if (was.state !== DroneState.Dock || was.routeLength !== 0) bad.push(`step ${s.step} drone ${d.id} was in state ${was.state}`);
          }
        });
        for (const id of pendingBefore) {
          const o = s.orders[id] as Order;
          if (o.status === OrderStatus.Assigned && o.tAssign === s.step) {
            const was = before[o.drone] as { state: number };
            if (was.state !== DroneState.Dock) bad.push(`order ${id} went to a drone in state ${was.state}`);
          }
        }
      },
    });
    expect(bad).toEqual([]);
    expect(assignments).toBeGreaterThan(30);
    expect(busyRounds).toBeGreaterThan(100);
  });
});

describe('别的站帮不帮', () => {
  function nearestStation(state: SimState, o: Order): number {
    const m = state.world.merchants[o.merchant] as { x: number; y: number };
    const d = state.stations.map((s) => dist(m.x, m.y, s.x, s.y));
    return d.indexOf(Math.min(...d));
  }

  it('「只由最近的站送」：接单的飞机属于离这家店最近的站', () => {
    const state = runDays({ ...CITY, peakRate: 68, seed: 42, rules: { select: 'deadline', zone: 'strict' } }, 2);
    const assigned = state.orders.filter((o) => o.tAssign >= 0);
    expect(assigned.length).toBeGreaterThan(300);
    for (const o of state.orders) expect(o.home).toBe(nearestStation(state, o));
    expect(assigned.filter((o) => o.departed !== o.home)).toEqual([]);
    expect(assigned.filter((o) => (state.drones[o.drone] as Drone).home !== o.home)).toEqual([]);
    expect(new Set(assigned.map((o) => o.home)).size).toBe(2); // 两座站都在工作
  });

  it('「哪座站都能送」：高负载时有订单由别的站的飞机送', () => {
    const state = runDays({ ...CITY, peakRate: 68, seed: 42, rules: { select: 'deadline', zone: 'global' } }, 2);
    const assigned = state.orders.filter((o) => o.tAssign >= 0);
    const other = assigned.filter((o) => o.departed !== o.home).length;
    expect(other).toBeGreaterThan(20);
    expect(other).toBeLessThan(assigned.length);
  });
});

describe('提前派出的统计', () => {
  it.each(['global', 'strict'])('先下单的先送：整段运行里一张订单也不记为提前派出，别的站帮不帮 %s', (zone) => {
    let contested = 0; // 较早的订单有飞机能接却没有派出，而更晚的订单派出了的轮数
    for (const seed of [42, 43, 44, 45, 46, 47, 48, 49]) {
      const state = createState({ ...CITY, seed, orderEndStep: 2 * DAY_STEPS, rules: { select: 'fifo', zone } });
      let eligible: number[] = [];
      let pending: number[] = [];
      let firstRecord = -1;
      stepEach(
        state,
        2 * DAY_STEPS + DRAIN_STEPS,
        (s) => {
          if (firstRecord < 0 && s.stats.early.length > 0) firstRecord = s.step;
        },
        {
          before(phase, s) {
            if (phase !== 'dispatch' || s.step % DECIDE_EVERY !== 0) return;
            eligible = buildRound(s).eligible;
            pending = s.pending.slice();
          },
          after(phase, s) {
            if (phase !== 'dispatch' || s.step % DECIDE_EVERY !== 0) return;
            const sent = pending.filter((id) => (s.orders[id] as Order).tAssign === s.step);
            if (eligible.some((x) => !sent.includes(x) && sent.some((y) => y > x))) contested++;
          },
        },
      );
      expect(firstRecord).toBe(-1);
      expect(state.stats.early).toEqual([]);
      expect(state.orders.filter((o) => o.early).length).toBe(0);
      expect(state.orders.filter((o) => o.tAssign >= 0).length).toBeGreaterThan(300);
    }
    // 这些局面里确实出现过较早的订单被后面的订单越过的轮次：只取「有飞机能接的订单里最早的几张」作名单的办法会在这样的轮里误记
    expect(contested).toBeGreaterThan(0);
  });
});

describe('载量', () => {
  it('机上份量取订单份量和载量的较小值，载量为 1 时大单也占 1 份', () => {
    const narrow = runDays({ ...CITY, seed: 42 }, 2);
    const assigned = narrow.orders.filter((o) => o.tAssign >= 0);
    expect(assigned.filter((o) => o.portion === 2).length).toBeGreaterThan(20);
    for (const o of assigned) expect(o.units).toBe(1);

    const wide = createState({ ...CITY, capacity: 2, seed: 42 });
    advance(wide, 1800);
    const sent = wide.orders.filter((o) => o.tAssign >= 0);
    for (const o of sent) expect(o.units).toBe(Math.min(o.portion, 2));
    expect(sent.some((o) => o.units === 2)).toBe(true);
  });

  it('任何时刻机上份量不超过载量', () => {
    const state = createState({ ...OVERLOAD, seed: 42 });
    let maxLoad = 0;
    stepEach(state, 3600, (s) => {
      for (const d of s.drones) maxLoad = Math.max(maxLoad, d.load);
    });
    expect(maxLoad).toBe(1);
  });
});

describe('飞机状态机', () => {
  it('一趟的完整过程：排队、起飞、飞往店、悬停等出餐、取餐、送达、回站、盘旋、降落', () => {
    const state = createState({ ...OPENING, peakRate: 0, drones: 1 });
    const drone = state.drones[0] as Drone;
    const order = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 250 });
    const seen: number[] = [drone.state];
    stepEach(state, 900, () => undefined, {
      after() {
        if (seen[seen.length - 1] !== drone.state) seen.push(drone.state);
      },
    });
    expect(seen).toEqual([
      DroneState.Dock,
      DroneState.TakeoffQueue,
      DroneState.Takeoff,
      DroneState.Fly,
      DroneState.Prep,
      DroneState.Pick,
      DroneState.Fly,
      DroneState.Drop,
      DroneState.Fly,
      DroneState.LandQueue,
      DroneState.Land,
      DroneState.Dock,
    ]);
    expect(order.status).toBe(OrderStatus.Delivered);
    expect(order.tPick).toBe(order.prepDone); // 飞机先到，等出餐完成才取
    expect(drone.station).toBe(0);
    expect(state.stations[0]?.occupied).toBe(1);
    expect(drone.battery).toBeGreaterThan(0);
    expect(drone.battery).toBeLessThanOrEqual(RANGE);
  });

  it('订单在起降口排队等起飞时被退单：飞机回到停机位，队列清空', () => {
    const state = createState({ ...OPENING, peakRate: 0, drones: 1 });
    const station = state.stations[0] as Station;
    const drone = state.drones[0] as Drone;
    station.gateFree = 2000; // 起降口被占住
    const order = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 60 });
    advance(state, 6);
    expect(order.status).toBe(OrderStatus.Assigned);
    expect(drone.state).toBe(DroneState.TakeoffQueue);
    expect(station.queue).toEqual([drone.id]);
    advance(state, CANCEL_STEPS - state.step); // 第 899 步结束
    expect(order.status).toBe(OrderStatus.Assigned);
    advance(state, 1); // 第 900 步：下单满 90 秒
    expect(order.status).toBe(OrderStatus.Cancelled);
    expect(order.tCancel).toBe(CANCEL_STEPS);
    expect(drone.state).toBe(DroneState.Dock);
    expect(drone.route).toEqual([]);
    expect(drone.departed).toBe(-1);
    expect(station.queue).toEqual([]);
    expect(station.occupied).toBe(1);
  });

  it('起飞之后订单才被退单：飞机放弃这一趟，转为回站', () => {
    const state = createState({ ...OPENING, peakRate: 0, drones: 1 });
    const drone = state.drones[0] as Drone;
    // 出餐要 200 秒，飞机到了也取不到餐；下单满 90 秒时飞机正悬停在店里
    const order = addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 2000 });
    advance(state, CANCEL_STEPS);
    expect(drone.state).toBe(DroneState.Prep);
    advance(state, 1);
    expect(order.status).toBe(OrderStatus.Cancelled);
    expect(drone.route).toEqual([]);
    expect(drone.returning).toBe(true);
    expect(drone.state).toBe(DroneState.Fly);
    advance(state, 400);
    expect(drone.state).toBe(DroneState.Dock);
    expect(order.tPick).toBe(-1);
  });
});

// ---- 一起送 ----
/** 一趟送几单的几组配置：高负载，让插入大量发生。 */
const POOLED: [string, ConfigOverrides][] = [
  ['三片区 顺路的一起送 哪座站都能送 快超时', { ...CITY, peakRate: 82, capacity: 2, rules: { select: 'deadline', zone: 'global', pool: 'any' } }],
  ['三片区 同一家店的一起送 只由最近的站送 先下单', { ...CITY, peakRate: 82, capacity: 2, rules: { select: 'fifo', zone: 'strict', pool: 'same' } }],
  ['三片区 顺路的一起送 等 10 秒再帮 来回快', { ...CITY, peakRate: 82, capacity: 2, rules: { select: 'roundtrip', zone: 'hybrid', pool: 'any' } }],
  ['老街一座站 顺路的一起送 先下单', { ...OPENING, drones: 4, peakRate: 24, capacity: 2, rules: { select: 'fifo', pool: 'any' } }],
  ['三片区 同一家店的一起送 载量 3 某一片的先送', { ...CITY, peakRate: 82, capacity: 3, rules: { select: 'prioOffice', zone: 'global', pool: 'same' } }],
];

/** 一架飞机路线上的订单编号（去重）。 */
function routeOrders(d: Drone): number[] {
  return [...new Set(d.route.map((stop) => stop.order))];
}

describe.each(POOLED)('一起送：%s', (_name, config) => {
  const capacity = config.capacity as number;
  const pool = (config.rules as { pool: string }).pool;
  const zone = (config.rules as { zone?: string }).zone ?? 'global';

  it('机上份量任何时刻不超过载量，并且等于机上订单的份量之和，路线上的点成对、先取后送', () => {
    const state = createState({ ...config, seed: 42 });
    let most = 0;
    let twoRoutes = 0;
    const bad: string[] = [];
    stepEach(state, 3600, (s) => {
      for (const d of s.drones) {
        most = Math.max(most, d.load);
        const aboard = d.onboard.reduce((sum, id) => sum + (s.orders[id] as Order).units, 0);
        if (d.load > capacity) bad.push(`step ${s.step} drone ${d.id}: load ${d.load} > ${capacity}`);
        if (d.load !== aboard) bad.push(`step ${s.step} drone ${d.id}: load ${d.load} vs onboard ${aboard}`);
        if (d.route.length > 0 && routeOrders(d).length >= 2) twoRoutes++;
        for (const id of routeOrders(d)) {
          const at = d.route.map((stop, i) => (stop.order === id ? i : -1)).filter((i) => i >= 0);
          const kinds = at.map((i) => (d.route[i] as { kind: number }).kind);
          const picked = d.onboard.includes(id);
          const expected = picked ? [StopKind.Drop] : [StopKind.Pickup, StopKind.Drop];
          if (JSON.stringify(kinds) !== JSON.stringify(expected)) bad.push(`step ${s.step} drone ${d.id} order ${id}: stops ${kinds.join(',')}, picked ${picked}`);
        }
      }
    });
    expect(bad.slice(0, 5)).toEqual([]);
    expect(most).toBe(capacity === 3 ? 3 : 2); // 机上确实装满过：一起送发生了
    expect(twoRoutes).toBeGreaterThan(200);
  });

  it('订单守恒：任何时刻下单数等于准时、超时送达、退单、未完成之和，没有一张订单在两架飞机的路线上', () => {
    const state = createState({ ...config, seed: 43 });
    const bad: string[] = [];
    stepEach(state, 3000, (s) => {
      if (s.step % 100 !== 0) return;
      const t = tally(s);
      if (t.ontime + t.late + t.cancelled + t.open !== s.orders.length) bad.push(`step ${s.step}: tally`);
      const seen = new Set<number>();
      for (const d of s.drones) {
        for (const id of routeOrders(d)) {
          if (seen.has(id)) bad.push(`step ${s.step}: order ${id} on two routes`);
          seen.add(id);
          const o = s.orders[id] as Order;
          if (o.drone !== d.id) bad.push(`step ${s.step}: order ${id} on drone ${d.id}, recorded ${o.drone}`);
          if (o.status !== OrderStatus.Assigned && o.status !== OrderStatus.Picked) bad.push(`step ${s.step}: order ${id} status ${o.status} on a route`);
        }
      }
      for (const id of s.pending) if (seen.has(id)) bad.push(`step ${s.step}: pending order ${id} on a route`);
    });
    expect(bad.slice(0, 5)).toEqual([]);
    const done = runDays({ ...config, seed: 43 }, 2);
    const t = tally(done);
    expect(t.open).toBe(0);
    expect(t.ontime + t.late + t.cancelled).toBe(done.orders.length);
  });

  it('路线里没有取餐点之后没有新的插入，插入只发生在路线上还有取餐点的飞机', () => {
    const state = createState({ ...config, seed: 44 });
    let before: { length: number; hasPickup: boolean }[] = [];
    let inserted = 0;
    const bad: string[] = [];
    stepEach(state, 3600, () => undefined, {
      before(phase, s) {
        if (phase === 'dispatch') before = s.drones.map((d) => ({ length: d.route.length, hasPickup: d.route.some((stop) => stop.kind === StopKind.Pickup) }));
      },
      after(phase, s) {
        if (phase !== 'dispatch') return;
        s.drones.forEach((d, i) => {
          const was = before[i] as { length: number; hasPickup: boolean };
          if (was.length > 0 && d.route.length > was.length) {
            inserted++;
            if (!was.hasPickup) bad.push(`step ${s.step} drone ${d.id}: inserted into a route with no pickup left`);
          }
        });
      },
    });
    expect(bad).toEqual([]);
    expect(inserted).toBeGreaterThan(15);
  });

  if (pool === 'same') {
    it('同一家店的一起送：同一架飞机路线上的订单都取自同一家店', () => {
      const state = createState({ ...config, seed: 45 });
      let multi = 0;
      const bad: string[] = [];
      stepEach(state, 3600, (s) => {
        for (const d of s.drones) {
          const ids = routeOrders(d);
          if (ids.length < 2) continue;
          multi++;
          const shops = new Set(ids.map((id) => (s.orders[id] as Order).merchant));
          if (shops.size !== 1) bad.push(`step ${s.step} drone ${d.id}: ${shops.size} shops`);
        }
      });
      expect(bad.slice(0, 5)).toEqual([]);
      expect(multi).toBeGreaterThan(100);
    });
  }

  if (zone === 'strict') {
    it('只由最近的站送：被插入的订单也由离店最近的站出发的飞机送', () => {
      const state = runDays({ ...config, seed: 46 }, 2);
      const assigned = state.orders.filter((o) => o.tAssign >= 0);
      expect(assigned.length).toBeGreaterThan(300);
      expect(assigned.filter((o) => o.departed !== o.home)).toEqual([]);
      expect(assigned.filter((o) => (state.drones[o.drone] as Drone).home !== o.home)).toEqual([]);
      expect(assigned.filter((o) => o.shared).length).toBeGreaterThan(50); // 确实有订单同乘
    });
  }

  it('先下单的先送：同一局面下，不论一起送和站点分工怎样，提前派出的数量恒为 0', () => {
    for (const seed of [42, 43, 44]) {
      const state = createState({ ...config, seed, orderEndStep: 2 * DAY_STEPS, rules: { ...(config.rules as object), select: 'fifo' } as ConfigOverrides['rules'] });
      let inserted = 0;
      let before: number[] = [];
      stepEach(state, 2 * DAY_STEPS + DRAIN_STEPS, () => undefined, {
        before(phase, s) {
          if (phase === 'dispatch') before = s.drones.map((d) => d.route.length);
        },
        after(phase, s) {
          if (phase !== 'dispatch') return;
          s.drones.forEach((d, i) => {
            if ((before[i] as number) > 0 && d.route.length > (before[i] as number)) inserted++;
          });
        },
      });
      expect(state.stats.early).toEqual([]);
      expect(state.orders.filter((o) => o.early)).toEqual([]);
      expect(inserted).toBeGreaterThan(30); // 这些局面里确实发生了插入
      expect(state.orders.filter((o) => o.tAssign >= 0).length).toBeGreaterThan(100);
    }
  });
});

describe('一起送：先下单的先送下提前派出恒为 0', () => {
  const zones = ['global', 'hybrid', 'strict'];
  const pools = ['single', 'same', 'any'];
  const matrix = zones.flatMap((zone) => pools.map((pool) => [zone, pool] as const));

  it.each(matrix)('别的站帮不帮 %s，一趟送几单 %s：载量 2，高负载，整段运行里一张订单也不记为提前派出', (zone, pool) => {
    let overtaken = 0; // 较早的订单有飞机能接却没有派出，而更晚的订单派出了的轮数
    let inserted = 0;
    for (const seed of [42, 43, 44]) {
      const state = createState({ ...CITY, peakRate: 82, capacity: 2, seed, orderEndStep: 2 * DAY_STEPS, rules: { select: 'fifo', zone, pool } });
      let eligible: number[] = [];
      let pending: number[] = [];
      let routes: number[] = [];
      stepEach(state, 2 * DAY_STEPS + DRAIN_STEPS, () => undefined, {
        before(phase, s) {
          if (phase !== 'dispatch' || s.step % DECIDE_EVERY !== 0) return;
          eligible = buildRound(s).eligible;
          pending = s.pending.slice();
          routes = s.drones.map((d) => d.route.length);
        },
        after(phase, s) {
          if (phase !== 'dispatch' || s.step % DECIDE_EVERY !== 0) return;
          const sent = pending.filter((id) => (s.orders[id] as Order).tAssign === s.step);
          if (eligible.some((x) => !sent.includes(x) && sent.some((y) => y > x))) overtaken++;
          s.drones.forEach((d, i) => {
            if ((routes[i] as number) > 0 && d.route.length > (routes[i] as number)) inserted++;
          });
        },
      });
      expect(state.stats.early).toEqual([]);
      expect(state.orders.filter((o) => o.early)).toEqual([]);
      expect(state.orders.filter((o) => o.tAssign >= 0).length).toBeGreaterThan(300);
    }
    expect(overtaken).toBeGreaterThan(0);
    if (pool === 'single') expect(inserted).toBe(0);
    else expect(inserted).toBeGreaterThan(30);
  });
});

describe('一起送：别的卡下提前派出的统计也把一起送的限制算进名单', () => {
  it('快超时的先送加顺路的一起送：有订单被记为提前派出，每条记录带着当时的卡，同一张订单只记一次', () => {
    const state = runDays({ ...CITY, peakRate: 82, capacity: 2, seed: 42, rules: { select: 'deadline', zone: 'global', pool: 'any' } }, 2);
    const early = state.stats.early;
    expect(early.length).toBeGreaterThan(20);
    expect(early.every((e) => e.rule === 'deadline')).toBe(true);
    expect(new Set(early.map((e) => e.order)).size).toBe(early.length);
    // 记数的订单都已经派出，而且不是玩家点击插队的
    for (const e of early) {
      const o = state.orders[e.order] as Order;
      expect(o.early).toBe(true);
      expect(o.tAssign).toBe(e.step);
    }
  });
});

describe('运行中途换规则、点击插队、各种载量和布局', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('种子 %i：随机的配置，每隔一段时间随机换三栏的卡、随机点击一张等待的订单，状态始终一致', (seed) => {
    const rng = createRng(seed * 7919);
    const pick = <T,>(items: readonly T[]): T => items[nextInt(rng, items.length)] as T;
    const scenario = pick(['oldStreet', 'threeDistricts', 'threeDistricts', 'sparseOffice'] as const);
    const capacity = pick([1, 2, 2, 3]);
    const drones = pick([3, 6, 10, 16]);
    const state = createState({
      scenario,
      layout: scenario === 'oldStreet' ? 'default' : pick(['default', 'single', 'three', 'edge'] as const),
      capacity,
      drones,
      peakRate: pick([20, 45, 70, 100]),
      gateInterval: pick([0.4, 0.8, 1.2]),
      extraBays: pick([0, 1]),
      seed,
      orderEndStep: 2 * DAY_STEPS,
      rules: { select: pick(ruleIds('select')), zone: pick(ruleIds('zone')), pool: pick(ruleIds('pool')) },
    });
    const bad: string[] = [];
    stepEach(state, 2 * DAY_STEPS + DRAIN_STEPS, (s) => {
      for (const d of s.drones) {
        const aboard = d.onboard.reduce((sum, id) => sum + (s.orders[id] as Order).units, 0);
        if (d.load !== aboard || d.load > capacity) bad.push(`step ${s.step} drone ${d.id}: load ${d.load}, aboard ${aboard}, capacity ${capacity}`);
        for (const id of routeOrders(d)) {
          const kinds = d.route.filter((stop) => stop.order === id).map((stop) => stop.kind);
          const expected = d.onboard.includes(id) ? [StopKind.Drop] : [StopKind.Pickup, StopKind.Drop];
          if (JSON.stringify(kinds) !== JSON.stringify(expected)) bad.push(`step ${s.step} drone ${d.id} order ${id}: stops ${kinds.join(',')}`);
          if ((s.orders[id] as Order).drone !== d.id) bad.push(`step ${s.step}: order ${id} is on drone ${d.id} but recorded on ${(s.orders[id] as Order).drone}`);
        }
        if (d.route.length === 0 && d.onboard.length > 0) bad.push(`step ${s.step} drone ${d.id}: orders aboard but no route`);
      }
      if (s.step % 200 === 0) {
        const seen = new Set<number>();
        for (const d of s.drones) {
          for (const stop of d.route) {
            if (stop.kind !== StopKind.Pickup) continue;
            if (seen.has(stop.order)) bad.push(`step ${s.step}: order ${stop.order} on two routes`);
            seen.add(stop.order);
          }
        }
        if (s.orders.filter((o) => o.status === OrderStatus.Pending).length !== s.pending.length) bad.push(`step ${s.step}: pending list does not match order status`);
        for (const id of s.pending) if (seen.has(id)) bad.push(`step ${s.step}: pending order ${id} is on a route`);
      }
      if (s.step % 170 === 0) setRules(s, { select: pick(ruleIds('select')), zone: pick(ruleIds('zone')), pool: pick(ruleIds('pool')) });
      if (s.step % 53 === 0 && s.pending.length > 0) prioritizeOrder(s, s.pending[nextInt(rng, s.pending.length)] as number);
    });
    expect(bad.slice(0, 5)).toEqual([]);
    const t = tally(state);
    expect(t.open).toBe(0);
    expect(t.ontime + t.late + t.cancelled).toBe(state.orders.length);
    expect(state.stats.stranded).toBe(0);
    expect(state.orders.length).toBeGreaterThan(30);
  });
});

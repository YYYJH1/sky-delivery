// 测试共用的小工具。
import { buildWorld, createState, DroneState, step } from '../src/core/index.ts';
import type { ConfigOverrides, Drone, Order, ScenarioId, SimState, StepObserver, World } from '../src/core/index.ts';

/** 三个片区、两座站、十六架飞机，高峰订单量略高于运力。 */
export const CITY: ConfigOverrides = {
  scenario: 'threeDistricts',
  drones: 16,
  peakRate: 68,
  gateInterval: 0.8,
  rules: { select: 'deadline', zone: 'global' },
};

/** 老街、一座站、两架飞机，订单量约为运力的 1.7 倍。 */
export const OPENING: ConfigOverrides = {
  scenario: 'oldStreet',
  drones: 2,
  peakRate: 12,
  gateInterval: 1.2,
};

export function stateOf(overrides: ConfigOverrides, steps = 0): SimState {
  const state = createState(overrides);
  for (let i = 0; i < steps; i++) step(state);
  return state;
}

/** 逐步推进，每步之后调用一次回调。 */
export function stepEach(state: SimState, steps: number, afterStep: (state: SimState) => void, observer?: StepObserver): void {
  for (let i = 0; i < steps; i++) {
    step(state, observer);
    afterStep(state);
  }
}

export function snapshotDrones(state: SimState): { state: number; routeLength: number; station: number }[] {
  return state.drones.map((d: Drone) => ({ state: d.state, routeLength: d.route.length, station: d.station }));
}

export function countByState(state: SimState, wanted: number): number {
  return state.drones.filter((d) => d.state === wanted).length;
}

export const AIRBORNE: number[] = [DroneState.Takeoff, DroneState.Fly, DroneState.Prep, DroneState.Pick, DroneState.Drop, DroneState.LandQueue, DroneState.Land];

/** 补全一张订单的全部字段，用于手工构造。 */
export function makeOrder(partial: Partial<Order> & { id: number }): Order {
  return {
    tOrder: 0,
    merchant: 0,
    building: 0,
    district: 0,
    portion: 1,
    units: 0,
    amount: 10,
    dMB: 0,
    prepDone: 0,
    home: 0,
    status: 0,
    tAssign: -1,
    tArrive: -1,
    tPick: -1,
    tDeliver: -1,
    tCancel: -1,
    drone: -1,
    departed: -1,
    gateWait: 0,
    rev: 0,
    tip: 0,
    early: false,
    manualAt: -1,
    shared: false,
    ...partial,
  };
}

/** 手工摆的地图：店和楼的坐标直接给出，都算老街片区。其余沿用该场景的地图。 */
export function customWorld(scenario: ScenarioId, merchants: [number, number][], buildings: [number, number][]): World {
  const base = buildWorld(scenario, 7);
  return {
    ...base,
    merchants: merchants.map(([x, y], i) => ({ x, y, district: 0, rank: i + 1, weight: 1 })),
    buildings: buildings.map(([x, y]) => ({ x, y, district: 0 })),
    buildingsByDistrict: [buildings.map((_, i) => i), [], []],
    cumWeights: [],
    digest: 'custom',
  };
}

/** 把各座站挪到指定位置，停在站里的飞机跟着挪。要在下订单之前调用，订单的本站按站的位置算。 */
export function placeStations(state: SimState, positions: [number, number][]): void {
  positions.forEach(([x, y], i) => {
    const s = state.stations[i];
    if (!s) throw new Error(`no station ${i}`);
    s.x = x;
    s.y = y;
  });
  for (const d of state.drones) {
    const s = state.stations[d.home];
    if (!s) throw new Error(`no station ${d.home}`);
    d.x = s.x;
    d.y = s.y;
  }
}

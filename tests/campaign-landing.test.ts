// 关掉就近降落之后飞机怎么回站。归属站没有空停机位时改去最近的有空位的站，不在上空盘旋。降落在哪座站，归属站就改成哪座。
// 用的局面：开着就近降落，站 0 的三架飞机落到站 1 把它的停机位占满，站 1 自己的两架飞机还在外面，然后关掉就近降落。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, DroneState, RANGE, addOrder, fleetOf, step } from '../src/core/index.ts';
import type { Drone, SimState } from '../src/core/index.ts';
import { campaignOf, must, quietState, roofWhere, withMoney } from './campaign-helpers.ts';

/** 老街东边靠河的一块小屋顶，在第二座站建在这里，站 1 在 (1052, 374)，老街开局的站 0 在 (490, 610)。 */
const OLD_EAST = roofWhere((r) => r.district === 0 && r.x > 1000 && r.y < 500);

/** 店 3 在 (768, 379)，离站 1 最近，店 12 在 (477, 538)，离站 0 最近。楼 1、8、17 在站 1 旁边，楼 36、41 在地图的南端，离两座站都很远。 */
const NEAR_STATION_ONE = [1, 8, 17];
const FAR_AWAY = [41, 36];

/**
 * 两座站各 3 个停机位，站 0 有 3 架飞机（编号 0 到 2），站 1 有 2 架（编号 3、4），开着就近降落，没有随机订单。
 * 派 5 张订单：站 1 的两架飞机各送一单到很远的楼，站 0 的三架飞机各送一单到站 1 旁边的楼。
 * 站 0 的飞机送完之后，站 1 的停机位是空的，最近的有空位的站就是站 1，三架都落在这里，归属站改成站 1：站 1 归属 5 架飞机，停机位只有 3 个。
 */
function scenario(): SimState {
  const state = withMoney(quietState({ returnRule: 'nearest' }));
  must(state, { type: 'buildStation', roof: OLD_EAST });
  must(state, { type: 'buyBay', station: 0 });
  must(state, { type: 'buyDrone', station: 0 });
  must(state, { type: 'buyBay', station: 1 });
  must(state, { type: 'buyDrone', station: 1 });
  must(state, { type: 'buyDrone', station: 1 });
  for (const building of FAR_AWAY) addOrder(state, { merchant: 3, building, portion: 1, prepSteps: 20 });
  for (const building of NEAR_STATION_ONE) addOrder(state, { merchant: 12, building, portion: 1, prepSteps: 20 });
  return state;
}

/** 站 0 的三架飞机和站 1 的两架飞机。 */
function groups(state: SimState): { visitors: Drone[]; owners: Drone[] } {
  return { visitors: state.drones.filter((d) => d.home === 0), owners: state.drones.filter((d) => d.home === 1) };
}

/** 一步一步推进到 done 成立，最多推进 limit 步，推进不到就报错。 */
function stepUntil(state: SimState, done: () => boolean, limit: number): void {
  for (let i = 0; i < limit && !done(); i++) step(state);
  if (!done()) throw new Error(`the situation did not come up within ${limit} steps`);
}

/** 各站归属的飞机数超出停机位数的部分，加起来。 */
function excess(state: SimState): number {
  return state.stations.reduce((sum, s) => sum + Math.max(0, fleetOf(state, s.id) - s.bays), 0);
}

describe('关掉就近降落之后的回站', () => {
  /** 站 0 的三架飞机都选好了落在站 1（已经在站 1 降落，或者正飞往站 1）的那一步：站 1 的两架飞机还在外面执行任务，没有一架选好回哪。 */
  function atSwitchOff(state: SimState): { visitors: Drone[]; owners: Drone[] } {
    const { visitors, owners } = groups(state);
    expect([visitors.length, owners.length]).toEqual([3, 2]);
    stepUntil(state, () => visitors.every((d) => d.station === 1 || (d.returning && d.target === 1)), 400);
    expect(owners.every((d) => d.station < 0 && !d.returning), '站 1 自己的飞机还在外面').toBe(true);
    return { visitors, owners };
  }

  it('关掉时已经飞往别的站的飞机，降落之后归属站改成降落的站，不再算在原来的站名下', () => {
    const state = scenario();
    const { visitors } = atSwitchOff(state);
    // 关掉的这一步，至少有一架还在飞往站 1，它的归属站还是站 0
    expect(visitors.some((d) => d.returning && d.home === 0)).toBe(true);
    must(state, { type: 'setNearestLanding', on: false });
    stepUntil(state, () => visitors.every((d) => d.state === DroneState.Dock && d.station === 1), 600);
    expect(visitors.map((d) => d.home)).toEqual([1, 1, 1]);
    expect(fleetOf(state, 0)).toBe(0);
    expect(state.stations.map((s) => s.occupied)).toEqual([0, 3]);
  });

  it('归属站的飞机多于停机位：回来的飞机改落最近的有空位的站，不在上空盘旋，电量不耗尽，各站归属的飞机数逐步回到不超过停机位', () => {
    const state = scenario();
    const { visitors, owners } = atSwitchOff(state);
    must(state, { type: 'setNearestLanding', on: false });
    expect(state.returnRule).toBe('home');

    const trace: number[] = [];
    let longestHover = 0;
    let lowestBattery = RANGE;
    for (let i = 0; i < 2 * DAY_STEPS; i++) {
      step(state);
      for (const d of state.drones) {
        if (d.state === DroneState.LandQueue) longestHover = Math.max(longestHover, state.step - d.queuedAt);
        lowestBattery = Math.min(lowestBattery, d.battery);
      }
      trace.push(excess(state));
    }

    // 站 1 归属 5 架飞机，停机位 3 个：超出 2 个，随后站 1 自己的两架飞机先后改落站 0，超出的数先降到 1，再降到 0
    const peak = Math.max(...trace);
    expect(peak).toBe(2);
    const afterPeak = trace.slice(trace.indexOf(peak));
    expect(afterPeak.every((n, i) => i === 0 || n <= (afterPeak[i - 1] as number)), '超出的数只降不升').toBe(true);
    expect([...new Set(afterPeak)]).toEqual([2, 1, 0]);
    expect(trace[trace.length - 1]).toBe(0);
    expect([fleetOf(state, 0), fleetOf(state, 1)]).toEqual([2, 3]);
    expect(owners.map((d) => d.home)).toEqual([0, 0]);
    expect(visitors.map((d) => d.home)).toEqual([1, 1, 1]);

    // 没有飞机在上空等了超过 10 秒，没有飞机的电量耗尽，全部停在自己的站里
    expect(longestHover).toBeLessThanOrEqual(100);
    expect(lowestBattery).toBeGreaterThan(0);
    expect(state.stats.stranded).toBe(0);
    for (const d of state.drones) {
      expect([d.state, d.route.length, d.home === d.station], `drone ${d.id}`).toEqual([DroneState.Dock, 0, true]);
    }
    expect(state.stations.map((s) => s.occupied)).toEqual([2, 3]);
    expect(campaignOf(state).nearestOwned).toBe(true);
  });
});

// 无人机总数不超过停机位总数：买飞机、退停机位、退站点都要看全城的总数，只看一座站不够。
// 开着就近降落时，飞机降落在哪座站，归属站就改成哪座，一座站归属的飞机可以多于它的停机位。这时另一座站可能有空位，
// 只看一座站的检查拦不住在那里添飞机，也拦不住退掉它的停机位或者整座站，全城的飞机数就会超过停机位数。
// 之后有飞机回站时所有的站都没有空位，只能在上空盘旋，电量会耗尽。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, DroneState, RANGE, addOrder, fleetOf, inboundTo, quoteCommand, step } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { expectRejected, liveDrones, must, quietState, roofWhere, withMoney } from './campaign-helpers.ts';

/** 老街东边靠河的一块小屋顶，第二座站建在这里，站 1 在 (1052, 374)，老街开局的站 0 在 (490, 610)。 */
const OLD_EAST = roofWhere((r) => r.district === 0 && r.x > 1000 && r.y < 500);

/** 店 3 在 (768, 379)，离站 1 最近，店 12 在 (477, 538)，离站 0 最近。楼 3 和楼 9 离站 0 比离站 1 近得多，楼 41、36、40 在地图的南端，离两座站都很远。 */
const NEAR_STATION_ZERO = [3, 9];
const FAR_AWAY = [41, 36, 40];

/** 没有退回的站的停机位总数。 */
function totalBays(state: SimState): number {
  return state.stations.reduce((sum, s) => (s.removed ? sum : sum + s.bays), 0);
}

/**
 * 站 0 有 3 个停机位和 3 架飞机（编号 0 到 2），站 1 是今天建的，自带 2 个停机位，有 2 架飞机（编号 3、4），开着就近降落，没有随机订单。
 * 派 5 张订单：站 0 的三架飞机各送一单到很远的楼，站 1 的两架飞机各送一单到离站 0 近的楼。
 * 站 1 的飞机送完之后，站 0 的停机位是空的，最近的有空位的站就是站 0，两架都落在这里，归属站改成站 0。
 */
function scenario(): SimState {
  const state = withMoney(quietState({ returnRule: 'nearest' }));
  must(state, { type: 'buildStation', roof: OLD_EAST });
  must(state, { type: 'buyBay', station: 0 });
  must(state, { type: 'buyDrone', station: 0 });
  must(state, { type: 'buyDrone', station: 1 });
  must(state, { type: 'buyDrone', station: 1 });
  for (const building of FAR_AWAY) addOrder(state, { merchant: 12, building, portion: 1, prepSteps: 20 });
  for (const building of NEAR_STATION_ZERO) addOrder(state, { merchant: 3, building, portion: 1, prepSteps: 20 });
  return state;
}

/** 一步一步推进到 done 成立，最多推进 limit 步，推进不到就报错。 */
function stepUntil(state: SimState, done: () => boolean, limit: number): void {
  for (let i = 0; i < limit && !done(); i++) step(state);
  if (!done()) throw new Error(`the situation did not come up within ${limit} steps`);
}

/**
 * 站 1 的两架飞机都落在站 0 的那一步，站 0 自己的三架飞机还在外面。
 * 站 0 归属 5 架飞机，停机位 3 个。站 1 空着：没有归属的飞机，没有占用，没有预约。飞机 5 架，停机位 5 个，总数已经满了。
 */
function overcrowded(): SimState {
  const state = scenario();
  const visitors = state.drones.filter((d) => d.home === 1);
  expect(visitors.map((d) => d.id)).toEqual([3, 4]);
  stepUntil(state, () => visitors.every((d) => d.state === DroneState.Dock && d.station === 0), 400);
  expect([fleetOf(state, 0), fleetOf(state, 1)]).toEqual([5, 0]);
  expect(state.stations.map((s) => [s.bays, s.occupied, inboundTo(state, s.id)])).toEqual([
    [3, 2, 0],
    [2, 0, 0],
  ]);
  expect([liveDrones(state).length, totalBays(state)]).toEqual([5, 5]);
  return state;
}

describe('无人机总数不超过停机位总数', () => {
  it('站 0 归属超员，全城的飞机数已经等于停机位数：在空着的站 1 添飞机 bayTotalFull，少一架时可以买，买完又满了', () => {
    const state = overcrowded();
    // 站 1 自己看有空位：归属 0 架，停机位 2 个，占用和预约都是 0。只有全城的总数拦得住
    expectRejected(state, { type: 'buyDrone', station: 1 }, 'bayTotalFull');
    // 超员的站 0 先报 fleetFull，次序不变
    expectRejected(state, { type: 'buyDrone', station: 0 }, 'fleetFull');
    // 退掉一架今天买的飞机，总数 4 架、停机位 5 个，可以买
    must(state, { type: 'refundDrone', drone: 4 });
    expect(quoteCommand(state, { type: 'buyDrone', station: 1 })).toMatchObject({ ok: true, reason: null, kind: 'buy' });
    must(state, { type: 'buyDrone', station: 1 });
    expect([liveDrones(state).length, totalBays(state)]).toEqual([5, 5]);
    expectRejected(state, { type: 'buyDrone', station: 1 }, 'bayTotalFull');
  });

  it('拦下购买之后，回站的飞机都有空位可落：不在上空等，电量不耗尽，五架飞机全部停进五个停机位', () => {
    const state = overcrowded();
    expectRejected(state, { type: 'buyDrone', station: 1 }, 'bayTotalFull');
    let longestHover = 0;
    let lowestBattery = RANGE;
    let mostOver = 0;
    for (let i = 0; i < 2 * DAY_STEPS; i++) {
      step(state);
      for (const d of state.drones) {
        if (d.state === DroneState.LandQueue) longestHover = Math.max(longestHover, state.step - d.queuedAt);
        lowestBattery = Math.min(lowestBattery, d.battery);
      }
      mostOver = Math.max(mostOver, liveDrones(state).length - totalBays(state));
    }
    expect(mostOver).toBeLessThanOrEqual(0);
    expect(longestHover).toBeLessThanOrEqual(100);
    expect(lowestBattery).toBeGreaterThan(0);
    expect(state.stats.stranded).toBe(0);
    for (const d of state.drones) {
      expect([d.state, d.route.length, d.home === d.station], `drone ${d.id}`).toEqual([DroneState.Dock, 0, true]);
    }
    expect(state.stations.map((s) => s.occupied)).toEqual([3, 2]);
  });

  it('退停机位也看全城的总数：站 1 自己停机位够用，退完之后停机位数少于飞机数也不行，baysInUse，先退一架飞机就可以退', () => {
    const state = overcrowded();
    must(state, { type: 'buyBay', station: 1 }); // 站 1 有 3 个停机位，今天买的第 3 个。停机位 6 个，飞机 5 架
    expect(quoteCommand(state, { type: 'refundBay', station: 1 })).toMatchObject({ ok: true, reason: null, kind: 'refund' }); // 退完 5 个，不少于 5 架
    const added = must(state, { type: 'buyDrone', station: 1 }); // 飞机 6 架，停机位 6 个
    // 站 1 自己看没有问题：退成 2 个停机位，归属 1 架，占用 1 个。只有全城的总数拦得住
    const station = state.stations[1] as { bays: number; occupied: number };
    expect([station.bays - 1 >= fleetOf(state, 1), station.bays - 1 >= station.occupied + inboundTo(state, 1)]).toEqual([true, true]);
    expectRejected(state, { type: 'refundBay', station: 1 }, 'baysInUse');
    must(state, { type: 'refundDrone', drone: added });
    must(state, { type: 'refundBay', station: 1 });
    expect([liveDrones(state).length, totalBays(state)]).toEqual([5, 5]);
  });

  it('退站点也看全城的总数：站 1 是空的，退掉它之后停机位数少于飞机数，baysInUse，飞机数不多于剩下的停机位数时可以退', () => {
    const state = overcrowded();
    // 站 1 自己是空的：没有归属的飞机，没有占用，没有预约。站点是今天建的，别的条件都满足
    expect([fleetOf(state, 1), (state.stations[1] as { occupied: number }).occupied, inboundTo(state, 1)]).toEqual([0, 0, 0]);
    expectRejected(state, { type: 'refundStation', station: 1 }, 'baysInUse'); // 退完停机位 3 个，飞机 5 架
    must(state, { type: 'refundDrone', drone: 4 });
    expectRejected(state, { type: 'refundStation', station: 1 }, 'baysInUse'); // 停机位 3 个，飞机 4 架
    must(state, { type: 'refundDrone', drone: 3 });
    expect(quoteCommand(state, { type: 'refundStation', station: 1 })).toMatchObject({ ok: true, reason: null, kind: 'refund' }); // 停机位 3 个，飞机 3 架
    must(state, { type: 'refundStation', station: 1 });
    expect([liveDrones(state).length, totalBays(state)]).toEqual([3, 3]);
  });
});

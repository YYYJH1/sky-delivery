// 机队时间和排队的计数：每一步给每架没有退回的无人机分一类，高峰窗口内按归属站累计，全天按时刻分 24 段累计占用。
// 高峰窗口内另外按归属站累计回站飞行（飞行并且在回站，空载飞行的一部分）的架·步数，小结记录里写成回站飞行占比 fleetBack。
// 先逐类核对分类和窗口的边界，再在一局真实的运行里与按规格另写的逐步计数对照。
import { describe, expect, it } from 'vitest';
import {
  BUSY_SEGMENTS,
  DAY_STEPS,
  DroneState,
  EVENING_WINDOW,
  FLEET_CLASSES,
  FleetClass,
  NOON_WINDOW,
  RANGE,
  TAKEOFF_STEPS,
  advance,
  busySegmentOf,
  createState,
  emptyTally,
  fleetClassOf,
  hashState,
  isBackFlight,
  peakRecord,
  peakSummary,
  recordFleet,
  recordPeakSummary,
  recordSortie,
  settleDay,
  sharesOf100,
  step,
  summaryStep,
} from '../src/core/index.ts';
import type { Drone, FleetTally, PeakFleet, PeakRecord, SimState, StepObserver } from '../src/core/index.ts';
import { playGame } from '../tools/autoplay-lib.ts';
import { campaignOf, must, outcomeOrder, quietState, roofWhere, runningState, unlockAll, withMoney } from './campaign-helpers.ts';
import { CITY } from './helpers.ts';

const OLD_EAST = roofWhere((r) => r.district === 0 && r.x > 1000 && r.y < 500);

/** 一座站、一架没有退回的无人机，其余都退回：只看这一架的分类。 */
function lone(patch: Partial<Drone>): SimState {
  const state = quietState();
  const [first, ...others] = state.drones;
  for (const d of others) d.removed = true;
  Object.assign(first as Drone, patch);
  state.step = NOON_WINDOW.start + 10;
  return state;
}

/** 一座站的五类计数之和。 */
const total = (row: readonly number[]): number => row.reduce((a, b) => a + b, 0);

describe('分类：每架没有退回的无人机每一步属于五类里的一类', () => {
  const CASES: [string, Partial<Drone>, number][] = [
    ['飞行，不在回站，机上有货：载货飞行', { state: DroneState.Fly, returning: false, onboard: [0] }, FleetClass.Loaded],
    ['飞行，不在回站，机上没货（去店铺取餐）：空载飞行', { state: DroneState.Fly, returning: false, onboard: [] }, FleetClass.Empty],
    ['飞行，在回站：空载飞行', { state: DroneState.Fly, returning: true, onboard: [] }, FleetClass.Empty],
    ['飞行，在回站，机上记着货：仍是空载飞行（回站就是空载）', { state: DroneState.Fly, returning: true, onboard: [0] }, FleetClass.Empty],
    ['起飞：作业', { state: DroneState.Takeoff }, FleetClass.Work],
    ['降落：作业', { state: DroneState.Land }, FleetClass.Work],
    ['取餐：作业', { state: DroneState.Pick }, FleetClass.Work],
    ['送达：作业', { state: DroneState.Drop }, FleetClass.Work],
    ['在店里悬停等出餐：并入作业', { state: DroneState.Prep }, FleetClass.Work],
    ['在起降口排队等起飞：排队', { state: DroneState.TakeoffQueue }, FleetClass.Queue],
    ['在站点上空等降落：排队', { state: DroneState.LandQueue }, FleetClass.Queue],
    ['停在机位上，已经接单（路线不空），还没进起降口的队列：排队', { state: DroneState.Dock, route: [{ kind: 0, order: 0 }] }, FleetClass.Queue],
    ['停在机位上，路线是空的：停放', { state: DroneState.Dock, route: [] }, FleetClass.Parked],
  ];

  it.each(CASES)('%s', (_name, patch, expected) => {
    const state = lone(patch);
    expect(fleetClassOf(state.drones[0] as Drone)).toBe(expected);
    recordFleet(state);
    const row = campaignOf(state).tally.peak.fleet[0] as number[];
    expect(row).toEqual(Array.from({ length: FLEET_CLASSES }, (_, i) => (i === expected ? 1 : 0)));
  });

  it('五类的顺序是载货飞行、空载飞行、作业、排队、停放', () => {
    expect([FleetClass.Loaded, FleetClass.Empty, FleetClass.Work, FleetClass.Queue, FleetClass.Parked]).toEqual([0, 1, 2, 3, 4]);
    expect(FLEET_CLASSES).toBe(5);
  });

  it('已退回的无人机不分类，也不计入任何计数', () => {
    const state = quietState();
    state.step = NOON_WINDOW.start;
    for (const d of state.drones) d.removed = true;
    recordFleet(state);
    const tally = campaignOf(state).tally;
    expect(total((tally.peak.fleet[0] as number[]))).toBe(0);
    expect(total(tally.day.drones)).toBe(0);
    expect(tally.peak.back).toEqual([0]);
    expect(tally.peak.steps).toBe(1); // 步数照计，没有无人机可计
  });
});

describe('回站飞行：飞行并且在回站，是空载飞行的一部分，另计一份，五类的数不变', () => {
  const BACK_CASES: [string, Partial<Drone>, boolean][] = [
    ['飞行，在回站，机上没货：是', { state: DroneState.Fly, returning: true, onboard: [] }, true],
    ['飞行，在回站，机上记着货：是（回站就是空载）', { state: DroneState.Fly, returning: true, onboard: [0] }, true],
    ['飞行，不在回站，机上有货（送货）：不是', { state: DroneState.Fly, returning: false, onboard: [0] }, false],
    ['飞行，不在回站，机上没货（去店铺取餐）：不是，仍是空载飞行', { state: DroneState.Fly, returning: false, onboard: [] }, false],
    ['在站点上空等降落，returning 为真：不是，那是排队', { state: DroneState.LandQueue, returning: true }, false],
    ['降落，returning 为真：不是，那是作业', { state: DroneState.Land, returning: true }, false],
    ['起飞：不是', { state: DroneState.Takeoff }, false],
    ['取餐：不是', { state: DroneState.Pick }, false],
    ['送达：不是', { state: DroneState.Drop }, false],
    ['在店里悬停等出餐：不是', { state: DroneState.Prep }, false],
    ['在起降口排队等起飞：不是', { state: DroneState.TakeoffQueue }, false],
    ['停在机位上：不是', { state: DroneState.Dock, route: [] }, false],
  ];

  it.each(BACK_CASES)('%s', (_name, patch, expected) => {
    const state = lone(patch);
    const drone = state.drones[0] as Drone;
    expect(isBackFlight(drone)).toBe(expected);
    recordFleet(state);
    const peak = campaignOf(state).tally.peak;
    expect(peak.back).toEqual([expected ? 1 : 0]);
    // 五类的数不变：回站飞行仍然算在空载飞行里，每一类各计一次，不因为另计回站而多算一次
    expect(peak.fleet[0]).toEqual(Array.from({ length: FLEET_CLASSES }, (_, i) => (i === fleetClassOf(drone) ? 1 : 0)));
    if (expected) expect((peak.fleet[0] as number[])[FleetClass.Empty]).toBe(1);
  });

  it('按无人机的归属站（home）计，不按它现在飞往哪座站或停在哪座站', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: OLD_EAST });
    const [a, b] = state.drones as [Drone, Drone];
    state.drones.forEach((d) => (d.removed = d.id > 1));
    // a 归属 0 号站，正在飞往 1 号站。b 归属 1 号站，正在飞往 0 号站
    Object.assign(a, { home: 0, state: DroneState.Fly, returning: true, target: 1, station: -1 });
    Object.assign(b, { home: 1, state: DroneState.Fly, returning: true, target: 0, station: -1 });
    state.step = NOON_WINDOW.start + 5;
    recordFleet(state);
    recordFleet(state);
    Object.assign(b, { returning: false, onboard: [0] }); // 第三步 b 改成载货飞行
    recordFleet(state);
    expect(campaignOf(state).tally.peak.back).toEqual([3, 2]);
    expect((campaignOf(state).tally.peak.fleet[1] as number[])[FleetClass.Loaded]).toBe(1);
  });

  it('同一步有几架在回站，按架数计；已退回的不计', () => {
    const state = lone({ state: DroneState.Fly, returning: true });
    const clone = structuredClone(state.drones[0] as Drone);
    clone.id = 98;
    const gone = structuredClone(clone);
    gone.id = 99;
    gone.removed = true;
    state.drones.push(clone, gone);
    recordFleet(state);
    expect(campaignOf(state).tally.peak.back).toEqual([2]);
  });

  it('只在高峰窗口内计：窗口外和第二天的窗口外都不动，窗口内每一步都计', () => {
    const state = lone({ state: DroneState.Fly, returning: true });
    const outside = [0, NOON_WINDOW.start - 1, NOON_WINDOW.end, EVENING_WINDOW.start - 1, EVENING_WINDOW.end, DAY_STEPS - 1, DAY_STEPS + NOON_WINDOW.start - 1];
    const inside = [NOON_WINDOW.start, NOON_WINDOW.end - 1, EVENING_WINDOW.start, EVENING_WINDOW.end - 1, DAY_STEPS + NOON_WINDOW.start];
    for (const tick of outside) {
      state.step = tick;
      recordFleet(state);
    }
    expect(campaignOf(state).tally.peak.back).toEqual([0]);
    for (const tick of inside) {
      state.step = tick;
      recordFleet(state);
    }
    expect(campaignOf(state).tally.peak.back).toEqual([inside.length]);
    // 全天的占用计数照常累加，与高峰窗口无关
    expect(total(campaignOf(state).tally.day.drones)).toBe(outside.length + inside.length);
  });

  it('新建的站从建成之后的第一次累加起补上一项，已有的计数不动', () => {
    const state = withMoney(lone({ state: DroneState.Fly, returning: true }));
    state.step = NOON_WINDOW.start;
    recordFleet(state);
    const peak = campaignOf(state).tally.peak;
    expect(peak.back).toEqual([1]);
    must(state, { type: 'buildStation', roof: OLD_EAST });
    state.step += 1;
    recordFleet(state);
    expect(peak.back).toEqual([2, 0]);
    expect(peak.back).toHaveLength(peak.fleet.length);
  });

  it('每座站一项：开局时和 emptyTally 里，回站飞行的数组与另外四项同样长', () => {
    const state = createState({ mode: 'campaign', seed: 3 });
    const peak = campaignOf(state).tally.peak;
    expect([peak.back.length, peak.fleet.length, peak.takeoffWait.length, peak.queue.length, peak.sorties.length]).toEqual([1, 1, 1, 1, 1]);
    expect(emptyTally(3).peak.back).toEqual([0, 0, 0]);
    expect(emptyTally(3).peak).toEqual({ steps: 0, fleet: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], back: [0, 0, 0], takeoffWait: [0, 0, 0], queue: [0, 0, 0], sorties: [0, 0, 0] });
  });
});

describe('按归属站和所在的站分别计数', () => {
  it('五类按无人机的归属站（home）计，等待起飞和排队的步数按无人机所在的站（station）计', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: OLD_EAST });
    const [a, b] = state.drones as [Drone, Drone];
    // a 归属 0 号站，现在在 1 号站上空等降落。b 归属 1 号站（改归属），在 0 号站的机位上已经接单排队等起飞
    state.drones.forEach((d) => (d.removed = d.id > 1));
    Object.assign(a, { home: 0, state: DroneState.LandQueue, station: 1, returning: true });
    Object.assign(b, { home: 1, state: DroneState.TakeoffQueue, station: 0, route: [{ kind: 0, order: 0 }] });
    state.step = NOON_WINDOW.start + 5;
    recordFleet(state);
    const peak = campaignOf(state).tally.peak;
    expect((peak.fleet[0] as number[])[FleetClass.Queue]).toBe(1); // a 的归属站是 0
    expect((peak.fleet[1] as number[])[FleetClass.Queue]).toBe(1); // b 的归属站是 1
    expect(peak.queue).toEqual([1, 1]); // b 在 0 号站排队，a 在 1 号站上空排队
    expect(peak.takeoffWait).toEqual([1, 0]); // 只有 b 在等起飞，a 在等降落，不算等起飞
  });

  it('同一座站同一步有几架在排队，只算一步', () => {
    const state = lone({ state: DroneState.TakeoffQueue, station: 0 });
    const clone = structuredClone(state.drones[0] as Drone);
    clone.id = 99;
    clone.removed = false;
    clone.state = DroneState.LandQueue;
    state.drones.push(clone);
    recordFleet(state);
    const peak = campaignOf(state).tally.peak;
    expect(peak.queue).toEqual([1]);
    expect(peak.takeoffWait).toEqual([1]);
    expect((peak.fleet[0] as number[])[FleetClass.Queue]).toBe(2); // 架·步按架数计
  });

  it('等待起飞包括停在机位上已经接单的，不包括等降落，也不包括别的状态', () => {
    for (const [patch, wait, queue] of [
      [{ state: DroneState.Dock, route: [{ kind: 0, order: 0 }] }, 1, 1],
      [{ state: DroneState.TakeoffQueue }, 1, 1],
      [{ state: DroneState.LandQueue }, 0, 1],
      [{ state: DroneState.Dock, route: [] }, 0, 0],
      [{ state: DroneState.Takeoff }, 0, 0],
      [{ state: DroneState.Fly }, 0, 0],
    ] as [Partial<Drone>, number, number][]) {
      const state = lone({ station: 0, ...patch });
      recordFleet(state);
      const peak = campaignOf(state).tally.peak;
      expect([peak.takeoffWait[0], peak.queue[0]], JSON.stringify(patch)).toEqual([wait, queue]);
    }
  });
});

describe('高峰窗口：午高峰第 600 到 1499 步，晚高峰第 2150 到 3099 步', () => {
  it('窗口内每一步都计，窗口外的高峰计数不动', () => {
    const state = lone({ state: DroneState.Dock });
    const inside = [NOON_WINDOW.start, NOON_WINDOW.end - 1, EVENING_WINDOW.start, EVENING_WINDOW.end - 1];
    const outside = [0, NOON_WINDOW.start - 1, NOON_WINDOW.end, EVENING_WINDOW.start - 1, EVENING_WINDOW.end, DAY_STEPS - 1];
    for (const tick of outside) {
      state.step = tick;
      recordFleet(state);
    }
    expect(campaignOf(state).tally.peak.steps).toBe(0);
    expect(total(campaignOf(state).tally.peak.fleet[0] ?? [])).toBe(0);
    for (const tick of inside) {
      state.step = tick;
      recordFleet(state);
    }
    expect(campaignOf(state).tally.peak.steps).toBe(inside.length);
    expect((campaignOf(state).tally.peak.fleet[0] as number[])[FleetClass.Parked]).toBe(inside.length);
  });

  it('第二天同样：窗口按天内的步算', () => {
    const state = lone({ state: DroneState.Dock });
    for (const tick of [NOON_WINDOW.start - 1, NOON_WINDOW.start, NOON_WINDOW.end - 1, NOON_WINDOW.end]) {
      state.step = DAY_STEPS + tick;
      recordFleet(state);
    }
    expect(campaignOf(state).tally.peak.steps).toBe(2);
  });

  it('放行起飞的架次只在窗口内计，按放行的站计', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: OLD_EAST });
    state.step = NOON_WINDOW.start - 1;
    recordSortie(state, 0);
    state.step = NOON_WINDOW.start;
    recordSortie(state, 0);
    recordSortie(state, 1);
    recordSortie(state, 1);
    state.step = NOON_WINDOW.end;
    recordSortie(state, 1);
    expect(campaignOf(state).tally.peak.sorties).toEqual([1, 2]);
  });
});

describe('全天按时刻分 24 段，每段 150 步', () => {
  it('第 i 段是天内第 150i 到 150i + 149 步', () => {
    expect(BUSY_SEGMENTS).toBe(24);
    expect([0, 1, 149, 150, 299, 300, 3449, 3450, 3599].map(busySegmentOf)).toEqual([0, 0, 0, 1, 1, 2, 22, 23, 23]);
    expect(busySegmentOf(DAY_STEPS)).toBe(0);
    expect(busySegmentOf(DAY_STEPS + 150)).toBe(1);
  });

  it('占用：不是停放就占用，停放但电量没满（正在充电）也占用，停放且满电不占用', () => {
    const cases: [string, Partial<Drone>, number][] = [
      ['停放，满电', { state: DroneState.Dock, battery: RANGE }, 0],
      ['停放，差一点点没满电', { state: DroneState.Dock, battery: RANGE - 0.001 }, 1],
      ['停放，电量耗尽', { state: DroneState.Dock, battery: 0 }, 1],
      ['飞行，满电', { state: DroneState.Fly, battery: RANGE }, 1],
      ['等降落', { state: DroneState.LandQueue, battery: RANGE }, 1],
      ['排队等起飞，满电', { state: DroneState.TakeoffQueue, battery: RANGE }, 1],
      ['停在机位上已经接单，满电', { state: DroneState.Dock, battery: RANGE, route: [{ kind: 0, order: 0 }] }, 1],
    ];
    for (const [name, patch, used] of cases) {
      const state = lone(patch);
      state.step = 1 * 150 + 3; // 第 1 段，不在高峰窗口里，一天的计数照样累加
      recordFleet(state);
      const day = campaignOf(state).tally.day;
      expect(day.drones[1], name).toBe(1);
      expect(day.used[1], name).toBe(used);
      expect(total(day.drones) + total(day.used), name).toBe(1 + used);
      expect(campaignOf(state).tally.peak.steps, name).toBe(0);
    }
  });

  it('每一段累计全部没有退回的无人机的架·步数', () => {
    const state = quietState();
    expect(state.drones).toHaveLength(2);
    for (let i = 0; i < 150; i++) {
      state.step = 150 + i;
      recordFleet(state);
    }
    const day = campaignOf(state).tally.day;
    expect(day.drones[1]).toBe(2 * 150);
    expect(day.drones[0]).toBe(0);
    expect(day.drones[2]).toBe(0);
  });
});

describe('新建的站从建成之后的第一次累加起补上一行', () => {
  it('在高峰窗口里建站：下一步计数的行数跟上站的数量，已有的计数不动', () => {
    const state = withMoney(quietState());
    state.step = NOON_WINDOW.start;
    recordFleet(state);
    const peak = campaignOf(state).tally.peak;
    expect(peak.fleet).toHaveLength(1);
    must(state, { type: 'buildStation', roof: OLD_EAST });
    state.step += 1;
    recordFleet(state);
    expect([peak.fleet.length, peak.takeoffWait.length, peak.queue.length, peak.sorties.length]).toEqual([2, 2, 2, 2]);
    expect(total(peak.fleet[0] as number[])).toBe(4); // 两架无人机，两步
    expect(total(peak.fleet[1] as number[])).toBe(0);
    expect(peak.steps).toBe(2);
  });
});

// ---- 与按规格另写的逐步计数对照 ----

interface Expected {
  steps: number;
  fleet: number[][];
  back: number[];
  takeoffWait: number[];
  queue: number[];
  sorties: number[];
  dayDrones: number[];
  dayUsed: number[];
}

/** 逐步重算：不引用核心里的分类函数，按规格另写一遍，每一步统计阶段结束时累加。 */
function expectedObserver(expected: Expected): StepObserver {
  const classOf = (d: Drone): number => {
    if (d.state === DroneState.Fly) return !d.returning && d.onboard.length > 0 ? 0 : 1;
    if (d.state === DroneState.Takeoff || d.state === DroneState.Land || d.state === DroneState.Pick || d.state === DroneState.Drop || d.state === DroneState.Prep) return 2;
    if (d.state === DroneState.TakeoffQueue || d.state === DroneState.LandQueue || (d.state === DroneState.Dock && d.route.length > 0)) return 3;
    return 4;
  };
  const inWindow = (stepNow: number): boolean => {
    const tick = stepNow % DAY_STEPS;
    return (tick >= NOON_WINDOW.start && tick < NOON_WINDOW.end) || (tick >= EVENING_WINDOW.start && tick < EVENING_WINDOW.end);
  };
  const grow = (n: number): void => {
    while (expected.fleet.length < n) {
      expected.fleet.push([0, 0, 0, 0, 0]);
      expected.back.push(0);
      expected.takeoffWait.push(0);
      expected.queue.push(0);
      expected.sorties.push(0);
    }
  };
  return {
    after(phase, s) {
      if (phase === 'gates' && inWindow(s.step)) {
        grow(s.stations.length);
        // 这一步从起降口放行起飞的：起飞动作刚好在这一步开始
        for (const d of s.drones) {
          if (d.removed || d.state !== DroneState.Takeoff || d.tEnd - TAKEOFF_STEPS !== s.step) continue;
          expected.sorties[d.station] = (expected.sorties[d.station] as number) + 1;
        }
        return;
      }
      if (phase !== 'stats') return;
      const segment = Math.floor((s.step % DAY_STEPS) / 150);
      const peak = inWindow(s.step);
      if (peak) {
        grow(s.stations.length);
        expected.steps += 1;
      }
      const waiting = new Set<number>();
      const queued = new Set<number>();
      for (const d of s.drones) {
        if (d.removed) continue;
        const cls = classOf(d);
        expected.dayDrones[segment] = (expected.dayDrones[segment] as number) + 1;
        if (cls !== 4 || d.battery < RANGE) expected.dayUsed[segment] = (expected.dayUsed[segment] as number) + 1;
        if (!peak) continue;
        const row = expected.fleet[d.home] as number[];
        row[cls] = (row[cls] as number) + 1;
        // 回站飞行：飞行并且在回站。按规格另写，不引用核心里的 isBackFlight
        if (d.state === DroneState.Fly && d.returning) expected.back[d.home] = (expected.back[d.home] as number) + 1;
        if (d.state === DroneState.TakeoffQueue || (d.state === DroneState.Dock && d.route.length > 0)) {
          waiting.add(d.station);
          queued.add(d.station);
        } else if (d.state === DroneState.LandQueue) {
          queued.add(d.station);
        }
      }
      for (const id of waiting) expected.takeoffWait[id] = (expected.takeoffWait[id] as number) + 1;
      for (const id of queued) expected.queue[id] = (expected.queue[id] as number) + 1;
    },
  };
}

/** 两座站、几架无人机、来单不少的经营模式局面（三个片区都开通，三星）：高峰里有起降排队。 */
function busyState(seed: number): SimState {
  const state = withMoney(unlockAll(runningState(seed, [3, 3, 3], [true, true, true])));
  must(state, { type: 'buildStation', roof: OLD_EAST });
  for (const station of [0, 1]) {
    must(state, { type: 'buyBay', station });
    must(state, { type: 'buyBay', station });
    must(state, { type: 'buyDrone', station });
    must(state, { type: 'buyDrone', station });
  }
  return state;
}

describe('与逐步重算的结果对照', () => {
  it.each([7, 11])('种子 %i：跑到午高峰结束之后，当场高峰的计数、占用的分段计数与逐步重算的完全相同', (seed) => {
    const state = busyState(seed);
    const expected: Expected = { steps: 0, fleet: [], back: [], takeoffWait: [], queue: [], sorties: [], dayDrones: new Array<number>(BUSY_SEGMENTS).fill(0), dayUsed: new Array<number>(BUSY_SEGMENTS).fill(0) };
    const observer = expectedObserver(expected);
    // 午高峰的小结在第 1800 步生成，计数在那一步读出并清零，所以停在第 1700 步核对
    while (state.step < 1700) step(state, observer);
    const tally = campaignOf(state).tally;
    expect(tally.peak.steps).toBe(NOON_WINDOW.end - NOON_WINDOW.start);
    expect(tally.peak.fleet).toEqual(expected.fleet);
    expect(tally.peak.back).toEqual(expected.back);
    expect(tally.peak.takeoffWait).toEqual(expected.takeoffWait);
    expect(tally.peak.queue).toEqual(expected.queue);
    expect(tally.peak.sorties).toEqual(expected.sorties);
    expect(tally.day.drones).toEqual(expected.dayDrones);
    expect(tally.day.used).toEqual(expected.dayUsed);
    // 不是空转：四座站里有放行起飞的，各类里除了排队都有数
    expect(total(expected.sorties)).toBeGreaterThan(10);
    for (const cls of [FleetClass.Loaded, FleetClass.Empty, FleetClass.Work, FleetClass.Parked]) {
      expect(total(expected.fleet.map((row) => row[cls] as number)), `class ${cls}`).toBeGreaterThan(0);
    }
    // 回站飞行有数，并且是空载飞行的一部分：每座站的回站飞行不多于它的空载飞行，合计也严格少于空载飞行（去店铺取餐的飞行不算回站）
    expect(total(expected.back)).toBeGreaterThan(0);
    expected.fleet.forEach((row, id) => expect(expected.back[id] as number, `station ${id}`).toBeLessThanOrEqual(row[FleetClass.Empty] as number));
    expect(total(expected.back)).toBeLessThan(total(expected.fleet.map((row) => row[FleetClass.Empty] as number)));
    // 每一步每架没有退回的无人机恰好计一次：各站五类之和等于步数乘无人机数
    const live = state.drones.filter((d) => !d.removed).length;
    expect(total(expected.fleet.map(total))).toBe(live * tally.peak.steps);
    expect(total(expected.dayDrones)).toBe(live * 1700);
  });
});

describe('不影响任何决定，沙盒模式不计数', () => {
  it('沙盒模式的状态里没有计数，运行之后也没有', () => {
    const state = createState(CITY);
    advance(state, DAY_STEPS);
    expect(state.campaign).toBeNull();
    expect(JSON.stringify(state)).not.toContain('tally');
  });

  it('计数只读状态：把计数清零或者改乱，之后每一步的订单、飞机和站点都不变', () => {
    const a = busyState(7);
    const b = busyState(7);
    for (let i = 0; i < 2000; i++) {
      if (i % 97 === 0) {
        const tally = campaignOf(b).tally;
        tally.peak.steps = 12345;
        tally.peak.fleet.forEach((row) => row.fill(7));
        tally.peak.back.fill(5);
        tally.day.used.fill(99);
      }
      step(a);
      step(b);
    }
    expect(JSON.stringify([b.orders, b.drones, b.stations, b.pending, b.stats, b.rng])).toBe(JSON.stringify([a.orders, a.drones, a.stations, a.pending, a.stats, a.rng]));
    expect(hashState(a)).not.toBe(hashState(b)); // 计数在哈希里
  });

  it('计数很小：打了几个游戏日之后，两份计数的序列化长度也只有几百字符，不按秒存历史', () => {
    const { state } = playGame('balanced', 3, { days: 6 });
    const text = JSON.stringify(campaignOf(state).tally);
    expect(text.length).toBeLessThan(1500);
    expect(campaignOf(state).tally.day.drones).toHaveLength(BUSY_SEGMENTS);
  });
});

// ---- 小结和日结的记录 ----

/** 五项的数组折成 PeakFleet，顺序与计数行相同。 */
function fleetOf100(counts: readonly number[]): PeakFleet {
  const [loaded, empty, work, queue, parked] = sharesOf100(counts) as [number, number, number, number, number];
  return { loaded, empty, work, queue, parked };
}

/** 把当场高峰的计数设成 peak 里给出的项，在午高峰的小结时刻生成这一场的记录。 */
function recordWith(state: SimState, peak: Partial<FleetTally['peak']>): PeakRecord {
  Object.assign(campaignOf(state).tally.peak, peak);
  state.step = summaryStep(0, 'noon');
  return recordPeakSummary(state, 0, 'noon');
}

describe('小结的记录：机队时间构成和各站的一行', () => {
  it('机队时间构成：五类折成加起来是 100 的整数，按最大余数分配，work 包括等待出餐', () => {
    const state = quietState();
    const record = recordWith(state, { steps: 900, fleet: [[100, 200, 300, 40, 260]] });
    // 100、200、300、40、260 占 900 的 11.1%、22.2%、33.3%、4.4%、28.9%，下取整之后加起来是 98，余数最大的两项（28.9 和 4.4）各补 1
    expect(record.fleet).toEqual({ loaded: 11, empty: 22, work: 33, queue: 5, parked: 29 });
    expect(Object.values(record.fleet as PeakFleet).reduce((a, b) => a + b, 0)).toBe(100);
    expect(record.stations[0]?.fleet).toEqual(record.fleet); // 只有一座站，两者相同
    expect(Object.keys(record.fleet as PeakFleet)).toEqual(['loaded', 'empty', 'work', 'queue', 'parked']);
  });

  it('回站飞行占比：回站飞行的架·步数除以五类之和，下取整，恰好整除的不少算，差一个架·步记低一档', () => {
    // 五类合计 900 架·步，回站 162 架·步是空载飞行 350 的一部分：162 / 900 恰好 18%
    expect(recordWith(quietState(), { steps: 900, fleet: [[300, 350, 200, 0, 50]], back: [162] }).fleetBack).toBe(18);
    // 差一个架·步：161 / 900 = 17.9%，记 17
    expect(recordWith(quietState(), { steps: 900, fleet: [[300, 350, 200, 0, 50]], back: [161] }).fleetBack).toBe(17);
    // 没有回站飞行是 0，不是 null。全部都在回站飞行是 100
    expect(recordWith(quietState(), { steps: 900, fleet: [[300, 350, 200, 0, 50]], back: [0] }).fleetBack).toBe(0);
    expect(recordWith(quietState(), { steps: 900, fleet: [[0, 900, 0, 0, 0]], back: [900] }).fleetBack).toBe(100);
  });

  it('回站飞行占比是整数，不大于机队时间构成里的空载飞行：回站是空载飞行的一部分，下取整的占比不会超过按最大余数分配的占比', () => {
    const record = recordWith(quietState(), { steps: 900, fleet: [[300, 350, 200, 0, 50]], back: [350] }); // 空载飞行全是回站
    expect(record.fleet?.empty).toBe(39); // 38.9% 按最大余数分配，补到 39
    expect(record.fleetBack).toBe(38); // 38.9% 下取整
    expect(Number.isInteger(record.fleetBack)).toBe(true);
  });

  it('回站飞行占比的分母与机队时间构成相同，分子也一样不含退回的站：退回的站里的回站飞行不算', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: OLD_EAST });
    must(state, { type: 'buildStation', roof: roofWhere((r, i) => r.district === 0 && !r.opening && i !== OLD_EAST) });
    must(state, { type: 'refundStation', station: 1 });
    // 0 号站 100 架·步，回站 6。1 号站已退回，50 架·步，全是回站。2 号站 100 架·步，回站 14
    const record = recordWith(state, { steps: 900, fleet: [[40, 10, 30, 10, 10], [0, 50, 0, 0, 0], [10, 20, 40, 10, 20]], back: [6, 50, 14] });
    expect(record.fleet).toEqual(fleetOf100([50, 30, 70, 20, 30]));
    // 没有退回的两座站合计 200 架·步，回站 20，占 10%。把退回的站算进去就是 70 / 250 = 28%
    expect(record.fleetBack).toBe(10);
  });

  it('计数里没有某座站的回站项（数组比站短）时按 0 算，占比照常给出', () => {
    const record = recordWith(quietState(), { steps: 900, fleet: [[100, 200, 300, 40, 260]], back: [] });
    expect(record.fleetBack).toBe(0);
    expect(record.fleet).not.toBeNull();
  });

  it('各站的两个时间占比是计数除以这一场的步数，下取整：恰好 15% 记 15，差一步记 14', () => {
    const state = quietState();
    const record = recordWith(state, { steps: 900, takeoffWait: [135], queue: [134], sorties: [7], fleet: [[1, 1, 1, 0, 0]] });
    const row = record.stations[0];
    expect([row?.takeoffWaitPct, row?.queuePct, row?.sorties]).toEqual([15, 14, 7]);
    expect(row?.fleet).toEqual({ loaded: 34, empty: 33, work: 33, queue: 0, parked: 0 });
  });

  it('分母取计数覆盖的步数：只覆盖了一部分的高峰（从旧存档迁移之后的第一场）按覆盖的步数算', () => {
    const state = quietState();
    const record = recordWith(state, { steps: 300, takeoffWait: [60], queue: [90], fleet: [[0, 0, 0, 0, 0]] });
    expect([record.stations[0]?.takeoffWaitPct, record.stations[0]?.queuePct]).toEqual([20, 30]);
  });

  it('没有计数：占比和架次是 0，机队时间构成是 null，没有已送达的订单时起降排队是 null', () => {
    const state = quietState();
    const record = recordWith(state, {});
    expect(record.fleet).toBeNull();
    expect(record.fleetBack).toBeNull(); // 与机队时间构成同时为 null
    expect(record.stations).toEqual([{ station: 0, gateWait: null, landWaitAvg: 0, takeoffWaitPct: 0, queuePct: 0, sorties: 0, fleet: null }]);
  });

  it('只列没有退回的站，按编号排；合计的机队时间构成不含退回的站', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: OLD_EAST });
    must(state, { type: 'buildStation', roof: roofWhere((r, i) => r.district === 0 && !r.opening && i !== OLD_EAST) });
    must(state, { type: 'refundStation', station: 1 }); // 当天建的站当天原价退回
    expect(state.stations.map((s) => s.removed)).toEqual([false, true, false]);
    const record = recordWith(state, { steps: 900, fleet: [[10, 0, 0, 0, 0], [0, 20, 0, 0, 0], [0, 0, 30, 0, 0]], sorties: [1, 2, 3] });
    expect(record.stations.map((r) => r.station)).toEqual([0, 2]);
    expect(record.stations.map((r) => r.sorties)).toEqual([1, 3]);
    expect(record.fleet).toEqual(fleetOf100([10, 0, 30, 0, 0])); // 1 号站退回了，它的 20 不算
    expect(record.stations[0]?.fleet).toEqual({ loaded: 100, empty: 0, work: 0, queue: 0, parked: 0 });
    expect(record.stations[1]?.fleet).toEqual({ loaded: 0, empty: 0, work: 100, queue: 0, parked: 0 });
  });

  it('起降排队：这一场已送达的订单，按从哪座站起飞分组，平均起降排队的秒数；窗口外的订单、小结时刻之后才送达的订单不算', () => {
    const state = quietState();
    outcomeOrder(state, { district: 0, tOrder: 599, delivered: 900, gateWait: 100, departed: 0 }); // 下单在窗口外
    outcomeOrder(state, { district: 0, tOrder: 700, delivered: 1000, gateWait: 14, departed: 0 });
    outcomeOrder(state, { district: 0, tOrder: 701, delivered: 1001, gateWait: 6, departed: 0 });
    outcomeOrder(state, { district: 0, tOrder: 1100, delivered: 1800, gateWait: 500, departed: 0 }); // 小结时刻才送达，不算
    outcomeOrder(state, { district: 0, tOrder: 1200, gateWait: 999, departed: 0 }); // 还没送达，不算
    outcomeOrder(state, { district: 0, tOrder: 1499, delivered: 1799, gateWait: 30, departed: 0 }); // 小结时刻的前一步送达，算
    outcomeOrder(state, { district: 0, tOrder: 1500, delivered: 1700, gateWait: 400, departed: 0 }); // 下单在窗口外（窗口是 [600, 1500)）
    const record = recordWith(state, {});
    expect(record.stations[0]?.gateWait).toBeCloseTo((14 + 6 + 30) / 3 / 10, 12);
    expect(record.stations[0]?.gateWait).toBeCloseTo(5 / 3, 12);
  });

  it('起降排队按起飞的站分：两座站各算各的，没有从这座站起飞的已送达订单时是 null', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: OLD_EAST });
    outcomeOrder(state, { district: 0, tOrder: 700, delivered: 1000, gateWait: 20, departed: 1 });
    outcomeOrder(state, { district: 0, tOrder: 710, delivered: 1010, gateWait: 40, departed: 1 });
    const record = recordWith(state, {});
    expect(record.stations.map((r) => r.gateWait)).toEqual([null, 3]);
  });

  it('等待降落的平均架数：与 peakSummary 里同一座站的 landWaitAvg 逐位相同', () => {
    const state = quietState();
    // 午高峰的 90 秒里，每秒累计 5 步有飞机在等降落，也就是平均 0.5 架；窗口外每秒累计 10 步，不算
    const row = state.stats.landWait[0] as number[];
    for (let sec = 0; sec < 150; sec++) row[sec] = sec >= 60 ? 5 : 10;
    const record = recordWith(state, {});
    expect(record.stations[0]?.landWaitAvg).toBe(peakSummary(state, 0, 'noon').stations[0]?.landWaitAvg);
    expect(record.stations[0]?.landWaitAvg).toBe(0.5);
  });

  it('生成记录之后，当场高峰的计数清零，每座站的行留着，下一场高峰重新累计', () => {
    const state = quietState();
    recordWith(state, { steps: 900, takeoffWait: [5], queue: [6], sorties: [7], fleet: [[1, 2, 3, 4, 5]], back: [2] });
    expect(campaignOf(state).tally.peak).toEqual({ steps: 0, fleet: [[0, 0, 0, 0, 0]], back: [0], takeoffWait: [0], queue: [0], sorties: [0] });
  });
});

describe('日结的记录：运力占用', () => {
  /** 把当天的计数设成 drones 和 used，做第 0 天的日结，返回这一天的 busy。 */
  function settleWith(state: SimState, drones: number[], used: number[]): number[] | null {
    const day = campaignOf(state).tally.day;
    drones.forEach((n, i) => (day.drones[i] = n));
    used.forEach((n, i) => (day.used[i] = n));
    state.step = DAY_STEPS;
    return settleDay(state, 0).busy;
  }

  it('24 个整数：每段的占用百分数下取整，这一段没有无人机时是 0', () => {
    const state = quietState();
    const busy = settleWith(state, [3, 3, 7, 0, 450, 450], [1, 2, 7, 0, 449, 1]);
    expect(busy).toHaveLength(24);
    expect(busy?.slice(0, 6)).toEqual([33, 66, 100, 0, 99, 0]);
    expect(busy?.slice(6).every((n) => n === 0)).toBe(true);
    expect(busy?.every((n) => Number.isInteger(n) && n >= 0 && n <= 100)).toBe(true);
  });

  it('日结写入记录并清空当天的计数，记录之后不再改动', () => {
    const state = quietState();
    settleWith(state, [3], [3]);
    expect(campaignOf(state).tally.day).toEqual({ drones: new Array<number>(24).fill(0), used: new Array<number>(24).fill(0) });
    const before = JSON.stringify(campaignOf(state).days[0]);
    campaignOf(state).tally.day.drones[0] = 9; // 第二天的计数
    state.step = DAY_STEPS + 1; // 日结已经做过，接着推进几步
    advance(state, 5);
    expect(JSON.stringify(campaignOf(state).days[0])).toBe(before);
  });

  it('没有记过计数的一天（刚读档的旧存档的当天）：全是 0', () => {
    const state = quietState();
    state.step = DAY_STEPS;
    expect(settleDay(state, 0).busy).toEqual(new Array<number>(24).fill(0));
  });
});

describe('一局真实的运行：记录与逐步重算的结果相同', () => {
  it('午高峰的小结：机队时间构成、各站的行和起降排队都与按规格另写的结果相同，生成记录之后不再改动', () => {
    const state = busyState(7);
    const expected: Expected = { steps: 0, fleet: [], back: [], takeoffWait: [], queue: [], sorties: [], dayDrones: new Array<number>(BUSY_SEGMENTS).fill(0), dayUsed: new Array<number>(BUSY_SEGMENTS).fill(0) };
    const observer = expectedObserver(expected);
    while (state.step < 1800) step(state, observer);
    expect(peakRecord(state, 0, 'noon')).toBeNull(); // 小结在第 1800 步开始时生成
    step(state, observer);
    const record = peakRecord(state, 0, 'noon');
    if (record === null) throw new Error('the noon summary should exist');
    expect(expected.steps).toBe(NOON_WINDOW.end - NOON_WINDOW.start);
    // 合计和各站的机队时间构成
    const sum = [0, 1, 2, 3, 4].map((i) => total(expected.fleet.map((row) => row[i] as number)));
    expect(record.fleet).toEqual(fleetOf100(sum));
    // 回站飞行占比：合计的回站飞行架·步数除以五类之和，下取整
    expect(record.fleetBack).toBe(Math.floor((100 * total(expected.back)) / total(expected.fleet.map(total))));
    expect(record.fleetBack as number).toBeGreaterThan(0);
    expect(record.fleetBack as number).toBeLessThanOrEqual((record.fleet as PeakFleet).empty);
    expect(campaignOf(state).tally.peak.back).toEqual([0, 0]); // 读完清零
    expect(record.stations.map((r) => r.station)).toEqual([0, 1]);
    record.stations.forEach((row, id) => {
      expect(row.fleet).toEqual(fleetOf100(expected.fleet[id] as number[]));
      expect(row.takeoffWaitPct).toBe(Math.floor((100 * (expected.takeoffWait[id] as number)) / expected.steps));
      expect(row.queuePct).toBe(Math.floor((100 * (expected.queue[id] as number)) / expected.steps));
      expect(row.sorties).toBe(expected.sorties[id]);
      expect(row.landWaitAvg).toBe(peakSummary(state, 0, 'noon').stations[id]?.landWaitAvg);
      // 起降排队：按订单另算一遍
      const mine = state.orders.filter((o) => o.tOrder >= NOON_WINDOW.start && o.tOrder < NOON_WINDOW.end && o.tDeliver >= 0 && o.tDeliver < 1800 && o.departed === id);
      const mean = mine.length === 0 ? null : mine.reduce((a, o) => a + o.gateWait, 0) / mine.length / 10;
      expect(row.gateWait).toBe(mean);
    });
    // 不是空转
    expect(record.stations.some((r) => r.gateWait !== null && r.gateWait > 0)).toBe(true);
    expect(record.stations.some((r) => r.takeoffWaitPct > 0)).toBe(true);
    expect(record.stations.every((r) => r.sorties > 0)).toBe(true);
    // 生成之后不再改动：后面的几场高峰、日结之后，这一场的记录逐字相同
    const before = JSON.stringify(record);
    advance(state, 2 * DAY_STEPS);
    expect(JSON.stringify(peakRecord(state, 0, 'noon'))).toBe(before);
  });

  it('日结：一天 24 段的占用百分数与按逐步重算的分段计数相同，日结之后当天的计数从零开始', () => {
    const state = busyState(11);
    const expected: Expected = { steps: 0, fleet: [], back: [], takeoffWait: [], queue: [], sorties: [], dayDrones: new Array<number>(BUSY_SEGMENTS).fill(0), dayUsed: new Array<number>(BUSY_SEGMENTS).fill(0) };
    const observer = expectedObserver(expected);
    while (state.step < DAY_STEPS) step(state, observer); // 第 0 天的 3600 步
    step(state); // 第 3600 步：日结
    const record = campaignOf(state).days[0];
    if (record === undefined || record.busy === null) throw new Error('the first settlement should have a busy band');
    expect(record.busy).toEqual(expected.dayDrones.map((n, i) => (n > 0 ? Math.floor((100 * (expected.dayUsed[i] as number)) / n) : 0)));
    expect(record.busy).toHaveLength(24);
    expect(record.busy.some((n) => n > 0)).toBe(true);
    expect(record.busy.some((n) => n < 100)).toBe(true);
    // 第 3600 步已经属于第 1 天，日结清零之后这一步先计进第 0 段
    const live = state.drones.filter((d) => !d.removed).length;
    expect(total(campaignOf(state).tally.day.drones)).toBe(live);
    expect(campaignOf(state).tally.day.drones[0]).toBe(live);
  });
});

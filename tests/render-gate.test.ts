// 起降口的画面：等起飞的飞机、起降口的等级和环的转动、站点旁等起飞和等降落两行字的摆放。
// 都是 scene.ts 里的纯函数，不碰 Pixi 和画布：状态进，数据出。
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { DroneState, STEPS_PER_SECOND } from '../src/core/index.ts';
import type { Drone } from '../src/core/index.ts';
import { markerUnits } from '../src/render/camera.ts';
import { STATION_SIZES } from '../src/render/city.ts';
import { overlapArea } from '../src/render/geometry.ts';
import type { Rect } from '../src/render/geometry.ts';
import { GATE_BEAD, GATE_FIRST, GATE_MARGIN, GATE_MAX_LEVEL, GATE_REST, GATE_STEP, gateExtent, gateOuter, gateRings, landingCircle } from '../src/render/layout.ts';
import { TAKEOFF_GRACE_STEPS, awaitsTakeoff, gateLevelOf, gateTurn, holdingSlots, labelSpots, pickLabelSpot, showsTakeoffWait, stackLines, takeoffCounts } from '../src/render/scene.ts';
import { quietState, must, withMoney } from './campaign-helpers.ts';
import { CITY, stateOf, stepEach } from './helpers.ts';

/** 一架测试用的飞机：只给画面要看的几个字段。queuedAt 缺省为 0，也就是早就排上队了。 */
function drone(state: number, routeLength: number, extra: Partial<Pick<Drone, 'removed' | 'station' | 'queuedAt'>> = {}): Pick<Drone, 'state' | 'route' | 'removed' | 'queuedAt'> & { station: number } {
  return { state, route: Array.from({ length: routeLength }, () => ({ kind: 0, order: 0 })), removed: extra.removed ?? false, station: extra.station ?? 0, queuedAt: extra.queuedAt ?? 0 };
}

/** 画面时刻：状态已经推进到第 step 步，插值 alpha（0 到不满 1），与界面层的算法相同。 */
const frameTime = (step: number, alpha: number): number => Math.max(0, step - 1) + alpha;

describe('等待起飞的飞机', () => {
  it('在起降口队列里等起飞的，和停在停机位上但已经接了单（路线不空）的，算等待起飞', () => {
    expect(awaitsTakeoff(drone(DroneState.TakeoffQueue, 2))).toBe(true);
    expect(awaitsTakeoff(drone(DroneState.TakeoffQueue, 0))).toBe(true);
    expect(awaitsTakeoff(drone(DroneState.Dock, 2))).toBe(true);
  });

  it('停着不动的（停在停机位上，路线为空）不算，正在起飞、飞行、等降落、降落的也不算', () => {
    expect(awaitsTakeoff(drone(DroneState.Dock, 0))).toBe(false);
    for (const s of [DroneState.Takeoff, DroneState.Fly, DroneState.Prep, DroneState.Pick, DroneState.Drop, DroneState.LandQueue, DroneState.Land]) {
      expect(awaitsTakeoff(drone(s, 2)), `state ${String(s)}`).toBe(false);
      expect(awaitsTakeoff(drone(s, 0)), `state ${String(s)}`).toBe(false);
    }
  });

  it('已退回的飞机不算', () => {
    expect(awaitsTakeoff(drone(DroneState.TakeoffQueue, 2, { removed: true }))).toBe(false);
    expect(awaitsTakeoff(drone(DroneState.Dock, 2, { removed: true }))).toBe(false);
  });

  it('按站数：没有占着停机位的（station 为 -1）和已退回的不数，没有等起飞的站不在表里', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: 3 });
    while ((state.stations[0] as { bays: number }).bays < 4) must(state, { type: 'buyBay', station: 0 });
    while (state.drones.filter((d) => d.station === 0).length < 4) must(state, { type: 'buyDrone', station: 0 });
    must(state, { type: 'buyDrone', station: 1 });
    const [a, b, c, d] = state.drones.filter((x) => x.station === 0);
    const e = state.drones.find((x) => x.station === 1);
    if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined) throw new Error('missing drones');
    const now = 1000; // 飞机的 queuedAt 都是 0，早就过了宽限
    expect(takeoffCounts(state, now).size).toBe(0);
    a.state = DroneState.TakeoffQueue;
    b.state = DroneState.TakeoffQueue;
    c.state = DroneState.Dock;
    c.route = [{ kind: 0, order: 0 }];
    d.state = DroneState.TakeoffQueue;
    d.removed = true;
    expect(takeoffCounts(state, now).get(0)).toBe(3);
    expect(takeoffCounts(state, now).has(1)).toBe(false);
    e.state = DroneState.TakeoffQueue;
    e.station = -1;
    expect(takeoffCounts(state, now).has(1)).toBe(false);
    e.station = 1;
    expect(takeoffCounts(state, now).get(1)).toBe(1);
  });

  it('只读：不改状态', () => {
    const state = stateOf(CITY, 400);
    const json = JSON.stringify(state);
    takeoffCounts(state, 400);
    gateLevelOf(state, 0);
    expect(JSON.stringify(state)).toBe(json);
  });

  it('宽限：在队列里等了不满 5 步的不画，满 5 步（0.5 秒）的画，路线不空但没进队列的飞机照常画', () => {
    expect(TAKEOFF_GRACE_STEPS).toBe(5);
    expect(TAKEOFF_GRACE_STEPS / STEPS_PER_SECOND).toBe(0.5);
    const queued = drone(DroneState.TakeoffQueue, 2, { queuedAt: 100 });
    for (const [now, expected] of [[99, false], [100, false], [102.5, false], [104.99, false], [105, true], [105.01, true], [130, true]] as const) {
      expect(showsTakeoffWait(queued, now), `画面时刻 ${String(now)}`).toBe(expected);
    }
    // 不是等起飞的飞机，等多久都不画
    for (const s of [DroneState.Takeoff, DroneState.Fly, DroneState.LandQueue, DroneState.Land]) expect(showsTakeoffWait(drone(s, 2, { queuedAt: 0 }), 1000), `state ${String(s)}`).toBe(false);
    expect(showsTakeoffWait(drone(DroneState.Dock, 0, { queuedAt: 0 }), 1000)).toBe(false);
    expect(showsTakeoffWait(drone(DroneState.TakeoffQueue, 2, { queuedAt: 0, removed: true }), 1000)).toBe(false);
    // 核心不产生的状态：停在停机位上、路线不空。queuedAt 是上一次排队的步，早就过了宽限
    expect(showsTakeoffWait(drone(DroneState.Dock, 2, { queuedAt: 0 }), 1000)).toBe(true);
  });

  it('各站的数目只数过了宽限的飞机：同一座站里三架飞机先后排上队，随画面时刻一架一架地计进去', () => {
    const state = withMoney(quietState());
    while ((state.stations[0] as { bays: number }).bays < 4) must(state, { type: 'buyBay', station: 0 });
    while (state.drones.filter((d) => !d.removed).length < 4) must(state, { type: 'buyDrone', station: 0 });
    const [a, b, c] = state.drones as [Drone, Drone, Drone];
    for (const [d, at] of [[a, 100], [b, 102], [c, 104]] as const) {
      d.state = DroneState.TakeoffQueue;
      d.queuedAt = at;
    }
    const counted = (now: number): number => takeoffCounts(state, now).get(0) ?? 0;
    expect([104.9, 105, 106.9, 107, 108.9, 109, 150].map(counted)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it('跑一阵真实的状态：各站的数目等于队列里已经等了至少 5 步的飞机数，插值到哪一刻都一样，起降口忙的时候确实出现过排队，也确实有被宽限滤掉的', () => {
    const state = stateOf({ ...CITY, gateInterval: 1.2 }); // 起降间隔取经营模式一级起降口的 1.2 秒，队排得长
    let queued = 0;
    let shown = 0;
    let both = 0;
    stepEach(state, 1800, (s) => {
      for (const alpha of [0, 0.5, 0.999]) {
        const now = frameTime(s.step, alpha);
        const counts = takeoffCounts(s, now);
        for (const st of s.stations) {
          const inQueue = st.queue.filter((id) => (s.drones[id] as Drone).state === DroneState.TakeoffQueue);
          const waited = inQueue.filter((id) => now - (s.drones[id] as Drone).queuedAt >= TAKEOFF_GRACE_STEPS).length;
          const waiting = s.drones.filter((x) => !x.removed && x.station === st.id && x.state === DroneState.TakeoffQueue).length;
          expect(counts.get(st.id) ?? 0, `step ${String(s.step)} alpha ${String(alpha)} station ${String(st.id)}`).toBe(waited);
          expect(inQueue.length).toBe(waiting);
          if (alpha === 0) {
            queued += inQueue.length;
            shown += waited;
            if (waited > 0 && holdingSlots(s, s.step).counts.has(st.id)) both += 1;
          }
        }
      }
    });
    expect(queued).toBeGreaterThan(50);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(queued);
    expect(both).toBeGreaterThan(0);
  });
});

describe('起降口的等级', () => {
  it('经营模式取这座站的 gateLevel：开局一级，每买一次升一级，最高三级', () => {
    const state = withMoney(quietState());
    expect(gateLevelOf(state, 0)).toBe(1);
    must(state, { type: 'upgradeGate', station: 0 });
    expect(gateLevelOf(state, 0)).toBe(2);
    must(state, { type: 'upgradeGate', station: 0 });
    expect(gateLevelOf(state, 0)).toBe(3);
  });

  it('每座站各算各的', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: 3 });
    must(state, { type: 'upgradeGate', station: 1 });
    expect(gateLevelOf(state, 0)).toBe(1);
    expect(gateLevelOf(state, 1)).toBe(2);
  });

  it('沙盒模式没有升级，一律按一级；没有这座站时也是一级', () => {
    const state = stateOf(CITY);
    expect(state.campaign).toBeNull();
    for (const s of state.stations) expect(gateLevelOf(state, s.id)).toBe(1);
    expect(gateLevelOf(quietState(), 99)).toBe(1);
  });

  it('等级夹在一到最高级之间', () => {
    const state = quietState();
    const info = state.campaign?.stations[0];
    if (info === undefined) throw new Error('no campaign station');
    info.gateLevel = 7;
    expect(gateLevelOf(state, 0)).toBe(GATE_MAX_LEVEL);
    info.gateLevel = 0;
    expect(gateLevelOf(state, 0)).toBe(1);
    info.gateLevel = Number.NaN;
    expect(gateLevelOf(state, 0)).toBe(1);
  });

  it('最高级和内容表里起降口的级数一致', () => {
    expect(GATE_MAX_LEVEL).toBe(ECONOMY_V1.gateSeconds.length);
  });
});

describe('起降口的环的几何', () => {
  /** 三种屋顶上起降圈的半径。 */
  const pads = Object.entries(STATION_SIZES).map(([size, [w, h]]) => ({ size, w, h, pad: landingCircle(w, h) }));

  it('一级只有起降圈本身，二级外面一道，三级外面两道：一级一道，二级两道，三级三道', () => {
    for (const { size, pad } of pads) {
      expect(gateRings(pad.r, 1), size).toEqual([]);
      expect(gateRings(pad.r, 2)).toHaveLength(1);
      expect(gateRings(pad.r, 3)).toHaveLength(2);
      expect(GATE_MAX_LEVEL).toBe(3);
    }
  });

  it('第一道环越过起降圈刻线的端头（刻线伸出圈外 5），之后每道隔 GATE_STEP，镜头缩小时间隔放大、第一道的距离不变', () => {
    const r = 24.8;
    const [one] = gateRings(r, 2);
    expect(one).toBeCloseTo(r + GATE_FIRST, 9);
    expect(GATE_FIRST).toBeGreaterThan(5);
    const [a, b] = gateRings(r, 3);
    expect((b ?? 0) - (a ?? 0)).toBeCloseTo(GATE_STEP, 9);
    const [c, d] = gateRings(r, 3, 2);
    expect(c).toBeCloseTo(r + GATE_FIRST, 9);
    expect((d ?? 0) - (c ?? 0)).toBeCloseTo(2 * GATE_STEP, 9);
  });

  it('最外一道就是环里最大的一个，没有环时是起降圈', () => {
    for (const { pad } of pads) {
      for (const unit of [1, 1.35, 2]) {
        for (let level = 1; level <= GATE_MAX_LEVEL; level++) {
          expect(gateOuter(pad.r, level, unit)).toBeCloseTo(Math.max(pad.r, ...gateRings(pad.r, level, unit)), 9);
        }
      }
    }
  });

  it('最外一道：一级是起降圈，往上是最后一道环；级数不整时取整，不到一级按一级', () => {
    expect(gateOuter(20, 1)).toBe(20);
    expect(gateOuter(20, 2)).toBeCloseTo(20 + GATE_FIRST, 9);
    expect(gateOuter(20, 3)).toBeCloseTo(20 + GATE_FIRST + GATE_STEP, 9);
    expect(gateOuter(20, 0)).toBe(20);
    expect(gateOuter(20, 2.4)).toBe(gateOuter(20, 2));
  });

  it('三级的环在最小的镜头缩放下，每道隔 2 个窗口像素以上，一道一道数得出来', () => {
    // 窗口 1280 乘 720，三个片区都开通时镜头的缩放是 0.32，环的放大倍数取到上限
    const zoom = 0.32;
    const unit = markerUnits(zoom).mark;
    expect(unit).toBe(2);
    expect(GATE_STEP * unit * zoom).toBeGreaterThanOrEqual(2);
    expect(GATE_FIRST * zoom).toBeGreaterThanOrEqual(1.5);
  });

  it('纹理的半边长装得下最外一道环和转动的小圆点，还留着一圈边', () => {
    for (const { size, pad } of pads) {
      for (const unit of [1, 1.5, 2]) {
        for (let level = 1; level <= GATE_MAX_LEVEL; level++) {
          const extent = gateExtent({ level, pad: pad.r, unit });
          expect(extent, `${size} 级 ${String(level)} 倍 ${String(unit)}`).toBeGreaterThanOrEqual(gateOuter(pad.r, level, unit) + GATE_BEAD * unit + GATE_MARGIN - 1);
        }
      }
    }
  });

  it('小圆点停着的位置在右上 45 度，避开起降圈上下左右的四个刻线', () => {
    expect(GATE_REST).toBeCloseTo(Math.PI / 4, 9);
    for (const quarter of [0, 1, 2, 3]) expect(Math.abs(GATE_REST - (quarter * Math.PI) / 2)).toBeGreaterThan(0.5);
  });

  it('环放到最大也在屋顶里面：最外一道环不出屋顶的上下边，也不超出左边多于几个单位', () => {
    const unit = markerUnits(0.01).mark;
    for (const { size, w, h, pad } of pads) {
      const outer = gateOuter(pad.r, GATE_MAX_LEVEL, unit);
      expect(pad.cy - outer, `${size} 上边`).toBeGreaterThanOrEqual(-1);
      expect(pad.cy + outer, `${size} 下边`).toBeLessThanOrEqual(h + 1);
      expect(pad.cx - outer, `${size} 左边`).toBeGreaterThanOrEqual(-5);
      expect(pad.cx + outer, `${size} 右边`).toBeLessThan(w);
    }
  });

  it('环比等降落的圈小得多，两个圈同时出现时分得开：环放到最大，半径也不到等降落的圈的一半，圆心也不在一处', () => {
    const unit = markerUnits(0.01).mark;
    for (const { size, w, h, pad } of pads) {
      const hold = Math.max(60, Math.hypot(w, h) / 2 + 16);
      expect(gateOuter(pad.r, GATE_MAX_LEVEL, unit), size).toBeLessThan(hold / 2);
      // 等降落的圈围着屋顶正中，起降圈在屋顶左侧
      expect(Math.hypot(pad.cx - w / 2, pad.cy - h / 2), size).toBeGreaterThan(10);
    }
  });
});

describe('起降口的环转动', () => {
  it('每放行一架转一整圈，一圈的时长是起降间隔：刚放行是 0，过半是 0.5，过了一个间隔是 1', () => {
    const st = { gateFree: 112, gateInterval: 12 }; // 上一次放行在第 100 步
    expect(gateTurn(st, 100)).toBe(0);
    expect(gateTurn(st, 106)).toBeCloseTo(0.5, 9);
    expect(gateTurn(st, 109)).toBeCloseTo(0.75, 9);
    expect(gateTurn(st, 112)).toBe(1);
    expect(gateTurn(st, 500)).toBe(1);
  });

  it('画面时刻带小数，转动跟着插值走', () => {
    const st = { gateFree: 108, gateInterval: 8 }; // 上一次放行在第 100 步，一圈 8 步
    expect(gateTurn(st, 100.5)).toBeCloseTo(0.5 / 8, 9);
    expect(gateTurn(st, 103.99)).toBeCloseTo(3.99 / 8, 9);
  });

  it('起降间隔越短转得越快：同样过 4 步，一级转了 1/3 圈，三级转满', () => {
    const level1 = { gateFree: 112, gateInterval: Math.round(ECONOMY_V1.gateSeconds[0] * STEPS_PER_SECOND) };
    const level3 = { gateFree: 104, gateInterval: Math.round(ECONOMY_V1.gateSeconds[2] * STEPS_PER_SECOND) };
    expect(level1.gateInterval).toBe(12);
    expect(level3.gateInterval).toBe(4);
    expect(gateTurn(level1, 104)).toBeCloseTo(1 / 3, 9);
    expect(gateTurn(level3, 104)).toBe(1);
  });

  it('没有放行过（开局，或者刚建站）环是静止的：转满的位置', () => {
    expect(gateTurn({ gateFree: 0, gateInterval: 12 }, 0)).toBe(1);
    expect(gateTurn({ gateFree: 1000, gateInterval: 12 }, 1000)).toBe(1);
    expect(gateTurn({ gateFree: 0, gateInterval: 12 }, 7)).toBe(1);
  });

  it('不会超出 0 到 1，间隔不对时按静止处理', () => {
    const st = { gateFree: 112, gateInterval: 12 };
    expect(gateTurn(st, 50)).toBe(0);
    expect(gateTurn(st, 1e9)).toBe(1);
    expect(gateTurn({ gateFree: 10, gateInterval: 0 }, 5)).toBe(1);
    expect(gateTurn({ gateFree: 10, gateInterval: Number.NaN }, 5)).toBe(1);
  });

  it('跑一阵真实的状态：每放行一架（gateFree 变了）环回到 0，之后一步一步转到 1 再停住，从来不超出 0 到 1', () => {
    const state = stateOf(CITY);
    const lastFree = state.stations.map((s) => s.gateFree);
    const lastRelease = state.stations.map((s) => s.gateFree - s.gateInterval);
    let releases = 0;
    let idleAtOne = 0;
    let midCycle = 0;
    stepEach(state, 1500, (s) => {
      const now = Math.max(0, s.step - 1); // 画面时刻 = 上一步的编号加插值，插值为 0
      for (const st of s.stations) {
        if (st.gateFree !== lastFree[st.id]) {
          lastFree[st.id] = st.gateFree;
          lastRelease[st.id] = st.gateFree - st.gateInterval;
          releases += 1;
          expect(gateTurn(st, now), `release at ${String(now)}`).toBe(0);
        }
        const turn = gateTurn(st, now);
        const expected = Math.min(1, (now - (lastRelease[st.id] as number)) / st.gateInterval);
        expect(turn).toBeCloseTo(expected, 9);
        expect(turn).toBeGreaterThanOrEqual(0);
        expect(turn).toBeLessThanOrEqual(1);
        if (turn === 1) idleAtOne += 1;
        else midCycle += 1;
      }
    });
    expect(releases).toBeGreaterThan(40);
    expect(idleAtOne).toBeGreaterThan(0);
    expect(midCycle).toBeGreaterThan(0);
  });

  it('升级起降口之后立即按新的间隔转：间隔缩短，转一圈的步数跟着变短', () => {
    const state = withMoney(quietState());
    const st = state.stations[0];
    if (st === undefined) throw new Error('no station');
    st.gateFree = 1012;
    st.gateInterval = 12;
    expect(gateTurn(st, 1006)).toBeCloseTo(0.5, 9);
    must(state, { type: 'upgradeGate', station: 0 });
    expect(st.gateInterval).toBe(8);
    expect(gateTurn(st, st.gateFree)).toBe(1);
    expect(gateTurn(st, st.gateFree - 8)).toBe(0);
  });
});

describe('站点旁的字：等起飞和等降落两行叠成一块', () => {
  it('文字取自词表：「{count} 架等待起飞」，和「{count} 架等待降落」并列', () => {
    expect(STR.hud.takeoffQueue).toBe('{count} 架等待起飞');
    expect(fmt(STR.hud.takeoffQueue, { count: 3 })).toBe('3 架等待起飞');
    expect(fmt(STR.hud.holding, { count: 2 })).toBe('2 架等待降落');
  });

  it('一行时块就是这一行，中心在原点', () => {
    const block = stackLines([{ w: 120, h: 30 }]);
    expect(block).toEqual({ w: 120, h: 30, centers: [{ x: 0, y: 0 }] });
  });

  it('两行上下叠，块的宽取宽的那行，高是两行加间隔，各行居中对齐，不互相压住', () => {
    const lines = [
      { w: 150, h: 30 },
      { w: 120, h: 28 },
    ];
    const block = stackLines(lines, 2);
    expect(block.w).toBe(150);
    expect(block.h).toBe(60);
    const [first, second] = block.centers;
    if (first === undefined || second === undefined) throw new Error('missing centers');
    expect(first).toEqual({ x: 0, y: -30 + 15 });
    expect(second.y).toBeCloseTo(-30 + 30 + 2 + 14, 9);
    const boxes: Rect[] = lines.map((l, i) => {
      const c = block.centers[i] as { x: number; y: number };
      return { x: c.x - l.w / 2, y: c.y - l.h / 2, w: l.w, h: l.h };
    });
    expect(overlapArea(boxes[0] as Rect, boxes[1] as Rect)).toBe(0);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(-block.w / 2 - 1e-9);
      expect(b.x + b.w).toBeLessThanOrEqual(block.w / 2 + 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(-block.h / 2 - 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(block.h / 2 + 1e-9);
    }
  });

  it('候选位置：单行时和原来只写等降落时的位置完全一样', () => {
    const a = { cx: 400, cy: 300, radius: 94 };
    const w = 160;
    const k = 1.5;
    const old = [
      { x: a.cx - 6 * k, y: a.cy - a.radius - 14 * k },
      { x: a.cx + a.radius * 0.75 + w / 2 - 20 * k, y: a.cy - a.radius * 0.9 - 8 * k },
      { x: a.cx - a.radius * 0.75 - w / 2 + 20 * k, y: a.cy - a.radius * 0.9 - 8 * k },
      { x: a.cx - 6 * k, y: a.cy + a.radius + 16 * k },
      { x: a.cx + a.radius + w / 2 + 6 * k, y: a.cy },
      { x: a.cx - a.radius - w / 2 - 6 * k, y: a.cy },
      { x: a.cx + a.radius * 0.75 + w / 2 - 20 * k, y: a.cy + a.radius * 0.9 + 10 * k },
      { x: a.cx - a.radius * 0.75 - w / 2 + 20 * k, y: a.cy + a.radius * 0.9 + 10 * k },
    ];
    expect(labelSpots(a, w, k)).toEqual(old);
    expect(labelSpots(a, w, k, 0)).toEqual(old);
  });

  it('候选位置：叠成两行时，圈上方的位置往上、下方的往下各多挪多出高度的一半，两侧的不变', () => {
    const a = { cx: 400, cy: 300, radius: 94 };
    const one = labelSpots(a, 160, 1.5);
    const two = labelSpots(a, 160, 1.5, 30);
    expect(two[0]?.y).toBeCloseTo((one[0]?.y ?? 0) - 15, 9);
    expect(two[1]?.y).toBeCloseTo((one[1]?.y ?? 0) - 15, 9);
    expect(two[2]?.y).toBeCloseTo((one[2]?.y ?? 0) - 15, 9);
    expect(two[3]?.y).toBeCloseTo((one[3]?.y ?? 0) + 15, 9);
    expect(two[6]?.y).toBeCloseTo((one[6]?.y ?? 0) + 15, 9);
    expect(two[7]?.y).toBeCloseTo((one[7]?.y ?? 0) + 15, 9);
    expect(two[4]).toEqual(one[4]);
    expect(two[5]).toEqual(one[5]);
    for (let i = 0; i < 8; i++) expect(two[i]?.x).toBe(one[i]?.x);
  });

  it('挑位置：取第一个什么也不压的；都压着时取压得最少的；出了画面的部分也算压着', () => {
    const view: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
    const spots = [
      { x: 100, y: 100 },
      { x: 500, y: 500 },
      { x: 700, y: 700 },
    ];
    const blocked: Rect = { x: 60, y: 90, w: 80, h: 20 };
    expect(pickLabelSpot(spots, 80, 20, [blocked], [], view)).toEqual({ x: 500, y: 500 });
    // 第一个被占着，后两个都空着：取第二个，不是压得最少的第三个
    expect(pickLabelSpot(spots, 80, 20, [blocked], [{ x: 690, y: 690, w: 20, h: 20 }], view)).toEqual({ x: 500, y: 500 });
    // 都被压着时取面积最小的
    const wide: Rect[] = [
      { x: 0, y: 0, w: 1000, h: 400 },
      { x: 0, y: 450, w: 1000, h: 80 },
    ];
    expect(pickLabelSpot(spots, 80, 20, wide, [], view)).toEqual({ x: 700, y: 700 });
    // 出了画面
    expect(pickLabelSpot([{ x: -50, y: 100 }, { x: 100, y: 100 }], 80, 20, [], [], view)).toEqual({ x: 100, y: 100 });
  });

  for (const k of [1, 1.5, 2.2]) {
    it(`每种屋顶：等起飞和等降落叠成的一块不压屋顶，也就不压屋顶上的站号，两行互不相压（字放大 ${String(k)} 倍）`, () => {
      for (const [size, [w, h]] of Object.entries(STATION_SIZES)) {
        const roof: Rect = { x: 500 - w / 2, y: 400 - h / 2, w, h };
        const circle = landingCircle(w, h);
        const number: Rect = { x: roof.x + circle.cx - circle.r, y: roof.y + circle.cy - circle.r, w: 2 * circle.r, h: 2 * circle.r };
        const anchor = { cx: 500, cy: 400, radius: Math.max(60, Math.hypot(w, h) / 2 + 16) };
        const lines = [
          { w: 150 * k, h: 30 * k },
          { w: 135 * k, h: 30 * k },
        ];
        const block = stackLines(lines);
        const spots = labelSpots(anchor, block.w, k, block.h - lines[0]!.h);
        const view: Rect = { x: -1e4, y: -1e4, w: 2e4, h: 2e4 };
        const spot = pickLabelSpot(spots, block.w, block.h, [roof], [], view);
        const box: Rect = { x: spot.x - block.w / 2, y: spot.y - block.h / 2, w: block.w, h: block.h };
        expect(overlapArea(box, roof), `${size} 屋顶`).toBe(0);
        expect(overlapArea(box, number), `${size} 站号`).toBe(0);
        const rects = lines.map((l, i) => {
          const c = block.centers[i] as { x: number; y: number };
          return { x: spot.x + c.x - l.w / 2, y: spot.y + c.y - l.h / 2, w: l.w, h: l.h };
        });
        expect(overlapArea(rects[0] as Rect, rects[1] as Rect)).toBe(0);
        for (const r of rects) expect(overlapArea(r, number)).toBe(0);
      }
    });
  }

  it('两座站挨着：后一座站的字块挑别的位置，不压前一座已经放好的字', () => {
    const view: Rect = { x: -1e4, y: -1e4, w: 2e4, h: 2e4 };
    const k = 1.5;
    const lines = [
      { w: 150 * k, h: 30 * k },
      { w: 135 * k, h: 30 * k },
    ];
    const block = stackLines(lines);
    const extra = block.h - lines[0]!.h;
    const a = { cx: 500, cy: 400, radius: 94 };
    const b = { cx: 640, cy: 400, radius: 94 }; // 两座站隔得很近，圈互相叠着
    const roofs: Rect[] = [
      { x: 438, y: 352, w: 124, h: 96 },
      { x: 578, y: 352, w: 124, h: 96 },
    ];
    const first = pickLabelSpot(labelSpots(a, block.w, k, extra), block.w, block.h, roofs, [], view);
    const placed: Rect[] = [{ x: first.x - block.w / 2, y: first.y - block.h / 2, w: block.w, h: block.h }];
    const second = pickLabelSpot(labelSpots(b, block.w, k, extra), block.w, block.h, roofs, placed, view);
    const box: Rect = { x: second.x - block.w / 2, y: second.y - block.h / 2, w: block.w, h: block.h };
    expect(overlapArea(box, placed[0] as Rect)).toBe(0);
    for (const roof of roofs) expect(overlapArea(box, roof)).toBe(0);
  });

  it('状态里同时有等起飞和等降落的飞机时，两个数都数得出来', () => {
    const state = withMoney(quietState());
    while ((state.stations[0] as { bays: number }).bays < 4) must(state, { type: 'buyBay', station: 0 });
    while (state.drones.filter((d) => !d.removed).length < 4) must(state, { type: 'buyDrone', station: 0 });
    state.step = 1000;
    const [a, b, c] = state.drones as [Drone, Drone, Drone];
    a.state = DroneState.TakeoffQueue;
    a.queuedAt = 900;
    b.state = DroneState.LandQueue;
    b.queuedAt = 900;
    c.state = DroneState.LandQueue;
    c.queuedAt = 950;
    expect(takeoffCounts(state, 1000).get(0)).toBe(1);
    expect(holdingSlots(state, 1000).counts.get(0)).toBe(2);
  });
});

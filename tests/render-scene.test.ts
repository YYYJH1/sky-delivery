// 画面的数据：小票的状态和计时条，票杆上的排布，停机位的分配，等降落的盘旋，航线的尾迹，送达和退单的记号。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { DroneState, OrderStatus, PROMISE_STEPS, StopKind, addOrder, unlock } from '../src/core/index.ts';
import { RAIL_LENGTH, STATION_SIZES, generateCity } from '../src/render/city.ts';
import type { ShopFront, StationRoof } from '../src/render/city-types.ts';
import { clipOutside, headingOf, makeBoard, moveClear, overlapArea, segmentDistance, worldBoundsOfBoard } from '../src/render/geometry.ts';
import type { Rect } from '../src/render/geometry.ts';
import { HELIPAD_NEAR, citySpecFromMap, planMapBoard } from '../src/render/map-spec.ts';
import {
  CANCEL_MARK_STEPS,
  DEFAULT_ROOF,
  DELIVERY_MARK_STEPS,
  HOLD_GRACE_STEPS,
  MAX_TICKETS_PER_RAIL,
  SlotTracker,
  TICKET_CENTER_DROP,
  TRAIL_STEPS,
  TrailTracker,
  URGENT_AGE_STEPS,
  activeMarks,
  clerkStation,
  destinations,
  districtModes,
  firstOrderSince,
  frontPoint,
  holdEase,
  holdingSlots,
  nearestStationOf,
  occupiesBay,
  orbitOffset,
  railEnds,
  roofsByIndex,
  simplify,
  stationRoofRect,
  ticketBar,
  ticketSlots,
  ticketState,
  waitingTickets,
} from '../src/render/scene.ts';
import { campaignOf, campaignState, must, quietState, withMoney } from './campaign-helpers.ts';
import { CITY, stateOf } from './helpers.ts';

describe('订单小票的状态和计时条', () => {
  it('不到 22 秒正常，22 到 30 秒（含）快超时，超过 30 秒已超时', () => {
    expect(URGENT_AGE_STEPS).toBe(220);
    expect(ticketState(0)).toBe('ok');
    expect(ticketState(219)).toBe('ok');
    expect(ticketState(220)).toBe('urgent');
    expect(ticketState(PROMISE_STEPS)).toBe('urgent');
    expect(ticketState(PROMISE_STEPS + 1)).toBe('late');
  });

  it('计时条按离 30 秒承诺还剩多少缩短，从 10 格到 1 格，超时为 0，剩得越少格数不会变多', () => {
    expect(ticketBar(0)).toBe(10);
    expect(ticketBar(150)).toBe(5);
    expect(ticketBar(299)).toBe(1);
    expect(ticketBar(PROMISE_STEPS)).toBe(0);
    expect(ticketBar(900)).toBe(0);
    let last = 11;
    for (let age = 0; age <= 320; age++) {
      const bar = ticketBar(age);
      expect(bar).toBeLessThanOrEqual(last);
      last = bar;
    }
  });
});

describe('等待中的订单挂在票杆上', () => {
  it('同一家店的订单下单早的在前，最多挂 5 张，其余折成「+n」', () => {
    const state = quietState();
    for (let i = 0; i < 7; i++) addOrder(state, { merchant: 1, building: 3, portion: 1, prepSteps: 50, tOrder: 100 + i * 10 });
    const groups = waitingTickets(state, 330);
    expect(groups.length).toBe(1);
    const g = groups[0];
    expect(g?.shop).toBe(1);
    expect(g?.shown.map((t) => t.order)).toEqual([0, 1, 2, 3, 4]);
    expect(g?.overflow).toBe(2);
    expect(MAX_TICKETS_PER_RAIL).toBe(5);
    expect(g?.shown[0]?.age).toBe(230);
    expect(g?.shown[0]?.state).toBe('urgent');
    expect(g?.shown[4]?.state).toBe('ok');
  });

  it('已经取走、送到、退单的订单不挂，已派出还没取到的挂着', () => {
    const state = quietState();
    for (let i = 0; i < 4; i++) addOrder(state, { merchant: 2, building: 5, portion: 1, prepSteps: 40, tOrder: 10 + i });
    const [a, b, c, d] = state.orders;
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error('missing orders');
    a.status = OrderStatus.Picked;
    b.status = OrderStatus.Delivered;
    c.status = OrderStatus.Cancelled;
    d.status = OrderStatus.Assigned;
    const groups = waitingTickets(state, 100);
    expect(groups[0]?.shown.map((t) => t.order)).toEqual([3]);
  });

  it('小票的边框用离这家店最近的站：有第二座站之后，靠近它的店换了颜色', () => {
    const state = withMoney(quietState());
    addOrder(state, { merchant: 0, building: 3, portion: 1, prepSteps: 50, tOrder: 0 });
    const shop = state.world.merchants[0] as { x: number; y: number };
    const before = waitingTickets(state, 10)[0];
    expect(before?.nearestStation).toBe(0);
    must(state, { type: 'buildStation', roof: 3 });
    const near = nearestStationOf(state, shop.x, shop.y);
    expect(waitingTickets(state, 10)[0]?.nearestStation).toBe(near);
    expect(nearestStationOf(state, state.stations[1]?.x ?? 0, state.stations[1]?.y ?? 0)).toBe(1);
  });

  it('订单按下单时间排，二分找到不早于某一步的第一张', () => {
    const state = quietState();
    for (const t of [5, 20, 20, 90, 300]) addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 10, tOrder: t });
    expect(firstOrderSince(state, 0)).toBe(0);
    expect(firstOrderSince(state, 20)).toBe(1);
    expect(firstOrderSince(state, 21)).toBe(3);
    expect(firstOrderSince(state, 301)).toBe(5);
  });
});

describe('票杆上小票的位置', () => {
  const front: ShopFront = { shop: 0, building: 0, side: 'b', origin: { x: 100, y: 200 }, angle: 0, awningWidth: 54, awningStart: 0, name: { x: 0, y: 0 } };

  it('以票杆中心为中心排开，一张在正中，两张间隔 16，三张以上间隔 13', () => {
    const uc = 27;
    expect(ticketSlots(front, 1).map((s) => s.u)).toEqual([uc]);
    expect(ticketSlots(front, 2).map((s) => s.u)).toEqual([uc - 8, uc + 8]);
    expect(ticketSlots(front, 5).map((s) => s.u)).toEqual([uc - 26, uc - 13, uc, uc + 13, uc + 26]);
    for (const s of ticketSlots(front, 5)) expect(s.v).toBeCloseTo(14.2, 5);
  });

  it('票杆两端相隔 64，以雨棚中心为中心', () => {
    expect(railEnds(front)).toEqual([27 - RAIL_LENGTH / 2, 27 + RAIL_LENGTH / 2]);
  });

  it('小票放大 unit 倍时，小票之间的间隔和票杆的长度也放大 unit 倍，票杆的中心不变，小票还是挂在票杆上', () => {
    const uc = 27;
    expect(ticketSlots(front, 5, 1.5).map((s) => s.u)).toEqual([uc - 39, uc - 19.5, uc, uc + 19.5, uc + 39]);
    expect(ticketSlots(front, 2, 2).map((s) => s.u)).toEqual([uc - 16, uc + 16]);
    const [r0, r1] = railEnds(front, 1.5);
    expect(r0).toBeCloseTo(uc - (RAIL_LENGTH * 1.5) / 2, 9);
    expect(r1).toBeCloseTo(uc + (RAIL_LENGTH * 1.5) / 2, 9);
    // 最外面一张小票的中心离票杆端点的距离，和不放大时的比例一样（放大 1.5 倍，距离也是 1.5 倍）
    const outer = Math.max(...ticketSlots(front, 5, 1.5).map((s) => s.u));
    const outer1 = Math.max(...ticketSlots(front, 5, 1).map((s) => s.u));
    expect((r1 - outer) / 1.5).toBeCloseTo(railEnds(front)[1] - outer1, 9);
    // 不给 unit 就是原来的排法
    expect(ticketSlots(front, 5, 1)).toEqual(ticketSlots(front, 5));
    expect(railEnds(front, 1)).toEqual(railEnds(front));
  });

  it('小票的中心在夹子下面 TICKET_CENTER_DROP，点选小票用它', () => {
    expect(TICKET_CENTER_DROP).toBeGreaterThan(8);
    expect(TICKET_CENTER_DROP).toBeLessThan(13);
  });

  it('门面局部坐标换成世界坐标：沿街边是 +u，朝街里是 +v，随四边转 0、180、-90、90 度', () => {
    const at = (angle: number): { x: number; y: number } => frontPoint({ ...front, angle }, 10, 5);
    expect(at(0)).toEqual({ x: 110, y: 205 });
    const flipped = at(180);
    expect(flipped.x).toBeCloseTo(90, 9);
    expect(flipped.y).toBeCloseTo(195, 9);
    const right = at(-90);
    expect(right.x).toBeCloseTo(105, 9);
    expect(right.y).toBeCloseTo(190, 9);
    const left = at(90);
    expect(left.x).toBeCloseTo(95, 9);
    expect(left.y).toBeCloseTo(210, 9);
  });
});

describe('停机位的分配', () => {
  function stationWithFour() {
    const state = withMoney(quietState());
    while ((state.stations[0] as { bays: number }).bays < 4) must(state, { type: 'buyBay', station: 0 });
    while (state.drones.filter((d) => !d.removed).length < 4) must(state, { type: 'buyDrone', station: 0 });
    return state;
  }

  it('占着停机位的是停着、等起飞、起飞中、降落中的飞机', () => {
    expect([DroneState.Dock, DroneState.TakeoffQueue, DroneState.Takeoff, DroneState.Land].every((s) => occupiesBay({ state: s }))).toBe(true);
    expect([DroneState.Fly, DroneState.Prep, DroneState.Pick, DroneState.Drop, DroneState.LandQueue].some((s) => occupiesBay({ state: s }))).toBe(false);
  });

  it('四架飞机各占一个位置，一架飞走之后别的不动，新回来的占最小的空位', () => {
    const state = stationWithFour();
    const tracker = new SlotTracker();
    const first = tracker.update(state);
    expect([...first.values()].sort()).toEqual([0, 1, 2, 3]);
    const d1 = state.drones[1];
    if (d1 === undefined) throw new Error('no drone 1');
    const slotOf1 = first.get(1);
    d1.state = DroneState.Fly;
    d1.station = -1;
    const second = tracker.update(state);
    expect(second.has(1)).toBe(false);
    for (const [id, slot] of first) if (id !== 1) expect(second.get(id), `drone ${id}`).toBe(slot);
    d1.state = DroneState.Land;
    d1.station = 0;
    const third = tracker.update(state);
    expect(third.get(1)).toBe(slotOf1);
  });

  it('清空之后重新分配', () => {
    const state = stationWithFour();
    const tracker = new SlotTracker();
    tracker.update(state);
    tracker.reset();
    expect(tracker.update(state).size).toBe(4);
  });
});

describe('等降落的飞机在站点上空盘旋', () => {
  it('等了不满宽限的还在站点上，之后用 4 步展开到圆周上', () => {
    expect(holdEase(0)).toBe(0);
    expect(holdEase(HOLD_GRACE_STEPS)).toBe(0);
    expect(holdEase(HOLD_GRACE_STEPS + 2)).toBeCloseTo(0.5, 9);
    expect(holdEase(HOLD_GRACE_STEPS + 4)).toBe(1);
    expect(holdEase(500)).toBe(1);
  });

  it('按站分组，先到的排前面，没过宽限的不算', () => {
    const state = withMoney(quietState());
    while ((state.stations[0] as { bays: number }).bays < 4) must(state, { type: 'buyBay', station: 0 });
    while (state.drones.filter((d) => !d.removed).length < 4) must(state, { type: 'buyDrone', station: 0 });
    state.step = 1000;
    const wait = [
      [0, 950],
      [1, 900],
      [2, 998],
    ] as const;
    for (const [id, at] of wait) {
      const d = state.drones[id];
      if (d === undefined) throw new Error('no drone');
      d.state = DroneState.LandQueue;
      d.station = 0;
      d.queuedAt = at;
    }
    const { slots, counts } = holdingSlots(state, 1000);
    expect(counts.get(0)).toBe(2);
    expect(slots.get(1)).toEqual({ index: 0, count: 2 });
    expect(slots.get(0)).toEqual({ index: 1, count: 2 });
    expect(slots.has(2)).toBe(false);
  });

  it('圈上顺时针排开：第一架在正上方，转起来之后角度随时间增加，半径不变', () => {
    const top = orbitOffset(80, 0, 3, 0);
    expect(top.x).toBeCloseTo(0, 9);
    expect(top.y).toBeCloseTo(-80, 9);
    const later = orbitOffset(80, 0, 3, 0.5);
    expect(later.x).toBeGreaterThan(0);
    expect(Math.hypot(later.x, later.y)).toBeCloseTo(80, 9);
    const third = orbitOffset(80, 1, 4, 0);
    expect(third.x).toBeCloseTo(80, 9);
    expect(third.y).toBeCloseTo(0, 9);
  });
});

describe('航线的尾迹', () => {
  it('每步记一次位置，最多留 40 步，从旧到新，载货与否随位置记下', () => {
    const state = quietState();
    const d = state.drones[0];
    if (d === undefined) throw new Error('no drone');
    const trails = new TrailTracker();
    for (let i = 0; i < 55; i++) {
      d.x = 10 * i;
      d.y = 0;
      d.onboard = i >= 50 ? [0] : [];
      trails.record(state);
    }
    const h = trails.history(0);
    expect(h.length).toBe(TRAIL_STEPS);
    expect(h[0]?.x).toBe(150);
    expect(h[h.length - 1]?.x).toBe(540);
    expect(h.slice(-5).every((p) => p.loaded)).toBe(true);
    expect(h.slice(0, -5).every((p) => !p.loaded)).toBe(true);
    trails.reset();
    expect(trails.history(0)).toEqual([]);
  });

  it('共线的点合并，拐点留下', () => {
    const line = Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: i * 5 }));
    expect(simplify(line)).toEqual([line[0], line[9]]);
    const bent = [...line, { x: 90, y: 100 }];
    expect(simplify(bent).length).toBe(3);
    expect(simplify([{ x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('送达和退单的记号，送餐目的地', () => {
  it('准时和超时送达的记号不同，几秒后淡出，之后不再出现', () => {
    const state = quietState();
    addOrder(state, { merchant: 0, building: 4, portion: 1, prepSteps: 10, tOrder: 0 });
    addOrder(state, { merchant: 0, building: 5, portion: 1, prepSteps: 10, tOrder: 0 });
    const [a, b] = state.orders;
    if (a === undefined || b === undefined) throw new Error('missing orders');
    a.status = OrderStatus.Delivered;
    a.tDeliver = 200;
    b.status = OrderStatus.Delivered;
    b.tDeliver = 400;
    const now = 400 + DELIVERY_MARK_STEPS * 0.5;
    expect(activeMarks(state, 200 + 5).map((m) => m.kind)).toEqual(['ontime']);
    expect(activeMarks(state, now).map((m) => m.kind)).toEqual(['late']);
    const alphas = [0, 10, 25, 30, 38, 44].map((age) => activeMarks(state, 400 + age)[0]?.alpha ?? -1);
    expect(alphas[0]).toBe(1);
    expect(alphas[1]).toBe(1);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1] as number);
    expect(alphas[alphas.length - 1]).toBeGreaterThan(0);
    expect(activeMarks(state, 400 + DELIVERY_MARK_STEPS)).toEqual([]);
    // 记号在楼上
    const home = state.world.buildings[4] as { x: number; y: number };
    expect(activeMarks(state, 205)[0]).toMatchObject({ x: home.x, y: home.y });
  });

  it('退单的记号留在店上，几秒后消失', () => {
    const state = quietState();
    addOrder(state, { merchant: 2, building: 1, portion: 1, prepSteps: 10, tOrder: 0 });
    const o = state.orders[0];
    if (o === undefined) throw new Error('no order');
    o.status = OrderStatus.Cancelled;
    o.tCancel = 900;
    const shop = state.world.merchants[2] as { x: number; y: number };
    expect(activeMarks(state, 905)[0]).toMatchObject({ kind: 'cancel', x: shop.x, y: shop.y, shop: 2 });
    expect(activeMarks(state, 900 + CANCEL_MARK_STEPS)).toEqual([]);
  });

  it('载着货的飞机要去的楼画接收垫，飞着或正在送时外面多一圈虚线', () => {
    const state = quietState();
    addOrder(state, { merchant: 0, building: 6, portion: 1, prepSteps: 10, tOrder: 0 });
    const d = state.drones[0];
    if (d === undefined) throw new Error('no drone');
    d.onboard = [0];
    d.route = [{ kind: StopKind.Drop, order: 0 }];
    d.state = DroneState.Fly;
    const home = state.world.buildings[6] as { x: number; y: number };
    expect(destinations(state)).toEqual([{ x: home.x, y: home.y, active: true }]);
    d.state = DroneState.Dock;
    expect(destinations(state)[0]?.active).toBe(false);
    d.onboard = [];
    expect(destinations(state)).toEqual([]);
    expect(campaignOf(state).opening.done).toBe(true);
  });
});

describe('几何', () => {
  it('世界坐标和画板坐标互相换算，转角之后画板中心对着 focus', () => {
    const board = makeBoard(2016, 1176, { x: 600, y: 650 }, (-7 * Math.PI) / 180);
    expect(board.toBoard(600, 650)).toEqual({ x: 1008, y: 588 });
    const p = board.toBoard(123.5, 987.25);
    const q = board.toWorld(p.x, p.y);
    expect(q.x).toBeCloseTo(123.5, 9);
    expect(q.y).toBeCloseTo(987.25, 9);
    const box = worldBoundsOfBoard(board, 0);
    for (const corner of [board.toWorld(0, 0), board.toWorld(2016, 0), board.toWorld(0, 1176), board.toWorld(2016, 1176)]) {
      expect(corner.x).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(corner.x).toBeLessThanOrEqual(box.x + box.w + 1e-6);
      expect(corner.y).toBeGreaterThanOrEqual(box.y - 1e-6);
      expect(corner.y).toBeLessThanOrEqual(box.y + box.h + 1e-6);
    }
  });

  it('线段被矩形裁剪：返回矩形外面的部分', () => {
    const r = { x: 10, y: 10, w: 20, h: 20 };
    expect(clipOutside(0, 20, 40, 20, r)).toEqual([
      [0, 20, 10, 20],
      [30, 20, 40, 20],
    ]);
    expect(clipOutside(0, 0, 5, 5, r)).toEqual([[0, 0, 5, 5]]);
    expect(clipOutside(12, 12, 28, 28, r)).toEqual([]);
    expect(clipOutside(20, 20, 20, 60, r)).toEqual([[20, 30, 20, 60]]);
  });

  it('朝向：0 朝上，顺时针为正', () => {
    expect(headingOf(0, 0, 0, -10)).toBeCloseTo(0, 9);
    expect(headingOf(0, 0, 10, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(headingOf(0, 0, 0, 10)).toBeCloseTo(Math.PI, 9);
    expect(headingOf(0, 0, -10, 0)).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('点到线段的距离', () => {
    expect(segmentDistance(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(segmentDistance(-3, 4, 0, 0, 10, 0)).toBe(5);
    expect(segmentDistance(2, 0, 0, 0, 0, 0)).toBe(2);
  });
});

describe('各片区现在的样子', () => {
  it('开局只有老街开通，写字楼区和大学城没显示：地图上只露纸色', () => {
    expect(districtModes(campaignState())).toEqual(['open', 'hidden', 'hidden']);
  });

  it('显示了还没开通的片区淡画：写字楼区先显示，大学城要等它', () => {
    const state = campaignState();
    unlock(state, 'showOffice');
    expect(districtModes(state)).toEqual(['open', 'faded', 'hidden']);
    unlock(state, 'showCampus');
    expect(districtModes(state)).toEqual(['open', 'faded', 'faded']);
  });

  it('开通之后正常画，开通的片区一定画出来，不管有没有显示', () => {
    const state = campaignState();
    campaignOf(state).districts[1]!.open = true;
    expect(districtModes(state)).toEqual(['open', 'open', 'hidden']);
    unlock(state, 'showCampus');
    campaignOf(state).districts[2]!.open = true;
    expect(districtModes(state)).toEqual(['open', 'open', 'open']);
  });

  it('沙盒模式没有解锁和开通，片区一律开通', () => {
    const state = campaignState();
    state.campaign = null;
    expect(districtModes(state)).toEqual(['open', 'open', 'open']);
  });

  it('只读：不改状态', () => {
    const state = campaignState();
    const json = JSON.stringify(state);
    districtModes(state);
    expect(JSON.stringify(state)).toBe(json);
  });
});

describe('站点的屋顶', () => {
  const roofs = new Map<number, StationRoof>([[3, { roof: 3, rect: { x: 100, y: 200, w: 124, h: 96 }, building: 7 }]]);

  it('建在候选屋顶上的站，屋顶取城市里那一块，中心是站的坐标', () => {
    const state = campaignState();
    const s = state.stations[0] as { x: number; y: number };
    const r = stationRoofRect(roofs, state, 0, 3);
    expect(r.rect).toEqual({ x: 100, y: 200, w: 124, h: 96 });
    expect(r.center).toEqual({ x: s.x, y: s.y });
  });

  it('没有对应屋顶的站（沙盒模式，或者屋顶不在画面里）在站的坐标上另画一块默认大小的', () => {
    const state = campaignState();
    const s = state.stations[0] as { x: number; y: number };
    for (const index of [null, 99]) {
      const r = stationRoofRect(roofs, state, 0, index);
      expect(r.rect.w).toBe(DEFAULT_ROOF[0]);
      expect(r.rect.h).toBe(DEFAULT_ROOF[1]);
      expect(r.rect.x + r.rect.w / 2).toBeCloseTo(s.x, 9);
      expect(r.rect.y + r.rect.h / 2).toBeCloseTo(s.y, 9);
    }
  });

  it('城市里的候选屋顶按地图里 roofs 的下标取，位置是地图里的点，大小分小、中、大三档，小的比大的小', () => {
    const plan = planMapBoard(MAP_V1.districts.map((d) => ({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 })));
    const city = generateCity(citySpecFromMap(MAP_V1, plan.region, HELIPAD_NEAR));
    const byIndex = roofsByIndex(city);
    expect(byIndex.size).toBe(MAP_V1.roofs.length);
    MAP_V1.roofs.forEach((roof, index) => {
      const found = byIndex.get(index);
      expect(found, `屋顶 ${index}`).toBeDefined();
      const [w, h] = STATION_SIZES[roof.size];
      expect(found?.rect.w).toBe(w);
      expect(found?.rect.h).toBe(h);
      expect((found?.rect.x ?? 0) + w / 2).toBeCloseTo(roof.x, 6);
      expect((found?.rect.y ?? 0) + h / 2).toBeCloseTo(roof.y, 6);
    });
    expect(STATION_SIZES.small[0]).toBeLessThan(STATION_SIZES.medium[0]);
    expect(STATION_SIZES.medium[0]).toBeLessThan(STATION_SIZES.large[0]);
    expect(STATION_SIZES.small[1]).toBeLessThan(STATION_SIZES.medium[1]);
    expect(STATION_SIZES.medium[1]).toBeLessThan(STATION_SIZES.large[1]);
  });
});

describe('把一块东西挪出另一块', () => {
  const zone: Rect = { x: 100, y: 100, w: 60, h: 40 };

  it('本来不相交就不挪', () => {
    expect(moveClear({ x: 0, y: 0, w: 20, h: 10 }, zone, [])).toEqual({ x: 0, y: 0 });
    expect(moveClear({ x: 160, y: 100, w: 20, h: 10 }, zone, [])).toEqual({ x: 0, y: 0 });
  });

  it('相交时挪到刚好不压住，取挪得最近的方向，留 2 个单位的空', () => {
    // 压在左边缘上，向左挪最近
    const rect: Rect = { x: 90, y: 110, w: 20, h: 10 };
    const m = moveClear(rect, zone, []);
    expect(m).toEqual({ x: -12, y: 0 });
    expect(overlapArea({ ...rect, x: rect.x + m.x, y: rect.y + m.y }, zone)).toBe(0);
    // 压在下边缘上，向下挪最近
    const low: Rect = { x: 120, y: 135, w: 20, h: 10 };
    expect(moveClear(low, zone, [])).toEqual({ x: 0, y: 7 });
  });

  it('四个方向都能挪，别的东西挡着的方向不选：向左被占了就换成向右、向上、向下里最近的', () => {
    const rect: Rect = { x: 90, y: 110, w: 20, h: 10 };
    const blockLeft: Rect = { x: 60, y: 100, w: 30, h: 40 };
    const m = moveClear(rect, zone, [blockLeft]);
    expect(m.x).not.toBe(-12);
    expect(overlapArea({ ...rect, x: rect.x + m.x, y: rect.y + m.y }, blockLeft)).toBe(0);
    expect(overlapArea({ ...rect, x: rect.x + m.x, y: rect.y + m.y }, zone)).toBe(0);
  });

  it('只读：不改传进来的矩形', () => {
    const rect: Rect = { x: 90, y: 110, w: 20, h: 10 };
    const before = JSON.stringify([rect, zone]);
    moveClear(rect, zone, [zone]);
    expect(JSON.stringify([rect, zone])).toBe(before);
  });
});

describe('数据员站在哪座站的屋顶上', () => {
  it('数据员没到岗：没有人物。经营模式开局什么都没开放，价签开放时数据员到岗', () => {
    expect(clerkStation(campaignState())).toBeNull();
    const state = quietState({}, false);
    expect(clerkStation(state)).toBeNull();
    unlock(state, 'priceTags');
    expect(clerkStation(state)).toBeNull(); // 只开了价签，数据员是另一项开放，随价签由核心每步检查时一起开
    unlock(state, 'dataClerk');
    expect(clerkStation(state)).toBe(0);
  });

  it('到岗之后站在编号最小的、没有退回的站的屋顶上：新建的站不换人，最小的站退回之后换到下一座', () => {
    const state = withMoney(quietState());
    expect(clerkStation(state)).toBe(0);
    must(state, { type: 'buildStation', roof: 1 });
    const third = must(state, { type: 'buildStation', roof: 2 });
    expect(clerkStation(state)).toBe(0);
    state.stations[0]!.removed = true;
    expect(clerkStation(state)).toBe(1);
    state.stations[1]!.removed = true;
    expect(clerkStation(state)).toBe(third);
    state.stations[third]!.removed = true;
    expect(clerkStation(state)).toBeNull();
  });

  it('沙盒模式没有数据员：没有解锁这回事，开放项一律算开放，所以要排除', () => {
    const sandbox = stateOf(CITY, 10);
    expect(sandbox.campaign).toBeNull();
    expect(clerkStation(sandbox)).toBeNull();
  });

  it('只读：不改状态', () => {
    const state = quietState();
    const json = JSON.stringify(state);
    clerkStation(state);
    expect(JSON.stringify(state)).toBe(json);
  });
});

// 经营模式的地图在页面里的纯数据部分：镜头，站、候选屋顶、片区在窗口里的位置，点击和悬停的命中判断，站点小卡、候选屋顶的文字和悬停提示的位置。
// 画出来的东西（PixiJS 的精灵）在浏览器里，这里测它们依据的数据：位置从哪里来，点得中的是不是画出来的那个。
import { describe, expect, it } from 'vitest';
import { BASE_COLORS, STATION_COLOR_NAMES } from '../src/content/palette.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { OrderStatus, addOrder, advance, applyCommand, refreshShops } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { boardToScreen, worldRectToScreen, worldToScreen } from '../src/render/camera.ts';
import { STATION_SIZES, generateCity } from '../src/render/city.ts';
import { stationColor, themeFor } from '../src/render/look.ts';
import { HELIPAD_NEAR, citySpecFromMap } from '../src/render/map-spec.ts';
import { placeTickets, roofsByIndex, waitingTickets } from '../src/render/scene.ts';
import type { TicketPoint } from '../src/render/scene.ts';
import { forceHolding } from '../src/ui/debug-params.ts';
import { TICKET_REACH, hitTest, pickRoof, pickStation, pickTicket, ticketReach } from '../src/ui/map-hit.ts';
import type { MapTargets, Surface } from '../src/ui/map-hit.ts';
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  TOOLTIP_OFFSET,
  cardPlacement,
  estimateWidth,
  layoutRoofLabels,
  overlapArea,
  placeLabels,
  pointInRect,
  rectsOverlap,
  roofLabelFontPx,
  tooltipPlacement,
} from '../src/ui/map-layout.ts';
import type { LabelRequest, Rect } from '../src/ui/map-layout.ts';
import {
  MAP_PLAN,
  cameraFor,
  districtAnchor,
  districtBoxes,
  insetsFor,
  roofBoxes,
  roofIndexOfStation,
  shopIsOpen,
  stationAnchor,
  stationBoxes,
} from '../src/ui/map-state.ts';
import { candidateRoofs, roofLines } from '../src/ui/roofs.ts';
import { windowViewFor } from '../src/ui/state.ts';
import { campaignOf, campaignState, must, quietState, unlockAll, withMoney } from './campaign-helpers.ts';

const CITY = generateCity(citySpecFromMap(MAP_V1, MAP_PLAN.region, HELIPAD_NEAR));
const ROOFS = roofsByIndex(CITY);
const VIEW = { width: 1920, height: 1080, dpr: 1, uiScale: 1 };
const SURFACE: Surface = { board: MAP_PLAN.board, camera: cameraFor(VIEW) };

/** 票杆上的小票在画板上的中心，和渲染器摆小票用同一个函数（placeTickets）。 */
function ticketPointsOf(state: SimState, nowSteps: number, unit = 1.875): TicketPoint[] {
  const out: TicketPoint[] = [];
  for (const group of waitingTickets(state, nowSteps)) {
    const front = CITY.shops.find((f) => f.shop === group.shop);
    if (front === undefined || !shopIsOpen(state, group.shop)) continue;
    for (const placed of placeTickets(front, group.shown, unit)) {
      const p = MAP_PLAN.board.toBoard(placed.center.x, placed.center.y);
      out.push({ order: placed.ticket.order, x: p.x, y: p.y });
    }
  }
  return out;
}

function targetsOf(state: SimState, options: { roofs?: ReturnType<typeof candidateRoofs>; nowSteps?: number } = {}): MapTargets {
  return {
    stations: stationBoxes(state, ROOFS),
    roofs: roofBoxes(options.roofs ?? [], ROOFS),
    tickets: ticketPointsOf(state, options.nowSteps ?? state.step),
  };
}

describe('窗口的缩放', () => {
  it('以 1920×1080 为基准等比缩放：1920×1080 是 1，1280×720 是 2/3', () => {
    expect(windowViewFor(1920, 1080)).toEqual({ width: 1920, height: 1080, scale: 1 });
    expect(windowViewFor(1280, 720).scale).toBeCloseTo(2 / 3, 12);
  });

  it('宽高比不是 16:9 时取小的那个比例，界面不会超出窗口', () => {
    expect(windowViewFor(2560, 1080).scale).toBe(1);
    expect(windowViewFor(1920, 1440).scale).toBe(1);
    expect(windowViewFor(1600, 1200).scale).toBeCloseTo(1600 / 1920, 12);
  });

  it('窗口小于 1280×720 时按 1280×720 算，页面出滚动条，不再缩小', () => {
    const small = windowViewFor(800, 600);
    expect([small.width, small.height]).toEqual([1280, 720]);
    expect(small.scale).toBeCloseTo(1280 / 1920, 12);
    expect(windowViewFor(1000, 900).width).toBe(1280);
  });
});

describe('地图的镜头', () => {
  it('顶部留 100、底部留 24，都乘界面的缩放', () => {
    expect(insetsFor(1)).toEqual({ top: 100, bottom: 24 });
    expect(insetsFor(2 / 3).top).toBeCloseTo(200 / 3, 12);
    expect(insetsFor(2 / 3).bottom).toBeCloseTo(16, 12);
  });

  it('三个片区转了角之后的四个角都在窗口里，不钻到顶部和底部的界面物件下面', () => {
    for (const [w, h, dpr] of [[1920, 1080, 1], [1280, 720, 1], [2560, 1080, 1], [1000, 1000, 1], [3840, 2160, 2], [1440, 900, 2]] as const) {
      const view = windowViewFor(w, h);
      const insets = insetsFor(view.scale);
      const camera = cameraFor({ width: view.width, height: view.height, dpr, uiScale: view.scale });
      const tol = 1 / dpr + 1e-6;
      for (const d of campaignState().world.districts) {
        for (const [x, y] of [[d.x0, d.y0], [d.x1, d.y0], [d.x0, d.y1], [d.x1, d.y1]] as const) {
          const p = worldToScreen(MAP_PLAN.board, camera, x, y);
          expect(p.x, `${w}x${h}`).toBeGreaterThanOrEqual(-tol);
          expect(p.x, `${w}x${h}`).toBeLessThanOrEqual(view.width + tol);
          expect(p.y, `${w}x${h}`).toBeGreaterThanOrEqual(insets.top - tol);
          expect(p.y, `${w}x${h}`).toBeLessThanOrEqual(view.height - insets.bottom + tol);
        }
      }
    }
  });

  it('窗口大一倍，缩放大一倍', () => {
    const a = cameraFor({ width: 960, height: 540, dpr: 1, uiScale: 0.5 });
    const b = cameraFor({ width: 1920, height: 1080, dpr: 1, uiScale: 1 });
    expect(b.scale / a.scale).toBeCloseTo(2, 9);
  });
});

describe('站', () => {
  it('开局的站：建在地图里第一块候选屋顶上，屋顶是中屋顶的大小，取自城市', () => {
    const state = campaignState();
    const boxes = stationBoxes(state, ROOFS);
    expect(boxes).toHaveLength(1);
    const first = boxes[0]!;
    expect(first.id).toBe(0);
    expect(roofIndexOfStation(state, 0)).toBe(campaignOf(state).stations[0]!.roof);
    expect(first.rect.w).toBe(STATION_SIZES.medium[0]);
    expect(first.rect.h).toBe(STATION_SIZES.medium[1]);
    const s = state.stations[0]!;
    expect(first.rect.x + first.rect.w / 2).toBeCloseTo(s.x, 6);
    expect(first.rect.y + first.rect.h / 2).toBeCloseTo(s.y, 6);
  });

  it('屋顶大小按小、中、大：小屋顶的站比大屋顶的小', () => {
    const state = withMoney(quietState());
    const small = must(state, { type: 'buildStation', roof: 1 }); // 老街的小屋顶
    const large = must(state, { type: 'buildStation', roof: 4 }); // 老街的大屋顶
    const byId = (id: number) => stationBoxes(state, ROOFS).find((s) => s.id === id)!.rect;
    expect(byId(small).w).toBeLessThan(byId(0).w);
    expect(byId(0).w).toBeLessThan(byId(large).w);
    expect(byId(small).h).toBeLessThan(byId(large).h);
  });

  it('站的颜色按站的编号对颜色表取模：一号蓝，二号琥珀，三号绿，四号紫，第五座又是蓝', () => {
    const pal = themeFor('day').pal;
    const expected = STATION_COLOR_NAMES.map((n) => BASE_COLORS[n]);
    expect(expected).toEqual([BASE_COLORS.steel, BASE_COLORS.amber, BASE_COLORS.green, BASE_COLORS.purple]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((id) => stationColor(pal, id))).toEqual([...expected, ...expected, expected[0]]);
  });

  it('站可以退回再建，编号不回收，编号超过 4 之后颜色照样取模', () => {
    const state = withMoney(quietState());
    let id = 0;
    for (let i = 0; i < 5; i++) {
      id = must(state, { type: 'buildStation', roof: 1 });
      must(state, { type: 'refundStation', station: id });
    }
    expect(id).toBe(5);
    const last = must(state, { type: 'buildStation', roof: 1 });
    expect(last).toBe(6);
    expect(stationBoxes(state, ROOFS).map((s) => s.id)).toEqual([0, last]);
    expect(stationColor(themeFor('day').pal, last)).toBe(BASE_COLORS.green);
  });

  it('已退回的站不画', () => {
    const state = withMoney(quietState());
    const id = must(state, { type: 'buildStation', roof: 1 });
    expect(stationBoxes(state, ROOFS).map((s) => s.id)).toEqual([0, id]);
    must(state, { type: 'refundStation', station: id });
    expect(stationBoxes(state, ROOFS).map((s) => s.id)).toEqual([0]);
  });

  it('没有城市屋顶对应的站（屋顶不在画面里）也有一块默认大小的屋顶，不会少', () => {
    const state = campaignState();
    const boxes = stationBoxes(state, new Map());
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.rect.w).toBeGreaterThan(0);
  });

  it('只读：列出站和候选屋顶不改状态', () => {
    const state = withMoney(campaignState(), 900);
    advance(state, 300);
    const json = JSON.stringify(state);
    stationBoxes(state, ROOFS);
    roofBoxes(candidateRoofs(state), ROOFS);
    districtBoxes(state);
    expect(JSON.stringify(state)).toBe(json);
  });
});

describe('店和片区', () => {
  it('开局只开星级够的店，都在老街；开通写字楼区之后它的店才开张', () => {
    const state = campaignState();
    const open = MAP_V1.shops.map((_, i) => shopIsOpen(state, i));
    expect(open.filter(Boolean)).toHaveLength(campaignOf(state).shopOpen.filter(Boolean).length);
    expect(open.filter(Boolean)).toHaveLength(MAP_V1.shops.filter((s) => s.district === 0 && s.opensAtStar === 1).length);
    // 老街的 14 家店里，要升星才开张的几家没有开
    expect(open.filter(Boolean).length).toBeLessThan(MAP_V1.shops.filter((s) => s.district === 0).length);
    campaignOf(state).districts[1]!.open = true;
    refreshShops(state);
    const after = MAP_V1.shops.map((_, i) => shopIsOpen(state, i));
    expect(after.filter(Boolean).length - open.filter(Boolean).length).toBe(MAP_V1.shops.filter((s) => s.district === 1 && s.opensAtStar === 1).length);
  });

  it('沙盒模式的店一直开着', () => {
    const state = campaignState();
    state.campaign = null;
    expect(MAP_V1.shops.every((_, i) => shopIsOpen(state, i))).toBe(true);
  });

  it('片区在世界里的矩形取自状态，开通的才标 open', () => {
    const state = campaignState();
    const boxes = districtBoxes(state);
    expect(boxes.map((b) => b.open)).toEqual([true, false, false]);
    const d = state.world.districts[0]!;
    expect(boxes[0]!.rect).toEqual({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 });
  });
});

describe('界面物件贴着地图上的东西', () => {
  it('选中的站的小卡锚点：屋顶转了角之后的外接框，中心就是屋顶的中心', () => {
    const state = campaignState();
    const box = stationBoxes(state, ROOFS)[0]!;
    const a = stationAnchor(SURFACE.board, SURFACE.camera, box);
    const c = worldToScreen(SURFACE.board, SURFACE.camera, box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2);
    expect(a.x).toBeCloseTo(c.x, 6);
    expect(a.y).toBeCloseTo(c.y, 6);
    expect(a.w).toBeGreaterThan(box.rect.w * SURFACE.camera.scale);
    expect(a.h).toBeGreaterThan(box.rect.h * SURFACE.camera.scale);
    // 锚点的中心点上点一下，点得中这座站
    expect(pickStation(SURFACE, [box], a.x, a.y)).toBe(0);
  });

  it('窗口大小变了，锚点跟着镜头走：窗口大一倍，锚点离窗口左上角的距离也大一倍', () => {
    const state = campaignState();
    const box = stationBoxes(state, ROOFS)[0]!;
    const small = stationAnchor(MAP_PLAN.board, cameraFor({ width: 960, height: 540, dpr: 1, uiScale: 0.5 }), box);
    const big = stationAnchor(MAP_PLAN.board, cameraFor({ width: 1920, height: 1080, dpr: 1, uiScale: 1 }), box);
    expect(big.w / small.w).toBeCloseTo(2, 6);
    expect(big.h / small.h).toBeCloseTo(2, 6);
  });

  it('开通价签的锚点：片区转了角之后的外接框，左上角加宽高，中心是片区的中心', () => {
    const state = campaignState();
    const box = districtBoxes(state)[1]!;
    const a = districtAnchor(SURFACE.board, SURFACE.camera, box);
    expect(a.district).toBe(1);
    const c = worldToScreen(SURFACE.board, SURFACE.camera, box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2);
    expect(a.x + a.w / 2).toBeCloseTo(c.x, 6);
    expect(a.y + a.h / 2).toBeCloseTo(c.y, 6);
    const r = worldRectToScreen(SURFACE.board, SURFACE.camera, box.rect);
    expect([a.x, a.y, a.w, a.h]).toEqual([r.x, r.y, r.w, r.h]);
  });
});

describe('点击的命中判断', () => {
  it('点在站点屋顶里是点中这座站，边上留 4 个像素的余量，再远就没有', () => {
    const state = campaignState();
    const targets = targetsOf(state);
    const box = targets.stations[0]!;
    const c = worldToScreen(SURFACE.board, SURFACE.camera, box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2);
    expect(hitTest(SURFACE, targets, c.x, c.y, false)).toEqual({ kind: 'station', id: 0 });
    // 屋顶上边正中，沿屋顶外的法线移动 3 个像素和 7 个像素
    const edge = (d: number) => {
      const top = worldToScreen(SURFACE.board, SURFACE.camera, box.rect.x + box.rect.w / 2, box.rect.y - d / SURFACE.camera.scale);
      return top;
    };
    expect(pickStation(SURFACE, targets.stations, edge(3).x, edge(3).y)).toBe(0);
    expect(pickStation(SURFACE, targets.stations, edge(7).x, edge(7).y)).toBeNull();
    expect(hitTest(SURFACE, targets, 5, 5, false)).toBeNull();
  });

  it('屋顶是转了角的：外接框的角上是空白，点不中', () => {
    const state = campaignState();
    const box = stationBoxes(state, ROOFS)[0]!;
    const r = worldRectToScreen(SURFACE.board, SURFACE.camera, box.rect);
    expect(pickStation(SURFACE, [box], r.x + 0.5, r.y + 0.5, 0)).toBeNull();
    expect(pickStation(SURFACE, [box], r.x + r.w - 0.5, r.y + r.h - 0.5, 0)).toBeNull();
  });

  it('点在小票的中心附近是点中这张订单，近的点得中，远的点不中', () => {
    const state = quietState();
    const order = addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 50 });
    const targets = targetsOf(state, { nowSteps: order.tOrder + 10 });
    expect(targets.tickets).toHaveLength(1);
    const p = boardToScreen(SURFACE.camera, targets.tickets[0]!.x, targets.tickets[0]!.y);
    expect(hitTest(SURFACE, targets, p.x, p.y, false)).toEqual({ kind: 'ticket', orderId: order.id });
    expect(hitTest(SURFACE, targets, p.x + TICKET_REACH - 1, p.y, false)).toEqual({ kind: 'ticket', orderId: order.id });
    expect(hitTest(SURFACE, targets, p.x + TICKET_REACH + 4, p.y, false)).toBeNull();
    expect(hitTest(SURFACE, targets, p.x, p.y + TICKET_REACH + 4, false)).toBeNull();
  });

  it('两张小票挨得近时取离鼠标最近的那张', () => {
    const state = quietState();
    const a = addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 50 });
    const b = addOrder(state, { merchant: 0, building: 11, portion: 1, prepSteps: 50 });
    const targets = targetsOf(state, { nowSteps: a.tOrder + 10 });
    expect(targets.tickets.map((t) => t.order)).toEqual([a.id, b.id]);
    const pa = boardToScreen(SURFACE.camera, targets.tickets[0]!.x, targets.tickets[0]!.y);
    const pb = boardToScreen(SURFACE.camera, targets.tickets[1]!.x, targets.tickets[1]!.y);
    expect(pickTicket(SURFACE, targets.tickets, pa.x, pa.y)).toBe(a.id);
    expect(pickTicket(SURFACE, targets.tickets, pb.x, pb.y)).toBe(b.id);
    // 两张小票之间靠近第二张的位置
    const mid = { x: pa.x * 0.3 + pb.x * 0.7, y: pa.y * 0.3 + pb.y * 0.7 };
    expect(pickTicket(SURFACE, targets.tickets, mid.x, mid.y, 40)).toBe(b.id);
  });

  it('点小票的距离不小于 TICKET_REACH，窗口很大、小票画得更大时才放大', () => {
    expect(ticketReach(cameraFor({ width: 1280, height: 720, dpr: 1, uiScale: 2 / 3 }))).toBe(TICKET_REACH);
    expect(ticketReach(cameraFor({ width: 3840, height: 2160, dpr: 1, uiScale: 2 }))).toBeGreaterThan(TICKET_REACH);
  });

  it('站和小票重叠时先认站', () => {
    const state = quietState();
    const box = stationBoxes(state, ROOFS)[0]!;
    const c = worldToScreen(SURFACE.board, SURFACE.camera, box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2);
    const bc = SURFACE.board.toBoard(box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2);
    const targets: MapTargets = { stations: [box], roofs: [], tickets: [{ order: 0, x: bc.x, y: bc.y }] };
    expect(hitTest(SURFACE, targets, c.x, c.y, false)).toEqual({ kind: 'station', id: 0 });
  });

  it('已经取走的订单不挂在票杆上，点不中', () => {
    const state = quietState();
    const a = addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 50 });
    a.status = OrderStatus.Picked;
    expect(targetsOf(state).tickets).toEqual([]);
  });

  it('选屋顶的状态下只认候选屋顶，站和小票都不响应', () => {
    const state = unlockAll(campaignState());
    addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 50 });
    const targets = targetsOf(state, { roofs: candidateRoofs(state), nowSteps: 20 });
    expect(targets.roofs.length).toBe(5);
    const station = targets.stations[0]!;
    const sc = worldToScreen(SURFACE.board, SURFACE.camera, station.rect.x + station.rect.w / 2, station.rect.y + station.rect.h / 2);
    expect(hitTest(SURFACE, targets, sc.x, sc.y, true)).toBeNull();
    const t = boardToScreen(SURFACE.camera, targets.tickets[0]!.x, targets.tickets[0]!.y);
    expect(hitTest(SURFACE, targets, t.x, t.y, true)).toBeNull();
    const r = targets.roofs[1]!;
    const rc = worldToScreen(SURFACE.board, SURFACE.camera, r.rect.x + r.rect.w / 2, r.rect.y + r.rect.h / 2);
    expect(hitTest(SURFACE, targets, rc.x, rc.y, true)).toEqual({ kind: 'roof', roof: r.roof });
    expect(pickRoof(SURFACE, targets.roofs, 3, 3)).toBeNull();
  });

  it('不在选屋顶的状态下，候选屋顶不响应', () => {
    const state = campaignState();
    const targets = targetsOf(state, { roofs: [] });
    const roof = ROOFS.get(candidateRoofs(state)[1]!.roof)!.rect;
    const c = worldToScreen(SURFACE.board, SURFACE.camera, roof.x + roof.w / 2, roof.y + roof.h / 2);
    expect(hitTest(SURFACE, targets, c.x, c.y, false)).toBeNull();
  });

  it('点击命令的结果：点中候选屋顶建站，状态按核心的规则变', () => {
    const state = withMoney(unlockAll(campaignState()), 5000);
    advance(state, 10);
    const targets = targetsOf(state, { roofs: candidateRoofs(state) });
    const r = targets.roofs[0]!;
    const c = worldToScreen(SURFACE.board, SURFACE.camera, r.rect.x + r.rect.w / 2, r.rect.y + r.rect.h / 2);
    const hit = hitTest(SURFACE, targets, c.x, c.y, true);
    expect(hit?.kind).toBe('roof');
    if (hit?.kind === 'roof') expect(applyCommand(state, { type: 'buildStation', roof: hit.roof }).ok).toBe(true);
    expect(state.stations).toHaveLength(2);
  });

  it('候选屋顶的框取自城市里那块屋顶，只列有候选的', () => {
    const state = campaignState();
    const candidates = candidateRoofs(state);
    const boxes = roofBoxes(candidates, ROOFS);
    expect(boxes.map((b) => b.roof)).toEqual(candidates.map((c) => c.roof));
    for (const b of boxes) {
      const size = STATION_SIZES[MAP_V1.roofs[b.roof]!.size];
      expect([b.rect.w, b.rect.h]).toEqual([size[0], size[1]]);
    }
    expect(roofBoxes(candidates, new Map())).toEqual([]);
  });

  it('等降落的站：站的屋顶不变，点站照样点得中', () => {
    const state = campaignState();
    advance(state, 100);
    forceHolding(state, 2);
    const targets = targetsOf(state);
    const box = targets.stations[0]!;
    const c = worldToScreen(SURFACE.board, SURFACE.camera, box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2);
    expect(hitTest(SURFACE, targets, c.x, c.y, false)).toEqual({ kind: 'station', id: 0 });
  });
});

describe('文字的排版', () => {
  const bounds: Rect = { x: 0, y: 100, w: 1000, h: 800 };

  it('矩形的重叠：相交算重叠，贴边不算，面积是相交部分', () => {
    const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
    expect(overlapArea(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(25);
    expect(overlapArea(a, { x: 20, y: 20, w: 1, h: 1 })).toBe(0);
    expect(pointInRect(a, 10, 10)).toBe(true);
    expect(pointInRect(a, 11, 10)).toBe(false);
    expect(pointInRect(a, 11, 10, 2)).toBe(true);
  });

  it('一块文字：放在东西的正下方，居中，隔一点距离', () => {
    const anchor: Rect = { x: 400, y: 300, w: 100, h: 60 };
    const [p] = placeLabels([{ id: 1, anchor, w: 200, h: 40 }], [anchor], bounds);
    expect(p).toMatchObject({ id: 1, x: 350, y: 366, w: 200, h: 40, clear: true });
  });

  it('下方被挡住时换到上方，再换到右边、左边，取第一个不压住别的', () => {
    const anchor: Rect = { x: 400, y: 300, w: 100, h: 60 };
    const below: Rect = { x: 300, y: 362, w: 300, h: 60 };
    const [above] = placeLabels([{ id: 1, anchor, w: 200, h: 40 }], [anchor, below], bounds);
    expect(above?.y).toBe(254);
    expect(above?.clear).toBe(true);
    const aboveBlock: Rect = { x: 300, y: 250, w: 300, h: 50 };
    const [right] = placeLabels([{ id: 1, anchor, w: 200, h: 40 }], [anchor, below, aboveBlock], bounds);
    expect(right?.x).toBe(506);
    expect(right?.clear).toBe(true);
  });

  it('文字都夹在范围里，不钻到界面物件下面', () => {
    const anchor: Rect = { x: 5, y: 105, w: 60, h: 40 };
    const [p] = placeLabels([{ id: 1, anchor, w: 300, h: 40 }], [anchor], bounds);
    expect(p!.x).toBeGreaterThanOrEqual(bounds.x);
    expect(p!.y).toBeGreaterThanOrEqual(bounds.y);
    expect(p!.x + p!.w).toBeLessThanOrEqual(bounds.x + bounds.w);
    expect(p!.y + p!.h).toBeLessThanOrEqual(bounds.y + bounds.h);
  });

  it('多块文字：先放的占好位置，后放的绕开，能绕开时互不重叠、不压住任何东西', () => {
    // 三个屋顶挨得很近，文字比屋顶间距宽得多，不能都放在下面
    const anchors: Rect[] = [300, 420, 540].map((x) => ({ x, y: 300, w: 70, h: 50 }));
    const requests: LabelRequest[] = anchors.map((anchor, id) => ({ id, anchor, w: 200, h: 44 }));
    const placed = placeLabels(requests, anchors, bounds);
    expect(placed.map((p) => p.id)).toEqual([0, 1, 2]);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(rectsOverlap(placed[i]!, placed[j]!), `${i} ${j}`).toBe(false);
      for (const a of anchors) expect(rectsOverlap(placed[i]!, a), `${i}`).toBe(false);
      expect(placed[i]!.clear).toBe(true);
    }
    expect(placed[0]!.y).toBeGreaterThan(300); // 第一块放在下面
    expect(placed[1]!.y).toBeLessThan(300); // 第二块下面被占了，换到上面
  });

  it('实在绕不开时选重叠最少的，并标出没有放干净', () => {
    // 一块范围小得放不下，文字比范围还大
    const tight: Rect = { x: 0, y: 0, w: 100, h: 60 };
    const anchor: Rect = { x: 20, y: 10, w: 60, h: 40 };
    const [p] = placeLabels([{ id: 9, anchor, w: 200, h: 80 }], [anchor], tight);
    expect(p?.clear).toBe(false);
  });

  it('文字块的大小原样返回', () => {
    const [p] = placeLabels([{ id: 3, anchor: { x: 400, y: 300, w: 100, h: 60 }, w: 123, h: 45 }], [], bounds);
    expect([p?.w, p?.h]).toEqual([123, 45]);
  });
});

describe('一行字大约多宽', () => {
  it('汉字和全角标点一个字号宽，数字窄一点，空格和小数点更窄', () => {
    expect(estimateWidth('老街', 10)).toBe(20);
    expect(estimateWidth('，。　', 10)).toBe(30);
    expect(estimateWidth('12', 10)).toBeCloseTo(11.6, 9);
    expect(estimateWidth('1.5', 10)).toBeCloseTo(14.6, 9);
    expect(estimateWidth('', 10)).toBe(0);
  });

  it('字号放大，宽度跟着等比放大', () => {
    expect(estimateWidth('飞到本片区的店平均 1.2 秒', 20)).toBeCloseTo(2 * estimateWidth('飞到本片区的店平均 1.2 秒', 10), 9);
  });
});

describe('候选屋顶的文字', () => {
  const bounds: Rect = { x: 8, y: 104, w: 1904, h: 860 };

  it('字号跟着窗口缩放，夹在 11 到 15 之间', () => {
    expect(roofLabelFontPx(1)).toBe(15);
    expect(roofLabelFontPx(2)).toBe(15);
    expect(roofLabelFontPx(0.5)).toBe(11);
    expect(roofLabelFontPx(0.8)).toBeCloseTo(12, 9);
  });

  it('每块屋顶一块文字，带两行字，位置不压住任何一块屋顶、别的文字和站，不钻出范围', () => {
    const state = campaignState();
    const candidates = candidateRoofs(state);
    const boxes = roofBoxes(candidates, ROOFS);
    const inputs = boxes.map((b) => {
      const c = candidates.find((x) => x.roof === b.roof)!;
      return { roof: b.roof, box: worldRectToScreen(SURFACE.board, SURFACE.camera, b.rect), lines: roofLines(c), ok: c.ok };
    });
    const stations = stationBoxes(state, ROOFS).map((b) => worldRectToScreen(SURFACE.board, SURFACE.camera, b.rect));
    const placed = layoutRoofLabels(inputs, stations, bounds, 15);
    expect(placed.map((p) => p.roof)).toEqual(candidates.map((c) => c.roof));
    for (const p of placed) {
      expect(p.lines).toHaveLength(2);
      expect(p.px).toBe(15);
      expect(p.x).toBeGreaterThanOrEqual(bounds.x);
      expect(p.x + p.w).toBeLessThanOrEqual(bounds.x + bounds.w);
      expect(p.y).toBeGreaterThanOrEqual(bounds.y);
      expect(p.y + p.h).toBeLessThanOrEqual(bounds.y + bounds.h);
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(rectsOverlap(placed[i]!, placed[j]!), `文字 ${i} 和 ${j}`).toBe(false);
    }
  });

  it('文字块的大小随字数和字号：宽度是最宽一行加左右内边距，高度是行数乘行高加上下内边距', () => {
    const [p] = layoutRoofLabels([{ roof: 7, box: { x: 400, y: 400, w: 60, h: 40 }, lines: ['一二三四五', '一二'], ok: true }], [], bounds, 15);
    expect(p!.w).toBeCloseTo(75 + 14, 9);
    expect(p!.h).toBeCloseTo(2 * 15 * 1.4 + 10, 9);
    expect(p!.ok).toBe(true);
  });
});

describe('悬停提示的位置', () => {
  it('摆在鼠标的右下方', () => {
    const p = tooltipPlacement({ x: 500, y: 300 }, 1920, 1080, 300, 30);
    expect(p).toEqual({ left: 500 + TOOLTIP_OFFSET.x, top: 300 + TOOLTIP_OFFSET.y });
  });

  it('靠近窗口右边放不下就翻到鼠标左边，靠近下边就翻到上边', () => {
    const right = tooltipPlacement({ x: 1800, y: 300 }, 1920, 1080, 300, 30);
    expect(right.left + 300).toBeLessThanOrEqual(1800);
    const bottom = tooltipPlacement({ x: 500, y: 1070 }, 1920, 1080, 300, 30);
    expect(bottom.top + 30).toBeLessThanOrEqual(1070);
  });

  it('翻过去还放不下时贴着窗口的边，不出窗口', () => {
    const p = tooltipPlacement({ x: 100, y: 10 }, 400, 300, 500, 400);
    expect(p.left).toBeGreaterThanOrEqual(4);
    expect(p.top).toBeGreaterThanOrEqual(4);
  });
});

describe('站点小卡的位置', () => {
  const at = { x: 600, y: 400, w: 100, h: 80 };

  it('站的右边放得下就摆右边，和站的顶边对齐，隔一点距离', () => {
    const p = cardPlacement(at, 1920, 1080, 1);
    expect(p.flip).toBe(false);
    expect(p.left).toBe(600 + 50 + CARD_GAP);
    expect(p.top).toBe(360);
  });

  it('右边放不下摆左边：小卡的右边贴着站，flip 为 true', () => {
    const p = cardPlacement({ ...at, x: 1800 }, 1920, 1080, 1);
    expect(p.flip).toBe(true);
    expect(p.left).toBe(1800 - 50 - CARD_GAP);
  });

  it('站在窗口下沿：小卡往上提，不超出窗口', () => {
    const p = cardPlacement({ ...at, y: 1050 }, 1920, 1080, 1);
    expect(p.top).toBeLessThanOrEqual(1080 - CARD_HEIGHT - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it('窗口缩放时，小卡的宽度、高度和距离一起缩放', () => {
    const p = cardPlacement({ x: 1000, y: 500, w: 60, h: 40 }, 1280, 720, 2 / 3);
    expect(p.flip).toBe(false);
    expect(p.left).toBeCloseTo(1000 + 30 + CARD_GAP * (2 / 3), 9);
    const wide = cardPlacement({ x: 1100, y: 500, w: 60, h: 40 }, 1280, 720, 2 / 3);
    expect(1100 + 30 + CARD_GAP * (2 / 3) + CARD_WIDTH * (2 / 3)).toBeGreaterThan(1280 - 8);
    expect(wide.flip).toBe(true);
  });
});

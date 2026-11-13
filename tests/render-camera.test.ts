// 镜头：整张地图转 7° 之后取外接框放进窗口，窗口坐标和世界坐标的换算（缩放、偏移、转角），点中转了角的屋顶，会动的东西的放大倍数。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import {
  bakeScaleFor,
  boardToScreen,
  fitCamera,
  markerUnits,
  screenPointInWorldRect,
  screenToBoard,
  screenToWorld,
  snapToDevice,
  visibleBoardRect,
  worldRectToScreen,
  worldToScreen,
} from '../src/render/camera.ts';
import type { Camera } from '../src/render/camera.ts';
import type { Rect } from '../src/render/geometry.ts';
import { MAP_ANGLE, MAP_MARGIN, planMapBoard } from '../src/render/map-spec.ts';

const DISTRICTS: Rect[] = MAP_V1.districts.map((d) => ({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 }));
const PLAN = planMapBoard(DISTRICTS);
const INSETS = { top: 100, bottom: 24 };

describe('整张地图的画板', () => {
  it('片区外框加四周的留白是城市要生成的范围，画板是它转 7° 之后的外接框', () => {
    expect(MAP_ANGLE).toBeCloseTo((-7 * Math.PI) / 180, 12);
    const x0 = Math.min(...DISTRICTS.map((d) => d.x));
    const x1 = Math.max(...DISTRICTS.map((d) => d.x + d.w));
    const y0 = Math.min(...DISTRICTS.map((d) => d.y));
    const y1 = Math.max(...DISTRICTS.map((d) => d.y + d.h));
    expect(PLAN.region).toEqual({ x: x0 - MAP_MARGIN, y: y0 - MAP_MARGIN, w: x1 - x0 + 2 * MAP_MARGIN, h: y1 - y0 + 2 * MAP_MARGIN });
    const c = Math.cos(MAP_ANGLE);
    const s = Math.abs(Math.sin(MAP_ANGLE));
    expect(PLAN.board.width).toBeCloseTo(PLAN.region.w * c + PLAN.region.h * s, 9);
    expect(PLAN.board.height).toBeCloseTo(PLAN.region.w * s + PLAN.region.h * c, 9);
    expect(PLAN.content).toEqual({ x: 0, y: 0, w: PLAN.board.width, h: PLAN.board.height });
  });

  it('世界里的外框四个角转到画板上，正好碰到画板的四条边', () => {
    const { region, board } = PLAN;
    const corners = [
      board.toBoard(region.x, region.y),
      board.toBoard(region.x + region.w, region.y),
      board.toBoard(region.x, region.y + region.h),
      board.toBoard(region.x + region.w, region.y + region.h),
    ];
    expect(Math.min(...corners.map((p) => p.x))).toBeCloseTo(0, 6);
    expect(Math.max(...corners.map((p) => p.x))).toBeCloseTo(board.width, 6);
    expect(Math.min(...corners.map((p) => p.y))).toBeCloseTo(0, 6);
    expect(Math.max(...corners.map((p) => p.y))).toBeCloseTo(board.height, 6);
  });

  it('没有片区时报错', () => {
    expect(() => planMapBoard([])).toThrow(/district/);
  });
});

describe('把地图放进窗口', () => {
  const windows: [number, number, number][] = [
    [1920, 1080, 1],
    [1280, 720, 1],
    [2560, 1080, 1],
    [1000, 1000, 1],
    [3840, 2160, 2],
    [1536, 864, 1.25],
  ];

  it('三个片区转了角之后的四个角都在窗口里，顶部留 100、底部留 24', () => {
    for (const [w, h, dpr] of windows) {
      const cam = fitCamera(PLAN.content, w, h, INSETS, dpr);
      for (const d of DISTRICTS) {
        for (const [x, y] of [[d.x, d.y], [d.x + d.w, d.y], [d.x, d.y + d.h], [d.x + d.w, d.y + d.h]] as const) {
          const p = worldToScreen(PLAN.board, cam, x, y);
          const tol = 1 / dpr + 1e-6; // 偏移对齐设备像素，最多差半个设备像素
          expect(p.x, `${w}x${h}`).toBeGreaterThanOrEqual(-tol);
          expect(p.x, `${w}x${h}`).toBeLessThanOrEqual(w + tol);
          expect(p.y, `${w}x${h}`).toBeGreaterThanOrEqual(INSETS.top - tol);
          expect(p.y, `${w}x${h}`).toBeLessThanOrEqual(h - INSETS.bottom + tol);
        }
      }
    }
  });

  it('画板正好占满窗口去掉上下留白之后的一个方向，另一个方向居中', () => {
    for (const [w, h, dpr] of windows) {
      const cam = fitCamera(PLAN.content, w, h, INSETS, dpr);
      const tol = 1 / dpr + 1e-6;
      const left = cam.x;
      const right = w - (cam.x + PLAN.board.width * cam.scale);
      const top = cam.y - INSETS.top;
      const bottom = h - INSETS.bottom - (cam.y + PLAN.board.height * cam.scale);
      expect(Math.min(left, right, top, bottom), `${w}x${h}`).toBeGreaterThanOrEqual(-tol);
      // 至少一个方向贴满，左右（或上下）留的一样多
      expect(Math.min(Math.abs(left), Math.abs(top)), `${w}x${h}`).toBeLessThanOrEqual(tol);
      expect(Math.abs(left - right), `${w}x${h}`).toBeLessThanOrEqual(2 * tol);
      expect(Math.abs(top - bottom), `${w}x${h}`).toBeLessThanOrEqual(2 * tol);
    }
  });

  it('1920×1080：高度是限制，缩放是 (1080 - 100 - 24) / 画板高度，左右各留出一块空白', () => {
    const cam = fitCamera(PLAN.content, 1920, 1080, INSETS, 1);
    expect(cam.scale).toBeCloseTo((1080 - 124) / PLAN.board.height, 9);
    expect(cam.x).toBeGreaterThan(200);
  });

  it('窗口比画板更窄时，宽度是限制，贴满左右', () => {
    const cam = fitCamera(PLAN.content, 1000, 1400, INSETS, 1);
    expect(cam.scale).toBeCloseTo(1000 / PLAN.board.width, 9);
    expect(Math.abs(cam.x)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('缩放按窗口等比：窗口大一倍（上下留白也大一倍），缩放大一倍', () => {
    const a = fitCamera(PLAN.content, 960, 540, { top: 50, bottom: 12 }, 1);
    const b = fitCamera(PLAN.content, 1920, 1080, INSETS, 1);
    expect(b.scale / a.scale).toBeCloseTo(2, 9);
  });

  it('偏移对齐设备像素：乘设备像素比之后是整数', () => {
    for (const [w, h, dpr] of windows) {
      const cam = fitCamera(PLAN.content, w, h, INSETS, dpr);
      expect(cam.x * dpr, `${w}x${h}`).toBeCloseTo(Math.round(cam.x * dpr), 9);
      expect(cam.y * dpr, `${w}x${h}`).toBeCloseTo(Math.round(cam.y * dpr), 9);
    }
    expect(snapToDevice(10.3, 1)).toBe(10);
    expect(snapToDevice(10.3, 2)).toBe(10.5);
    expect(snapToDevice(-0.26, 4)).toBe(-0.25);
  });

  it('静态层的烘焙倍率是镜头缩放乘设备像素比', () => {
    const cam = fitCamera(PLAN.content, 1920, 1080, INSETS, 2);
    expect(bakeScaleFor(cam, 2)).toBeCloseTo(cam.scale * 2, 12);
  });
});

describe('窗口坐标和世界坐标的换算', () => {
  const cam: Camera = fitCamera(PLAN.content, 1920, 1080, INSETS, 1);

  it('世界到窗口再回来，点不变', () => {
    for (const [x, y] of [[100, 200], [1250, 700], [2300, 150], [900, 1700], [-50, 3000]] as const) {
      const s = worldToScreen(PLAN.board, cam, x, y);
      const back = screenToWorld(PLAN.board, cam, s.x, s.y);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  it('窗口到世界再回来，点不变', () => {
    for (const [sx, sy] of [[0, 0], [960, 540], [1919, 1079], [333.5, 777.25]] as const) {
      const w = screenToWorld(PLAN.board, cam, sx, sy);
      const back = worldToScreen(PLAN.board, cam, w.x, w.y);
      expect(back.x).toBeCloseTo(sx, 6);
      expect(back.y).toBeCloseTo(sy, 6);
    }
  });

  it('世界里朝右的一段，在窗口里朝右上：转角是 -7°，缩放是镜头的缩放', () => {
    const a = worldToScreen(PLAN.board, cam, 1000, 1000);
    const b = worldToScreen(PLAN.board, cam, 1100, 1000);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    expect(Math.hypot(dx, dy)).toBeCloseTo(100 * cam.scale, 9);
    expect(Math.atan2(dy, dx)).toBeCloseTo(MAP_ANGLE, 9);
    expect(dy).toBeLessThan(0);
  });

  it('画板和窗口之间只有缩放和平移', () => {
    const b = boardToScreen(cam, 10, 20);
    expect(b).toEqual({ x: 10 * cam.scale + cam.x, y: 20 * cam.scale + cam.y });
    const back = screenToBoard(cam, b.x, b.y);
    expect(back.x).toBeCloseTo(10, 9);
    expect(back.y).toBeCloseTo(20, 9);
  });

  it('窗口盖住画板上的哪一块：左上角和右下角换回窗口正好是 (0,0) 和 (宽,高)', () => {
    const v = visibleBoardRect(cam, 1920, 1080);
    const a = boardToScreen(cam, v.x, v.y);
    const b = boardToScreen(cam, v.x + v.w, v.y + v.h);
    expect(a.x).toBeCloseTo(0, 9);
    expect(a.y).toBeCloseTo(0, 9);
    expect(b.x).toBeCloseTo(1920, 9);
    expect(b.y).toBeCloseTo(1080, 9);
  });

  it('世界里的矩形在窗口里的外接框：比不转角时的大小大一点，中心不变', () => {
    const rect: Rect = { x: 1000, y: 800, w: 124, h: 96 };
    const box = worldRectToScreen(PLAN.board, cam, rect);
    const center = worldToScreen(PLAN.board, cam, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(box.x + box.w / 2).toBeCloseTo(center.x, 6);
    expect(box.y + box.h / 2).toBeCloseTo(center.y, 6);
    expect(box.w).toBeGreaterThan(rect.w * cam.scale);
    expect(box.h).toBeGreaterThan(rect.h * cam.scale);
    // 四个角都在外接框里
    for (const [x, y] of [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]] as const) {
      const p = worldToScreen(PLAN.board, cam, x, y);
      expect(p.x).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(p.x).toBeLessThanOrEqual(box.x + box.w + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(box.y - 1e-6);
      expect(p.y).toBeLessThanOrEqual(box.y + box.h + 1e-6);
    }
  });
});

describe('点中转了角的屋顶', () => {
  const cam: Camera = fitCamera(PLAN.content, 1920, 1080, INSETS, 1);
  const roof: Rect = { x: 1000, y: 800, w: 124, h: 96 };

  it('屋顶中心和靠近四个角的内侧点都点得中', () => {
    const c = worldToScreen(PLAN.board, cam, 1062, 848);
    expect(screenPointInWorldRect(PLAN.board, cam, roof, c.x, c.y)).toBe(true);
    for (const [x, y] of [[roof.x + 3, roof.y + 3], [roof.x + roof.w - 3, roof.y + 3], [roof.x + 3, roof.y + roof.h - 3], [roof.x + roof.w - 3, roof.y + roof.h - 3]] as const) {
      const p = worldToScreen(PLAN.board, cam, x, y);
      expect(screenPointInWorldRect(PLAN.board, cam, roof, p.x, p.y)).toBe(true);
    }
  });

  it('外接框的角上有一块空白，它不属于屋顶：按真实的形状判断，点不中', () => {
    const box = worldRectToScreen(PLAN.board, cam, roof);
    // 转了角的矩形，外接框的四个角都在矩形外面
    const inside = [[box.x + 1, box.y + 1], [box.x + box.w - 1, box.y + 1], [box.x + 1, box.y + box.h - 1], [box.x + box.w - 1, box.y + box.h - 1]].filter(([x, y]) =>
      screenPointInWorldRect(PLAN.board, cam, roof, x as number, y as number),
    );
    expect(inside).toHaveLength(0);
  });

  it('边上的余量按窗口像素算：屋顶外 4 个像素以内点得中，再远点不中', () => {
    const topMid = worldToScreen(PLAN.board, cam, roof.x + roof.w / 2, roof.y);
    // 沿屋顶上边向外的法线（世界里朝上，转角之后）移动
    const out = (d: number): { x: number; y: number } => {
      const a = screenToWorld(PLAN.board, cam, topMid.x, topMid.y);
      const w = { x: a.x, y: a.y - d / cam.scale };
      return worldToScreen(PLAN.board, cam, w.x, w.y);
    };
    const near = out(3);
    const far = out(7);
    expect(screenPointInWorldRect(PLAN.board, cam, roof, near.x, near.y, 4)).toBe(true);
    expect(screenPointInWorldRect(PLAN.board, cam, roof, far.x, far.y, 4)).toBe(false);
    expect(screenPointInWorldRect(PLAN.board, cam, roof, near.x, near.y, 0)).toBe(false);
  });
});

describe('会动的东西和字的放大倍数', () => {
  it('镜头缩放是 1 时什么都不放大：倍数全是 1', () => {
    for (const v of Object.values(markerUnits(1))) expect(v).toBe(1);
    for (const v of Object.values(markerUnits(2.5))) expect(v).toBe(1);
  });

  it('整张地图放进窗口时缩放小，倍数大于 1，放大之后在窗口里不比目标尺寸小', () => {
    const z = 0.48;
    const u = markerUnits(z);
    for (const v of Object.values(u)) expect(v).toBeGreaterThan(1);
    expect(z * u.ticket).toBeCloseTo(0.9, 9);
    expect(z * u.drone).toBeCloseTo(0.72, 9);
    expect(z * u.text).toBeCloseTo(0.9, 9);
  });

  it('缩放越小倍数越大，有上限；缩放越大倍数越小，到 1 为止', () => {
    let last = 0;
    for (const z of [1, 0.9, 0.7, 0.5, 0.3, 0.1]) {
      const u = markerUnits(z);
      expect(u.ticket).toBeGreaterThanOrEqual(last);
      last = u.ticket;
      expect(u.ticket).toBeLessThanOrEqual(2.2);
      expect(u.drone).toBeLessThanOrEqual(2);
      expect(u.line).toBeLessThanOrEqual(1.8);
    }
    expect(markerUnits(0.001).ticket).toBe(2.2);
  });

  it('镜头缩放为 0 或负数时不出错', () => {
    expect(Number.isFinite(markerUnits(0).ticket)).toBe(true);
    expect(Number.isFinite(markerUnits(-1).ticket)).toBe(true);
  });
});

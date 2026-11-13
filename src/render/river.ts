// 河：地图数据里是一串控制点，这里用 Catmull-Rom 样条平滑成河道中心线，并给出到河道的距离、两岸的平行线。
// 河只用于画面，飞机可以直接飞过去。
import type { River } from './city-types.ts';
import type { Rect, Vec } from './geometry.ts';
import { clamp, dist, segmentDistance } from './geometry.ts';

/** 平滑后相邻两点的间隔，世界单位。 */
const STEP = 12;

function catmull(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
}

/**
 * 河道中心线。两端沿着最后一段的方向再延伸 reach，让河流出画面的边缘（画板比世界大一圈，河不能在地图边上突然断掉）。
 */
export function makeRiver(control: readonly Vec[], halfWidth: number, reach = 700): River {
  if (control.length < 2) return { center: [], halfWidth };
  const first = control[0] as Vec;
  const second = control[1] as Vec;
  const last = control[control.length - 1] as Vec;
  const before = control[control.length - 2] as Vec;
  const norm = (a: Vec, b: Vec): Vec => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const d0 = norm(second, first);
  const d1 = norm(before, last);
  const pts: Vec[] = [{ x: first.x + d0.x * reach, y: first.y + d0.y * reach }, ...control, { x: last.x + d1.x * reach, y: last.y + d1.y * reach }];
  const center: Vec[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)] as Vec;
    const p1 = pts[i] as Vec;
    const p2 = pts[i + 1] as Vec;
    const p3 = pts[Math.min(pts.length - 1, i + 2)] as Vec;
    const len = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
    const n = Math.max(2, Math.ceil(len / STEP));
    for (let k = 0; k < n; k++) center.push(catmull(p0, p1, p2, p3, k / n));
  }
  center.push(pts[pts.length - 1] as Vec);
  return { center, halfWidth };
}

/** (x, y) 到河道中心线的距离。 */
export function riverDistance(river: River, x: number, y: number): number {
  let best = Infinity;
  const c = river.center;
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i] as Vec;
    const b = c[i + 1] as Vec;
    // 先用包围盒粗筛
    if (Math.min(a.x, b.x) - best > x || Math.max(a.x, b.x) + best < x || Math.min(a.y, b.y) - best > y || Math.max(a.y, b.y) + best < y) continue;
    const d = segmentDistance(x, y, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

/** (x, y) 在河里，或者离岸不到 margin。 */
export function isWet(river: River, x: number, y: number, margin = 0): boolean {
  return riverDistance(river, x, y) < river.halfWidth + margin;
}

/** 线段 (ax,ay)-(bx,by) 和矩形有公共点：穿过矩形，或者有端点落在矩形里，擦边也算。 */
function segmentHitsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  if (Math.max(ax, bx) < r.x || Math.min(ax, bx) > r.x + r.w || Math.max(ay, by) < r.y || Math.min(ay, by) > r.y + r.h) return false;
  const dx = bx - ax;
  const dy = by - ay;
  const side = (px: number, py: number): number => dx * (py - ay) - dy * (px - ax);
  const s1 = side(r.x, r.y);
  const s2 = side(r.x + r.w, r.y);
  const s3 = side(r.x, r.y + r.h);
  const s4 = side(r.x + r.w, r.y + r.h);
  // 矩形的四个角都在线段所在直线的同一侧，线段就碰不到它
  return !((s1 > 0 && s2 > 0 && s3 > 0 && s4 > 0) || (s1 < 0 && s2 < 0 && s3 < 0 && s4 < 0));
}

/** 线段到矩形的最短距离。线段碰到矩形时是 0。 */
export function segmentRectDistance(ax: number, ay: number, bx: number, by: number, r: Rect): number {
  if (segmentHitsRect(ax, ay, bx, by, r)) return 0;
  // 没有公共点时，最近的一对点里至少有一个是矩形的角或线段的端点
  const toRect = (px: number, py: number): number => dist(px, py, clamp(px, r.x, r.x + r.w), clamp(py, r.y, r.y + r.h));
  let best = Math.min(toRect(ax, ay), toRect(bx, by));
  for (const [cx, cy] of [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ] as const) {
    best = Math.min(best, segmentDistance(cx, cy, ax, ay, bx, by));
  }
  return best;
}

/** 矩形到河道中心线的最短距离。小于半个河宽，说明矩形压在水面上。 */
export function rectRiverDistance(river: River, rect: Rect): number {
  let best = Infinity;
  const c = river.center;
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i] as Vec;
    const b = c[i + 1] as Vec;
    if (Math.max(a.x, b.x) + best < rect.x || Math.min(a.x, b.x) - best > rect.x + rect.w || Math.max(a.y, b.y) + best < rect.y || Math.min(a.y, b.y) - best > rect.y + rect.h) continue;
    const d = segmentRectDistance(a.x, a.y, b.x, b.y, rect);
    if (d < best) best = d;
  }
  return best;
}

/** 在一小块区域里反复问河的事用的探针，由 probeRiver 生成。 */
export interface RiverProbe {
  /** 和 isWet 一样。 */
  wet(x: number, y: number, margin?: number): boolean;
  /** 和 rectRiverDistance 一样。 */
  rectDistance(rect: Rect): number;
}

/**
 * 先把离 area 不到「半个河宽加 reach」的河段挑出来，之后探针每次只看这几段，不必把整条河扫一遍。
 * 询问的点和矩形要在 area 里。只关心距离小于半个河宽加 reach 的情况时，结果和 isWet、rectRiverDistance 完全一样。
 */
export function probeRiver(river: River, area: Rect, reach: number): RiverProbe {
  const t = river.halfWidth + reach;
  const keep: [number, number, number, number][] = [];
  const c = river.center;
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i] as Vec;
    const b = c[i + 1] as Vec;
    if (Math.max(a.x, b.x) < area.x - t || Math.min(a.x, b.x) > area.x + area.w + t || Math.max(a.y, b.y) < area.y - t || Math.min(a.y, b.y) > area.y + area.h + t) continue;
    keep.push([a.x, a.y, b.x, b.y]);
  }
  return {
    wet(x, y, margin = 0) {
      let best = Infinity;
      for (const [ax, ay, bx, by] of keep) {
        if (Math.min(ax, bx) - best > x || Math.max(ax, bx) + best < x || Math.min(ay, by) - best > y || Math.max(ay, by) + best < y) continue;
        const d = segmentDistance(x, y, ax, ay, bx, by);
        if (d < best) best = d;
      }
      return best < river.halfWidth + margin;
    },
    rectDistance(rect) {
      let best = Infinity;
      for (const [ax, ay, bx, by] of keep) {
        if (Math.max(ax, bx) + best < rect.x || Math.min(ax, bx) - best > rect.x + rect.w || Math.max(ay, by) + best < rect.y || Math.min(ay, by) - best > rect.y + rect.h) continue;
        const d = segmentRectDistance(ax, ay, bx, by, rect);
        if (d < best) best = d;
      }
      return best;
    },
  };
}

/**
 * 河道中心线向一侧平行移动 d 得到的折线：沿着每个点的法线移动。
 * 弯得很急的内侧，移动之后的线会折回来，把折回去的点丢掉，只留下顺着河走的点。
 */
export function riverEdge(river: River, d: number, side: -1 | 1, within?: Rect): Vec[] {
  const c = river.center;
  const out: Vec[] = [];
  for (let i = 0; i < c.length; i++) {
    const prev = c[Math.max(0, i - 1)] as Vec;
    const next = c[Math.min(c.length - 1, i + 1)] as Vec;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.sqrt(tx * tx + ty * ty) || 1;
    const p = { x: (c[i] as Vec).x + side * d * (-ty / len), y: (c[i] as Vec).y + side * d * (tx / len) };
    if (within !== undefined && (p.x < within.x - 80 || p.x > within.x + within.w + 80 || p.y < within.y - 80 || p.y > within.y + within.h + 80)) continue;
    const last = out[out.length - 1];
    if (last !== undefined) {
      const sx = p.x - last.x;
      const sy = p.y - last.y;
      // 折回来的点：这一步和河道前进的方向反着
      if (sx * tx + sy * ty < 0) continue;
    }
    out.push(p);
  }
  return out;
}

/** 河道中心线上离 (x, y) 最近的一点，和那里的走向（弧度，沿着河的方向）。桥要垂直于它。 */
export function riverNearest(river: River, x: number, y: number): { point: Vec; angle: number; distance: number } {
  let best = Infinity;
  let at = 0;
  const c = river.center;
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i] as Vec;
    const b = c[i + 1] as Vec;
    const d = segmentDistance(x, y, a.x, a.y, b.x, b.y);
    if (d < best) {
      best = d;
      at = i;
    }
  }
  const a = c[at] as Vec;
  const b = c[Math.min(c.length - 1, at + 1)] as Vec;
  return { point: a, angle: Math.atan2(b.y - a.y, b.x - a.x), distance: best };
}

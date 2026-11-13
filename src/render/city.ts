// 城市生成：地图数据里只有店、楼、候选屋顶的坐标和一条河，街道和街区、屋顶上的东西都在这里按坐标生成。
// 全部是确定的：同一份输入（地图数据、画面区域、种子）得到同一份城市，没有 Math.random，也不读时钟。
//
// 做法：
// 1. 保留的屋顶。每家店、每栋送餐的楼、每块候选屋顶，在它的坐标上占一块固定大小的屋顶。
//    互相压住的，沿穿透较浅的方向推开，推不开的再缩小，候选屋顶不动也不缩小。
// 2. 街道。streets.ts 把画面覆盖的区域一刀一刀切开，街不能压住候选屋顶，尽量少压住店和楼，切下来的叶子就是街区。
//    压在街上的店和楼挪进它所在的街区里面：整块屋顶移进街区的边界，太大就缩小。
// 3. 整理。店和楼挪进街区之后，还压着别的保留屋顶的，或者碰到水面的，在坐标四周找一块空位重新放：
//    先保持原来的大小，尽量离坐标不超过 14 个单位，放不下再缩小，缩到最小还放不下的就不画这一块。
//    没有这两种问题的店和楼不动。飞机飞到的坐标落在画出来的屋顶上或者屋顶边上，搬过的屋顶在没有空位时才离得更远。
//    候选屋顶不动，地图数据里的候选屋顶彼此压着，或者压在水面上，这里没有办法。
// 4. 河。街区和河的距离不够的，缩成干的那一块，缩不出像样的一块就整块改成河岸绿地，河画在它上面。
//    有保留屋顶的街区缩不出干的一块，中心又在水里的，缩成中心不在水里、盖住尽量多保留屋顶的一块。
//    横街或竖街垂直穿过河的地方架桥，最多三座，相隔不少于 230。
// 5. 屋顶。每个街区按它所在片区的画法摆满屋顶（老街小而密，写字楼大而少，大学城是长条宿舍楼），绕开保留的屋顶。
//    新摆的屋顶不压已有的屋顶，也不压到水面，压到的那一块不摆。
//    屋顶上的物件、瓦线、小天井、亮窗在屋顶里随机取位置，种子来自街区的编号，不同街区互不影响。
// 6. 树。绿地和河岸里随机撒，老街的院子里 70% 一棵，大学城的街区里更多。树不种在水里。
// 7. 店的门面。四边各试一次，取门面区域压住别的屋顶最少的一边，同分取离街区边最近的。店名放在门面旁边不压东西的位置。
// 8. 片区名。放在大街上，字距拉开，随地图转。
import type { Block, BlockKind, Building, BuildingRole, Bridge, City, Label, Prop, Ridge, ShopFront, StationRoof, Street, Style, Tree } from './city-types.ts';
import type { Rect, Vec } from './geometry.ts';
import { clamp, contains, fromCenter, inflate, overlapArea, overlaps, rectCenter } from './geometry.ts';
import { isWet, makeRiver, probeRiver, rectRiverDistance } from './river.ts';
import type { RiverProbe } from './river.ts';
import { createRand, int, mixSeed, pick, range, weighted } from './rng.ts';
import type { Rand } from './rng.ts';
import { subdivide } from './streets.ts';

export const RIVER_HALF_WIDTH = 58;
/** 街区离河的距离：河岸留出这么宽的纸白。 */
const BANK = 20;

export type RoofSizeName = 'small' | 'medium' | 'large';
export type HomeKind = 'residence' | 'office' | 'dorm';

export interface CitySpec {
  readonly seed: number;
  /** 要生成的世界范围，要盖住整个画板。 */
  readonly region: Rect;
  /** 片区的范围，下标是片区序号：0 老街，1 写字楼区，2 大学城。 */
  readonly districts: readonly Rect[];
  readonly river: readonly Vec[];
  readonly shops: readonly { readonly x: number; readonly y: number; readonly district: number }[];
  readonly homes: readonly { readonly x: number; readonly y: number; readonly district: number; readonly kind: HomeKind }[];
  readonly roofs: readonly { readonly x: number; readonly y: number; readonly district: number; readonly size: RoofSizeName }[];
  /** 写字楼里有一栋楼顶画停机坪标记：取离这一点最近的大写字楼。不给就不画。 */
  readonly helipadNear?: Vec;
}

/** 候选屋顶的大小：小、中、大，对应停机位上限 6、9、12。 */
export const STATION_SIZES: Readonly<Record<RoofSizeName, readonly [number, number]>> = {
  small: [100, 80],
  medium: [124, 96],
  large: [140, 112],
};
const SHOP_SIZE: readonly [number, number] = [54, 44];
const HOME_SIZES: Readonly<Record<HomeKind, readonly [number, number]>> = {
  residence: [46, 40],
  office: [96, 76],
  dorm: [112, 28],
};
const DISTRICT_STYLES: readonly Style[] = ['old', 'office', 'campus'];
/** 店门面的深度：雨棚 7，票杆在 13，小票挂到 36 左右。 */
export const FRONT_DEPTH = 40;
/** 票杆的长度。 */
export const RAIL_LENGTH = 64;
/** 雨棚的最大宽度。 */
export const AWNING_MAX = 68;
const LABEL_FONT = 30;
const LABEL_SPACING = 12;

// ---- 保留的屋顶 ----
interface Reserved {
  readonly role: BuildingRole;
  readonly style: Style;
  readonly px: number;
  readonly py: number;
  readonly fixed: boolean;
  /** 屋顶原本的大小，整理时从这个大小开始往小试。 */
  readonly nw: number;
  readonly nh: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
}

function rectOf(r: Reserved): Rect {
  return fromCenter(r.vx, r.vy, r.w, r.h);
}

/** 保持坐标在屋顶里：屋顶中心离坐标不超过半宽减 7。 */
function clampToPoint(r: Reserved): void {
  r.vx = clamp(r.vx, r.px - (r.w / 2 - 7), r.px + (r.w / 2 - 7));
  r.vy = clamp(r.vy, r.py - (r.h / 2 - 7), r.py + (r.h / 2 - 7));
}

function placeReserved(spec: CitySpec): Reserved[] {
  const items: Reserved[] = [];
  const styleOf = (d: number): Style => DISTRICT_STYLES[d] ?? 'old';
  // 画面区域之外的点不画：它们离区域边缘太远，硬挪进最近的街区会压住别的屋顶
  const near = (x: number, y: number): boolean => contains(spec.region, x, y, 30);
  spec.roofs.forEach((p, i) => {
    if (!near(p.x, p.y)) return;
    const [w, h] = STATION_SIZES[p.size];
    items.push({ role: { type: 'roof', index: i }, style: styleOf(p.district), px: p.x, py: p.y, fixed: true, nw: w, nh: h, w, h, vx: p.x, vy: p.y });
  });
  spec.shops.forEach((p, i) => {
    if (!near(p.x, p.y)) return;
    const [w, h] = SHOP_SIZE;
    items.push({ role: { type: 'shop', index: i }, style: styleOf(p.district), px: p.x, py: p.y, fixed: false, nw: w, nh: h, w, h, vx: p.x, vy: p.y });
  });
  spec.homes.forEach((p, i) => {
    if (!near(p.x, p.y)) return;
    const [w, h] = HOME_SIZES[p.kind];
    items.push({ role: { type: 'home', index: i }, style: styleOf(p.district), px: p.x, py: p.y, fixed: false, nw: w, nh: h, w, h, vx: p.x, vy: p.y });
  });
  const GAP = 6;
  // 先推开：沿穿透较浅的方向，两块都能动时各让一半
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i] as Reserved;
        const b = items[j] as Reserved;
        if (!overlaps(rectOf(a), rectOf(b), GAP)) continue;
        const penX = (a.w + b.w) / 2 + GAP - Math.abs(a.vx - b.vx);
        const penY = (a.h + b.h) / 2 + GAP - Math.abs(a.vy - b.vy);
        const alongX = penX <= penY;
        const dir = (alongX ? b.vx - a.vx : b.vy - a.vy) >= 0 ? 1 : -1;
        const pen = alongX ? penX : penY;
        const shareA = a.fixed ? 0 : b.fixed ? 1 : 0.5;
        const shareB = 1 - shareA;
        if (alongX) {
          a.vx -= dir * pen * shareA;
          b.vx += dir * pen * shareB;
        } else {
          a.vy -= dir * pen * shareA;
          b.vy += dir * pen * shareB;
        }
        clampToPoint(a);
        clampToPoint(b);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 推不开的再缩小，每次缩 4，最小 28 乘 24。候选屋顶不缩
  for (let iter = 0; iter < 8; iter++) {
    let shrunk = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i] as Reserved;
        const b = items[j] as Reserved;
        if (!overlaps(rectOf(a), rectOf(b), GAP - 2)) continue;
        for (const r of [a, b]) {
          if (r.fixed) continue;
          r.w = Math.max(28, r.w - 4);
          r.h = Math.max(24, r.h - 3);
          clampToPoint(r);
          shrunk = true;
        }
      }
    }
    if (!shrunk) break;
  }
  return items;
}

/** 离点 (x, y) 最近的叶子：点在叶子里就是它，否则取点到叶子的距离最小的。 */
function leafFor(leaves: readonly Rect[], x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  leaves.forEach((l, i) => {
    const dx = Math.max(l.x - x, 0, x - (l.x + l.w));
    const dy = Math.max(l.y - y, 0, y - (l.y + l.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** 把一块屋顶移进叶子里：太大就缩小，再整块挪进叶子的边界（留 2 个单位）。 */
function clampInto(r: Reserved, leaf: Rect): void {
  r.w = Math.min(r.w, leaf.w - 4);
  r.h = Math.min(r.h, leaf.h - 4);
  r.vx = clamp(r.vx, leaf.x + 2 + r.w / 2, leaf.x + leaf.w - 2 - r.w / 2);
  r.vy = clamp(r.vy, leaf.y + 2 + r.h / 2, leaf.y + leaf.h - 2 - r.h / 2);
}

/** 街切完之后，店和楼挪进各自的街区，再把互相压住的推开，推完再挪回街区里面。 */
function settleInLeaves(items: Reserved[], leaves: readonly Rect[]): Map<Reserved, number> {
  const leafOf = new Map<Reserved, number>();
  for (const r of items) {
    const at = leafFor(leaves, r.vx, r.vy);
    leafOf.set(r, at);
    if (!r.fixed) clampInto(r, leaves[at] as Rect);
  }
  const GAP = 6;
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i] as Reserved;
        const b = items[j] as Reserved;
        if (!overlaps(rectOf(a), rectOf(b), GAP)) continue;
        const penX = (a.w + b.w) / 2 + GAP - Math.abs(a.vx - b.vx);
        const penY = (a.h + b.h) / 2 + GAP - Math.abs(a.vy - b.vy);
        const alongX = penX <= penY;
        const dir = (alongX ? b.vx - a.vx : b.vy - a.vy) >= 0 ? 1 : -1;
        const pen = alongX ? penX : penY;
        const shareA = a.fixed ? 0 : b.fixed ? 1 : 0.5;
        if (alongX) {
          a.vx -= dir * pen * shareA;
          b.vx += dir * pen * (1 - shareA);
        } else {
          a.vy -= dir * pen * shareA;
          b.vy += dir * pen * (1 - shareA);
        }
        if (!a.fixed) clampInto(a, leaves[leafOf.get(a) as number] as Rect);
        if (!b.fixed) clampInto(b, leaves[leafOf.get(b) as number] as Rect);
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (let iter = 0; iter < 30; iter++) {
    let shrunk = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i] as Reserved;
        const b = items[j] as Reserved;
        if (!overlaps(rectOf(a), rectOf(b), GAP - 2)) continue;
        for (const r of [a, b]) {
          if (r.fixed) continue;
          r.w = Math.max(28, r.w - 4);
          r.h = Math.max(24, r.h - 3);
          clampInto(r, leaves[leafOf.get(r) as number] as Rect);
          shrunk = true;
        }
      }
    }
    if (!shrunk) break;
  }
  return leafOf;
}

// ---- 整理：还压着别的屋顶或碰到水面的店和楼 ----
/** 搬走的店和楼，坐标落在屋顶外不超过这么多个单位算够近。 */
const NEAR_POINT = 14;
/** 搬走的屋顶离水面至少这么远：不碰水面，再留一点岸。 */
const WATER_MARGIN = 4;
/** 在坐标四周这么远的范围里找空位。 */
const SPOT_REACH = 100;
/** 屋顶离别的屋顶的间隙，先要大的，实在放不下再放宽。 */
const SPOT_GAPS: readonly number[] = [6, 3, 1];
/** 屋顶缩小的比例，缩小之后的大小不小于 28 乘 24。 */
const SPOT_SCALES: readonly number[] = [1, 0.85, 0.7, 0.55];
/** 前面都放不下时最后试的屋顶大小，一档比一档小。 */
const LAST_RESORT_ROOFS: readonly (readonly [number, number])[] = [
  [20, 16],
  [16, 14],
];
/** 找空位时屋顶中心的取点间隔，另外还会取贴着别的屋顶和街区边的位置。 */
const SPOT_STEP = 6;

interface Spot {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 坐标到这块屋顶的距离，坐标落在屋顶上是 0。 */
  readonly near: number;
}

/** 从原本的大小往小排，一档一档试。 */
function sizeLadder(r: Reserved): [number, number][] {
  const out: [number, number][] = [];
  const add = (w: number, h: number): void => {
    if (!out.some(([a, b]) => a === w && b === h)) out.push([w, h]);
  };
  for (const s of SPOT_SCALES) add(Math.max(28, Math.round(r.nw * s)), Math.max(24, Math.round(r.nh * s)));
  for (const [w, h] of LAST_RESORT_ROOFS) add(w, h);
  return out;
}

/** 在街区 leaves 里给大小 w 乘 h 的屋顶找空位：整块屋顶在街区里，离别的屋顶不近于 gap，不碰水面。取离坐标最近的，同样近的取离现在位置近的。 */
function findSpot(item: Reserved, w: number, h: number, gap: number, others: readonly Rect[], leaves: readonly Rect[], probe: RiverProbe, river: City['river']): Spot | null {
  let best: Spot | null = null;
  let bestScore = Infinity;
  // 取点的位置：等间隔的，再加上正好贴着别的屋顶的位置。多出 0.01 免得浮点误差把贴着的位置误判成压着
  const line = (lo: number, hi: number, anchors: readonly number[]): number[] => {
    const out: number[] = [];
    for (let v = lo; v < hi; v += SPOT_STEP) out.push(v);
    out.push(hi);
    for (const a of anchors) if (a >= lo && a <= hi) out.push(a);
    return out;
  };
  for (const leaf of leaves) {
    // 屋顶中心能取的范围：整块屋顶在街区里（离边 2 个单位），中心离坐标不超过 SPOT_REACH
    const x0 = Math.max(leaf.x + 2 + w / 2, item.px - SPOT_REACH);
    const x1 = Math.min(leaf.x + leaf.w - 2 - w / 2, item.px + SPOT_REACH);
    const y0 = Math.max(leaf.y + 2 + h / 2, item.py - SPOT_REACH);
    const y1 = Math.min(leaf.y + leaf.h - 2 - h / 2, item.py + SPOT_REACH);
    if (x0 > x1 || y0 > y1) continue;
    const zone = { x: x0 - w / 2 - gap, y: y0 - h / 2 - gap, w: x1 - x0 + w + 2 * gap, h: y1 - y0 + h + 2 * gap };
    const nearby = others.filter((o) => overlaps(o, zone));
    const xs = line(x0, x1, [item.px, item.vx, ...nearby.flatMap((o) => [o.x - gap - w / 2 - 0.01, o.x + o.w + gap + w / 2 + 0.01])]);
    const ys = line(y0, y1, [item.py, item.vy, ...nearby.flatMap((o) => [o.y - gap - h / 2 - 0.01, o.y + o.h + gap + h / 2 + 0.01])]);
    for (const cx of xs) {
      for (const cy of ys) {
        const rect = fromCenter(cx, cy, w, h);
        if (nearby.some((o) => overlaps(rect, o, gap))) continue;
        const dx = Math.max(rect.x - item.px, 0, item.px - (rect.x + rect.w));
        const dy = Math.max(rect.y - item.py, 0, item.py - (rect.y + rect.h));
        const near = Math.sqrt(dx * dx + dy * dy);
        // 离坐标的距离为主，距离差不多的取离现在位置近的
        const score = near + 0.002 * Math.sqrt((cx - item.vx) ** 2 + (cy - item.vy) ** 2);
        if (score >= bestScore - 1e-9) continue;
        if (probe.rectDistance(rect) < river.halfWidth + WATER_MARGIN) continue;
        best = { x: cx, y: cy, w, h, near };
        bestScore = score;
      }
    }
  }
  return best;
}

/** 把店或楼搬到空位上。放得下就取离坐标够近的，大小优先、间隙其次，都不够近就取离坐标最近的。一块空位也没有返回 false。 */
function relocate(item: Reserved, items: readonly Reserved[], leaves: readonly Rect[], river: City['river']): boolean {
  const area = { x: item.px - SPOT_REACH, y: item.py - SPOT_REACH, w: 2 * SPOT_REACH, h: 2 * SPOT_REACH };
  // 屋顶最大 112 宽，中心在 area 里的屋顶最远伸出 56，再加上最大的间隙 6，所以多留到 70
  const wide = inflate(area, 70);
  const others = items.filter((o) => o !== item).map(rectOf).filter((o) => overlaps(o, wide));
  const nearLeaves = leaves.filter((l) => overlaps(l, wide));
  const probe = probeRiver(river, wide, WATER_MARGIN + 4);
  let fallback: Spot | null = null;
  for (const gap of SPOT_GAPS) {
    for (const [w, h] of sizeLadder(item)) {
      const spot = findSpot(item, w, h, gap, others, nearLeaves, probe, river);
      if (spot === null) continue;
      if (spot.near <= NEAR_POINT) {
        place(item, spot);
        return true;
      }
      if (fallback === null || spot.near < fallback.near) fallback = spot;
    }
  }
  if (fallback === null) return false;
  place(item, fallback);
  return true;
}

function place(item: Reserved, spot: Spot): void {
  item.w = spot.w;
  item.h = spot.h;
  item.vx = spot.x;
  item.vy = spot.y;
}

/** 中心落在某个街区里的保留屋顶才会画出来。画面区域边缘外面一点的候选屋顶，中心不在任何街区里，不画，也就谈不上压住谁。 */
function drawn(items: readonly Reserved[], leaves: readonly Rect[]): Reserved[] {
  return items.filter((r) => leaves.some((l) => contains(l, r.vx, r.vy)));
}

/** 店和楼挪进街区、互相推开之后，还压着别的保留屋顶或碰到水面的，重新找位置。找不到位置的从 items 里去掉。候选屋顶不动。 */
function tidyReserved(items: Reserved[], leaves: readonly Rect[], river: City['river']): void {
  const shown = drawn(items, leaves);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as Reserved;
    if (item.fixed || !shown.includes(item)) continue;
    const rect = rectOf(item);
    const pressed = shown.some((o) => o !== item && overlaps(rect, rectOf(o)));
    if (!pressed && rectRiverDistance(river, rect) >= river.halfWidth) continue;
    if (relocate(item, shown, leaves, river)) continue;
    items.splice(i, 1);
    shown.splice(shown.indexOf(item), 1);
  }
}

// ---- 河和街区 ----
interface WetMask {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly wet: Uint8Array;
}

function wetMask(rect: Rect, river: City['river']): WetMask {
  const cell = 8;
  const cols = Math.max(1, Math.ceil(rect.w / cell));
  const rows = Math.max(1, Math.ceil(rect.h / cell));
  const wet = new Uint8Array(cols * rows);
  // 格子中心最多超出矩形半个格子，多留一整个格子的余量
  const probe = probeRiver(river, inflate(rect, cell), BANK);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (probe.wet(rect.x + (c + 0.5) * cell, rect.y + (r + 0.5) * cell, BANK)) wet[r * cols + c] = 1;
    }
  }
  return { cols, rows, cell, wet };
}

/** 街区里不碰河的四条贴边长条（左、右、上、下），和碰河的格子占的比例。街区全干时没有长条，比例是 0。 */
function dryStrips(rect: Rect, river: City['river']): { strips: Rect[]; wetShare: number } {
  const m = wetMask(rect, river);
  let wetCount = 0;
  for (const v of m.wet) wetCount += v;
  if (wetCount === 0) return { strips: [], wetShare: 0 };
  const share = wetCount / m.wet.length;
  const colWet = (c: number): boolean => {
    for (let r = 0; r < m.rows; r++) if (m.wet[r * m.cols + c]) return true;
    return false;
  };
  const rowWet = (r: number): boolean => {
    for (let c = 0; c < m.cols; c++) if (m.wet[r * m.cols + c]) return true;
    return false;
  };
  let left = 0;
  while (left < m.cols && !colWet(left)) left++;
  let right = 0;
  while (right < m.cols && !colWet(m.cols - 1 - right)) right++;
  let top = 0;
  while (top < m.rows && !rowWet(top)) top++;
  let bottom = 0;
  while (bottom < m.rows && !rowWet(m.rows - 1 - bottom)) bottom++;
  const strips: Rect[] = [
    { x: rect.x, y: rect.y, w: Math.min(rect.w, left * m.cell), h: rect.h },
    { x: rect.x + rect.w - Math.min(rect.w, right * m.cell), y: rect.y, w: Math.min(rect.w, right * m.cell), h: rect.h },
    { x: rect.x, y: rect.y, w: rect.w, h: Math.min(rect.h, top * m.cell) },
    { x: rect.x, y: rect.y + rect.h - Math.min(rect.h, bottom * m.cell), w: rect.w, h: Math.min(rect.h, bottom * m.cell) },
  ];
  return { strips, wetShare: share };
}

/** 把一个街区缩成不碰河的那一块：四条贴边的长条里面积最大的。全干返回原样，全湿返回 null。 */
function dryPart(rect: Rect, river: City['river']): { rect: Rect | null; wetShare: number } {
  const { strips, wetShare } = dryStrips(rect, river);
  if (wetShare === 0) return { rect, wetShare: 0 };
  let best: Rect | null = null;
  let bestArea = 0;
  for (const s of strips) {
    const area = s.w * s.h;
    if (s.w >= 56 && s.h >= 52 && area > bestArea) {
      best = s;
      bestArea = area;
    }
  }
  if (best === null || bestArea < rect.w * rect.h * 0.3) return { rect: null, wetShare };
  return { rect: best, wetShare };
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/**
 * 街区里有保留的屋顶，缩不出像样的干的一块，中心又在水里时，用这个取街区的范围。
 * 在干的长条、保留屋顶的外包框、单个保留屋顶四周里，取中心不在水里、盖住保留屋顶最多的，同样多的取面积大的。
 */
function driestPart(leaf: Rect, items: readonly Rect[], river: City['river']): Rect {
  const wetCentre = (r: Rect): boolean => isWet(river, r.x + r.w / 2, r.y + r.h / 2, -10);
  const x0 = Math.min(...items.map((r) => r.x));
  const y0 = Math.min(...items.map((r) => r.y));
  const x1 = Math.max(...items.map((r) => r.x + r.w));
  const y1 = Math.max(...items.map((r) => r.y + r.h));
  const candidates: Rect[] = [
    ...dryStrips(leaf, river).strips.filter((s) => s.w >= 20 && s.h >= 20),
    intersect(inflate({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 6), leaf),
    ...items.map((r) => intersect(inflate(r, 6), leaf)),
  ];
  let best: Rect | null = null;
  let bestCovered = -1;
  for (const c of candidates) {
    if (wetCentre(c)) continue;
    const covered = items.filter((r) => r.x >= c.x && r.y >= c.y && r.x + r.w <= c.x + c.w && r.y + r.h <= c.y + c.h).length;
    if (covered > bestCovered || (covered === bestCovered && best !== null && c.w * c.h > best.w * best.h)) {
      best = c;
      bestCovered = covered;
    }
  }
  return best ?? intersect(inflate(items[0] as Rect, 6), leaf);
}

// ---- 屋顶 ----
interface BuildState {
  nextId: number;
  readonly buildings: Building[];
}

interface DecorateOptions {
  /** 离最近的候选屋顶太近的地方不画彩钢棚。 */
  readonly nearStation: boolean;
}

function roofWindows(rect: Rect, style: Style, rand: Rand): Building['windows'] {
  const out: { x: number; y: number; t: number }[] = [];
  const rows = style === 'office' ? 2 : 1;
  const n = style === 'office' ? clamp(Math.round(rect.w / 15), 2, 7) : style === 'campus' ? clamp(Math.round(rect.w / 13), 3, 9) : clamp(Math.round(rect.w / 15), 1, 4);
  const span = rect.w - 14;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < n; i++) {
      const x = rect.x + 7 + (n === 1 ? span / 2 : (span * i) / (n - 1));
      const y = style === 'campus' ? rect.y + rect.h / 2 : rect.y + rect.h - 4.5 - r * 5.5;
      out.push({ x, y, t: rand() });
    }
  }
  return out;
}

function addBuilding(state: BuildState, rect: Rect, style: Style, role: BuildingRole, rand: Rand, opts: DecorateOptions): Building {
  const props: Prop[] = [];
  const free: Rect[] = [];
  /** 在屋顶里给一个物件找位置：宽高 w 乘 h，距屋顶边 edge，不压已经摆了的物件。 */
  const slot = (w: number, h: number, edge = 5): Vec | null => {
    if (rect.w - 2 * edge < w || rect.h - 2 * edge < h) return null;
    for (let k = 0; k < 20; k++) {
      const x = rect.x + edge + rand() * (rect.w - 2 * edge - w);
      const y = rect.y + edge + rand() * (rect.h - 2 * edge - h);
      const box = { x: x - 2, y: y - 2, w: w + 4, h: h + 4 };
      if (free.every((f) => !overlaps(f, box))) {
        free.push({ x, y, w, h });
        return { x: x + w / 2, y: y + h / 2 };
      }
    }
    return null;
  };
  let steel = false;
  let ridge: Ridge | null = null;
  let tinted = false;
  let patio: Rect | null = null;
  let shadow = 4;
  const plain = role.type === 'plain' || role.type === 'shop' || role.type === 'home';
  if (style === 'old') {
    shadow = range(rand, 3, 6);
    const r = rand();
    if (role.type === 'roof') {
      // 候选屋顶：普通的平屋顶，一两样小东西，建站之后站点的画盖在上面
      for (let i = 0; i < 2; i++) {
        const kind = pick(rand, ['stair', 'tank', 'ac'] as const);
        const p = slot(kind === 'tank' ? 12 : 10, 9, 8);
        if (p !== null) props.push(kind === 'tank' ? { kind, x: p.x, y: p.y, a: 5, b: 0 } : { kind, x: p.x, y: p.y, a: 0, b: 0 });
      }
    } else if (r < 0.05 && role.type === 'plain' && !opts.nearStation && rect.w >= 30 && rect.h >= 24) {
      steel = true;
    } else if (r < 0.58) {
      ridge = { horizontal: rect.w >= rect.h, side: rand() < 0.5 };
    } else if (plain && rand() < 0.3) {
      const p = slot(10, 8, 3);
      if (p !== null) props.push({ kind: 'stair', x: p.x, y: p.y, a: 0, b: 0 });
    }
    if (role.type !== 'roof' && rect.w > 34 && rect.h > 28 && rand() < 0.13) {
      const pw = range(rand, 10, 14);
      const ph = range(rand, 8, 11);
      patio = { x: rect.x + 5 + rand() * (rect.w - pw - 10), y: rect.y + 5 + rand() * (rect.h - ph - 10), w: pw, h: ph };
      free.push(patio);
    }
  } else if (style === 'office') {
    shadow = range(rand, 10, 18);
    tinted = true;
    if (role.type !== 'roof') {
      if (rect.w > 70 && rect.h > 54 && rand() < 0.45) {
        const [pw, ph] = pick(rand, [[34, 18], [40, 22], [30, 16]] as const);
        const cols = Math.max(2, Math.round(pw / 6.4));
        const rows = Math.max(1, Math.round(ph / 8.6));
        const p = slot(cols * 6.4, rows * 8.6, 9);
        if (p !== null) props.push({ kind: 'pv', x: p.x, y: p.y, a: cols, b: rows });
      }
      const towers = int(rand, 2, 3);
      for (let i = 0; i < towers; i++) {
        const rr = range(rand, 6, 8);
        const p = slot(2 * rr, 2 * rr, 9);
        if (p !== null) props.push({ kind: 'cooling', x: p.x, y: p.y, a: rr, b: 0 });
      }
      const p = slot(18, 12, 9);
      if (p !== null) {
        const k = Math.abs(Math.round(rect.x) + Math.round(rect.y)) % 3;
        if (k === 0) props.push({ kind: 'skylight', x: p.x, y: p.y, a: 16, b: 10 });
        else if (k === 1) props.push({ kind: 'stair', x: p.x, y: p.y, a: 0, b: 0 });
        else props.push({ kind: 'ac', x: p.x, y: p.y, a: 0, b: 0 });
      }
      if (rect.w > 100 && rect.h > 70 && Math.abs(Math.round(rect.x) * 3 + Math.round(rect.y)) % 4 === 0) {
        const x = rect.x + rect.w - 18;
        const y = rect.y + 18;
        if (free.every((f) => !overlaps(f, { x: x - 9, y: y - 9, w: 18, h: 18 }))) props.push({ kind: 'antenna', x, y, a: 0, b: 0 });
      }
    }
  } else {
    shadow = range(rand, 5, 9);
    if (role.type !== 'roof' && rect.w > 60) {
      for (const ex of [rect.x + 13, rect.x + rect.w - 13]) props.push({ kind: 'stair', x: ex, y: rect.y + rect.h / 2, a: 0, b: 0 });
    }
  }
  const b: Building = {
    id: state.nextId++,
    rect,
    style,
    role,
    shadow,
    steel,
    ridge,
    tinted,
    patio,
    props: steel ? [{ kind: 'shed', x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, a: rect.w, b: rect.h }] : props,
    windows: role.type === 'roof' ? [] : roofWindows(rect, style, rand),
  };
  state.buildings.push(b);
  return b;
}

/** 老街每个街区里零散的小东西：晾衣绳、水箱、热水器排、种植箱，每个街区两三样，放在屋顶或小院里。 */
function scatterSmallObjects(roofs: Rect[], yards: Rect[], rand: Rand, props: Map<number, Prop[]>, ownerOf: (r: Rect) => number | null): void {
  const cands: { inner: Rect; owner: number | null }[] = [];
  for (const r of roofs) if (r.w >= 34 && r.h >= 26) cands.push({ inner: { x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 }, owner: ownerOf(r) });
  for (const y of yards) if (y.w >= 18 && y.h >= 14) cands.push({ inner: y, owner: null });
  if (cands.length === 0) return;
  const taken: Rect[] = [];
  const kinds = ['clothesline', 'tank', 'heaters', 'planters'] as const;
  const weights = [8, 8, 5, 8];
  const n = int(rand, 2, 3);
  for (let i = 0; i < n; i++) {
    const kind = weighted(rand, kinds, weights);
    const heaters = int(rand, 3, 4);
    const [ow, oh] = kind === 'heaters' ? [(heaters - 1) * 7.2 + 6.2, 10.6] : kind === 'planters' ? [15.8, 10.2] : kind === 'clothesline' ? [26.2, 7.1] : [12.6, 10];
    for (let attempt = 0; attempt < 16; attempt++) {
      const c = pick(rand, cands);
      if (c.inner.w < ow || c.inner.h < oh) continue;
      const px = c.inner.x + rand() * (c.inner.w - ow);
      const py = c.inner.y + rand() * (c.inner.h - oh);
      const box = { x: px - 2, y: py - 2, w: ow + 4, h: oh + 4 };
      if (taken.some((t) => overlaps(t, box))) continue;
      taken.push({ x: px, y: py, w: ow, h: oh });
      const prop: Prop =
        kind === 'clothesline'
          ? { kind, x: px + 13.1, y: py + 1.1, a: 24, b: 0 }
          : kind === 'tank'
            ? { kind, x: px + 5, y: py + 5, a: 5, b: 0 }
            : kind === 'heaters'
              ? { kind, x: px + ow / 2, y: py + 6, a: heaters, b: 0 }
              : { kind, x: px + 7.9, y: py + 5.1, a: 0, b: 0 };
      if (c.owner !== null) {
        const list = props.get(c.owner) ?? [];
        list.push(prop);
        props.set(c.owner, list);
      }
      break;
    }
  }
}

// ---- 主函数 ----
export function generateCity(spec: CitySpec): City {
  const river = makeRiver(spec.river, RIVER_HALF_WIDTH);
  const reserved = placeReserved(spec);
  const streetsRand = createRand(mixSeed(spec.seed, 1));
  // 候选屋顶旁边 90 个单位以内的店和楼，街也不能切到：它们和候选屋顶已经推开了，同在一个街区里放得下，
  // 要是街从中间切过去，两边的街区都放不下，只能叠在一起
  const fixedRects = reserved.filter((r) => r.fixed).map(rectOf);
  const nearRoof = (r: Reserved): boolean => fixedRects.some((f) => overlaps(f, rectOf(r), 90));
  const { streets, leaves } = subdivide(
    spec.region,
    [...fixedRects, ...reserved.filter((r) => !r.fixed && nearRoof(r)).map(rectOf)],
    reserved.filter((r) => !r.fixed && !nearRoof(r)).map(rectOf),
    streetsRand,
  );
  settleInLeaves(reserved, leaves);
  tidyReserved(reserved, leaves, river);
  const reservedRects = drawn(reserved, leaves).map(rectOf);

  const styleAt = (x: number, y: number): Style => {
    let best = 0;
    let bestD = Infinity;
    spec.districts.forEach((d, i) => {
      const dx = Math.max(d.x - x, 0, x - (d.x + d.w));
      const dy = Math.max(d.y - y, 0, y - (d.y + d.h));
      const dd = dx * dx + dy * dy;
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    return DISTRICT_STYLES[best] ?? 'old';
  };

  const state: BuildState = { nextId: 0, buildings: [] };
  const blocks: Block[] = [];
  const trees: Tree[] = [];
  const allYards: Rect[] = [];
  const stationCenters = reserved.filter((r) => r.role.type === 'roof').map((r) => ({ x: r.vx, y: r.vy }));

  const treeAt = (x: number, y: number, r: number): void => {
    trees.push({ x, y, r, seed: trees.length + 1 });
  };
  const scatterTrees = (rect: Rect, count: number, avoid: Rect[], rand: Rand, rmin = 3.4, rmax = 5.4, keep = 1): void => {
    let done = 0;
    // 街区窄过 12 时取点会略微超出矩形，余量留 8
    const probe = probeRiver(river, inflate(rect, 8), 12);
    for (let k = 0; k < count * 12 && done < count; k++) {
      const tx = range(rand, rect.x + 6, rect.x + rect.w - 6);
      const ty = range(rand, rect.y + 6, rect.y + rect.h - 6);
      const r = range(rand, rmin, rmax);
      if (probe.wet(tx, ty, 12)) continue;
      if (avoid.some((a) => tx > a.x - r - 2 && tx < a.x + a.w + r + 2 && ty > a.y - r - 2 && ty < a.y + a.h + r + 2)) continue;
      if (keep >= 1 || (done * 7 + 3) % 10 < keep * 10) treeAt(tx, ty, r * 1.1);
      done++;
    }
  };

  let trackDone = false;
  let courtDone = false;
  leaves.forEach((leaf, index) => {
    const rand = createRand(mixSeed(spec.seed, 2, index));
    const inside = reserved.filter((r) => contains(leaf, r.vx, r.vy));
    const insideRects = inside.map(rectOf);
    const center = rectCenter(leaf);
    const style = styleAt(center.x, center.y);
    const { rect: dry, wetShare } = dryPart(leaf, river);
    if (dry === null && inside.length === 0) {
      // 河岸绿地：整块填绿，河画在它上面。完全在河里的不画
      if (wetShare < 0.92) {
        blocks.push({ rect: leaf, kind: 'bank', style, track: null, court: null });
        scatterTrees(leaf, Math.floor((leaf.w * leaf.h) / 2400), [], rand);
      }
      return;
    }
    // 有保留的屋顶的街区一般不缩，保留的屋顶本来就在干的地方。街区的中心都在水里的，缩成不在水里的一块
    const r = dry ?? (isWet(river, center.x, center.y, -10) ? driestPart(leaf, insideRects, river) : leaf);
    const rc = rectCenter(r);
    // 没有保留屋顶的小块和偶尔的一块做成公园
    if (inside.length === 0 && (r.w < 84 || r.h < 74 || rand() < 0.06)) {
      blocks.push({ rect: r, kind: 'park', style, track: null, court: null });
      scatterTrees(r, Math.floor((r.w * r.h) / 1500), [], rand);
      return;
    }
    // 大学城里挑一块大的做操场，一块做篮球场，都不能有保留的屋顶
    let kind: BlockKind = 'normal';
    let court: Rect | null = null;
    let track: Rect | null = null;
    if (style === 'campus' && inside.length === 0) {
      if (!trackDone && r.w > 140 && r.h > 110 && rc.y > 1300) {
        kind = 'track';
        track = { x: r.x + 8, y: r.y + 8, w: r.w - 16, h: r.h - 16 };
        trackDone = true;
      } else if (!courtDone && r.w > 100 && r.h > 70 && rc.y > 1400) {
        court = { x: rc.x - 30, y: r.y + r.h - 44, w: 60, h: 32 };
        courtDone = true;
      }
    }
    blocks.push({ rect: r, kind, style, track, court });
    if (kind === 'track') {
      scatterTrees(r, 9, [track as Rect], rand);
      return;
    }

    // 屋顶：先放保留的，再用网格填满
    const roofs: Rect[] = [];
    const yards: Rect[] = [];
    const nearStation = (rect: Rect): boolean => {
      const c = rectCenter(rect);
      return stationCenters.some((s) => (s.x - c.x) ** 2 + (s.y - c.y) ** 2 < 150 * 150);
    };
    const made: { building: Building; rect: Rect }[] = [];
    for (const res of inside) {
      const rect = rectOf(res);
      made.push({ building: addBuilding(state, rect, res.style, res.role, rand, { nearStation: false }), rect });
      roofs.push(rect);
    }
    const blockedBy = (rect: Rect): boolean => insideRects.some((f) => overlaps(f, rect, 4)) || (court !== null && overlaps(court, rect, 3));
    // 街区里没有碰到水的格子，屋顶和树就不必问河。新的屋顶不能压住已有的屋顶（别的街区里的保留屋顶也算），也不能压到水面
    const water = wetShare > 0 ? probeRiver(river, inflate(leaf, 4), 8) : null;
    const unfit = (rect: Rect): boolean => roofs.some((q) => overlaps(q, rect)) || reservedRects.some((q) => overlaps(q, rect)) || (water !== null && water.rectDistance(rect) < river.halfWidth);
    if (style === 'old') {
      const nx = Math.max(1, Math.round(r.w / 62));
      const ny = Math.max(1, Math.round(r.h / 54));
      const cw = r.w / nx;
      const ch = r.h / ny;
      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < ny; b++) {
          const cell: Rect = { x: r.x + a * cw + 4, y: r.y + b * ch + 4, w: cw - 8, h: ch - 8 };
          if (rand() < 0.11) {
            if (!blockedBy(cell)) yards.push(cell);
            continue;
          }
          const pad = range(rand, 3.5, 6.5);
          const w = cw - 2 * pad - range(rand, 0, cw * 0.12);
          const h = ch - 2 * pad - range(rand, 0, ch * 0.12);
          if (w < 22 || h < 20) continue;
          const rect: Rect = { x: r.x + a * cw + pad, y: r.y + b * ch + pad, w, h };
          if (blockedBy(rect) || unfit(rect)) continue;
          made.push({ building: addBuilding(state, rect, 'old', { type: 'plain' }, rand, { nearStation: nearStation(rect) }), rect });
          roofs.push(rect);
        }
      }
    } else if (style === 'office') {
      const nx = Math.max(1, Math.round(r.w / 118));
      const ny = Math.max(1, Math.round(r.h / 104));
      const cw = r.w / nx;
      const ch = r.h / ny;
      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < ny; b++) {
          const pad = range(rand, 5, 8);
          const rect: Rect = { x: r.x + a * cw + pad, y: r.y + b * ch + pad, w: cw - 2 * pad, h: ch - 2 * pad };
          if (rect.w < 40 || rect.h < 36 || blockedBy(rect) || unfit(rect)) continue;
          made.push({ building: addBuilding(state, rect, 'office', { type: 'plain' }, rand, { nearStation: false }), rect });
          roofs.push(rect);
        }
      }
    } else {
      const rows = Math.max(1, Math.floor((r.h + 10) / 40));
      const rh = range(rand, 21, 26);
      const gap = (r.h - rows * rh) / (rows + 1);
      for (let row = 0; row < rows; row++) {
        const y = r.y + gap * (row + 1) + rh * row;
        const xa = r.x + range(rand, 4, 10);
        const wt = r.w - range(rand, 10, 24);
        const parts: [number, number][] = wt > 130 && rand() < 0.45 ? [[xa, wt * range(rand, 0.42, 0.55)], [xa + wt * 0.5 + 10, wt * 0.5 - 10]] : [[xa, wt]];
        // 街区很宽时前一段会压住后一段。两段都要画的话，把前一段缩短，留 4 个单位的间隙
        const first = parts[0] as [number, number];
        const second = parts[1];
        if (second !== undefined && first[0] + first[1] > second[0]) {
          const fits = ([px, pw]: [number, number]): boolean => pw >= 44 && !blockedBy({ x: px, y, w: pw, h: rh }) && !unfit({ x: px, y, w: pw, h: rh });
          if (fits(first) && fits(second)) first[1] = second[0] - first[0] - 4;
        }
        for (const [px, pw] of parts) {
          const rect: Rect = { x: px, y, w: pw, h: rh };
          if (pw < 44 || blockedBy(rect) || unfit(rect)) continue;
          made.push({ building: addBuilding(state, rect, 'campus', { type: 'plain' }, rand, { nearStation: false }), rect });
          roofs.push(rect);
        }
      }
      scatterTrees(r, Math.floor((r.w * r.h) / 520), [...roofs.map((q) => inflate(q, 3)), ...(court === null ? [] : [court])], rand, 3.4, 5.4, 0.75);
    }
    // 小院里的树
    if (style === 'old') {
      allYards.push(...yards);
      for (const y of yards) {
        if (rand() >= 0.7) continue;
        const tx = y.x + y.w * range(rand, 0.3, 0.7);
        const ty = y.y + y.h * range(rand, 0.3, 0.7);
        const tr = range(rand, 3.4, 4.6) * 1.1;
        if (water === null || !water.wet(tx, ty, 0)) treeAt(tx, ty, tr);
      }
      // 每个街区两三样小东西。放进已经建好的屋顶的 props 里，所以要重建那几个 Building
      const extra = new Map<number, Prop[]>();
      const ownerOf = (rect: Rect): number | null => made.find((m) => m.rect === rect)?.building.id ?? null;
      scatterSmallObjects(roofs, yards, rand, extra, ownerOf);
      if (extra.size > 0) {
        for (const [id, more] of extra) {
          const at = state.buildings.findIndex((q) => q.id === id);
          const old = state.buildings[at] as Building;
          if (old.steel) continue;
          state.buildings[at] = { ...old, props: [...old.props, ...more] };
        }
      }
    }
  });

  const buildings = state.buildings;
  // 店的门面、候选屋顶
  const shopRoles = buildings.filter((b) => b.role.type === 'shop');
  const stationRoofs: StationRoof[] = buildings
    .filter((b) => b.role.type === 'roof')
    .map((b) => ({ roof: (b.role as { index: number }).index, rect: b.rect, building: b.id }));
  const blockOf = (rect: Rect): Block | undefined => blocks.find((bl) => contains(bl.rect, rect.x + rect.w / 2, rect.y + rect.h / 2));
  const fronts: ShopFront[] = [];
  const frontZones: Rect[] = [];
  for (const b of shopRoles) {
    const idx = (b.role as { index: number }).index;
    const front = chooseFront(b, idx, buildings, stationRoofs, frontZones, blockOf(b.rect));
    fronts.push(front.front);
    frontZones.push(front.zone);
  }
  // 店名：放在门面旁边不压东西的位置
  const placed: Rect[] = [];
  const named: ShopFront[] = fronts.map((f) => {
    const b = buildings[f.building] as Building;
    const name = placeShopName(b, buildings, frontZones, stationRoofs, placed);
    placed.push({ x: name.x - 2, y: name.y - 14, w: 13 * 6 + 4, h: 18 });
    return { ...f, name };
  });

  const bridges = makeBridges(streets, river);
  // 片区名躲开店的门面和店名、候选屋顶
  const nameBoxes = named.map((f) => ({ x: f.name.x - 2, y: f.name.y - 14, w: 13 * 6 + 4, h: 18 }));
  const labels = makeLabels(spec, streets, river, [...frontZones, ...nameBoxes, ...stationRoofs.map((r) => r.rect)]);
  addHelipad(buildings, spec.helipadNear);
  return { seed: spec.seed, region: spec.region, streets, blocks, buildings, trees, yards: allYards, bridges, labels, river, shops: named, stations: stationRoofs };
}

/** 写字楼里取一栋大楼画停机坪标记：圆心在屋顶中心，把压在它下面的别的物件拿掉。 */
function addHelipad(buildings: Building[], near: Vec | undefined): void {
  if (near === undefined) return;
  let best = -1;
  let bestD = Infinity;
  buildings.forEach((b, i) => {
    if (b.style !== 'office' || b.role.type !== 'plain' || b.rect.w <= 100 || b.rect.h <= 70) return;
    const c = rectCenter(b.rect);
    const d = (c.x - near.x) ** 2 + (c.y - near.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0) return;
  const b = buildings[best] as Building;
  const c = rectCenter(b.rect);
  const kept = b.props.filter((p) => Math.abs(p.x - c.x) > 26 || Math.abs(p.y - c.y) > 26);
  buildings[best] = { ...b, props: [...kept, { kind: 'helipad', x: c.x, y: c.y, a: 15, b: 0 }] };
}

// ---- 店的门面 ----
function frontZoneOf(rect: Rect, side: 'b' | 't' | 'l' | 'r'): Rect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const half = RAIL_LENGTH / 2 + 3;
  switch (side) {
    case 'b':
      return { x: cx - half, y: rect.y + rect.h, w: 2 * half, h: FRONT_DEPTH };
    case 't':
      return { x: cx - half, y: rect.y - FRONT_DEPTH, w: 2 * half, h: FRONT_DEPTH };
    case 'l':
      return { x: rect.x - FRONT_DEPTH, y: cy - half, w: FRONT_DEPTH, h: 2 * half };
    default:
      return { x: rect.x + rect.w, y: cy - half, w: FRONT_DEPTH, h: 2 * half };
  }
}

function chooseFront(b: Building, shop: number, all: readonly Building[], stations: readonly StationRoof[], taken: readonly Rect[], block: Block | undefined): { front: ShopFront; zone: Rect } {
  const sides = ['b', 't', 'l', 'r'] as const;
  let best: (typeof sides)[number] = 'b';
  let bestScore = Infinity;
  const r = b.rect;
  for (const side of sides) {
    const zone = frontZoneOf(r, side);
    let score = 0;
    for (const o of all) if (o.id !== b.id) score += overlapArea(zone, o.rect);
    for (const z of taken) score += 3 * overlapArea(zone, z);
    for (const s of stations) score += 8 * overlapArea(zone, s.rect);
    if (block !== undefined) {
      const d = side === 'b' ? block.rect.y + block.rect.h - (r.y + r.h) : side === 't' ? r.y - block.rect.y : side === 'l' ? r.x - block.rect.x : block.rect.x + block.rect.w - (r.x + r.w);
      score += 0.1 * d;
    }
    if (score < bestScore) {
      bestScore = score;
      best = side;
    }
  }
  const length = best === 'b' || best === 't' ? r.w : r.h;
  const awningWidth = Math.min(length, AWNING_MAX);
  const awningStart = (length - awningWidth) / 2;
  const origin: Vec = best === 'b' ? { x: r.x, y: r.y + r.h } : best === 't' ? { x: r.x + r.w, y: r.y } : best === 'r' ? { x: r.x + r.w, y: r.y + r.h } : { x: r.x, y: r.y };
  const angle = best === 'b' ? 0 : best === 't' ? 180 : best === 'r' ? -90 : 90;
  return { front: { shop, building: b.id, side: best, origin, angle, awningWidth, awningStart, name: { x: r.x, y: r.y } }, zone: frontZoneOf(r, best) };
}

function placeShopName(b: Building, all: readonly Building[], zones: readonly Rect[], stations: readonly StationRoof[], placed: readonly Rect[]): Vec {
  const r = b.rect;
  const tw = 13 * 6;
  const candidates: Vec[] = [
    { x: r.x + r.w / 2 - tw / 2, y: r.y + r.h + 14 },
    { x: r.x + r.w / 2 - tw / 2, y: r.y - 5 },
    { x: r.x + r.w + 5, y: r.y + r.h / 2 + 5 },
    { x: r.x - tw - 5, y: r.y + r.h / 2 + 5 },
    { x: r.x + r.w / 2 - tw / 2, y: r.y + r.h + 54 },
    { x: r.x + r.w / 2 - tw / 2, y: r.y - 24 },
  ];
  let best = candidates[0] as Vec;
  let bestScore = Infinity;
  for (const c of candidates) {
    const box: Rect = { x: c.x - 2, y: c.y - 14, w: tw + 4, h: 18 };
    let score = 0;
    for (const o of all) if (o.id !== b.id) score += overlapArea(box, o.rect);
    for (const z of zones) score += 4 * overlapArea(box, z);
    for (const s of stations) score += 6 * overlapArea(box, s.rect);
    for (const p of placed) score += 4 * overlapArea(box, p);
    score += 0.5 * overlapArea(box, r);
    if (score < bestScore) {
      bestScore = score;
      best = c;
      if (score === 0) break;
    }
  }
  return best;
}

// ---- 桥 ----
function makeBridges(streets: readonly Street[], river: City['river']): Bridge[] {
  const found: { bridge: Bridge; length: number }[] = [];
  for (const s of streets) {
    if (!s.main) continue;
    // 沿街的中心线找湿的那一段
    let wetStart: number | null = null;
    let wetEnd: number | null = null;
    for (let t = s.a; t <= s.b; t += 4) {
      const x = s.orient === 'h' ? t : s.c;
      const y = s.orient === 'h' ? s.c : t;
      if (isWet(river, x, y, 0)) {
        if (wetStart === null) wetStart = t;
        wetEnd = t;
      }
    }
    if (wetStart === null || wetEnd === null) continue;
    if (wetStart <= s.a + 24 || wetEnd >= s.b - 24) continue;
    // 斜着过河的街不架桥：湿的一段超过垂直过河的 1.4 倍
    if (wetEnd - wetStart > 2 * RIVER_HALF_WIDTH * 1.4) continue;
    const rect: Rect = s.orient === 'h' ? { x: wetStart - 16, y: s.c - s.w / 2, w: wetEnd - wetStart + 32, h: s.w } : { x: s.c - s.w / 2, y: wetStart - 16, w: s.w, h: wetEnd - wetStart + 32 };
    found.push({ bridge: { rect, horizontal: s.orient === 'h' }, length: s.b - s.a });
  }
  found.sort((p, q) => q.length - p.length);
  const out: Bridge[] = [];
  for (const f of found) {
    const c = rectCenter(f.bridge.rect);
    if (out.every((o) => Math.hypot(rectCenter(o.rect).x - c.x, rectCenter(o.rect).y - c.y) >= 230)) out.push(f.bridge);
    if (out.length >= 3) break;
  }
  return out;
}

// ---- 片区名 ----
function makeLabels(spec: CitySpec, streets: readonly Street[], river: City['river'], obstacles: readonly Rect[]): Label[] {
  const out: Label[] = [];
  spec.districts.forEach((d, index) => {
    if (!overlaps(d, spec.region)) return;
    const chars = index === 0 ? 2 : 4;
    const width = chars * LABEL_FONT + (chars - 1) * LABEL_SPACING + 12;
    const target = { x: d.x + d.w * 0.28, y: d.y + d.h * 0.2 };
    let best: Label | null = null;
    let bestScore = Infinity;
    for (const s of streets) {
      if (s.orient !== 'h' || s.b - s.a < width + 30) continue;
      if (s.c < d.y + 10 || s.c > d.y + d.h - 10) continue;
      // 沿街每隔 16 个单位试一个位置，字的范围里不能有河，不能压住别的东西
      const lo = Math.max(s.a, d.x) + width / 2 + 14;
      const hi = Math.min(s.b, d.x + d.w) - width / 2 - 14;
      for (let x = lo; x <= hi; x += 16) {
        if (isWet(river, x - width / 2, s.c, 6) || isWet(river, x + width / 2, s.c, 6) || isWet(river, x, s.c, 6)) continue;
        const box: Rect = { x: x - width / 2, y: s.c - 18, w: width, h: 36 };
        let blocked = 0;
        for (const o of obstacles) blocked += overlapArea(box, o);
        const score = Math.abs(s.c - target.y) + 0.3 * Math.abs(x - target.x) + (s.main ? 0 : 25) + 4 * blocked;
        if (score < bestScore) {
          bestScore = score;
          best = { district: index, x, y: s.c };
        }
      }
    }
    if (best !== null) out.push(best);
  });
  return out;
}

/** 字的宽度估计，店名摆放和片区名都用。 */
export const LABEL_METRICS = { font: LABEL_FONT, spacing: LABEL_SPACING } as const;

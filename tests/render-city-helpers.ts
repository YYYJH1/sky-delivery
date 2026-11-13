// 城市生成的相压检查，以及造随机地图规格的函数。render-city-map 和 render-city-random 两个测试文件共用。
import { createHash } from 'node:crypto';
import type { MapV1, RoofSize } from '../src/content/table_types.ts';
import { RIVER_HALF_WIDTH, STATION_SIZES, generateCity } from '../src/render/city.ts';
import type { CitySpec } from '../src/render/city.ts';
import type { City } from '../src/render/city-types.ts';
import { contains, dist, overlaps, segmentDistance } from '../src/render/geometry.ts';
import type { Rect, Vec } from '../src/render/geometry.ts';
import { citySpecFromMap, planBoard } from '../src/render/map-spec.ts';
import type { BoardPlan } from '../src/render/map-spec.ts';
import { isWet, makeRiver, riverDistance } from '../src/render/river.ts';
import { createRand, int, mixSeed, range } from '../src/render/rng.ts';

/** 一个问题：kind 是种类，text 说明在哪里。 */
export interface Problem {
  readonly kind: string;
  readonly text: string;
}

// ---- 几何：矩形到河道中心线的距离 ----

/** 线段 ab 与线段 cd 有公共点（含擦边和共线重叠）。 */
function segmentsMeet(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const cross = (o: Vec, p: Vec, q: Vec): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const onSeg = (p: Vec, q: Vec, r: Vec): boolean => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSeg(a, b, c)) || (d2 === 0 && onSeg(a, b, d)) || (d3 === 0 && onSeg(c, d, a)) || (d4 === 0 && onSeg(c, d, b));
}

/** 线段 ab 到矩形的最短距离：线段碰到矩形（含端点在矩形里）是 0，否则取矩形四条边到线段的最短距离。 */
export function segmentToRect(a: Vec, b: Vec, r: Rect): number {
  const inside = (p: Vec): boolean => contains(r, p.x, p.y);
  if (inside(a) || inside(b)) return 0;
  const corners: Vec[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const p = corners[k] as Vec;
    const q = corners[(k + 1) % 4] as Vec;
    if (segmentsMeet(a, b, p, q)) return 0;
    best = Math.min(best, segmentDistance(a.x, a.y, p.x, p.y, q.x, q.y), segmentDistance(b.x, b.y, p.x, p.y, q.x, q.y), segmentDistance(p.x, p.y, a.x, a.y, b.x, b.y), segmentDistance(q.x, q.y, a.x, a.y, b.x, b.y));
  }
  return best;
}

/**
 * 矩形到河道中心线的最短距离，小于半个河宽就是压在水面上。
 * 只关心小于 limit 的距离时传 limit：距离不小于 limit 的，返回值也不小于 limit（可能是无穷大），可以少算很多。
 */
export function distanceToRiver(river: City['river'], rect: Rect, limit = Infinity): number {
  let best = Infinity;
  const c = river.center;
  for (let i = 0; i + 1 < c.length; i++) {
    const a = c[i] as Vec;
    const b = c[i + 1] as Vec;
    // 线段的包围盒离矩形已经比目前的最短距离和 limit 都远，就不必细算
    const reach = Math.min(best, limit);
    if (Math.min(a.x, b.x) - reach > rect.x + rect.w || Math.max(a.x, b.x) + reach < rect.x || Math.min(a.y, b.y) - reach > rect.y + rect.h || Math.max(a.y, b.y) + reach < rect.y) continue;
    best = Math.min(best, segmentToRect(a, b, rect));
  }
  return best;
}

// ---- 检查 ----

const roleName = (b: City['buildings'][number]): string => (b.role.type === 'plain' ? `plain#${b.id}` : `${b.role.type}#${b.role.index}`);
const fmt = (r: Rect): string => `[${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.w.toFixed(1)}x${r.h.toFixed(1)}]`;

/** 互相压住的矩形对：按 x 排序后扫描，擦边（间隙为 0）不算。 */
export function overlappingPairs(rects: readonly Rect[]): [number, number][] {
  const order = rects.map((_, i) => i).sort((p, q) => (rects[p] as Rect).x - (rects[q] as Rect).x);
  const out: [number, number][] = [];
  for (let p = 0; p < order.length; p++) {
    const i = order[p] as number;
    const a = rects[i] as Rect;
    for (let q = p + 1; q < order.length; q++) {
      const j = order[q] as number;
      const b = rects[j] as Rect;
      if (b.x >= a.x + a.w) break;
      if (overlaps(a, b)) out.push([i, j]);
    }
  }
  return out;
}

/** 街带：横街是 [a, b] 乘 [c - w/2, c + w/2]，竖街反过来。 */
function streetBand(s: City['streets'][number]): Rect {
  return s.orient === 'h' ? { x: s.a, y: s.c - s.w / 2, w: s.b - s.a, h: s.w } : { x: s.c - s.w / 2, y: s.a, w: s.w, h: s.b - s.a };
}

/**
 * 城市里的相压和越界。检查的是画面上有占地矩形的东西：
 * 候选屋顶、站点屋顶、楼的屋顶、店的屋顶、街区里的普通屋顶，两两互不相压，也不压在水面和街带上。
 * 另外沿用已有测试的判定：树不种在河里，不是河岸绿地的街区，中心离河道中心线不少于半个河宽减 10。
 * 店门面的雨棚和票杆挂在屋顶外面，它们可以伸到邻居的屋顶上，不在检查之列。
 */
export function findProblems(city: City): Problem[] {
  const out: Problem[] = [];
  const bs = city.buildings;
  for (const [i, j] of overlappingPairs(bs.map((b) => b.rect))) {
    const a = bs[i] as City['buildings'][number];
    const b = bs[j] as City['buildings'][number];
    const kinds = [a.role.type, b.role.type].sort().join('+');
    out.push({ kind: `相压 ${kinds}`, text: `${roleName(a)} ${fmt(a.rect)} 与 ${roleName(b)} ${fmt(b.rect)}` });
  }
  for (const b of bs) {
    const d = distanceToRiver(city.river, b.rect, city.river.halfWidth);
    if (d < city.river.halfWidth) out.push({ kind: `压河 ${b.role.type}`, text: `${roleName(b)} ${fmt(b.rect)} 离河道中心线 ${d.toFixed(1)}` });
  }
  const bands = city.streets.map(streetBand);
  for (const b of bs) {
    bands.forEach((band, k) => {
      if (overlaps(b.rect, band)) out.push({ kind: `压街 ${b.role.type}`, text: `${roleName(b)} ${fmt(b.rect)} 与第 ${k} 条街 ${fmt(band)}` });
    });
  }
  for (const t of city.trees) if (isWet(city.river, t.x, t.y, 0)) out.push({ kind: '树在河里', text: `${t.x.toFixed(1)},${t.y.toFixed(1)}` });
  for (const bl of city.blocks) {
    if (bl.kind === 'bank') continue;
    const cx = bl.rect.x + bl.rect.w / 2;
    const cy = bl.rect.y + bl.rect.h / 2;
    if (isWet(city.river, cx, cy, -10)) out.push({ kind: '街区中心在河里', text: `${cx.toFixed(1)},${cy.toFixed(1)} ${fmt(bl.rect)}` });
  }
  return out;
}

/** 规格里落在画面区域里的店、楼、候选屋顶，各应当有且只有一块屋顶。候选屋顶不挪也不缩小。 */
export function findMissing(spec: CitySpec, city: City): Problem[] {
  const out: Problem[] = [];
  const near = (x: number, y: number): boolean => contains(spec.region, x, y, 30);
  const want: { type: 'shop' | 'home' | 'roof'; index: number }[] = [];
  spec.shops.forEach((p, index) => near(p.x, p.y) && want.push({ type: 'shop', index }));
  spec.homes.forEach((p, index) => near(p.x, p.y) && want.push({ type: 'home', index }));
  spec.roofs.forEach((p, index) => near(p.x, p.y) && want.push({ type: 'roof', index }));
  for (const w of want) {
    const found = city.buildings.filter((b) => b.role.type === w.type && (b.role as { index: number }).index === w.index);
    if (found.length !== 1) out.push({ kind: '缺屋顶', text: `${w.type}#${w.index} 有 ${found.length} 块` });
  }
  const extra = city.buildings.filter((b) => b.role.type !== 'plain').length - want.length;
  if (extra !== 0) out.push({ kind: '屋顶数量不符', text: `保留的屋顶多出 ${extra} 块` });
  for (const b of city.buildings) {
    if (b.role.type !== 'roof') continue;
    const p = spec.roofs[b.role.index] as CitySpec['roofs'][number];
    const [w, h] = STATION_SIZES[p.size];
    const moved = Math.abs(b.rect.x + b.rect.w / 2 - p.x) > 1e-9 || Math.abs(b.rect.y + b.rect.h / 2 - p.y) > 1e-9;
    if (moved || b.rect.w !== w || b.rect.h !== h) out.push({ kind: '候选屋顶被动过', text: `roof#${b.role.index} ${fmt(b.rect)}` });
  }
  const stations = city.stations.map((s) => `${s.roof}@${fmt(s.rect)}`).sort();
  const fromBuildings = city.buildings
    .filter((b) => b.role.type === 'roof')
    .map((b) => `${(b.role as { index: number }).index}@${fmt(b.rect)}`)
    .sort();
  if (stations.join('|') !== fromBuildings.join('|')) out.push({ kind: '站点屋顶与候选屋顶不一致', text: `${stations.length} 对 ${fromBuildings.length}` });
  return out;
}

// ---- 地图规格 ----

/** 整张地图：画面区域盖住 0 到宽、0 到高的全部点位，由画板换算出来。 */
export function wholeMapPlan(map: MapV1): BoardPlan {
  return planBoard({ x: map.width / 2, y: map.height / 2 }, map.width, map.height);
}

/** 在整张地图上，用 mapSeed 乘 7919 再加 offset 做种子，生成一座城市。 */
export function generateOnMap(map: MapV1, plan: BoardPlan, offset: number, helipadNear?: Vec): { spec: CitySpec; city: City } {
  const base = citySpecFromMap(map, plan.region, helipadNear);
  const spec: CitySpec = { ...base, seed: map.mapSeed * 7919 + offset };
  return { spec, city: generateCity(spec) };
}

/** 一批种子的检查结果：有问题的种子数，各种问题各出现在几个种子里，以及几个例子。 */
export interface Sweep {
  readonly seeds: number;
  readonly withProblems: number;
  readonly byKind: Record<string, number>;
  readonly examples: string[];
}

/** 没有任何问题时的检查结果。 */
export const cleanSweep = (seeds: number): Sweep => ({ seeds, withProblems: 0, byKind: {}, examples: [] });

/** 对 offset 从 from 到 to（不含）的每个种子生成城市，检查相压、越界和保留的屋顶是否齐全。 */
export function sweepSeeds(map: MapV1, plan: BoardPlan, from: number, to: number, helipadNear?: Vec): Sweep {
  const byKind: Record<string, number> = {};
  const examples: string[] = [];
  let withProblems = 0;
  for (let offset = from; offset < to; offset++) {
    const { spec, city } = generateOnMap(map, plan, offset, helipadNear);
    const problems = [...findProblems(city), ...findMissing(spec, city)];
    if (problems.length === 0) continue;
    withProblems++;
    for (const kind of new Set(problems.map((p) => p.kind))) byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (examples.length < 4) examples.push(`种子 ${spec.seed}：${(problems[0] as Problem).kind} ${(problems[0] as Problem).text}`);
  }
  return { seeds: to - from, withProblems, byKind, examples };
}

/** 各片区候选屋顶的大小，按放置的先后，和真实地图一样每片区 5 到 6 块。 */
const ROOF_SIZES: readonly (readonly RoofSize[])[] = [
  ['medium', 'small', 'small', 'medium', 'large', 'small'],
  ['medium', 'small', 'large', 'small', 'medium'],
  ['medium', 'small', 'small', 'large', 'medium'],
];
const HOME_KINDS = ['residence', 'office', 'dorm'] as const;

/**
 * 按固定的种子造一张随机地图：三个片区的位置和大小是随机的，河是随机的一条折线，有时穿过片区。
 * 店和楼互相相距不小于 60，离河道中心线不小于 50。候选屋顶离片区边缘不小于 40，与全部点相距不小于 60。
 * 这几条和真实地图的脚本一样。候选屋顶在城市里不挪动也不缩小，规格里的候选屋顶要是彼此压着或者压在水面上，
 * 生成器没有办法，所以这里另外留出余量：候选屋顶之间的间隙不小于 30，离水面不少于 12。
 */
export function randomMap(mapSeed: number): MapV1 {
  const rand = createRand(mixSeed(mapSeed, 0x7e57));
  const width = 2400;
  const height = 1800;
  // 片区：地图分成 2 乘 2 个格子，随机挑三个格子，每个格子里随机取一块矩形，所以三块互不相压
  const cells = [0, 1, 2, 3];
  for (let k = cells.length - 1; k > 0; k--) {
    const j = int(rand, 0, k);
    [cells[k], cells[j]] = [cells[j] as number, cells[k] as number];
  }
  const districts = cells.slice(0, 3).map((cell) => {
    const w = Math.round(range(rand, 750, 1100));
    const h = Math.round(range(rand, 500, 820));
    const x0 = Math.round((cell % 2) * (width / 2) + range(rand, 20, width / 2 - 20 - w));
    const y0 = Math.round(Math.floor(cell / 2) * (height / 2) + range(rand, 40, height / 2 - 40 - h));
    return { x0, x1: x0 + w, y0, y1: y0 + h };
  });
  // 河：一条从一边走到对边的折线，横着走或竖着走
  const vertical = rand() < 0.5;
  const along = vertical ? height : width;
  const across = vertical ? width : height;
  const steps = int(rand, 5, 8);
  let lateral = range(rand, 0.3 * across, 0.7 * across);
  const river: { x: number; y: number }[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * along;
    river.push(vertical ? { x: Math.round(lateral), y: Math.round(t) } : { x: Math.round(t), y: Math.round(lateral) });
    lateral = Math.min(0.85 * across, Math.max(0.15 * across, lateral + range(rand, -150, 150)));
  }
  const centre = makeRiver(river, RIVER_HALF_WIDTH);
  const farFromRiver = (p: Vec, min: number): boolean => riverDistance(centre, p.x, p.y) >= min;
  // 店和楼：在片区矩形里拒绝采样
  const points: Vec[] = [];
  const place = (d: (typeof districts)[number]): Vec => {
    for (let tries = 0; tries < 100000; tries++) {
      const p = { x: Math.round(range(rand, d.x0, d.x1) * 100) / 100, y: Math.round(range(rand, d.y0, d.y1) * 100) / 100 };
      if (points.every((q) => dist(p.x, p.y, q.x, q.y) >= 60) && farFromRiver(p, 50)) {
        points.push(p);
        return p;
      }
    }
    throw new Error(`random map ${mapSeed}: no room for another point`);
  };
  const shops: MapV1['shops'] = [];
  const buildings: MapV1['buildings'] = [];
  districts.forEach((d, district) => {
    const nShops = [int(rand, 8, 14), int(rand, 5, 8), int(rand, 6, 10)][district] as number;
    const nHomes = [int(rand, 14, 20), int(rand, 8, 12), int(rand, 10, 14)][district] as number;
    for (let i = 0; i < nShops; i++) {
      const p = place(d);
      shops.push({ nameIndex: shops.length, x: p.x, y: p.y, district, rank: shops.length + 1, opensAtStar: 1 });
    }
    for (let i = 0; i < nHomes; i++) {
      const p = place(d);
      buildings.push({ x: p.x, y: p.y, district, kind: HOME_KINDS[district] as (typeof HOME_KINDS)[number] });
    }
  });
  // 候选屋顶：每块在 60 个候选点里取离本片区已有屋顶最远的合格点
  const roofs: MapV1['roofs'] = [];
  districts.forEach((d, district) => {
    const mine: Vec[] = [];
    (ROOF_SIZES[district] as readonly RoofSize[]).forEach((size) => {
      const [w, h] = STATION_SIZES[size];
      let best: Vec | null = null;
      let bestScore = -1;
      // 已有的候选屋顶向四周各放大 30，新的屋顶不能压进这一圈
      const taken = roofs.map((r) => {
        const [rw, rh] = STATION_SIZES[r.size];
        return { x: r.x - rw / 2 - 30, y: r.y - rh / 2 - 30, w: rw + 60, h: rh + 60 };
      });
      for (let k = 0; k < 400; k++) {
        const p = { x: Math.round(range(rand, d.x0 + 40, d.x1 - 40) * 10) / 10, y: Math.round(range(rand, d.y0 + 40, d.y1 - 40) * 10) / 10 };
        if (!points.every((q) => dist(p.x, p.y, q.x, q.y) >= 60)) continue;
        const rect = { x: p.x - w / 2, y: p.y - h / 2, w, h };
        if (taken.some((o) => overlaps(o, rect))) continue;
        if (!(distanceToRiver(centre, rect, RIVER_HALF_WIDTH + 12) >= RIVER_HALF_WIDTH + 12)) continue;
        const score = mine.length === 0 ? -dist(p.x, p.y, (d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2) + 1e6 : Math.min(...mine.map((q) => dist(p.x, p.y, q.x, q.y)));
        if (score > bestScore) {
          best = p;
          bestScore = score;
        }
      }
      if (best === null) return;
      points.push(best);
      mine.push(best);
      roofs.push({ x: best.x, y: best.y, district, size, priceCoef: 1, opening: false });
    });
  });
  return {
    version: 0,
    mapSeed,
    width,
    height,
    districts: districts.map((d, i) => ({ id: `district${i}`, ...d })),
    shops,
    buildings,
    roofs,
    river,
  };
}

// ---- 固定值 ----

/** 城市输出的哈希：整体一个，各个部分各一个，部分的哈希用来在整体不符时看是哪一部分变了。 */
export function hashes(city: City): { whole: string; parts: Record<string, string> } {
  const h = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
  const record = city as unknown as Record<string, unknown>;
  return { whole: h(city), parts: Object.fromEntries(Object.keys(record).map((k) => [k, h(record[k])])) };
}

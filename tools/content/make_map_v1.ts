// 生成地图 v1：src/content/map_v1.ts。同样的输入得到逐字节相同的文件，可以随时重做。
// 用法：node --disable-warning=ExperimentalWarning tools/content/make_map_v1.ts [--check] [--out 路径] [--json 路径]
//   --check  不写文件，只检查现有文件与重新生成的结果是否逐字节相同，不同时退出码为 1
//   --json   另存一份 JSON
//
// 做法：
// 1. 店和楼。取 buildWorld('threeDistricts', 17) 的全部店和楼，坐标四舍五入到 0.01，间距仍不小于 60。
//    选种子 17 的原因：在 20 张随机地图上比较「仅限最近站点」和「全站协同」时，种子 17 的四项差值
//    （退单率、午高峰准时率、全天准时率、进账）离 20 张地图的平均值最近。
//    店在每个片区内按热度名次从高到低排，片区之间按老街、写字楼区、大学城的顺序排，
//    这个顺序就是店名在词表里的序号 nameIndex（0 到 27），所以老街最热的店的 nameIndex 是 0。
//    热度名次要调整：buildWorld 给的名次是随机的，种子 17 里写字楼区有全城最热的店（名次 1），
//    开通写字楼区时送往那里的订单只有约一成来自老街的店。要的是写字楼区店少，很多订单从老街的店送过河，
//    目标是刚开通的几天里四成到六成。所以写字楼区的六家店
//    固定取 OFFICE_HEAT_RANKS 里的名次，在全城偏冷的一端，按店在片区里从热到冷的顺序对应。
//    老街和大学城的店保持 buildWorld 给的相对顺序，补上剩下的名次，名次合起来仍是 1 到 28。
//    店在片区里的先后顺序不变，所以店名序号和坐标的对应不变。
// 2. 店的开张星级。每个片区先定哪几家晚开，其余在片区开通时就开。晚开的店取热度居中或偏低的，
//    按热度从高到低依次放在二星、三星、四星、五星开张。老街开局 9 家（晚开 5 家，二星开 2 家，三到五星各 1 家），
//    写字楼区开局 3 家（晚开 3 家，二到四星各 1 家），大学城开局 4 家（晚开 4 家，二到五星各 1 家）。
//    写字楼区只有 6 家店，五星时没有新店。
// 3. 楼的类型：老街是住宅，写字楼区是写字楼，大学城是宿舍。
// 4. 候选屋顶。每个片区 4 到 6 块（老街 6，写字楼区 5，大学城 5），大小按固定序列给：
//    老街依次是中、小、小、中、大、小，写字楼区是中、小、大、小、中，大学城是中、小、小、大、中。
//    老街的第一块是开局已建的。每块屋顶与全部店、楼和别的屋顶相距不小于 60，离片区矩形的边缘不小于 40。
//    - 每个片区的第一块屋顶：取片区里开局开张的店的质心，在 10 为间隔的格点里找离质心最近的合格点。
//      老街的这一块就是开局的站所在的屋顶，大小取中。
//    - 其余的屋顶：用种子 1701 的随机数，每块抽 60 个候选点，在合格的候选里取离本片区已有屋顶最远的一个，
//      这样同一片区的屋顶分得开。
//    - 价格系数 = 0.70 + 0.60 × (0.5 × 大小分 + 0.5 × 居中分)，取两位小数。大小分：小 0，中 0.5，大 1。
//      居中分 = 1 减去（到片区中心的距离 / 片区矩形的半对角线），不小于 0。系数在 0.70 到 1.30 之间，
//      大屋顶和靠近片区中心的更贵。
// 5. 河：一条折线，从地图上边缘沿老街和写字楼区之间向南，再折向东，穿过写字楼区和大学城之间，到地图右边缘。
//    只供画面用，飞机可以直接飞过。折线离所有店、楼、屋顶不小于 50，脚本会检查。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONTENT_VERSION, buildWorld, createRng, nextRange } from '../../src/core/index.ts';
import type {
  BuildingKind,
  MapBuildingV1,
  MapDistrictV1,
  MapPointV1,
  MapRoofV1,
  MapShopV1,
  MapV1,
  RoofSize,
} from '../../src/content/table_types.ts';

const MAP_SEED = 17;
const ROOF_SEED = 1701;
const MIN_GAP = 60; // 屋顶与全部店、楼、别的屋顶的最小间距
const EDGE_MARGIN = 40; // 屋顶离片区矩形边缘的最小距离
const CANDIDATES = 60; // 每块屋顶抽多少个候选点
const GRID = 10; // 找离质心最近的合格点时的格点间隔
const RIVER_CLEARANCE = 50;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '..', '..', 'src', 'content', 'map_v1.ts');

const KIND_OF_DISTRICT: readonly BuildingKind[] = ['residence', 'office', 'dorm'];

const OFFICE = 1;

/**
 * 写字楼区六家店的热度名次（全城 28 家一起排，1 最热），按店在片区里从热到冷的顺序。
 * 取 11 到 28 之间的值，使开通写字楼区之后头几天，送往写字楼区的订单里约一半来自老街的店。
 */
const OFFICE_HEAT_RANKS: readonly number[] = [11, 15, 19, 23, 26, 28];

/**
 * 每个片区晚开的店：下标是店在本片区里按热度从高到低排的位置（0 最热），
 * 每一组依次在二星、三星、四星、五星开张。没有列出的店在片区开通时就开。
 */
const LATE_SHOPS: readonly (readonly (readonly number[])[])[] = [
  [[5, 7], [9], [11], [13]], // 老街 14 家，开局 9 家
  [[2], [4], [5]], // 写字楼区 6 家，开局 3 家
  [[3], [5], [6], [7]], // 大学城 8 家，开局 4 家
];

/** 每个片区候选屋顶的大小，按放置的先后。第一块是该片区的第一块屋顶，老街的第一块是开局已建的。 */
const ROOF_SIZES: readonly (readonly RoofSize[])[] = [
  ['medium', 'small', 'small', 'medium', 'large', 'small'],
  ['medium', 'small', 'large', 'small', 'medium'],
  ['medium', 'small', 'small', 'large', 'medium'],
];

/** 河的折线。 */
const RIVER: readonly MapPointV1[] = [
  { x: 1170, y: 0 },
  { x: 1260, y: 220 },
  { x: 1215, y: 480 },
  { x: 1285, y: 760 },
  { x: 1250, y: 1000 },
  { x: 1420, y: 1040 },
  { x: 1750, y: 1010 },
  { x: 2100, y: 1060 },
  { x: 2400, y: 1030 },
];

interface Point {
  x: number;
  y: number;
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function centroid(points: readonly Point[]): Point {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/** 点到折线的最短距离。 */
function distToPolyline(p: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as Point;
    const b = line[i + 1] as Point;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    best = Math.min(best, dist(p, { x: a.x + t * abx, y: a.y + t * aby }));
  }
  return best;
}

/**
 * 调整之后的热度名次，下标与 world.merchants 相同。写字楼区的店取 OFFICE_HEAT_RANKS，
 * 其余的店按 buildWorld 给的名次从小到大，依次取剩下的名次。
 */
function heatRanks(world: ReturnType<typeof buildWorld>): number[] {
  const order = (district: number): number[] =>
    world.merchants
      .map((m, i) => (m.district === district ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => (world.merchants[a] as { rank: number }).rank - (world.merchants[b] as { rank: number }).rank);
  const ranks: number[] = world.merchants.map(() => 0);
  order(OFFICE).forEach((index, position) => {
    ranks[index] = OFFICE_HEAT_RANKS[position] as number;
  });
  const rest = world.merchants
    .map((m, i) => (m.district !== OFFICE ? i : -1))
    .filter((i) => i >= 0)
    .sort((a, b) => (world.merchants[a] as { rank: number }).rank - (world.merchants[b] as { rank: number }).rank);
  const free: number[] = [];
  for (let r = 1; r <= world.merchants.length; r++) if (!OFFICE_HEAT_RANKS.includes(r)) free.push(r);
  rest.forEach((index, k) => {
    ranks[index] = free[k] as number;
  });
  return ranks;
}

function buildShops(world: ReturnType<typeof buildWorld>): MapShopV1[] {
  const shops: MapShopV1[] = [];
  const heat = heatRanks(world);
  for (let district = 0; district < 3; district++) {
    const inDistrict = world.merchants
      .map((m, i) => ({ m, rank: heat[i] as number }))
      .filter((s) => s.m.district === district)
      .sort((a, b) => a.rank - b.rank);
    const opensAt = inDistrict.map(() => 1);
    (LATE_SHOPS[district] as readonly (readonly number[])[]).forEach((group, i) => {
      for (const position of group) opensAt[position] = 2 + i;
    });
    inDistrict.forEach(({ m, rank }, position) => {
      shops.push({
        nameIndex: shops.length,
        x: r2(m.x),
        y: r2(m.y),
        district,
        rank,
        opensAtStar: opensAt[position] as number,
      });
    });
  }
  return shops;
}

function buildBuildings(world: ReturnType<typeof buildWorld>): MapBuildingV1[] {
  return world.buildings.map((b) => ({
    x: r2(b.x),
    y: r2(b.y),
    district: b.district,
    kind: KIND_OF_DISTRICT[b.district] as BuildingKind,
  }));
}

function sizeScore(size: RoofSize): number {
  return size === 'small' ? 0 : size === 'medium' ? 0.5 : 1;
}

function priceCoef(p: Point, rect: MapDistrictV1, size: RoofSize): number {
  const center = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
  const half = dist({ x: rect.x0, y: rect.y0 }, center);
  const central = Math.max(0, 1 - dist(p, center) / half);
  return Math.round((0.7 + 0.6 * (0.5 * sizeScore(size) + 0.5 * central)) * 100) / 100;
}

function farEnough(p: Point, others: readonly Point[]): boolean {
  return others.every((q) => dist(p, q) >= MIN_GAP);
}

/** 在片区矩形（缩进边距）里，格点中离 target 最近的合格点。距离相同取 y 小的，再取 x 小的。 */
function nearestValid(target: Point, rect: MapDistrictV1, avoid: readonly Point[]): Point {
  let best: Point | null = null;
  let bestDist = Infinity;
  const x0 = rect.x0 + EDGE_MARGIN;
  const x1 = rect.x1 - EDGE_MARGIN;
  const y0 = rect.y0 + EDGE_MARGIN;
  const y1 = rect.y1 - EDGE_MARGIN;
  for (let y = Math.ceil(y0 / GRID) * GRID; y <= y1; y += GRID) {
    for (let x = Math.ceil(x0 / GRID) * GRID; x <= x1; x += GRID) {
      const p = { x, y };
      if (!farEnough(p, avoid)) continue;
      const d = dist(p, target);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
  }
  if (best === null) throw new Error('no valid roof position near the target');
  return best;
}

function buildRoofs(shops: readonly MapShopV1[], buildings: readonly MapBuildingV1[], districts: readonly MapDistrictV1[]): MapRoofV1[] {
  const rng = createRng(ROOF_SEED);
  const fixed: Point[] = [...shops, ...buildings];
  const roofs: MapRoofV1[] = [];
  districts.forEach((rect, district) => {
    const sizes = ROOF_SIZES[district] as readonly RoofSize[];
    const early = shops.filter((s) => s.district === district && s.opensAtStar === 1);
    const placed: Point[] = [];
    sizes.forEach((size, i) => {
      const avoid = [...fixed, ...roofs];
      let p: Point;
      if (i === 0) {
        p = nearestValid(centroid(early), rect, avoid);
      } else {
        let best: Point | null = null;
        let bestScore = -1;
        for (let k = 0; k < CANDIDATES; k++) {
          const cand = {
            x: r1(nextRange(rng, rect.x0 + EDGE_MARGIN, rect.x1 - EDGE_MARGIN)),
            y: r1(nextRange(rng, rect.y0 + EDGE_MARGIN, rect.y1 - EDGE_MARGIN)),
          };
          if (!farEnough(cand, avoid)) continue;
          const score = Math.min(...placed.map((q) => dist(cand, q)));
          if (score > bestScore) {
            best = cand;
            bestScore = score;
          }
        }
        if (best === null) throw new Error(`no valid candidate for roof ${i} of district ${district}`);
        p = best;
      }
      placed.push(p);
      roofs.push({ x: p.x, y: p.y, district, size, priceCoef: priceCoef(p, rect, size), opening: district === 0 && i === 0 });
    });
  });
  return roofs;
}

function buildMap(): MapV1 {
  const world = buildWorld('threeDistricts', MAP_SEED);
  const districts: MapDistrictV1[] = world.districts.map((d) => ({ id: d.id, x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1 }));
  const shops = buildShops(world);
  const buildings = buildBuildings(world);
  const roofs = buildRoofs(shops, buildings, districts);
  return {
    version: CONTENT_VERSION, // 地图跟着内容表的版本号走，内容版本升了要重新生成（见 tests/campaign-content.test.ts）
    mapSeed: MAP_SEED,
    width: world.width,
    height: world.height,
    districts,
    shops,
    buildings,
    roofs,
    river: RIVER.map((p) => ({ ...p })),
  };
}

/** 检查生成结果：间距、河的间距、数量。不满足时抛错，不写文件。 */
function validate(map: MapV1): void {
  const points: Point[] = [...map.shops, ...map.buildings, ...map.roofs];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = dist(points[i] as Point, points[j] as Point);
      if (d < MIN_GAP) throw new Error(`points ${i} and ${j} are ${d.toFixed(2)} apart, less than ${MIN_GAP}`);
    }
  }
  for (const p of points) {
    const d = distToPolyline(p, map.river);
    if (d < RIVER_CLEARANCE) throw new Error(`a point at (${p.x}, ${p.y}) is ${d.toFixed(1)} from the river, less than ${RIVER_CLEARANCE}`);
  }
  if (map.shops.length !== 28 || map.buildings.length !== 42) throw new Error('unexpected number of shops or buildings');
  const ranks = map.shops.map((s) => s.rank).sort((a, b) => a - b);
  if (ranks.some((r, i) => r !== i + 1)) throw new Error('heat ranks must be exactly 1 to 28');
  for (let k = 0; k < 3; k++) {
    const inDistrict = map.shops.filter((s) => s.district === k).map((s) => s.rank);
    if (inDistrict.some((r, i) => i > 0 && r <= (inDistrict[i - 1] as number))) throw new Error(`district ${k} shops are not in heat order`);
  }
  const opening = map.roofs.filter((r) => r.opening);
  if (opening.length !== 1 || opening[0]?.size !== 'medium' || opening[0]?.district !== 0) throw new Error('bad opening roof');
}

function fmt(v: number): string {
  return String(v);
}

function render(map: MapV1): string {
  const lines: string[] = [];
  const rows = <T>(items: readonly T[], one: (item: T) => string): void => {
    for (const item of items) lines.push(`    ${one(item)},`);
  };
  lines.push('// 地图 v1。本文件由 tools/content/make_map_v1.ts 生成，不要手改，要改就改脚本再重新生成。');
  lines.push('// 生成的做法写在脚本开头的注释里。店在每个片区内按热度从高到低排，nameIndex 与下标相同。');
  lines.push("import type { MapV1 } from './table_types.ts';");
  lines.push('');
  lines.push('export const MAP_V1: MapV1 = {');
  lines.push(`  version: ${map.version},`);
  lines.push(`  mapSeed: ${map.mapSeed},`);
  lines.push(`  width: ${map.width},`);
  lines.push(`  height: ${map.height},`);
  lines.push('  districts: [');
  rows(map.districts, (d) => `{ id: '${d.id}', x0: ${fmt(d.x0)}, x1: ${fmt(d.x1)}, y0: ${fmt(d.y0)}, y1: ${fmt(d.y1)} }`);
  lines.push('  ],');
  lines.push('  shops: [');
  rows(
    map.shops,
    (s) => `{ nameIndex: ${s.nameIndex}, x: ${fmt(s.x)}, y: ${fmt(s.y)}, district: ${s.district}, rank: ${s.rank}, opensAtStar: ${s.opensAtStar} }`,
  );
  lines.push('  ],');
  lines.push('  buildings: [');
  rows(map.buildings, (b) => `{ x: ${fmt(b.x)}, y: ${fmt(b.y)}, district: ${b.district}, kind: '${b.kind}' }`);
  lines.push('  ],');
  lines.push('  roofs: [');
  rows(
    map.roofs,
    (r) =>
      `{ x: ${fmt(r.x)}, y: ${fmt(r.y)}, district: ${r.district}, size: '${r.size}', priceCoef: ${fmt(r.priceCoef)}, opening: ${String(r.opening)} }`,
  );
  lines.push('  ],');
  lines.push('  river: [');
  rows(map.river, (p) => `{ x: ${fmt(p.x)}, y: ${fmt(p.y)} }`);
  lines.push('  ],');
  lines.push('};');
  return lines.join('\n') + '\n';
}

function main(): void {
  const { values } = parseArgs({
    options: { check: { type: 'boolean' }, out: { type: 'string' }, json: { type: 'string' } },
    strict: true,
  });
  const map = buildMap();
  validate(map);
  const text = render(map);
  const out = values.out ?? DEFAULT_OUT;
  if (values.check) {
    const current = readFileSync(out, 'utf8');
    if (current !== text) {
      process.stderr.write(`${out} differs from the regenerated map\n`);
      process.exit(1);
    }
    process.stdout.write('map_v1.ts is identical to the regenerated map\n');
  } else {
    writeFileSync(out, text);
    process.stdout.write(`wrote ${out}\n`);
  }
  if (values.json) {
    writeFileSync(values.json, JSON.stringify(map, null, 1) + '\n');
    process.stdout.write(`wrote ${values.json}\n`);
  }
}

main();

// 地图：片区、店、楼，以及站点布局。静态数据，创建之后不再改变。
import { detExp, detLn } from './detmath.ts';
import { Hasher } from './hash.ts';
import { createRng, nextRange, shuffleInPlace } from './rng.ts';
import type { RngState } from './rng.ts';
import type { Building, DistrictRect, LayoutId, Merchant, ScenarioId, SimConfig, World } from './types.ts';

export const MAP_WIDTH = 2400;
export const MAP_HEIGHT = 1800;
export const MIN_GAP = 60; // 任意两个点之间的最小间距

export const DISTRICT_OLD = 0;
export const DISTRICT_OFFICE = 1;
export const DISTRICT_CAMPUS = 2;

interface DistrictDef extends DistrictRect {
  shops: number;
  buildings: number;
}

const DISTRICT_DEFS: readonly DistrictDef[] = [
  { id: 'oldStreet', x0: 100, x1: 1100, y0: 200, y1: 1100, shops: 14, buildings: 20 },
  { id: 'office', x0: 1400, x1: 2300, y0: 150, y1: 900, shops: 6, buildings: 10 },
  { id: 'campus', x0: 900, x1: 2100, y0: 1150, y1: 1700, shops: 8, buildings: 12 },
];

export const HEAT_EXPONENT = 0.9; // 店铺热度权重 1 / 名次^0.9
export const DISTANCE_SCALE = 700; // 抽店时的距离衰减尺度
const DISTANCE_SCALE_FAR = 1400; // 送往写字楼区的订单放宽后的尺度
export const SAME_DISTRICT_BONUS = 2; // 同片区的店权重翻倍
const SPARSE_OFFICE_SHOPS = 2; // 写字楼区只保留最热的两家店

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

interface Point {
  x: number;
  y: number;
}

/** 在片区矩形内拒绝采样一个点，与已有的全部点相距不小于 MIN_GAP。 */
function placePoint(rng: RngState, rect: DistrictRect, placed: Point[]): Point {
  for (let tries = 0; tries < 100000; tries++) {
    const x = nextRange(rng, rect.x0, rect.x1);
    const y = nextRange(rng, rect.y0, rect.y1);
    if (placed.every((q) => dist(x, y, q.x, q.y) >= MIN_GAP)) {
      const p = { x, y };
      placed.push(p);
      return p;
    }
  }
  throw new Error('no room left in the district for another point');
}

/** 按地图种子生成店和楼。三个场景共用同一批点位：只有老街的场景取其中的老街，其余同理。 */
export function buildWorld(scenario: ScenarioId, mapSeed: number): World {
  const rng = createRng(mapSeed);
  const placed: Point[] = [];
  let shops: Merchant[] = [];
  let buildings: Building[] = [];
  DISTRICT_DEFS.forEach((def, k) => {
    for (let i = 0; i < def.shops; i++) {
      shops.push({ ...placePoint(rng, def, placed), district: k, rank: 0, weight: 0 });
    }
    for (let i = 0; i < def.buildings; i++) {
      buildings.push({ ...placePoint(rng, def, placed), district: k });
    }
  });
  // 全部店随机排热度名次
  const perm = shops.map((_, i) => i);
  shuffleInPlace(rng, perm);
  shops.forEach((shop, i) => {
    shop.rank = (perm[i] as number) + 1;
  });

  if (scenario === 'oldStreet') {
    shops = shops.filter((s) => s.district === DISTRICT_OLD);
    buildings = buildings.filter((b) => b.district === DISTRICT_OLD);
    // 名次在老街内重排成 1 到 n
    const byRank = [...shops].sort((p, q) => p.rank - q.rank);
    byRank.forEach((s, i) => {
      s.rank = i + 1;
    });
  } else if (scenario === 'sparseOffice') {
    const office = shops.filter((s) => s.district === DISTRICT_OFFICE).sort((p, q) => p.rank - q.rank);
    const drop = new Set(office.slice(SPARSE_OFFICE_SHOPS));
    shops = shops.filter((s) => !drop.has(s));
  }
  for (const s of shops) s.weight = detExp(-HEAT_EXPONENT * detLn(s.rank));

  const buildingsByDistrict = DISTRICT_DEFS.map((_, k) => {
    const idx: number[] = [];
    buildings.forEach((b, i) => {
      if (b.district === k) idx.push(i);
    });
    return idx;
  });

  // 抽店的权重：热度 × exp(-距离/尺度) × (同片区 2 倍)，累计后按随机数二分查找
  const cumWeights = buildings.map((b) => {
    const scale = scenario === 'sparseOffice' && b.district === DISTRICT_OFFICE ? DISTANCE_SCALE_FAR : DISTANCE_SCALE;
    let total = 0;
    return shops.map((s) => {
      const bonus = s.district === b.district ? SAME_DISTRICT_BONUS : 1;
      total += s.weight * detExp(-dist(s.x, s.y, b.x, b.y) / scale) * bonus;
      return total;
    });
  });

  const world: World = {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    districts: DISTRICT_DEFS.map(({ id, x0, x1, y0, y1 }) => ({ id, x0, x1, y0, y1 })),
    merchants: shops,
    buildings,
    buildingsByDistrict,
    cumWeights,
    digest: '',
  };
  world.digest = digestWorld(world);
  return world;
}

function digestWorld(world: World): string {
  const h = new Hasher();
  h.num(world.merchants.length);
  for (const m of world.merchants) {
    h.num(m.x);
    h.num(m.y);
    h.num(m.district);
    h.num(m.rank);
    h.num(m.weight);
  }
  h.num(world.buildings.length);
  for (const b of world.buildings) {
    h.num(b.x);
    h.num(b.y);
    h.num(b.district);
  }
  for (const row of world.cumWeights) h.nums(row);
  return h.digest();
}

// ---- 站点布局 ----
export interface StationPlan {
  x: number;
  y: number;
  drones: number; // 开局的飞机数
  bays: number; // 停机位数
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

function rectCenter(rect: DistrictRect): Point {
  return { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
}

const EDGE_SHIFT = 400; // 「向外移」的距离

function stationPositions(world: World, scenario: ScenarioId, layout: LayoutId): Point[] {
  const shopsOf = (k: number): Merchant[] => world.merchants.filter((s) => s.district === k);
  if (scenario === 'oldStreet') return [centroid(world.merchants)];
  // 默认两座：一座在老街全部店的质心，一座在写字楼区与大学城两个矩形中心的中点
  const defaults = (): Point[] => {
    const office = rectCenter(world.districts[DISTRICT_OFFICE] as DistrictRect);
    const campus = rectCenter(world.districts[DISTRICT_CAMPUS] as DistrictRect);
    return [centroid(shopsOf(DISTRICT_OLD)), { x: (office.x + campus.x) / 2, y: (office.y + campus.y) / 2 }];
  };
  switch (layout) {
    case 'default':
      return defaults();
    case 'single':
      return [centroid(world.merchants)];
    case 'three':
      return [DISTRICT_OLD, DISTRICT_OFFICE, DISTRICT_CAMPUS].map((k) => centroid(shopsOf(k)));
    case 'edge':
      // 默认的两座站各自朝远离全图中心的方向平移，不超出地图
      return defaults().map((p) => {
        const dx = p.x - world.width / 2;
        const dy = p.y - world.height / 2;
        const len = Math.sqrt(dx * dx + dy * dy);
        return {
          x: Math.min(Math.max(p.x + (EDGE_SHIFT * dx) / len, 0), world.width),
          y: Math.min(Math.max(p.y + (EDGE_SHIFT * dy) / len, 0), world.height),
        };
      });
  }
}

/** 站点位置、各站的开局飞机数和停机位数。飞机在各站之间尽量平分，前面的站多分一架。 */
export function planStations(world: World, config: SimConfig): StationPlan[] {
  const positions = stationPositions(world, config.scenario, config.layout);
  const n = positions.length;
  return positions.map((p, i) => {
    const drones = Math.floor(config.drones / n) + (i < config.drones % n ? 1 : 0);
    return { x: p.x, y: p.y, drones, bays: drones + config.extraBays };
  });
}

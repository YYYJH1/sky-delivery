// 内容表：地图 v1、价格、各片区的订单规律、开局订单。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISTRICT_RATES_V1, STAR_MULTIPLIER_V1 } from '../src/content/districts_v1.ts';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { OPENING_ORDERS_V1 } from '../src/content/opening_v1.ts';
import { CONTENT_VERSION } from '../src/content/version.ts';
import { buildCampaignWorld, buildWorld, createState, districtLambda, refreshShops } from '../src/core/index.ts';
import { ARRIVAL_CURVE } from '../src/core/systems/orders.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Point {
  x: number;
  y: number;
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

describe('地图 v1：店和楼', () => {
  it('三个片区共 28 家店、42 栋楼，店在每个片区内按热度从高到低排，店名序号与下标相同', () => {
    expect(MAP_V1.shops.length).toBe(28);
    expect(MAP_V1.buildings.length).toBe(42);
    expect(MAP_V1.districts.map((d) => d.id)).toEqual(['oldStreet', 'office', 'campus']);
    expect(MAP_V1.shops.map((s) => s.nameIndex)).toEqual(Array.from({ length: 28 }, (_, i) => i));
    expect([0, 1, 2].map((k) => MAP_V1.shops.filter((s) => s.district === k).length)).toEqual([14, 6, 8]);
    expect([0, 1, 2].map((k) => MAP_V1.buildings.filter((b) => b.district === k).length)).toEqual([20, 10, 12]);
    // 片区按老街、写字楼区、大学城的顺序排，片区内热度名次递增
    expect(MAP_V1.shops.map((s) => s.district)).toEqual([...MAP_V1.shops.map((s) => s.district)].sort((a, b) => a - b));
    for (const k of [0, 1, 2]) {
      const ranks = MAP_V1.shops.filter((s) => s.district === k).map((s) => s.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
    // 三个片区的热度名次合起来恰好是 1 到 28
    expect(MAP_V1.shops.map((s) => s.rank).sort((a, b) => a - b)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
  });

  it('老街最热的店的店名序号是 0，开局第一张订单来自它', () => {
    const hottestOld = MAP_V1.shops.filter((s) => s.district === 0).sort((a, b) => a.rank - b.rank)[0];
    expect(hottestOld?.nameIndex).toBe(0);
    expect(OPENING_ORDERS_V1[0]?.merchant).toBe(0);
  });

  it('店和楼取自 buildWorld(threeDistricts, 17)：同一片区里按热度排的同一位置的店、同一个下标的楼，坐标相差不超过 0.005', () => {
    expect(MAP_V1.mapSeed).toBe(17);
    const world = buildWorld('threeDistricts', 17);
    // 地图里写字楼区的店的热度名次调整过，所以店按片区内的先后对应，不按全城名次
    for (const k of [0, 1, 2]) {
      const original = world.merchants.filter((w) => w.district === k).sort((a, b) => a.rank - b.rank);
      const mine = MAP_V1.shops.filter((s) => s.district === k);
      expect(mine.length).toBe(original.length);
      mine.forEach((shop, position) => {
        const m = original[position] as Point;
        expect(Math.abs(m.x - shop.x), `shop ${shop.nameIndex}`).toBeLessThanOrEqual(0.005 + 1e-9);
        expect(Math.abs(m.y - shop.y), `shop ${shop.nameIndex}`).toBeLessThanOrEqual(0.005 + 1e-9);
      });
    }
    world.buildings.forEach((b, i) => {
      const own = MAP_V1.buildings[i] as { x: number; y: number; district: number };
      expect(own.district).toBe(b.district);
      expect(Math.abs(own.x - b.x)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(own.y - b.y)).toBeLessThanOrEqual(0.005 + 1e-9);
    });
  });

  it('楼的类型：老街是住宅，写字楼区是写字楼，大学城是宿舍', () => {
    const kinds = ['residence', 'office', 'dorm'];
    for (const b of MAP_V1.buildings) expect(b.kind).toBe(kinds[b.district]);
  });

  it('店和楼都在自己片区的矩形里，任意两点（店、楼、屋顶）相距不小于 60', () => {
    for (const s of [...MAP_V1.shops, ...MAP_V1.buildings, ...MAP_V1.roofs]) {
      const d = MAP_V1.districts[s.district] as { x0: number; x1: number; y0: number; y1: number };
      expect(s.x).toBeGreaterThanOrEqual(d.x0);
      expect(s.x).toBeLessThanOrEqual(d.x1);
      expect(s.y).toBeGreaterThanOrEqual(d.y0);
      expect(s.y).toBeLessThanOrEqual(d.y1);
    }
    const all: Point[] = [...MAP_V1.shops, ...MAP_V1.buildings, ...MAP_V1.roofs];
    let nearest = Infinity;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) nearest = Math.min(nearest, dist(all[i] as Point, all[j] as Point));
    }
    expect(nearest).toBeGreaterThanOrEqual(60);
  });
});

describe('地图 v1：店的开张', () => {
  const countAt = (district: number, star: number): number =>
    MAP_V1.shops.filter((s) => s.district === district && s.opensAtStar === star).length;

  it('开局时老街开 9 家，写字楼区 3 家，大学城 4 家', () => {
    expect([0, 1, 2].map((k) => countAt(k, 1))).toEqual([9, 3, 4]);
  });

  it('其余的店在片区升星时开张，每升一星开一到两家（写字楼区只有 6 家店，五星时没有新店）', () => {
    expect([2, 3, 4, 5].map((star) => countAt(0, star))).toEqual([2, 1, 1, 1]);
    expect([2, 3, 4, 5].map((star) => countAt(1, star))).toEqual([1, 1, 1, 0]);
    expect([2, 3, 4, 5].map((star) => countAt(2, star))).toEqual([1, 1, 1, 1]);
    for (const shop of MAP_V1.shops) {
      expect(shop.opensAtStar).toBeGreaterThanOrEqual(1);
      expect(shop.opensAtStar).toBeLessThanOrEqual(5);
    }
  });

  it('晚开的店取热度居中或偏低的：每个片区最热的两家店开局就开', () => {
    for (const k of [0, 1, 2]) {
      const shops = MAP_V1.shops.filter((s) => s.district === k);
      expect(shops[0]?.opensAtStar).toBe(1);
      expect(shops[1]?.opensAtStar).toBe(1);
      const late = shops.filter((s) => s.opensAtStar > 1);
      const meanRank = (list: typeof shops): number => list.reduce((sum, s) => sum + s.rank, 0) / list.length;
      expect(meanRank(late)).toBeGreaterThan(meanRank(shops.filter((s) => s.opensAtStar === 1)));
    }
  });
});

describe('地图 v1：写字楼区的过河单', () => {
  /** 送往写字楼区的订单里，来自老街的店的占比：每栋写字楼等概率，店按累计权重抽，取各栋楼的平均。 */
  function oldStreetShare(officeStar: number): number {
    const state = createState({ mode: 'campaign' });
    const campaign = state.campaign as NonNullable<typeof state.campaign>;
    (campaign.districts[0] as { star: number }).star = 3;
    (campaign.districts[1] as { open: boolean; star: number }).open = true;
    (campaign.districts[1] as { open: boolean; star: number }).star = officeStar;
    refreshShops(state);
    const buildings = state.world.buildingsByDistrict[1] as number[];
    let total = 0;
    for (const b of buildings) {
      const cum = campaign.cumWeights[b] as number[];
      let fromOld = 0;
      cum.forEach((c, i) => {
        if (MAP_V1.shops[i]?.district === 0) fromOld += c - (i > 0 ? (cum[i - 1] as number) : 0);
      });
      total += fromOld / (cum[cum.length - 1] as number);
    }
    return total / buildings.length;
  }

  it('写字楼区的六家店排在全城热度的偏冷一端（名次 11 到 28），老街和大学城的店保持原来的相对顺序', () => {
    expect(MAP_V1.shops.filter((s) => s.district === 1).map((s) => s.rank)).toEqual([11, 15, 19, 23, 26, 28]);
    const world = buildWorld('threeDistricts', 17);
    for (const k of [0, 2]) {
      const original = world.merchants.filter((w) => w.district === k).sort((a, b) => a.rank - b.rank);
      const mine = MAP_V1.shops.filter((s) => s.district === k);
      expect(mine.length).toBe(original.length);
      // 位置相同的店，坐标相同，名次只会变小或不变：老街和大学城的店补上了写字楼区让出的名次
      mine.forEach((shop, position) => expect(shop.rank).toBeLessThanOrEqual((original[position] as { rank: number }).rank));
    }
  });

  it('写字楼区刚开通（老街三星，写字楼区一星）时，送往写字楼区的订单约一半来自老街的店：四成到六成', () => {
    const share = oldStreetShare(1);
    expect(share).toBeGreaterThanOrEqual(0.4);
    expect(share).toBeLessThanOrEqual(0.6);
  });

  it('写字楼区升星开了新店之后，过河单仍占三成以上，不会因为新店变热而消失', () => {
    for (const star of [2, 3, 4, 5]) expect(oldStreetShare(star), `office ${star} star`).toBeGreaterThanOrEqual(0.3);
  });
});

describe('地图 v1：候选屋顶', () => {
  it('每个片区 4 到 6 块，大小分小、中、大，三种都有', () => {
    for (const k of [0, 1, 2]) {
      const n = MAP_V1.roofs.filter((r) => r.district === k).length;
      expect(n).toBeGreaterThanOrEqual(4);
      expect(n).toBeLessThanOrEqual(6);
    }
    expect(new Set(MAP_V1.roofs.map((r) => r.size))).toEqual(new Set(['small', 'medium', 'large']));
  });

  it('价格系数在 0.7 到 1.3 之间，大屋顶和靠近片区中心的更贵', () => {
    const score = { small: 0, medium: 0.5, large: 1 };
    for (const r of MAP_V1.roofs) {
      expect(r.priceCoef).toBeGreaterThanOrEqual(0.7);
      expect(r.priceCoef).toBeLessThanOrEqual(1.3);
      const d = MAP_V1.districts[r.district] as { x0: number; x1: number; y0: number; y1: number };
      const center = { x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 };
      const half = dist({ x: d.x0, y: d.y0 }, center);
      const central = Math.max(0, 1 - dist(r, center) / half);
      expect(r.priceCoef).toBeCloseTo(0.7 + 0.6 * (0.5 * score[r.size] + 0.5 * central), 2);
    }
    // 同一片区里同样大小的屋顶，离中心近的更贵
    for (const k of [0, 1, 2]) {
      const d = MAP_V1.districts[k] as { x0: number; x1: number; y0: number; y1: number };
      const center = { x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 };
      const roofs = MAP_V1.roofs.filter((r) => r.district === k);
      for (const a of roofs) {
        for (const b of roofs) {
          if (a.size === b.size && dist(a, center) < dist(b, center) - 1) expect(a.priceCoef).toBeGreaterThanOrEqual(b.priceCoef);
        }
      }
    }
  });

  it('开局已建的屋顶只有一块：在老街，大小取中，离老街开局开张的店的质心不远', () => {
    const opening = MAP_V1.roofs.filter((r) => r.opening);
    expect(opening.length).toBe(1);
    const roof = opening[0] as (typeof MAP_V1.roofs)[number];
    expect(roof.district).toBe(0);
    expect(roof.size).toBe('medium');
    expect(MAP_V1.roofs[0]).toBe(roof); // 下标 0
    const early = MAP_V1.shops.filter((s) => s.district === 0 && s.opensAtStar === 1);
    const centroid = { x: early.reduce((a, s) => a + s.x, 0) / early.length, y: early.reduce((a, s) => a + s.y, 0) / early.length };
    expect(dist(roof, centroid)).toBeLessThan(60);
  });

  it('每个片区的第一块屋顶在该片区开局开张的店的质心附近', () => {
    for (const k of [1, 2]) {
      const early = MAP_V1.shops.filter((s) => s.district === k && s.opensAtStar === 1);
      const centroid = { x: early.reduce((a, s) => a + s.x, 0) / early.length, y: early.reduce((a, s) => a + s.y, 0) / early.length };
      const first = MAP_V1.roofs.find((r) => r.district === k) as Point;
      expect(dist(first, centroid)).toBeLessThan(100);
    }
  });
});

describe('地图 v1：河', () => {
  it('一条折线，从上边缘到右边缘，经过老街和写字楼区之间，离所有店、楼、屋顶不小于 50', () => {
    const line = MAP_V1.river;
    expect(line.length).toBeGreaterThanOrEqual(3);
    expect((line[0] as Point).y).toBe(0);
    expect((line[line.length - 1] as Point).x).toBe(MAP_V1.width);
    const old = MAP_V1.districts[0] as { x1: number };
    const office = MAP_V1.districts[1] as { x0: number };
    // 在老街和写字楼区都有的纵向范围内，河在两个矩形之间
    for (const y of [250, 400, 600, 800]) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i] as Point;
        const b = line[i + 1] as Point;
        if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) {
          const x = a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
          expect(x, `y=${y}`).toBeGreaterThan(old.x1);
          expect(x, `y=${y}`).toBeLessThan(office.x0);
          break;
        }
      }
    }
    const farFrom = (p: Point): number => {
      let best = Infinity;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i] as Point;
        const b = line[i + 1] as Point;
        const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
        best = Math.min(best, dist(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }));
      }
      return best;
    };
    for (const p of [...MAP_V1.shops, ...MAP_V1.buildings, ...MAP_V1.roofs]) expect(farFrom(p)).toBeGreaterThanOrEqual(50);
  });
});

describe('地图 v1：生成脚本', () => {
  it('重新生成得到逐字节相同的文件', () => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/content/make_map_v1.ts', '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('经营模式的 World 由地图 v1 做成：店和楼与内容表一一对应，热度权重与沙盒的算法相同', () => {
    const world = buildCampaignWorld();
    expect(world.merchants.length).toBe(28);
    expect(world.buildings.length).toBe(42);
    expect(world.buildingsByDistrict.map((l) => l.length)).toEqual([20, 10, 12]);
    expect(world.merchants.map((m) => m.rank)).toEqual(MAP_V1.shops.map((s) => s.rank));
    // 名次合起来是 1 到 28，权重只由名次算出，所以与沙盒里同一名次的店的权重逐位相同（哪个片区的店不要紧）
    const sandbox = buildWorld('threeDistricts', 17);
    for (const m of world.merchants) {
      const same = sandbox.merchants.find((s) => s.rank === m.rank) as { weight: number };
      expect(m.weight).toBe(same.weight);
    }
    expect(world.digest).not.toBe('');
    expect(createState({ mode: 'campaign' }).world.digest).toBe(world.digest);
  });
});

describe('价格表', () => {
  it('参数：价格表，其中校准过的五个数是飞机和停机位的基础价、第 2 和第 4 座站的基准价、写字楼区的开通价', () => {
    const e = ECONOMY_V1;
    expect(e.startMoney).toBe(0);
    expect([e.droneBase, e.droneGrowth, e.bayBase, e.bayGrowth]).toEqual([100, 1.14, 140, 1.17]);
    expect(e.stationBase).toEqual([330, 1400, 2800]);
    expect(e.maxStations).toBe(4);
    expect(e.gateSeconds).toEqual([1.2, 0.8, 0.4]);
    expect(e.gatePrice).toEqual([0, 240, 900]);
    expect(e.bayCap).toEqual({ small: 6, medium: 9, large: 12 });
    expect([e.doubleBoxPrice, e.doubleBoxCapacity]).toEqual([180, 2]);
    expect([e.nearestLandingPrice, e.nearestLandingMinStations]).toEqual([300, 2]);
    expect(e.districtOpenPrice).toEqual([0, 200, 1600]);
    expect(e.districtOpenStars).toBe(3);
    expect(e.openingDrones).toBe(2);
    expect(e.baysAtBuild).toBe(2);
  });
});

describe('各片区的订单规律', () => {
  it('基础来单率：老街 11，写字楼区 40，大学城 18（前两个校准过），星级倍数是 1.25 的 0 到 4 次方', () => {
    expect(DISTRICT_RATES_V1.map((d) => d.baseRate)).toEqual([11, 40, 18]);
    expect(STAR_MULTIPLIER_V1).toEqual([1, 1.25, 1.5625, 1.953125, 2.44140625]);
    // 每升一星乘 1.25，掉一星除以 1.25，与日结文案「多两成半」「少两成」一致
    STAR_MULTIPLIER_V1.forEach((m, i) => {
      if (i > 0) expect(m).toBe((STAR_MULTIPLIER_V1[i - 1] as number) * 1.25);
    });
    expect(DISTRICT_RATES_V1.map((d) => d.id)).toEqual(MAP_V1.districts.map((d) => d.id));
  });

  it('曲线的控制点：秒数从 0 到 360 递增，来单率为正，每个片区的曲线在高峰处取 1', () => {
    for (const d of DISTRICT_RATES_V1) {
      expect(d.curveSeconds.length).toBe(d.curveRate.length);
      expect(d.curveSeconds[0]).toBe(0);
      expect(d.curveSeconds[d.curveSeconds.length - 1]).toBe(360);
      expect(d.curveSeconds).toEqual([...d.curveSeconds].sort((a, b) => a - b));
      for (const r of d.curveRate) expect(r).toBeGreaterThan(0);
      expect(Math.max(...d.curveRate)).toBe(1);
    }
  });

  it('老街沿用沙盒里的双峰曲线：每一步的相对来单率都相同', () => {
    for (let tick = 0; tick < 3600; tick += 1) {
      expect(districtLambda(0, tick, 1)).toBe((((DISTRICT_RATES_V1[0] as { baseRate: number }).baseRate / 60) * (ARRIVAL_CURVE[tick] as number) * 1) * 0.1);
    }
  });

  it('写字楼区午高峰高、晚间低，大学城晚高峰和夜间高、午间低', () => {
    const at = (district: number, second: number): number => districtLambda(district, second * 10, 1) / 0.1 / ((DISTRICT_RATES_V1[district] as { baseRate: number }).baseRate / 60);
    // 午高峰第 75 到 120 秒，晚高峰第 232 到 283 秒，夜间第 330 秒
    expect(at(1, 100)).toBeCloseTo(1, 9);
    expect(at(1, 260)).toBeLessThan(0.4);
    expect(at(1, 330)).toBeLessThan(0.15);
    expect(at(2, 260)).toBeCloseTo(1, 9);
    expect(at(2, 100)).toBeLessThan(0.4);
    expect(at(2, 330)).toBeGreaterThan(0.6);
    // 与老街相比：写字楼区午间最高，大学城晚间最高
    const peaks = DISTRICT_RATES_V1.map((d) => d.curveSeconds[d.curveRate.indexOf(1)] as number);
    expect(peaks[1]).toBeGreaterThanOrEqual(75);
    expect(peaks[1]).toBeLessThanOrEqual(120);
    expect(peaks[2]).toBeGreaterThanOrEqual(232);
    expect(peaks[2]).toBeLessThanOrEqual(283);
  });

  it('每步的来单率 = 基础来单率 / 60 × 曲线 × 星级倍数 × 每步秒数', () => {
    expect(districtLambda(0, 900, 1)).toBeCloseTo((11 / 60) * 1 * 1 * 0.1, 12);
    expect(districtLambda(0, 900, 3)).toBeCloseTo((11 / 60) * 1 * 1.5625 * 0.1, 12);
    expect(districtLambda(1, 900, 5)).toBeCloseTo((40 / 60) * 1 * 2.44140625 * 0.1, 12);
    expect(districtLambda(2, 2600, 2)).toBeCloseTo((18 / 60) * 1 * 1.25 * 0.1, 12);
  });
});

describe('开局的五张订单', () => {
  it('五张：第一张在开局时来自老街最热的店，其余四张在第 10 到 50 秒之间依次出现', () => {
    expect(OPENING_ORDERS_V1.length).toBe(5);
    expect(OPENING_ORDERS_V1[0]?.step).toBeLessThanOrEqual(10);
    const rest = OPENING_ORDERS_V1.slice(1).map((o) => o.step);
    for (const step of rest) {
      expect(step).toBeGreaterThanOrEqual(100);
      expect(step).toBeLessThanOrEqual(500);
    }
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
  });

  it('其中两张几乎同时出现，相差不超过 1 秒', () => {
    const steps = OPENING_ORDERS_V1.map((o) => o.step);
    const gaps = steps.slice(1).map((s, i) => s - (steps[i] as number));
    expect(gaps.filter((g) => g <= 10).length).toBe(1);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
  });

  it('都是普通单，楼是离店较近的老街住宅，出餐 4 到 10 秒，店和楼各不相同', () => {
    for (const o of OPENING_ORDERS_V1) {
      const shop = MAP_V1.shops[o.merchant] as { district: number; opensAtStar: number; x: number; y: number };
      const building = MAP_V1.buildings[o.building] as { district: number; kind: string; x: number; y: number };
      expect(o.portion).toBe(1);
      expect(shop.district).toBe(0);
      expect(shop.opensAtStar).toBe(1); // 开局开张的店
      expect(building.district).toBe(0);
      expect(building.kind).toBe('residence');
      expect(dist(shop, building)).toBeLessThanOrEqual(300);
      expect(o.prepSteps).toBeGreaterThanOrEqual(40);
      expect(o.prepSteps).toBeLessThanOrEqual(100);
    }
    expect(new Set(OPENING_ORDERS_V1.map((o) => o.merchant)).size).toBe(5);
    expect(new Set(OPENING_ORDERS_V1.map((o) => o.building)).size).toBe(5);
  });
});

describe('内容表的版本号', () => {
  it('是正整数，写进经营模式的状态', () => {
    expect(Number.isInteger(CONTENT_VERSION)).toBe(true);
    expect(CONTENT_VERSION).toBeGreaterThanOrEqual(1);
    expect(MAP_V1.version).toBe(CONTENT_VERSION);
    expect(createState({ mode: 'campaign' }).campaign?.contentVersion).toBe(CONTENT_VERSION);
  });
});

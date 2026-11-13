import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  buildWorld,
  createRng,
  createState,
  makeConfig,
  nextFloat,
  nextInt,
  planStations,
  poisson,
} from '../src/core/index.ts';
import type { RngState, World } from '../src/core/index.ts';
import { detExp, detLn } from '../src/core/detmath.ts';
import { shuffleInPlace, nextU32 } from '../src/core/rng.ts';
import { MAP_HEIGHT, MAP_WIDTH, MIN_GAP, dist } from '../src/core/world.ts';

const DISTRICTS = [
  { name: 'oldStreet', x0: 100, x1: 1100, y0: 200, y1: 1100, shops: 14, buildings: 20 },
  { name: 'office', x0: 1400, x1: 2300, y0: 150, y1: 900, shops: 6, buildings: 10 },
  { name: 'campus', x0: 900, x1: 2100, y0: 1150, y1: 1700, shops: 8, buildings: 12 },
] as const;

describe('地图', () => {
  const world = buildWorld('threeDistricts', 7);

  it('三个片区：店和楼的数量、范围和最小间距', () => {
    expect(world.merchants.length).toBe(28);
    expect(world.buildings.length).toBe(42);
    DISTRICTS.forEach((d, k) => {
      const shops = world.merchants.filter((m) => m.district === k);
      const homes = world.buildings.filter((b) => b.district === k);
      expect(shops.length).toBe(d.shops);
      expect(homes.length).toBe(d.buildings);
      for (const p of [...shops, ...homes]) {
        expect(p.x).toBeGreaterThanOrEqual(d.x0);
        expect(p.x).toBeLessThanOrEqual(d.x1);
        expect(p.y).toBeGreaterThanOrEqual(d.y0);
        expect(p.y).toBeLessThanOrEqual(d.y1);
      }
    });
    const points = [...world.merchants, ...world.buildings];
    let closest = Infinity;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const p = points[i] as { x: number; y: number };
        const q = points[j] as { x: number; y: number };
        closest = Math.min(closest, dist(p.x, p.y, q.x, q.y));
      }
    }
    expect(closest).toBeGreaterThanOrEqual(MIN_GAP);
    expect(world.width).toBe(MAP_WIDTH);
    expect(world.height).toBe(MAP_HEIGHT);
  });

  it('店铺热度名次是 1 到 28 的一个排列，权重是名次的 -0.9 次方', () => {
    expect(world.merchants.map((m) => m.rank).sort((a, b) => a - b)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    for (const m of world.merchants) expect(m.weight).toBeCloseTo(Math.pow(m.rank, -0.9), 12);
  });

  it('同一个地图种子得到同一张地图，不同的种子得到不同的地图', () => {
    expect(buildWorld('threeDistricts', 7)).toEqual(world);
    expect(buildWorld('threeDistricts', 8).digest).not.toBe(world.digest);
  });

  it('只有老街：取三片区地图里的老街，名次在老街内重排', () => {
    const old = buildWorld('oldStreet', 7);
    expect(old.merchants.length).toBe(14);
    expect(old.buildings.length).toBe(20);
    expect(old.merchants.map((m) => [m.x, m.y])).toEqual(world.merchants.slice(0, 14).map((m) => [m.x, m.y]));
    expect(old.buildings.map((b) => [b.x, b.y])).toEqual(world.buildings.slice(0, 20).map((b) => [b.x, b.y]));
    expect(old.merchants.map((m) => m.rank).sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    // 重排前后的相对次序不变
    const order = (w: World): number[] => w.merchants.map((_, i) => i).sort((a, b) => (w.merchants[a]?.rank ?? 0) - (w.merchants[b]?.rank ?? 0));
    expect(order(old)).toEqual(order({ ...world, merchants: world.merchants.slice(0, 14) } as World));
    expect(old.buildingsByDistrict.map((l) => l.length)).toEqual([20, 0, 0]);
  });

  it('写字楼区只保留最热的两家店，其余点位不变', () => {
    const sparse = buildWorld('sparseOffice', 7);
    const office = world.merchants.filter((m) => m.district === 1).sort((a, b) => a.rank - b.rank);
    const kept = sparse.merchants.filter((m) => m.district === 1);
    expect(kept.length).toBe(2);
    expect(kept.map((m) => [m.x, m.y]).sort()).toEqual(office.slice(0, 2).map((m) => [m.x, m.y]).sort());
    expect(sparse.merchants.length).toBe(24);
    expect(sparse.buildings).toEqual(world.buildings);
    for (const k of [0, 2]) {
      expect(sparse.merchants.filter((m) => m.district === k)).toEqual(world.merchants.filter((m) => m.district === k));
    }
  });

  it('抽店的累计权重：热度 × exp(-距离/尺度) × 同片区翻倍；送往写字楼区的订单在稀疏场景里尺度放宽到 1400', () => {
    for (const [scenario, w] of [['threeDistricts', world], ['sparseOffice', buildWorld('sparseOffice', 7)]] as const) {
      w.buildings.forEach((b, i) => {
        const scale = scenario === 'sparseOffice' && b.district === 1 ? 1400 : 700;
        const cum = w.cumWeights[i] as number[];
        let previous = 0;
        w.merchants.forEach((m, j) => {
          const expected = Math.pow(m.rank, -0.9) * Math.exp(-dist(m.x, m.y, b.x, b.y) / scale) * (m.district === b.district ? 2 : 1);
          const got = (cum[j] as number) - previous;
          expect(got / expected).toBeCloseTo(1, 9);
          previous = cum[j] as number;
        });
      });
    }
  });
});

describe('站点布局', () => {
  const plan = (layout: 'default' | 'single' | 'three' | 'edge', extra: Partial<typeof DEFAULT_CONFIG> = {}) => {
    const config = makeConfig({ scenario: 'threeDistricts', layout, drones: 16, ...extra });
    const w = buildWorld(config.scenario, config.mapSeed);
    return { w, plans: planStations(w, config) };
  };
  const centroid = (points: { x: number; y: number }[]): [number, number] => [
    points.reduce((a, p) => a + p.x, 0) / points.length,
    points.reduce((a, p) => a + p.y, 0) / points.length,
  ];

  it('默认两座站：一座在老街店铺的质心，一座在写字楼区和大学城两个矩形中心的中点，飞机平分', () => {
    const { w, plans } = plan('default');
    expect(plans.length).toBe(2);
    const [cx, cy] = centroid(w.merchants.filter((m) => m.district === 0));
    expect(plans[0]?.x).toBeCloseTo(cx, 9);
    expect(plans[0]?.y).toBeCloseTo(cy, 9);
    expect([plans[1]?.x, plans[1]?.y]).toEqual([1675, 975]);
    expect(plans.map((p) => p.drones)).toEqual([8, 8]);
    expect(plans.map((p) => p.bays)).toEqual([8, 8]);
  });

  it('一座大站：全部飞机在一座站里', () => {
    const { w, plans } = plan('single');
    expect(plans.length).toBe(1);
    const [cx, cy] = centroid(w.merchants);
    expect([plans[0]?.x, plans[0]?.y]).toEqual([cx, cy]);
    expect(plans[0]?.drones).toBe(16);
    expect(plans[0]?.bays).toBe(16);
  });

  it('三座站：各片区店铺的质心，飞机尽量平分，前面的站多一架', () => {
    const { w, plans } = plan('three');
    expect(plans.map((p) => p.drones)).toEqual([6, 5, 5]);
    [0, 1, 2].forEach((k) => {
      const [cx, cy] = centroid(w.merchants.filter((m) => m.district === k));
      expect(plans[k]?.x).toBeCloseTo(cx, 9);
      expect(plans[k]?.y).toBeCloseTo(cy, 9);
    });
  });

  it('两座站各向外移：沿远离地图中心的方向平移 400，不超出地图', () => {
    const base = plan('default').plans;
    const edge = plan('edge').plans;
    base.forEach((p, i) => {
      const e = edge[i] as { x: number; y: number };
      expect(dist(p.x, p.y, e.x, e.y)).toBeCloseTo(400, 6);
      expect(dist(e.x, e.y, 1200, 900)).toBeGreaterThan(dist(p.x, p.y, 1200, 900));
      expect(e.x).toBeGreaterThanOrEqual(0);
      expect(e.x).toBeLessThanOrEqual(MAP_WIDTH);
      expect(e.y).toBeGreaterThanOrEqual(0);
      expect(e.y).toBeLessThanOrEqual(MAP_HEIGHT);
    });
  });

  it('每座站的停机位是开局飞机数加上额外的停机位', () => {
    const { plans } = plan('default', { extraBays: 3 });
    expect(plans.map((p) => [p.drones, p.bays])).toEqual([[8, 11], [8, 11]]);
    expect(plan('single', { drones: 7 }).plans[0]?.bays).toBe(7);
    expect(plan('three', { drones: 7 }).plans.map((p) => p.drones)).toEqual([3, 2, 2]);
  });

  it('只有老街的场景只有一座站，其他布局报错', () => {
    const state = createState({ scenario: 'oldStreet', drones: 2 });
    expect(state.stations.length).toBe(1);
    expect(state.drones.map((d) => d.home)).toEqual([0, 0]);
    expect(() => createState({ scenario: 'oldStreet', layout: 'three' })).toThrow();
    expect(() => createState({ scenario: 'oldStreet', layout: 'edge' })).toThrow();
  });

  it('开局状态：飞机满电停在自己的站上，停机位按飞机数占用', () => {
    const state = createState({ scenario: 'threeDistricts', layout: 'three', drones: 15 });
    expect(state.stations.map((s) => s.occupied)).toEqual([5, 5, 5]);
    for (const d of state.drones) {
      const s = state.stations[d.home];
      expect([d.x, d.y]).toEqual([s?.x, s?.y]);
      expect(d.battery).toBe(7000);
      expect(d.state).toBe(0);
    }
    expect(state.drones.map((d) => d.id)).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });
});

describe('随机数', () => {
  it('相同的种子得到相同的序列，不同的种子得到不同的序列', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const xs = Array.from({ length: 50 }, () => nextU32(a));
    expect(Array.from({ length: 50 }, () => nextU32(b))).toEqual(xs);
    expect(Array.from({ length: 50 }, () => nextU32(c))).not.toEqual(xs);
  });

  it('序列固定：种子 42 的前三个数（改动算法会改变所有地图和订单，需要有意为之）', () => {
    const r = createRng(42);
    expect([nextU32(r), nextU32(r), nextU32(r)]).toEqual([890322987, 2796912455, 4258306155]);
  });

  it('小数落在 [0, 1)，均值约 0.5，十个等宽区间的计数大致相同', () => {
    const r = createRng(7);
    const counts = new Array<number>(10).fill(0);
    let sum = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const x = nextFloat(r);
      expect(x >= 0 && x < 1).toBe(true);
      sum += x;
      counts[Math.floor(x * 10)] = (counts[Math.floor(x * 10)] as number) + 1;
    }
    expect(sum / n).toBeGreaterThan(0.495);
    expect(sum / n).toBeLessThan(0.505);
    for (const c of counts) expect(Math.abs(c - n / 10)).toBeLessThan(0.03 * (n / 10));
  });

  it('状态是普通对象，存下再读回后序列接着走', () => {
    const r = createRng(9);
    for (let i = 0; i < 10; i++) nextU32(r);
    const saved = JSON.parse(JSON.stringify(r)) as RngState;
    expect(Array.from({ length: 20 }, () => nextU32(saved))).toEqual(Array.from({ length: 20 }, () => nextU32(r)));
  });

  it('整数、洗牌和泊松分布', () => {
    const r = createRng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(nextInt(r, 7));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const deck = Array.from({ length: 30 }, (_, i) => i);
    shuffleInPlace(createRng(3), deck);
    expect([...deck].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(deck).not.toEqual(Array.from({ length: 30 }, (_, i) => i));
    const again = Array.from({ length: 30 }, (_, i) => i);
    shuffleInPlace(createRng(3), again);
    expect(again).toEqual(deck);

    for (const lambda of [0.02, 0.1, 1.5]) {
      const p = createRng(5);
      const xs = Array.from({ length: 100000 }, () => poisson(p, lambda));
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
      expect(Math.abs(mean - lambda) / lambda).toBeLessThan(0.05);
      expect(Math.abs(variance - lambda) / lambda).toBeLessThan(0.1);
    }
    const idle = createRng(5);
    const before = { ...idle };
    expect(poisson(idle, 0)).toBe(0);
    expect(idle).toEqual(before); // 来单率为零时不消耗随机数
  });
});

describe('只用四则运算的 exp 和 ln', () => {
  it('与 Math.exp、Math.log 在 1e-12 内一致', () => {
    for (let x = -20; x <= 5; x += 0.37) {
      const got = detExp(x);
      expect(Math.abs(got - Math.exp(x)) / Math.exp(x)).toBeLessThan(1e-12);
    }
    for (const x of [1e-3, 0.02, 0.5, 0.75, 1, 1.4999, 1.5, 2, 28, 700, 1e4]) {
      expect(Math.abs(detLn(x) - Math.log(x))).toBeLessThan(1e-12);
      expect(Math.abs(detExp(detLn(x)) / x - 1)).toBeLessThan(1e-12);
    }
    expect(detExp(0)).toBe(1);
    expect(detLn(1)).toBe(0);
    expect(() => detLn(0)).toThrow();
  });
});

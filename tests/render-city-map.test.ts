// 城市生成在任意种子下不出现屋顶相压：整张地图（map_v1）的 300 个种子。
// 检查的是候选屋顶、站点屋顶、楼的屋顶、店的屋顶和街区里的普通屋顶，两两互不相压，也不压在水面和街上，
// 沿用已有测试的判定：树不种在河里，街区的中心不在河里。每个店、楼、候选屋顶各有一块屋顶，候选屋顶不挪不缩。
// 另外记下当前种子在老街画面区域上的输出，生成器的改动不能让它变。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { generateCity } from '../src/render/city.ts';
import type { Rect } from '../src/render/geometry.ts';
import { citySpecFromMap, planBoard } from '../src/render/map-spec.ts';
import { createRand, range } from '../src/render/rng.ts';
import { cleanSweep, hashes, overlappingPairs, segmentToRect, sweepSeeds, wholeMapPlan } from './render-city-helpers.ts';

/** 放停机坪标记的位置。 */
const HELIPAD = { x: 1620, y: 230 };
const SEEDS = 300;
const CHUNK = 50;

describe('当前种子的输出不变', () => {
  // 当前种子 17 × 7919 + 2 的城市输出，整体一个哈希，各个部分各一个。画板对准老街的中心。
  // 生成器只在出现相压时才改动布局，这个种子在这块区域上没有相压，所以输出要和这里记的完全相同
  const SLICE = {
    whole: 'bdd0d920ac9a2bec',
    parts: {
      seed: 'ec5be6aa281d96b2',
      region: '4d5675c7b3a1f0bf',
      streets: '3144ebd9235c535b',
      blocks: '9931affa17866987',
      buildings: 'c7dd2b09049b9ff3',
      trees: 'f0ca4b62b7740b08',
      yards: 'dea0ae6015d9d362',
      bridges: '9cc7775b662f16f1',
      labels: '96b2dca00698ab17',
      river: '5866a8072b1b9336',
      shops: 'fe11e9390e7d22a4',
      stations: '911b2a69aa0c37df',
    },
  };
  const WIDER = {
    whole: '832b0bbf20f78350',
    parts: {
      seed: 'ec5be6aa281d96b2',
      region: '4a42b6c38b7cba1d',
      streets: '54c73c1b704a475c',
      blocks: '29dd9db38df00da7',
      buildings: 'f15e8da9ac3a4e13',
      trees: 'ba8884e353bff220',
      yards: '54982eb138a2612b',
      bridges: 'de37923810994656',
      labels: 'aaeda81537ef467b',
      river: '5866a8072b1b9336',
      shops: '302ee79603e77b9a',
      stations: '85a120d645fc2ec5',
    },
  };

  it('老街的画面区域：种子 134625 的城市逐部分相同', () => {
    const spec = citySpecFromMap(MAP_V1, planBoard({ x: 600, y: 650 }, 1920, 1080).region, HELIPAD);
    expect(spec.seed).toBe(17 * 7919 + 2);
    const got = hashes(generateCity(spec));
    expect(got.parts).toEqual(SLICE.parts);
    expect(got.whole).toBe(SLICE.whole);
  });

  it('画面区域更宽一圈：同一个种子的城市逐部分相同', () => {
    const spec = citySpecFromMap(MAP_V1, planBoard({ x: 600, y: 650 }, 2400, 1300).region);
    expect(spec.seed).toBe(17 * 7919 + 2);
    const got = hashes(generateCity(spec));
    expect(got.parts).toEqual(WIDER.parts);
    expect(got.whole).toBe(WIDER.whole);
  });
});

describe('检查函数自己的核对', () => {
  it('矩形到线段的距离：与沿线段逐点取样的结果一致', () => {
    const rand = createRand(20261113);
    for (let k = 0; k < 400; k++) {
      const r: Rect = { x: range(rand, -50, 50), y: range(rand, -50, 50), w: range(rand, 5, 80), h: range(rand, 5, 80) };
      const a = { x: range(rand, -150, 150), y: range(rand, -150, 150) };
      const b = { x: range(rand, -150, 150), y: range(rand, -150, 150) };
      let sampled = Infinity;
      const n = 4000;
      for (let i = 0; i <= n; i++) {
        const px = a.x + ((b.x - a.x) * i) / n;
        const py = a.y + ((b.y - a.y) * i) / n;
        const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
        const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
        sampled = Math.min(sampled, Math.sqrt(dx * dx + dy * dy));
      }
      const exact = segmentToRect(a, b, r);
      // 取样的最小值不会比真值小，线段不长于 450，取样间隔不到 0.12，所以差不会超过 0.06
      expect(exact).toBeLessThanOrEqual(sampled + 1e-9);
      expect(sampled - exact).toBeLessThan(0.06);
    }
  });

  it('相压的矩形对：扫描法与两两比较的结果一致，擦边不算', () => {
    const rand = createRand(77);
    const rects: Rect[] = [];
    for (let k = 0; k < 150; k++) rects.push({ x: Math.round(range(rand, 0, 300)), y: Math.round(range(rand, 0, 300)), w: Math.round(range(rand, 10, 60)), h: Math.round(range(rand, 10, 60)) });
    const brute: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i] as Rect;
        const b = rects[j] as Rect;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) brute.push(`${i},${j}`);
      }
    }
    const swept = overlappingPairs(rects).map(([i, j]) => `${Math.min(i, j)},${Math.max(i, j)}`);
    expect(swept.sort()).toEqual(brute.sort());
    expect(overlappingPairs([{ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }])).toEqual([]);
  });
});

describe('整张地图，300 个种子', () => {
  const plan = wholeMapPlan(MAP_V1);

  it('画面区域盖住整张地图', () => {
    expect(plan.region.x).toBeLessThan(0);
    expect(plan.region.y).toBeLessThan(0);
    expect(plan.region.x + plan.region.w).toBeGreaterThan(MAP_V1.width);
    expect(plan.region.y + plan.region.h).toBeGreaterThan(MAP_V1.height);
  });

  for (let from = 0; from < SEEDS; from += CHUNK) {
    it(`种子偏移 ${from} 到 ${from + CHUNK - 1}：屋顶互不相压，不压河和街，保留的屋顶齐全`, () => {
      expect(sweepSeeds(MAP_V1, plan, from, from + CHUNK, HELIPAD)).toEqual(cleanSweep(CHUNK));
    });
  }
});

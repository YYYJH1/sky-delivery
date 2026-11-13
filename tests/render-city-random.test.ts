// 城市生成在任意种子、任意地图规格下不出现屋顶相压：三张按固定种子造出来的随机地图，各跑 100 个种子。
// 地图规格里片区的位置和大小、河的走向、店和楼和候选屋顶的位置都和真实地图不同，河有时穿过片区。
// 检查的内容和 render-city-map.test.ts 一样。
import { describe, expect, it } from 'vitest';
import { RIVER_HALF_WIDTH, STATION_SIZES } from '../src/render/city.ts';
import { dist, overlaps } from '../src/render/geometry.ts';
import type { Rect } from '../src/render/geometry.ts';
import { makeRiver, riverDistance } from '../src/render/river.ts';
import { cleanSweep, distanceToRiver, randomMap, sweepSeeds, wholeMapPlan } from './render-city-helpers.ts';

const MAP_SEEDS = [101, 202, 303] as const;
const SEEDS = 100;
const CHUNK = 50;

describe.each(MAP_SEEDS)('随机地图 %i', (mapSeed) => {
  const map = randomMap(mapSeed);
  const plan = wholeMapPlan(map);

  it('规格本身：片区互不相压，点位的间距、离河的距离和候选屋顶的余量都守策略', () => {
    expect(map.districts.length).toBe(3);
    const rects = map.districts.map((d) => ({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i] as Rect, rects[j] as Rect)).toBe(false);
    expect(map.shops.length).toBeGreaterThanOrEqual(15);
    expect(map.buildings.length).toBeGreaterThanOrEqual(25);
    expect(map.roofs.length).toBeGreaterThanOrEqual(12);
    const river = makeRiver(map.river, RIVER_HALF_WIDTH);
    const points = [...map.shops, ...map.buildings, ...map.roofs];
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as { x: number; y: number };
      expect(riverDistance(river, p.x, p.y)).toBeGreaterThanOrEqual(50);
      for (let j = i + 1; j < points.length; j++) {
        const q = points[j] as { x: number; y: number };
        expect(dist(p.x, p.y, q.x, q.y)).toBeGreaterThanOrEqual(60);
      }
    }
    for (let i = 0; i < map.roofs.length; i++) {
      const a = map.roofs[i] as (typeof map.roofs)[number];
      const [aw, ah] = STATION_SIZES[a.size];
      expect(distanceToRiver(river, { x: a.x - aw / 2, y: a.y - ah / 2, w: aw, h: ah }, RIVER_HALF_WIDTH + 12)).toBeGreaterThanOrEqual(RIVER_HALF_WIDTH + 12);
      for (let j = i + 1; j < map.roofs.length; j++) {
        const b = map.roofs[j] as (typeof map.roofs)[number];
        const [bw, bh] = STATION_SIZES[b.size];
        const gap = Math.max(Math.abs(a.x - b.x) - (aw + bw) / 2, Math.abs(a.y - b.y) - (ah + bh) / 2);
        expect(gap).toBeGreaterThanOrEqual(30);
      }
    }
  });

  for (let from = 0; from < SEEDS; from += CHUNK) {
    it(`种子偏移 ${from} 到 ${from + CHUNK - 1}：屋顶互不相压，不压河和街，保留的屋顶齐全`, () => {
      expect(sweepSeeds(map, plan, from, from + CHUNK)).toEqual(cleanSweep(CHUNK));
    });
  }
});

// 河的距离计算：probeRiver 只看离区域够近的河段，结果要和逐点问整条河的 isWet 一样。
// rectRiverDistance 量矩形到河道中心线的距离，要和检查函数里另一种算法一致。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { RIVER_HALF_WIDTH } from '../src/render/city.ts';
import type { Rect } from '../src/render/geometry.ts';
import { isWet, makeRiver, probeRiver, rectRiverDistance } from '../src/render/river.ts';
import { createRand, range } from '../src/render/rng.ts';
import { distanceToRiver } from './render-city-helpers.ts';

describe('河的距离计算', () => {
  const river = makeRiver(MAP_V1.river, RIVER_HALF_WIDTH);

  it('probeRiver 在区域里与 isWet 逐点相同，边距取负数、零和正数都一样', () => {
    const rand = createRand(5);
    let mismatches = 0;
    let wet = 0;
    for (let k = 0; k < 60; k++) {
      const area: Rect = { x: range(rand, 900, 1600), y: range(rand, 0, 1100), w: range(rand, 20, 400), h: range(rand, 20, 400) };
      const probe = probeRiver(river, area, 20);
      for (let i = 0; i < 200; i++) {
        const x = range(rand, area.x, area.x + area.w);
        const y = range(rand, area.y, area.y + area.h);
        for (const margin of [-10, 0, 12, 20]) {
          const expected = isWet(river, x, y, margin);
          if (expected) wet++;
          if (probe.wet(x, y, margin) !== expected) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
    // 取的点有一部分真的在河里，比较才有意义
    expect(wet).toBeGreaterThan(1000);
  });

  it('rectRiverDistance 与检查函数里另一种算法一致，probeRiver 的 rectDistance 在关心的范围里也一样', () => {
    const rand = createRand(9);
    let compared = 0;
    for (let k = 0; k < 300; k++) {
      const rect: Rect = { x: range(rand, 900, 1700), y: range(rand, 0, 1100), w: range(rand, 10, 140), h: range(rand, 10, 120) };
      const exact = distanceToRiver(river, rect);
      expect(Math.abs(rectRiverDistance(river, rect) - exact)).toBeLessThan(1e-9);
      const probe = probeRiver(river, rect, 20);
      const reach = RIVER_HALF_WIDTH + 20;
      if (exact < reach) {
        expect(Math.abs(probe.rectDistance(rect) - exact)).toBeLessThan(1e-9);
        compared++;
      } else {
        expect(probe.rectDistance(rect)).toBeGreaterThanOrEqual(reach);
      }
    }
    expect(compared).toBeGreaterThan(50);
  });
});

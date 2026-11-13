// 片区：整张地图的城市怎样分给三个片区，每个片区烘焙成自己的一层，没显示、淡画、开通三种样子。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { generateCity } from '../src/render/city.ts';
import type { City } from '../src/render/city-types.ts';
import { DISTRICT_MARGIN, FADED_ALPHA, FADE_SECONDS, approachAlpha, assignDistricts, cityOfDistrict, districtOfPoint, modeAlpha, modeOf, riverCity } from '../src/render/districts.ts';
import type { Rect } from '../src/render/geometry.ts';
import { HELIPAD_NEAR, citySpecFromMap, planMapBoard } from '../src/render/map-spec.ts';

const DISTRICTS: Rect[] = MAP_V1.districts.map((d) => ({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 }));
const PLAN = planMapBoard(DISTRICTS);
const CITY: City = generateCity(citySpecFromMap(MAP_V1, PLAN.region, HELIPAD_NEAR));
const MEMBERSHIP = assignDistricts(CITY, DISTRICTS);

describe('点属于哪个片区', () => {
  it('在片区外框里的点属于这个片区', () => {
    expect(districtOfPoint(DISTRICTS, 600, 650)).toBe(0);
    expect(districtOfPoint(DISTRICTS, 1800, 500)).toBe(1);
    expect(districtOfPoint(DISTRICTS, 1500, 1400)).toBe(2);
  });

  it('外框外面不超过余量的点属于离它最近的片区，超过了不属于任何片区', () => {
    expect(districtOfPoint(DISTRICTS, 1100 + DISTRICT_MARGIN - 1, 650)).toBe(0);
    expect(districtOfPoint(DISTRICTS, 1100 + DISTRICT_MARGIN + 20, 650)).toBe(-1);
    // 老街和写字楼区之间的河上
    expect(districtOfPoint(DISTRICTS, 1250, 650)).toBe(-1);
    // 画板的角上
    expect(districtOfPoint(DISTRICTS, 50, 1700)).toBe(-1);
  });

  it('余量可以另给', () => {
    expect(districtOfPoint(DISTRICTS, 1250, 650, 200)).toBe(0);
    expect(districtOfPoint(DISTRICTS, 1100 + 5, 650, 0)).toBe(-1);
  });

  it('没有片区时不属于任何一个', () => {
    expect(districtOfPoint([], 0, 0)).toBe(-1);
  });
});

describe('三种样子', () => {
  it('开通了就是开通，不管有没有显示：开通的片区里有店在营业，一定要画', () => {
    expect(modeOf({ shown: true, open: true })).toBe('open');
    expect(modeOf({ shown: false, open: true })).toBe('open');
  });

  it('显示了没开通的淡画，没显示的不画', () => {
    expect(modeOf({ shown: true, open: false })).toBe('faded');
    expect(modeOf({ shown: false, open: false })).toBe('hidden');
  });

  it('整层的不透明度：开通 1，淡画 FADED_ALPHA，没显示 0', () => {
    expect(modeAlpha('open')).toBe(1);
    expect(modeAlpha('faded')).toBe(FADED_ALPHA);
    expect(modeAlpha('hidden')).toBe(0);
    expect(FADED_ALPHA).toBeGreaterThan(0.2);
    expect(FADED_ALPHA).toBeLessThan(0.6);
  });
});

describe('片区显示状态变了，不透明度渐变', () => {
  it('匀速：走完 0 到 1 要 FADE_SECONDS，朝哪个方向都一样', () => {
    expect(FADE_SECONDS).toBeGreaterThan(0.5);
    expect(FADE_SECONDS).toBeLessThan(1.2);
    expect(approachAlpha(0, 1, FADE_SECONDS / 2)).toBeCloseTo(0.5, 12);
    expect(approachAlpha(1, 0, FADE_SECONDS / 2)).toBeCloseTo(0.5, 12);
    expect(approachAlpha(0, 1, FADE_SECONDS)).toBe(1);
  });

  it('到了目标就停，不冲过头，也不倒退', () => {
    expect(approachAlpha(0.3, FADED_ALPHA, 10)).toBe(FADED_ALPHA);
    expect(approachAlpha(1, FADED_ALPHA, 10)).toBe(FADED_ALPHA);
    expect(approachAlpha(0.2, 0.2, 0.5)).toBe(0.2);
    expect(approachAlpha(0.2, 0.9, 0)).toBe(0.2);
    expect(approachAlpha(0.2, 0.9, -1)).toBe(0.2);
  });

  it('没有给时间（第一次摆放，读档）直接到位', () => {
    expect(approachAlpha(1, 0, Number.POSITIVE_INFINITY)).toBe(0);
    expect(approachAlpha(0, FADED_ALPHA, Number.NaN)).toBe(FADED_ALPHA);
  });

  it('没显示的片区第一次显示：从 0 起，在镜头挪动的时间里淡入到 FADED_ALPHA，每一步都不倒退', () => {
    let alpha = 0;
    let last = 0;
    for (let ms = 16; ms <= 800; ms += 16) {
      alpha = approachAlpha(alpha, FADED_ALPHA, 0.016);
      expect(alpha).toBeGreaterThanOrEqual(last);
      last = alpha;
    }
    expect(alpha).toBe(FADED_ALPHA);
  });
});

describe('城市分给三个片区', () => {
  it('每个片区都有街区和屋顶', () => {
    for (let d = 0; d < 3; d++) {
      const part = cityOfDistrict(CITY, MEMBERSHIP, d);
      expect(part.blocks.length, `片区 ${d} 的街区`).toBeGreaterThan(5);
      expect(part.buildings.length, `片区 ${d} 的屋顶`).toBeGreaterThan(10);
      expect(part.labels.map((l) => l.district), `片区 ${d} 的名字`).toEqual([d]);
    }
  });

  it('一项只属于一个片区：三个片区的和加上不画的，等于城市里的全部', () => {
    const count = (tags: Int8Array, d: number): number => tags.reduce((n, t) => n + (t === d ? 1 : 0), 0);
    for (const [name, tags, total] of [
      ['街区', MEMBERSHIP.blocks, CITY.blocks.length],
      ['屋顶', MEMBERSHIP.buildings, CITY.buildings.length],
      ['树', MEMBERSHIP.trees, CITY.trees.length],
      ['院子', MEMBERSHIP.yards, CITY.yards.length],
    ] as const) {
      expect(tags.length, name).toBe(total);
      expect(count(tags, 0) + count(tags, 1) + count(tags, 2) + count(tags, -1), name).toBe(total);
      for (const t of tags) expect(t >= -1 && t <= 2, name).toBe(true);
    }
  });

  it('店、送餐的楼、候选屋顶的屋顶都在自己的片区的那一层里', () => {
    let checked = 0;
    CITY.buildings.forEach((b, i) => {
      const role = b.role;
      if (role.type === 'plain') return;
      const entry = role.type === 'shop' ? MAP_V1.shops[role.index] : role.type === 'home' ? MAP_V1.buildings[role.index] : MAP_V1.roofs[role.index];
      expect(entry, `${role.type} ${role.index}`).toBeDefined();
      expect(MEMBERSHIP.buildings[i], `${role.type} ${role.index}`).toBe((entry as { district: number }).district);
      checked += 1;
    });
    expect(checked).toBe(MAP_V1.shops.length + MAP_V1.buildings.length + MAP_V1.roofs.length);
  });

  it('每一层只有这个片区的东西：街区的中心离片区外框不超过余量', () => {
    for (let d = 0; d < 3; d++) {
      const part = cityOfDistrict(CITY, MEMBERSHIP, d);
      for (const b of part.blocks) {
        const cx = b.rect.x + b.rect.w / 2;
        const cy = b.rect.y + b.rect.h / 2;
        expect(districtOfPoint(DISTRICTS, cx, cy), `片区 ${d}`).toBe(d);
      }
    }
  });

  it('画板上的空地（不属于任何片区）不画：有街区没分给任何片区', () => {
    expect(MEMBERSHIP.blocks.some((t) => t === -1)).toBe(true);
    const assigned = MEMBERSHIP.blocks.filter((t) => t >= 0).length;
    expect(assigned).toBeLessThan(CITY.blocks.length);
    expect(assigned).toBeGreaterThan(CITY.blocks.length * 0.3);
  });

  it('片区这一层不带河和桥，河和桥单独一层', () => {
    for (let d = 0; d < 3; d++) expect(cityOfDistrict(CITY, MEMBERSHIP, d).bridges).toEqual([]);
    const base = riverCity(CITY);
    expect(base.blocks).toEqual([]);
    expect(base.buildings).toEqual([]);
    expect(base.trees).toEqual([]);
    expect(base.labels).toEqual([]);
    expect(base.river).toBe(CITY.river);
    expect(base.bridges).toBe(CITY.bridges);
  });

  it('分法是确定的：同一座城市分两次，结果相同', () => {
    const again = assignDistricts(CITY, DISTRICTS);
    expect(Array.from(again.blocks)).toEqual(Array.from(MEMBERSHIP.blocks));
    expect(Array.from(again.buildings)).toEqual(Array.from(MEMBERSHIP.buildings));
    expect(Array.from(again.trees)).toEqual(Array.from(MEMBERSHIP.trees));
  });

  it('余量越小，分到片区里的街区越少', () => {
    const tight = assignDistricts(CITY, DISTRICTS, 0).blocks.filter((t) => t >= 0).length;
    const loose = assignDistricts(CITY, DISTRICTS, 200).blocks.filter((t) => t >= 0).length;
    expect(tight).toBeLessThanOrEqual(MEMBERSHIP.blocks.filter((t) => t >= 0).length);
    expect(loose).toBeGreaterThanOrEqual(MEMBERSHIP.blocks.filter((t) => t >= 0).length);
  });
});

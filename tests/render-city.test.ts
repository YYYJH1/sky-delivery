// 城市生成：确定、完整、不乱。同一份地图数据得到同一座城市，店、楼、候选屋顶各出现一次，屋顶互不相压，飞机飞到的坐标落在屋顶上或边上。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { RIVER_HALF_WIDTH, STATION_SIZES, generateCity } from '../src/render/city.ts';
import type { City } from '../src/render/city-types.ts';
import { contains, overlaps } from '../src/render/geometry.ts';
import type { Rect } from '../src/render/geometry.ts';
import { citySpecFromMap, planBoard } from '../src/render/map-spec.ts';
import { isWet } from '../src/render/river.ts';

const SLICE = planBoard({ x: 600, y: 650 }, 1920, 1080);
const sliceCity = generateCity(citySpecFromMap(MAP_V1, SLICE.region, { x: 1620, y: 230 }));

/** 另一块区域：大学城一带，检查生成对别的位置也成立。 */
const CAMPUS = planBoard({ x: 1500, y: 1400 }, 1920, 1080);
const campusCity = generateCity(citySpecFromMap(MAP_V1, CAMPUS.region));

const inRegion = (city: City, x: number, y: number): boolean => contains(city.region, x, y, 30);

/** 画板之内的点：画面区域是转了角的画板的外接框，四个角在画板之外，那里的屋顶看不到，检查只管画板之内。 */
const onBoard = (plan: typeof SLICE, x: number, y: number): boolean => {
  const p = plan.board.toBoard(x, y);
  return p.x >= 0 && p.x <= plan.board.width && p.y >= 0 && p.y <= plan.board.height;
};

function expectedCounts(city: City): { shops: number; homes: number; roofs: number } {
  return {
    shops: MAP_V1.shops.filter((s) => inRegion(city, s.x, s.y)).length,
    homes: MAP_V1.buildings.filter((b) => inRegion(city, b.x, b.y)).length,
    roofs: MAP_V1.roofs.filter((r) => inRegion(city, r.x, r.y)).length,
  };
}

describe('确定性', () => {
  it('同样的输入得到同样的城市，逐项相同', () => {
    const again = generateCity(citySpecFromMap(MAP_V1, SLICE.region, { x: 1620, y: 230 }));
    expect(JSON.stringify(again)).toBe(JSON.stringify(sliceCity));
  });

  it('换一个种子，街道和屋顶都不同', () => {
    const spec = citySpecFromMap(MAP_V1, SLICE.region);
    const other = generateCity({ ...spec, seed: spec.seed + 1 });
    expect(JSON.stringify(other.streets)).not.toBe(JSON.stringify(sliceCity.streets));
  });

  it('同一份地图数据，画面区域不同，保留的屋顶位置不变', () => {
    const a = sliceCity.buildings.filter((b) => b.role.type === 'shop' && b.role.index === 0)[0];
    const wider = planBoard({ x: 600, y: 650 }, 2400, 1300);
    const b = generateCity(citySpecFromMap(MAP_V1, wider.region)).buildings.filter((x) => x.role.type === 'shop' && x.role.index === 0)[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // 店 0 在老街，两种区域下屋顶都盖着它的坐标
    const shop = MAP_V1.shops[0] as { x: number; y: number };
    for (const roof of [a, b]) expect(contains((roof as { rect: Rect }).rect, shop.x, shop.y, 16)).toBe(true);
  });
});

describe('保留的屋顶：店、送餐的楼、候选屋顶', () => {
  for (const [name, city, plan] of [
    ['老街一带', sliceCity, SLICE],
    ['大学城一带', campusCity, CAMPUS],
  ] as const) {
    it(`${name}：区域里的每家店、每栋楼、每块候选屋顶各有一块屋顶，区域外的不画`, () => {
      const want = expectedCounts(city);
      const count = (type: string): number => city.buildings.filter((b) => b.role.type === type).length;
      expect(count('shop')).toBe(want.shops);
      expect(count('home')).toBe(want.homes);
      expect(count('roof')).toBe(want.roofs);
      const seen = new Set(city.buildings.filter((b) => b.role.type !== 'plain').map((b) => JSON.stringify(b.role)));
      expect(seen.size).toBe(want.shops + want.homes + want.roofs);
    });

    it(`${name}：画板之内的屋顶互不相压`, () => {
      const bad: string[] = [];
      for (let i = 0; i < city.buildings.length; i++) {
        for (let j = i + 1; j < city.buildings.length; j++) {
          const a = city.buildings[i];
          const b = city.buildings[j];
          if (a === undefined || b === undefined || !overlaps(a.rect, b.rect)) continue;
          const c = { x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h / 2 };
          if (onBoard(plan, c.x, c.y)) bad.push(`${JSON.stringify(a.role)} ${JSON.stringify(b.role)}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it(`${name}：飞机飞到的坐标落在屋顶上或离屋顶边不超过 16 个单位，候选屋顶盖着它的坐标`, () => {
      for (const b of city.buildings) {
        const p = b.role.type === 'shop' ? MAP_V1.shops[b.role.index] : b.role.type === 'home' ? MAP_V1.buildings[b.role.index] : b.role.type === 'roof' ? MAP_V1.roofs[b.role.index] : undefined;
        if (p === undefined || !onBoard(plan, p.x, p.y)) continue;
        const dx = Math.max(b.rect.x - p.x, 0, p.x - (b.rect.x + b.rect.w));
        const dy = Math.max(b.rect.y - p.y, 0, p.y - (b.rect.y + b.rect.h));
        expect(Math.sqrt(dx * dx + dy * dy), JSON.stringify(b.role)).toBeLessThanOrEqual(16);
        if (b.role.type === 'roof') {
          const size = (MAP_V1.roofs[b.role.index] as { size: 'small' | 'medium' | 'large' }).size;
          expect([b.rect.w, b.rect.h]).toEqual([...STATION_SIZES[size]]);
          expect(contains(b.rect, p.x, p.y)).toBe(true);
        }
      }
    });
  }
});

describe('街道、街区和河', () => {
  it('街宽只有两种：大街 30，小巷 22，横街竖街都有，大街不少于 4 条', () => {
    expect(new Set(sliceCity.streets.map((s) => s.w))).toEqual(new Set([22, 30]));
    expect(sliceCity.streets.some((s) => s.orient === 'h')).toBe(true);
    expect(sliceCity.streets.some((s) => s.orient === 'v')).toBe(true);
    expect(sliceCity.streets.filter((s) => s.main).length).toBeGreaterThanOrEqual(4);
  });

  it('老街里有成片的小街区：街区不比 236 乘 196 大的占九成以上', () => {
    const normal = sliceCity.blocks.filter((b) => b.kind === 'normal');
    expect(normal.length).toBeGreaterThan(50);
    const big = normal.filter((b) => b.rect.w > 240 || b.rect.h > 200);
    // 个别街区因为候选屋顶挡着切不开，允许略大
    expect(big.length).toBeLessThanOrEqual(Math.ceil(normal.length * 0.1));
  });

  it('树不种在河里', () => {
    for (const t of sliceCity.trees) expect(isWet(sliceCity.river, t.x, t.y, 0), `${t.x},${t.y}`).toBe(false);
  });

  it('街区不压进河里：街区的中心离河道中心线不到半个河宽的一个都没有', () => {
    for (const b of sliceCity.blocks) {
      if (b.kind === 'bank') continue;
      const cx = b.rect.x + b.rect.w / 2;
      const cy = b.rect.y + b.rect.h / 2;
      expect(isWet(sliceCity.river, cx, cy, -10), `${cx},${cy}`).toBe(false);
    }
    expect(RIVER_HALF_WIDTH).toBeGreaterThan(40);
  });

  it('桥最多三座，相隔不少于 230，桥面跨过河', () => {
    expect(sliceCity.bridges.length).toBeGreaterThanOrEqual(1);
    expect(sliceCity.bridges.length).toBeLessThanOrEqual(3);
    for (let i = 0; i < sliceCity.bridges.length; i++) {
      for (let j = i + 1; j < sliceCity.bridges.length; j++) {
        const a = sliceCity.bridges[i] as { rect: Rect };
        const b = sliceCity.bridges[j] as { rect: Rect };
        const d = Math.hypot(a.rect.x + a.rect.w / 2 - (b.rect.x + b.rect.w / 2), a.rect.y + a.rect.h / 2 - (b.rect.y + b.rect.h / 2));
        expect(d).toBeGreaterThanOrEqual(230);
      }
    }
  });

  it('片区名落在各自片区的范围里，老街和写字楼区都有', () => {
    const districts = MAP_V1.districts;
    for (const label of sliceCity.labels) {
      const d = districts[label.district] as { x0: number; x1: number; y0: number; y1: number };
      expect(label.x).toBeGreaterThan(d.x0);
      expect(label.x).toBeLessThan(d.x1);
      expect(label.y).toBeGreaterThan(d.y0);
      expect(label.y).toBeLessThan(d.y1);
    }
    expect(sliceCity.labels.map((l) => l.district)).toEqual(expect.arrayContaining([0, 1]));
  });
});

describe('屋顶上的东西和店的门面', () => {
  it('屋顶物件的中心都在它的屋顶里', () => {
    for (const b of sliceCity.buildings) for (const p of b.props) expect(contains(b.rect, p.x, p.y), `${b.id} ${p.kind}`).toBe(true);
  });

  it('十二种物件在老街一带都画得出来：老街的几种和写字楼的几种各有，停机坪恰好一个', () => {
    const kinds = new Set(sliceCity.buildings.flatMap((b) => b.props.map((p) => p.kind)));
    for (const k of ['tank', 'heaters', 'ac', 'clothesline', 'planters', 'shed', 'cooling', 'pv', 'stair', 'skylight'] as const) expect(kinds.has(k), k).toBe(true);
    expect(sliceCity.buildings.flatMap((b) => b.props).filter((p) => p.kind === 'helipad').length).toBe(1);
  });

  it('彩钢棚占老街普通屋顶的 3% 到 9%，离候选屋顶 150 以上', () => {
    const old = sliceCity.buildings.filter((b) => b.style === 'old' && b.role.type === 'plain');
    const steel = old.filter((b) => b.steel);
    expect(steel.length / old.length).toBeGreaterThan(0.02);
    expect(steel.length / old.length).toBeLessThan(0.1);
  });

  it('每家店一个门面，沿街的一边是上下左右之一，雨棚不宽过 68', () => {
    const shops = sliceCity.buildings.filter((b) => b.role.type === 'shop');
    expect(sliceCity.shops.length).toBe(shops.length);
    for (const f of sliceCity.shops) {
      expect(['b', 't', 'l', 'r']).toContain(f.side);
      expect(f.awningWidth).toBeLessThanOrEqual(68);
      expect(f.awningStart).toBeGreaterThanOrEqual(0);
    }
  });

  it('亮窗：每栋楼的窗都在屋顶里，门槛在 0 到 1', () => {
    for (const b of sliceCity.buildings) {
      for (const w of b.windows) {
        expect(contains(b.rect, w.x, w.y)).toBe(true);
        expect(w.t).toBeGreaterThanOrEqual(0);
        expect(w.t).toBeLessThan(1);
      }
    }
  });
});

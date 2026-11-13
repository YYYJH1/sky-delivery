// 店名放在哪里：城市生成时挑的位置在镜头缩小之后会被挤到片区外面或者压在票杆上，渲染时按现在的字号重新挑。
// 这里测纯函数：门面占着的地方，片区的街区范围，候选的位置，挑位置的结果。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { SHOPS } from '../src/content/strings.zh.ts';
import { markerUnits } from '../src/render/camera.ts';
import { RAIL_LENGTH, generateCity } from '../src/render/city.ts';
import type { City, ShopFront } from '../src/render/city-types.ts';
import { assignDistricts } from '../src/render/districts.ts';
import { inflate, overlapArea } from '../src/render/geometry.ts';
import type { Rect } from '../src/render/geometry.ts';
import { HELIPAD_NEAR, citySpecFromMap, planMapBoard } from '../src/render/map-spec.ts';
import { FOOTPRINT_PAD, boxAt, districtFootprints, nameCandidates, placeNames } from '../src/render/names.ts';
import type { NameSite, NameWorld } from '../src/render/names.ts';
import { frontDepth, frontPoint, frontZone, railEnds } from '../src/render/scene.ts';

const DISTRICTS: Rect[] = MAP_V1.districts.map((d) => ({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 }));
const CITY: City = generateCity(citySpecFromMap(MAP_V1, planMapBoard(DISTRICTS).region, HELIPAD_NEAR));
const FOOTPRINTS = districtFootprints(CITY, DISTRICTS);
const MEMBER = assignDistricts(CITY, DISTRICTS);
const WORLD: NameWorld = { buildings: CITY.buildings.map((b) => b.rect), roofs: CITY.stations.map((r) => r.rect) };

/** 渲染器摆店名时用的店名框：字按 13 像素的汉字加四周的描边，放大倍数是 k。 */
function sitesAt(zoom: number): NameSite[] {
  const U = markerUnits(zoom);
  return CITY.shops.map((front) => {
    const name = SHOPS[front.shop]?.name ?? '';
    const w = (13 * [...name].length + 8) * U.text;
    const h = 23 * U.text;
    return {
      shop: front.shop,
      front,
      zone: frontZone(front, U.ticket),
      rail: railEnds(front, U.ticket),
      depth: frontDepth(U.ticket),
      size: { w, h, ax: 4 * U.text, ay: 16 * U.text },
      footprint: FOOTPRINTS[MEMBER.buildings[front.building] as number] as Rect[],
    };
  });
}

/** 四个方向的门面，做法和城市生成里的一样：原点在屋顶的一个角，朝向 0、180、-90、90 度。 */
function frontOf(building: Rect, side: ShopFront['side']): ShopFront {
  const origin = side === 'b' ? { x: building.x, y: building.y + building.h } : side === 't' ? { x: building.x + building.w, y: building.y } : side === 'r' ? { x: building.x + building.w, y: building.y + building.h } : { x: building.x, y: building.y };
  const angle = side === 'b' ? 0 : side === 't' ? 180 : side === 'r' ? -90 : 90;
  const length = side === 'b' || side === 't' ? building.w : building.h;
  const awning = Math.min(length, 68);
  return { shop: 0, building: 0, side, origin, angle, awningWidth: awning, awningStart: (length - awning) / 2, name: { x: building.x, y: building.y } };
}

function siteOf(building: Rect, side: ShopFront['side'], unit = 1, size = { w: 70, h: 26, ax: 4, ay: 18 }, footprint: Rect[] = []): NameSite {
  const front = frontOf(building, side);
  return { shop: 0, front, zone: frontZone(front, unit), rail: railEnds(front, unit), depth: frontDepth(unit), size, footprint };
}

describe('门面占着的地方', () => {
  it('深度从 46 起，小票每放大一倍多 26', () => {
    expect(frontDepth(1)).toBe(46);
    expect(frontDepth(2)).toBe(72);
    expect(frontDepth(1.5)).toBeCloseTo(59, 12);
  });

  it('四个方向的门面：占着的地方贴着屋顶的那一边，沿街边是票杆长度加两端各 6，朝街里是深度', () => {
    const building: Rect = { x: 300, y: 200, w: 54, h: 44 };
    for (const side of ['b', 't', 'l', 'r'] as const) {
      for (const unit of [1, 1.6, 2.2]) {
        const front = frontOf(building, side);
        const zone = frontZone(front, unit);
        const alongStreet = side === 'b' || side === 't' ? zone.w : zone.h;
        const intoStreet = side === 'b' || side === 't' ? zone.h : zone.w;
        expect(alongStreet, `${side} ${unit}`).toBeCloseTo(RAIL_LENGTH * unit + 12, 9);
        expect(intoStreet, `${side} ${unit}`).toBeCloseTo(frontDepth(unit), 9);
        // 贴着屋顶：和屋顶只有边相接，不压
        expect(overlapArea(zone, building), `${side} ${unit}`).toBeCloseTo(0, 9);
        const edge = side === 'b' ? zone.y - (building.y + building.h) : side === 't' ? building.y - (zone.y + zone.h) : side === 'r' ? zone.x - (building.x + building.w) : building.x - (zone.x + zone.w);
        expect(edge, `${side} ${unit}`).toBeCloseTo(0, 9);
      }
    }
  });

  it('真实地图里的门面：占着的地方包住票杆两端和小票挂下去的最远处', () => {
    for (const front of CITY.shops) {
      const zone = frontZone(front, 1.4);
      const [r0, r1] = railEnds(front, 1.4);
      for (const [u, v] of [[r0, 0], [r1, 0], [r0, 14], [r1, 14], [(r0 + r1) / 2, frontDepth(1.4)]] as const) {
        const p = frontPoint(front, u, v);
        expect(p.x).toBeGreaterThanOrEqual(zone.x - 1e-6);
        expect(p.x).toBeLessThanOrEqual(zone.x + zone.w + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(zone.y - 1e-6);
        expect(p.y).toBeLessThanOrEqual(zone.y + zone.h + 1e-6);
      }
    }
  });
});

describe('片区的街区范围', () => {
  it('每个片区一组，是它的街区各外扩 FOOTPRINT_PAD', () => {
    expect(FOOTPRINTS).toHaveLength(DISTRICTS.length);
    DISTRICTS.forEach((_, d) => {
      const blocks = CITY.blocks.filter((_, i) => MEMBER.blocks[i] === d);
      expect(blocks.length).toBeGreaterThan(10);
      expect(FOOTPRINTS[d]).toEqual(blocks.map((b) => inflate(b.rect, FOOTPRINT_PAD)));
    });
  });

  it('每家店的屋顶都在它的片区的街区范围里', () => {
    for (const front of CITY.shops) {
      const d = MEMBER.buildings[front.building] as number;
      const roof = WORLD.buildings[front.building] as Rect;
      const covered = (FOOTPRINTS[d] as Rect[]).reduce((sum, f) => sum + overlapArea(roof, f), 0);
      expect(covered).toBeGreaterThanOrEqual(roof.w * roof.h - 1e-6);
    }
  });
});

describe('店名的候选位置', () => {
  const building: Rect = { x: 500, y: 400, w: 54, h: 44 };

  it('第一个是城市生成时挑的位置，大小都是字的大小', () => {
    for (const side of ['b', 't', 'l', 'r'] as const) {
      const site = siteOf(building, side);
      const boxes = nameCandidates(site, building);
      expect(boxes.length).toBeGreaterThanOrEqual(12);
      expect(boxes[0]).toEqual(boxAt(site.size, site.front.name));
      for (const box of boxes) {
        expect(box.w).toBe(site.size.w);
        expect(box.h).toBe(site.size.h);
      }
    }
  });

  it('门面外面的一个：贴着小票挂下去的最远处，在门面正中，不压着门面', () => {
    const size = { w: 70, h: 26, ax: 4, ay: 18 };
    for (const [side, expected] of [
      ['b', (z: Rect) => ({ x: z.x + z.w / 2 - 35, y: z.y + z.h + 3 })],
      ['t', (z: Rect) => ({ x: z.x + z.w / 2 - 35, y: z.y - 3 - 26 })],
      ['r', (z: Rect) => ({ x: z.x + z.w + 3, y: z.y + z.h / 2 - 13 })],
      ['l', (z: Rect) => ({ x: z.x - 3 - 70, y: z.y + z.h / 2 - 13 })],
    ] as const) {
      const site = siteOf(building, side, 1, size);
      const box = nameCandidates(site, building)[1] as Rect;
      const want = expected(site.zone);
      expect(box.x, side).toBeCloseTo(want.x, 9);
      expect(box.y, side).toBeCloseTo(want.y, 9);
      expect(overlapArea(box, site.zone), side).toBe(0);
    }
  });

  it('票杆左边和右边的两个：和票杆同一高度，贴着门面占着的地方，不压着它', () => {
    for (const side of ['b', 't', 'l', 'r'] as const) {
      const site = siteOf(building, side, 1.3);
      const boxes = nameCandidates(site, building);
      const left = boxes[2] as Rect;
      const right = boxes[3] as Rect;
      expect(overlapArea(left, site.zone), side).toBe(0);
      expect(overlapArea(right, site.zone), side).toBe(0);
      // 两个在门面的两侧：中心离门面中心一样远，方向相反
      const z = { x: site.zone.x + site.zone.w / 2, y: site.zone.y + site.zone.h / 2 };
      const l = { x: left.x + left.w / 2 - z.x, y: left.y + left.h / 2 - z.y };
      const r = { x: right.x + right.w / 2 - z.x, y: right.y + right.h / 2 - z.y };
      // 沿街边的方向上对称，朝街里的方向上在同一个高度
      if (side === 'b' || side === 't') {
        expect(l.x + r.x, side).toBeCloseTo(0, 9);
        expect(l.y, side).toBeCloseTo(r.y, 9);
      } else {
        expect(l.y + r.y, side).toBeCloseTo(0, 9);
        expect(l.x, side).toBeCloseTo(r.x, 9);
      }
    }
  });
});

describe('挑店名的位置', () => {
  it('原来的位置压着的东西很少，就不挪', () => {
    const building: Rect = { x: 500, y: 400, w: 54, h: 44 };
    const site = { ...siteOf(building, 'b'), footprint: [{ x: 300, y: 300, w: 600, h: 400 }] };
    // 原来的位置在门面左边的空地上
    const front = { ...site.front, name: { x: 410, y: 440 } };
    const kept = { ...site, front };
    const out = placeNames([kept], { buildings: [building], roofs: [] });
    expect(out.get(0)).toEqual({ x: 410, y: 440 });
  });

  it('原来的位置压着自己的门面：挪到不压的地方，离门面不远', () => {
    const building: Rect = { x: 500, y: 400, w: 54, h: 44 };
    const base = siteOf(building, 'b', 1, { w: 70, h: 26, ax: 4, ay: 18 }, [{ x: 300, y: 300, w: 600, h: 400 }]);
    // 原来的字压在雨棚和票杆上
    const site = { ...base, front: { ...base.front, name: { x: 515, y: 466 } } };
    expect(overlapArea(boxAt(site.size, site.front.name), site.zone)).toBeGreaterThan(0);
    const out = placeNames([site], { buildings: [building], roofs: [] });
    const origin = out.get(0) as { x: number; y: number };
    const box = boxAt(site.size, origin);
    expect(overlapArea(box, site.zone)).toBe(0);
    expect(Math.hypot(box.x + box.w / 2 - (site.zone.x + site.zone.w / 2), box.y + box.h / 2 - (site.zone.y + site.zone.h / 2))).toBeLessThan(90);
  });

  it('原来的位置在片区的街区范围外面：挪到范围里面或者紧贴门面', () => {
    const building: Rect = { x: 500, y: 400, w: 54, h: 44 };
    // 范围只到屋顶下面一点，原来的位置在范围下面的空地上
    const footprint: Rect = { x: 300, y: 300, w: 400, h: 190 };
    const base = siteOf(building, 'b', 1, { w: 70, h: 26, ax: 4, ay: 18 }, [footprint]);
    const site = { ...base, front: { ...base.front, name: { x: 500, y: 560 } } };
    const origin = placeNames([site], { buildings: [building], roofs: [] }).get(0) as { x: number; y: number };
    const box = boxAt(site.size, origin);
    expect(overlapArea(box, footprint)).toBeGreaterThanOrEqual(box.w * box.h - 1e-6);
  });

  it('不压别的店名：两家店原来的位置一样，后摆的让开', () => {
    const a: Rect = { x: 500, y: 400, w: 54, h: 44 };
    const b: Rect = { x: 800, y: 400, w: 54, h: 44 };
    const size = { w: 70, h: 26, ax: 4, ay: 18 };
    const footprint: Rect[] = [{ x: 300, y: 300, w: 800, h: 300 }];
    const first = { ...siteOf(a, 'b', 1, size, footprint), shop: 0, front: { ...siteOf(a, 'b').front, building: 0, name: { x: 700, y: 520 } } };
    const second = { ...siteOf(b, 'b', 1, size, footprint), shop: 1, front: { ...siteOf(b, 'b').front, building: 1, name: { x: 700, y: 520 } } };
    const out = placeNames([first, second], { buildings: [a, b], roofs: [] });
    const boxA = boxAt(size, out.get(0) as { x: number; y: number });
    const boxB = boxAt(size, out.get(1) as { x: number; y: number });
    expect(overlapArea(boxA, boxB)).toBe(0);
  });

  it('同样的输入同样的结果', () => {
    const a = placeNames(sitesAt(0.8), WORLD);
    const b = placeNames(sitesAt(0.8), WORLD);
    expect([...a]).toEqual([...b]);
  });

  it('只给了部分店时，别的店的门面不算：没开张的店不占地方', () => {
    const all = sitesAt(0.8);
    const some = all.filter((s) => s.shop % 2 === 0);
    const out = placeNames(some, WORLD);
    expect([...out.keys()].sort((x, y) => x - y)).toEqual(some.map((s) => s.shop).sort((x, y) => x - y));
  });
});

describe('真实的地图：开局和两个片区时的镜头缩放下', () => {
  // 缩放 0.8 是开局只有老街，0.69 是老街加写字楼区，1 是风格切片里的缩放
  for (const zoom of [1, 0.8, 0.69]) {
    it(`缩放 ${zoom}：28 家店的店名都不压着自己和别家的门面、不压候选屋顶、互相不压，都在片区的街区范围里`, () => {
      const sites = sitesAt(zoom);
      const out = placeNames(sites, WORLD);
      expect(out.size).toBe(sites.length);
      const boxes = sites.map((s) => ({ site: s, box: boxAt(s.size, out.get(s.shop) as { x: number; y: number }) }));
      for (const { site, box } of boxes) {
        const name = SHOPS[site.shop]?.name;
        for (const other of sites) expect(overlapArea(box, other.zone), `${name} 压着 ${SHOPS[other.shop]?.name} 的门面`).toBe(0);
        for (const roof of WORLD.roofs) expect(overlapArea(box, roof), `${name} 压着候选屋顶`).toBe(0);
        const covered = site.footprint.reduce((sum, f) => sum + overlapArea(box, f), 0);
        expect(covered, `${name} 在片区外面`).toBeGreaterThanOrEqual(0.9 * box.w * box.h);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlapArea((boxes[i] as (typeof boxes)[number]).box, (boxes[j] as (typeof boxes)[number]).box), `${SHOPS[boxes[i]?.site.shop ?? 0]?.name} 和 ${SHOPS[boxes[j]?.site.shop ?? 0]?.name}`).toBe(0);
        }
      }
    });
  }

  it('缩放 0.48（三个片区都显示）：字大了很多，仍然不压自己的门面，几乎都在片区里，每个都离门面不远', () => {
    const sites = sitesAt(0.48);
    const out = placeNames(sites, WORLD);
    for (const site of sites) {
      const box = boxAt(site.size, out.get(site.shop) as { x: number; y: number });
      expect(overlapArea(box, site.zone), SHOPS[site.shop]?.name).toBe(0);
      const covered = site.footprint.reduce((sum, f) => sum + overlapArea(box, f), 0);
      expect(covered, SHOPS[site.shop]?.name).toBeGreaterThanOrEqual(0.75 * box.w * box.h);
      const dx = box.x + box.w / 2 - (site.zone.x + site.zone.w / 2);
      const dy = box.y + box.h / 2 - (site.zone.y + site.zone.h / 2);
      expect(Math.hypot(dx, dy), SHOPS[site.shop]?.name).toBeLessThan(160);
    }
  });

  it('开在片区边沿的吴叔排骨面：原来的位置有一大半在片区外面，现在在片区里面', () => {
    const shop = SHOPS.findIndex((s) => s.name === '吴叔排骨面');
    const site = sitesAt(0.8).find((s) => s.shop === shop) as NameSite;
    const original = boxAt(site.size, site.front.name);
    const outsideOf = (box: Rect): number => 1 - site.footprint.reduce((sum, f) => sum + overlapArea(box, f), 0) / (box.w * box.h);
    expect(outsideOf(original)).toBeGreaterThan(0.5);
    const placed = boxAt(site.size, placeNames(sitesAt(0.8), WORLD).get(shop) as { x: number; y: number });
    expect(outsideOf(placed)).toBeLessThan(0.05);
  });
});

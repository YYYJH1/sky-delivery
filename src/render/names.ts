// 店名放在哪里。纯函数，不碰画布和 Pixi，坐标都是世界坐标。
// 城市生成时给每家店挑了一个店名的位置，但那时字按原大小算，也不知道镜头会不会缩小。镜头缩小之后字和票杆都放大了，
// 开在片区边沿的店，字会被挤到片区外面，看着像飘在纸上。这里在渲染时按现在的字号重新挑一次：
// 字尽量放在片区的街区里面，或者紧贴店的门面，压到别的东西越少越好，实在放不下才放到外面。
import type { City, ShopFront } from './city-types.ts';
import { assignDistricts } from './districts.ts';
import { inflate, overlapArea } from './geometry.ts';
import type { Rect, Vec } from './geometry.ts';
import { frontPoint } from './scene.ts';

/** 片区的街区外扩多少还算在片区里面，世界单位。街道宽 22 到 30，字落在街道上也算里面。 */
export const FOOTPRINT_PAD = 14;

/** 字的框和门面之间留的空，世界单位。 */
const GAP = 3;

/** 票杆在门面局部坐标里离街边的距离，和它两端的字摆成一排时字的中线放在这里。 */
const RAIL_V = 14;

/** 一家店要摆的店名。 */
export interface NameSite {
  readonly shop: number;
  readonly front: ShopFront;
  /** 门面和小票占着的地方，世界坐标。字不能压在它上面。 */
  readonly zone: Rect;
  /** 票杆两端在门面局部坐标里沿街边的位置。 */
  readonly rail: readonly [number, number];
  /** 门面占着的深度：从街边到小票挂下去的最远处，门面局部坐标里沿 +v 的长度。 */
  readonly depth: number;
  /** 字的框：宽高，以及字的原点（左端基线）离框的左上角多远。世界单位，已经按字的放大倍数算好。 */
  readonly size: { readonly w: number; readonly h: number; readonly ax: number; readonly ay: number };
  /** 这家店所在的片区的街区范围，每个街区外扩过 FOOTPRINT_PAD。 */
  readonly footprint: readonly Rect[];
}

/** 摆店名时要躲开的东西。 */
export interface NameWorld {
  /** 城市里全部屋顶，按 city.buildings 的下标。 */
  readonly buildings: readonly Rect[];
  /** 候选屋顶，站建在上面，字不要压住。 */
  readonly roofs: readonly Rect[];
}

/** 每个片区的街区范围：片区里的每个街区各外扩 pad，下标是片区序号。 */
export function districtFootprints(city: City, districts: readonly Rect[], pad = FOOTPRINT_PAD): Rect[][] {
  const member = assignDistricts(city, districts);
  const out: Rect[][] = districts.map(() => []);
  city.blocks.forEach((block, i) => {
    const d = member.blocks[i] as number;
    if (d >= 0) (out[d] as Rect[]).push(inflate(block.rect, pad));
  });
  return out;
}

/** 字的框以 origin（左端基线）为原点放在哪里。 */
export function boxAt(size: NameSite['size'], origin: Vec): Rect {
  return { x: origin.x - size.ax, y: origin.y - size.ay, w: size.w, h: size.h };
}

/** 框的中心。 */
function centerOf(r: Rect): Vec {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function boxCentered(size: NameSite['size'], c: Vec): Rect {
  return { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h };
}

/**
 * 一家店的店名可以放的位置，第一个是城市生成时挑的。其余的紧贴着门面或者屋顶：
 * 门面外面（小票挂下去的那一头），票杆左边和右边，屋顶的上下左右，以及贴着屋顶的边挪到一头的位置。框按字的大小，世界坐标。
 * 门面总是沿着街，朝向是 0、90、180 或 -90 度，所以门面的两个方向在世界里都和坐标轴平行。
 */
export function nameCandidates(site: NameSite, building: Rect): Rect[] {
  const { front, size, rail, depth } = site;
  const out: Rect[] = [boxAt(size, front.name)];
  // 门面局部坐标：+u 沿街边，+v 朝街里，整体转 front.angle 度。它的两个方向在世界里是 (c, s) 和 (-s, c)
  const a = (front.angle * Math.PI) / 180;
  const tangent = { x: Math.round(Math.cos(a)), y: Math.round(Math.sin(a)) };
  const normal = { x: -tangent.y, y: tangent.x };
  const extent = (d: Vec): number => Math.abs(d.x) * size.w + Math.abs(d.y) * size.h;
  const uc = (rail[0] + rail[1]) / 2;
  // 门面外面：字的近边贴着小票挂到的最远处，居中
  const far = frontPoint(front, uc, depth + GAP);
  out.push(boxCentered(size, { x: far.x + (normal.x * extent(normal)) / 2, y: far.y + (normal.y * extent(normal)) / 2 }));
  // 票杆左边和右边：和票杆同一高度，字的近边贴着门面占着的地方
  for (const sign of [-1, 1] as const) {
    const end = frontPoint(front, sign < 0 ? rail[0] - 6 - GAP : rail[1] + 6 + GAP, RAIL_V);
    const half = extent(tangent) / 2;
    out.push(boxCentered(size, { x: end.x + sign * tangent.x * half, y: end.y + sign * tangent.y * half }));
  }
  // 屋顶的下方、上方、右边、左边，贴着屋顶和稍远一点各一个
  const c = centerOf(building);
  for (const gap of [GAP, 6 * GAP]) {
    out.push(boxCentered(size, { x: c.x, y: building.y + building.h + gap + size.h / 2 }));
    out.push(boxCentered(size, { x: c.x, y: building.y - gap - size.h / 2 }));
    out.push(boxCentered(size, { x: building.x + building.w + gap + size.w / 2, y: c.y }));
    out.push(boxCentered(size, { x: building.x - gap - size.w / 2, y: c.y }));
  }
  // 贴着屋顶的四边，顺着边挪到一头，和屋顶的一角对齐
  const right = building.x + building.w;
  const bottom = building.y + building.h;
  for (const x of [building.x, right - size.w]) {
    out.push({ x, y: bottom + GAP, w: size.w, h: size.h });
    out.push({ x, y: building.y - GAP - size.h, w: size.w, h: size.h });
  }
  for (const y of [building.y, bottom - size.h]) {
    out.push({ x: right + GAP, y, w: size.w, h: size.h });
    out.push({ x: building.x - GAP - size.w, y, w: size.w, h: size.h });
  }
  return out;
}

/** 压住各种东西的代价，每单位面积。 */
const COST = {
  /** 别的屋顶。 */
  building: 1,
  /** 自己的屋顶：字压在店的屋顶上不算太糟。 */
  own: 0.5,
  /** 别家店的门面和小票。 */
  zone: 4,
  /** 自己的门面和小票：不能压。 */
  ownZone: 40,
  /** 候选屋顶。 */
  roof: 6,
  /** 别的店名。 */
  name: 4,
  /** 片区的街区范围之外：字飘在纸上。 */
  outside: 2,
};

/** 离门面中心每远一单位的代价。只在几个位置压住的东西一样少时分高低，让字尽量靠近门面。 */
const DISTANCE_COST = 0.05;

/** 原来的位置压住的东西不超过字框面积的这一比例，就不挪。字压到一点街区的边角这种小事不值得换地方。 */
const KEEP_BELOW = 0.04;

function covered(box: Rect, parts: readonly Rect[]): number {
  let area = 0;
  for (const p of parts) area += overlapArea(box, p);
  return area;
}

/**
 * 给每家店挑店名的位置，返回字的原点（左端基线，世界坐标）。按 sites 的顺序摆，先摆的占好位置。
 * 每个候选位置的代价是压住别的屋顶、别家的门面、候选屋顶和已经摆好的店名的面积，加上落在片区街区之外的面积。
 * 原来的位置压住的东西很少就不挪，否则取代价最小的，代价一样时取离门面近的。
 */
export function placeNames(sites: readonly NameSite[], world: NameWorld): Map<number, Vec> {
  const result = new Map<number, Vec>();
  const placed: Rect[] = [];
  for (const site of sites) {
    const building = world.buildings[site.front.building] as Rect;
    const others = world.buildings.filter((_, i) => i !== site.front.building);
    const zones = sites.filter((s) => s.shop !== site.shop).map((s) => s.zone);
    const mine = centerOf(site.zone);
    const penalty = (box: Rect): number => {
      let score = COST.building * covered(box, others) + COST.own * overlapArea(box, building);
      score += COST.zone * covered(box, zones) + COST.ownZone * overlapArea(box, site.zone);
      score += COST.roof * covered(box, world.roofs) + COST.name * covered(box, placed);
      score += COST.outside * Math.max(0, box.w * box.h - covered(box, site.footprint));
      return score;
    };
    const candidates = nameCandidates(site, building);
    const original = candidates[0] as Rect;
    let best = original;
    if (penalty(original) > KEEP_BELOW * original.w * original.h) {
      let bestScore = Infinity;
      for (const box of candidates) {
        const c = centerOf(box);
        const score = penalty(box) + DISTANCE_COST * Math.hypot(c.x - mine.x, c.y - mine.y);
        if (score < bestScore - 1e-9) {
          bestScore = score;
          best = box;
        }
      }
    }
    placed.push(best);
    result.set(site.shop, { x: best.x + site.size.ax, y: best.y + site.size.ay });
  }
  return result;
}

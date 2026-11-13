// 片区：城市生成器给整张地图铺满街区和屋顶，这里把它们分给三个片区，每个片区烘焙成自己的一层。
// 还没显示的片区这一层不显示（只露纸色），显示了还没开通的淡画，开通了正常画，状态变了只是换一层的透明度，不用重新烘焙。
// 纯函数，不碰 DOM 和 Pixi。
import type { Block, City, Label } from './city-types.ts';
import { contains } from './geometry.ts';
import type { Rect } from './geometry.ts';

/** 一个片区在地图上的样子：没显示的不画，显示了没开通的淡画，开通了正常画。 */
export type DistrictMode = 'hidden' | 'faded' | 'open';

/** 淡画的片区整层的不透明度。 */
export const FADED_ALPHA = 0.4;

/** 片区的外框之外多算多远的街区，世界单位。街区按中心点归属，边上的街区要算进来。 */
export const DISTRICT_MARGIN = 60;

/** 一层的不透明度，没显示的为 0。 */
export function modeAlpha(mode: DistrictMode): number {
  return mode === 'hidden' ? 0 : mode === 'faded' ? FADED_ALPHA : 1;
}

/** 片区的显示状态变了，这一层的不透明度从 0 渐变到 1 要多久，秒。镜头拉远的同时，新显示的片区跟着淡入。 */
export const FADE_SECONDS = 0.8;

/**
 * 不透明度朝 target 走了 dt 秒之后的值：匀速，走完 0 到 1 要 FADE_SECONDS，到了 target 就停。
 * dt 不是有限的数时（第一次摆放）直接到 target。
 */
export function approachAlpha(current: number, target: number, dt: number): number {
  if (!Number.isFinite(dt)) return target;
  const step = Math.max(0, dt) / FADE_SECONDS;
  return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
}

function distanceToRect(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.sqrt(dx * dx + dy * dy);
}

/** 点属于哪个片区：离它最近的片区外框，不超过 margin 才算，否则是 -1（不属于任何片区）。 */
export function districtOfPoint(districts: readonly Rect[], x: number, y: number, margin = DISTRICT_MARGIN): number {
  let best = -1;
  let bestD = Infinity;
  districts.forEach((d, i) => {
    const dist = distanceToRect(d, x, y);
    if (dist < bestD) {
      bestD = dist;
      best = i;
    }
  });
  return bestD <= margin ? best : -1;
}

/** 城市里的每一项属于哪个片区，下标与 city 里对应的列表相同，-1 是不属于任何片区（画板上的空地，不画）。 */
export interface Membership {
  readonly blocks: Int8Array;
  readonly buildings: Int8Array;
  readonly trees: Int8Array;
  readonly yards: Int8Array;
}

export function assignDistricts(city: City, districts: readonly Rect[], margin = DISTRICT_MARGIN): Membership {
  const blocks = new Int8Array(city.blocks.length);
  city.blocks.forEach((b, i) => {
    blocks[i] = districtOfPoint(districts, b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h / 2, margin);
  });
  /** 点所在的街区属于哪个片区。不在任何街区里（压在街上的零星东西）时按离片区的远近定。 */
  const byBlock = (x: number, y: number): number => {
    for (let i = 0; i < city.blocks.length; i++) {
      if (contains((city.blocks[i] as Block).rect, x, y)) return blocks[i] as number;
    }
    return districtOfPoint(districts, x, y, margin);
  };
  const buildings = new Int8Array(city.buildings.length);
  city.buildings.forEach((b, i) => {
    buildings[i] = byBlock(b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h / 2);
  });
  const trees = new Int8Array(city.trees.length);
  city.trees.forEach((t, i) => {
    trees[i] = byBlock(t.x, t.y);
  });
  const yards = new Int8Array(city.yards.length);
  city.yards.forEach((y, i) => {
    yards[i] = byBlock(y.x + y.w / 2, y.y + y.h / 2);
  });
  return { blocks, buildings, trees, yards };
}

function pick<T>(list: readonly T[], tags: Int8Array, district: number): T[] {
  const out: T[] = [];
  list.forEach((item, i) => {
    if (tags[i] === district) out.push(item);
  });
  return out;
}

/** 只含一个片区的东西的城市：烘焙这个片区的一层。河和桥不在里面，它们画在底层。 */
export function cityOfDistrict(city: City, membership: Membership, district: number): City {
  const labels: Label[] = city.labels.filter((l) => l.district === district);
  return {
    ...city,
    blocks: pick(city.blocks, membership.blocks, district),
    buildings: pick(city.buildings, membership.buildings, district),
    trees: pick(city.trees, membership.trees, district),
    yards: pick(city.yards, membership.yards, district),
    bridges: [],
    labels,
  };
}

/** 只有河和桥的城市：烘焙最底下的一层，河一直画到窗口的边。 */
export function riverCity(city: City): City {
  return { ...city, blocks: [], buildings: [], trees: [], yards: [], labels: [] };
}

/** 一个片区的两个事实：显示了没有，开通了没有。写字楼区要等老街到过三星才显示，大学城要等写字楼区到过三星。 */
export interface DistrictFacts {
  readonly shown: boolean;
  readonly open: boolean;
}

/** 开通了的片区里有店在营业，一定要画出来，不管有没有显示。 */
export function modeOf(facts: DistrictFacts): DistrictMode {
  return facts.open ? 'open' : facts.shown ? 'faded' : 'hidden';
}

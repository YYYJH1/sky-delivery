// 楼名：按楼的种类生成，不逐栋起名。
// 老街的住宅楼是「{n} 号院」，写字楼区的写字楼是「{字母}座」，大学城的宿舍楼是「{n} 号宿舍楼」，
// 编号在各片区内从 1 或 A 开始。订单悬停时写成「{片区} {楼名}」，例如「老街 7 号院」。
// 纯函数，不碰 DOM 和状态。
import { MAP_V1 } from '../content/map_v1.ts';
import type { BuildingKind } from '../content/table_types.ts';
import { SHOPS, STR, districtName, fmt } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import { STEPS_PER_SECOND } from '../core/index.ts';

/** 第 n 个字母（n 从 0 起）：0 是 A，25 是 Z，26 是 AA，27 是 AB。 */
export function letterOf(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`ui: bad letter index ${String(n)}`);
  let rest = n;
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (rest % 26)) + out;
    rest = Math.floor(rest / 26) - 1;
    if (rest < 0) return out;
  }
}

/** 一栋楼的楼名。ordinal 是它在本片区里的序号，从 0 起。 */
export function buildingName(kind: BuildingKind, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) throw new RangeError(`ui: bad building ordinal ${String(ordinal)}`);
  switch (kind) {
    case 'residence':
      return fmt(STR.hud.buildingName.residence, { index: ordinal + 1 });
    case 'office':
      return fmt(STR.hud.buildingName.office, { letter: letterOf(ordinal) });
    case 'dorm':
      return fmt(STR.hud.buildingName.dorm, { index: ordinal + 1 });
  }
}

/** 订单悬停里的写法：片区加楼名。 */
export function placeName(district: number, name: string): string {
  return fmt(STR.hud.buildingName.place, { district: districtName(district as DistrictIndex), name });
}

export interface BuildingSpec {
  readonly district: number;
  readonly kind: BuildingKind;
}

/**
 * 一批楼的楼名，下标和传入的顺序相同。序号按片区各自从头数，
 * 所以老街的第一栋是「1 号院」，写字楼区的第一栋是「A 座」。
 */
export function buildingNames(buildings: readonly BuildingSpec[]): string[] {
  const seen = new Map<number, number>();
  return buildings.map((b) => {
    const ordinal = seen.get(b.district) ?? 0;
    seen.set(b.district, ordinal + 1);
    return buildingName(b.kind, ordinal);
  });
}

/** 地图 v1 里每栋楼的楼名，下标与 world.buildings 相同。 */
export const MAP_BUILDING_NAMES: readonly string[] = buildingNames(MAP_V1.buildings);

/** 地图 v1 里每栋楼带片区的写法，订单悬停用。 */
export const MAP_BUILDING_PLACES: readonly string[] = MAP_V1.buildings.map((b, i) =>
  placeName(b.district, MAP_BUILDING_NAMES[i] as string),
);

/** 订单悬停的一行字：「{楼名}，{菜名}，等了 {n} 秒」，楼名带片区。等的秒数向下取整，不为负。 */
export function orderHoverText(order: { readonly merchant: number; readonly building: number; readonly tOrder: number }, nowSteps: number): string {
  const place = MAP_BUILDING_PLACES[order.building];
  const shop = SHOPS[order.merchant];
  if (place === undefined || shop === undefined) throw new RangeError(`ui: order points at an unknown shop or building (${String(order.merchant)}, ${String(order.building)})`);
  const seconds = Math.max(0, Math.floor((nowSteps - order.tOrder) / STEPS_PER_SECOND + 1e-9));
  return fmt(STR.hud.orderHover, { building: place, dish: shop.dish, seconds });
}

// 新店的位置：片区加方位，例如「老街北边」「大学城中间」。
// 地图上 x 向右、y 向下，所以东是 x 增大的方向，南是 y 增大的方向，北在上。
// 方位按新店相对片区中心的方向取东、南、西、北。偏移先按片区的半边长折算，这样宽扁的片区不会总是东西向。
// 折算之后离中心不超过 middleRadius（NOTES_V1.middleRadius）的写「中间」。
import { MAP_V1 } from '../../content/map_v1.ts';
import { NOTES_V1 } from '../../content/notes_v1.ts';
import type { NewShop, PlaceDirection } from '../types.ts';

export interface PlaceRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** 点 (x, y) 相对矩形中心的方位。两个方向偏得一样多时取东西。 */
export function placeDirection(x: number, y: number, rect: PlaceRect, middleRadius: number = NOTES_V1.middleRadius): PlaceDirection {
  const halfW = (rect.x1 - rect.x0) / 2;
  const halfH = (rect.y1 - rect.y0) / 2;
  if (!(halfW > 0) || !(halfH > 0)) return 'middle';
  const u = (x - (rect.x0 + rect.x1) / 2) / halfW;
  const v = (y - (rect.y0 + rect.y1) / 2) / halfH;
  if (u * u + v * v <= middleRadius * middleRadius) return 'middle';
  if (Math.abs(u) >= Math.abs(v)) return u >= 0 ? 'east' : 'west';
  return v >= 0 ? 'south' : 'north';
}

/** 地图 v1 里第 shop 家店相对它所在片区中心的方位。 */
export function newShopAt(shop: number): NewShop {
  const s = MAP_V1.shops[shop];
  const rect = s === undefined ? undefined : MAP_V1.districts[s.district];
  if (s === undefined || rect === undefined) throw new RangeError(`no shop ${String(shop)}`);
  return { shop, direction: placeDirection(s.x, s.y, rect) };
}

// 地图数据（内容表 map_v1）换成城市生成的输入，以及画板的摆法。
import type { MapV1 } from '../content/table_types.ts';
import type { CitySpec } from './city.ts';
import type { Board, Rect, Vec } from './geometry.ts';
import { makeBoard, rectCenter, worldBoundsOfBoard } from './geometry.ts';

/** 地图转的角度：逆时针转 7°。 */
export const MAP_ANGLE = (-7 * Math.PI) / 180;

/** 画板四周比画面多留的一圈，逻辑像素。平移和抖动不会露出没画的地方。 */
export const BOARD_MARGIN = 48;

/**
 * 城市画面的随机种子的偏移。城市的样子只跟地图本身有关，不跟内容表的版本号走：
 * 内容版本因为数值、解锁条件这类与地图无关的改动而升级时，街区和屋顶不应该跟着变。
 * 取 2 时现在这张地图的街区和屋顶互不相压。地图的点位改了，再换这个数。
 */
export const CITY_SEED_OFFSET = 2;

export function citySpecFromMap(map: MapV1, region: Rect, helipadNear?: Vec): CitySpec {
  const spec: CitySpec = {
    seed: map.mapSeed * 7919 + CITY_SEED_OFFSET,
    region,
    districts: map.districts.map((d) => ({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 })),
    river: map.river,
    shops: map.shops.map((s) => ({ x: s.x, y: s.y, district: s.district })),
    homes: map.buildings.map((b) => ({ x: b.x, y: b.y, district: b.district, kind: b.kind })),
    roofs: map.roofs.map((r) => ({ x: r.x, y: r.y, district: r.district, size: r.size })),
  };
  return helipadNear === undefined ? spec : { ...spec, helipadNear };
}

export interface BoardPlan {
  readonly board: Board;
  /** 城市要生成的世界范围：盖住整个画板，再外扩一圈。 */
  readonly region: Rect;
}

/**
 * 画板对准世界里的 focus，画面是 viewWidth 乘 viewHeight 的逻辑像素，四周多留 BOARD_MARGIN。
 * 画板的 1 个单位就是世界的 1 个单位，镜头的缩放放在 Pixi 的容器上。
 */
export function planBoard(focus: Vec, viewWidth: number, viewHeight: number, angle = MAP_ANGLE): BoardPlan {
  const board = makeBoard(viewWidth + 2 * BOARD_MARGIN, viewHeight + 2 * BOARD_MARGIN, focus, angle);
  return { board, region: worldBoundsOfBoard(board, 40) };
}

/** 写字楼区有一栋楼顶画停机坪标记，取离这一点最近的大写字楼。 */
export const HELIPAD_NEAR: Vec = { x: 1620, y: 230 };

/** 整张地图四周比片区外框多留的一圈，世界单位。 */
export const MAP_MARGIN = 80;

export interface MapPlan {
  /** 画板正好是整张地图（片区外框加 MAP_MARGIN）转了角之后的外接框。 */
  readonly board: Board;
  /** 城市要生成的世界范围：片区外框加 MAP_MARGIN，一个正的矩形。 */
  readonly region: Rect;
  /** 三个片区都显示时镜头要放进窗口的范围，画板坐标，就是整块画板。只显示一部分片区时的范围见 mapRegion。 */
  readonly content: Rect;
}

/** 一组片区的外框加四周一圈留白，是一个正的矩形（世界坐标）。镜头框住哪几个片区，就取这几个片区的 mapRegion。 */
export function mapRegion(districts: readonly Rect[], margin = MAP_MARGIN): Rect {
  if (districts.length === 0) throw new RangeError('render: a map needs at least one district');
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const d of districts) {
    x0 = Math.min(x0, d.x);
    y0 = Math.min(y0, d.y);
    x1 = Math.max(x1, d.x + d.w);
    y1 = Math.max(y1, d.y + d.h);
  }
  return { x: x0 - margin, y: y0 - margin, w: x1 - x0 + 2 * margin, h: y1 - y0 + 2 * margin };
}

/**
 * 整张地图的画板：三个片区的外框加四周一圈留白，转 angle 之后取外接框。画板的 1 个单位就是世界的 1 个单位，
 * 镜头的缩放和偏移放在 camera.ts，所以窗口大小变了，城市和画板都不用重新生成。
 */
export function planMapBoard(districts: readonly Rect[], angle = MAP_ANGLE, margin = MAP_MARGIN): MapPlan {
  const region = mapRegion(districts, margin);
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const width = region.w * c + region.h * s;
  const height = region.w * s + region.h * c;
  const board = makeBoard(width, height, rectCenter(region), angle);
  return { board, region, content: { x: 0, y: 0, w: width, h: height } };
}

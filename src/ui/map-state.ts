// 地图和状态之间的对接：站建在哪块屋顶上，店有没有开张，站、候选屋顶、片区在世界里的矩形，以及它们在窗口里的位置
// （站的小卡、开通价签贴着它们摆）。纯函数，只读状态，不碰 DOM。
// 世界里的矩形是正的，转了角的画板和镜头的缩放平移在 src/render/camera.ts 里换算。
import { MAP_V1 } from '../content/map_v1.ts';
import { districtName } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import { bayCap } from '../core/index.ts';
import type { SimState } from '../core/index.ts';
import { MAX_ZOOM, fitCamera, snapToDevice, worldRectToScreen } from '../render/camera.ts';
import type { Camera, Insets } from '../render/camera.ts';
import { LABEL_METRICS } from '../render/city.ts';
import type { Label, StationRoof } from '../render/city-types.ts';
import type { DistrictMode } from '../render/districts.ts';
import { mapRegion, planMapBoard } from '../render/map-spec.ts';
import type { MapPlan } from '../render/map-spec.ts';
import type { Board, Rect } from '../render/geometry.ts';
import { stationRoofRect } from '../render/scene.ts';
import type { CandidateRoof } from './roofs.ts';
import type { DistrictAnchor, StationAnchor } from './state.ts';

/** 地图 v1 的三个片区外框，世界坐标。 */
export const DISTRICT_RECTS: readonly Rect[] = MAP_V1.districts.map((d) => ({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 }));

/** 整张地图的画板和城市要生成的范围。 */
export const MAP_PLAN: MapPlan = planMapBoard(DISTRICT_RECTS);

/** 窗口的大小和设备像素比，界面物件的缩放。 */
export interface WindowGeometry {
  readonly width: number;
  readonly height: number;
  /** 设备像素比，取 1 到 2。 */
  readonly dpr: number;
  /** 界面物件的缩放，顶部和底部给界面物件留的高度跟着它走。 */
  readonly uiScale: number;
}

/** 顶部给小票、日程纸条、速度纸条留 100，底部给价签和片区纸条留 24，都按界面物件的缩放。 */
export function insetsFor(uiScale: number): Insets {
  return { top: 100 * uiScale, bottom: 24 * uiScale };
}

/** 镜头要框住哪几个片区：下标是片区序号，真表示框住。cameraFor 和 contentFor 不给时三个片区都框。 */
export type Framed = readonly boolean[];

const ALL_FRAMED: Framed = DISTRICT_RECTS.map(() => true);

/**
 * 已经显示的片区就是镜头要框住的片区：淡画的和开通的算，还没显示的不算。
 * 一个都没有显示时（不该出现）框第一个片区，镜头不会没有东西可框。
 */
export function framedOf(modes: readonly DistrictMode[]): Framed {
  const framed = DISTRICT_RECTS.map((_, i) => modes[i] !== undefined && modes[i] !== 'hidden');
  return framed.some((f) => f) ? framed : DISTRICT_RECTS.map((_, i) => i === 0);
}

/** 两组框住的片区是不是同一组。 */
export function sameFramed(a: Framed, b: Framed): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/**
 * 镜头要放进窗口的范围，画板坐标：框住的片区的外框加四周的留白（mapRegion），转 7° 之后取外接框。
 * 三个片区都框住时就是整块画板。
 */
export function contentFor(framed: Framed = ALL_FRAMED): Rect {
  const picked = DISTRICT_RECTS.filter((_, i) => framed[i] === true);
  return MAP_PLAN.board.boundsOf(mapRegion(picked.length > 0 ? picked : DISTRICT_RECTS));
}

/** 调度台收起时占着窗口右边多宽，按 1920×1080 的尺寸写：白板 200 加右边距 24，再留 12 的空。 */
export const BOARD_STRIP = 236;

/** 让出调度台的位置之后，地图左边留的空，和左上角小票、左下角价签离窗口边的距离一样。 */
export const SIDE_MARGIN = 24;

/**
 * 窗口对应的镜头：把框住的片区放进窗口，顶部和底部留出界面的位置。缩放不超过 MAX_ZOOM（按界面物件的缩放），
 * 所以只有一个小片区时地图也不会放得比缩放 1 还大。
 * 框住的片区宽，右边会压到调度台下面去（店名和街区被盖住）时，让出调度台的位置：地图放进左边 SIDE_MARGIN 和调度台之间，
 * 缩放小一点，往左挪一点。只有老街，或者三个片区都在（窗口里左右本来就空着）时不用让。
 */
export function cameraFor(view: WindowGeometry, framed: Framed = ALL_FRAMED): Camera {
  const content = contentFor(framed);
  const insets = insetsFor(view.uiScale);
  const cap = MAX_ZOOM * view.uiScale;
  const whole = fitCamera(content, view.width, view.height, insets, view.dpr, cap);
  const strip = BOARD_STRIP * view.uiScale;
  const margin = SIDE_MARGIN * view.uiScale;
  const right = whole.x + (content.x + content.w) * whole.scale;
  if (right <= view.width - strip + 1e-6) return whole;
  const narrow = fitCamera(content, view.width - strip - margin, view.height, insets, view.dpr, cap);
  return { scale: narrow.scale, x: snapToDevice(narrow.x + margin, view.dpr), y: narrow.y };
}

/** 站建在哪块候选屋顶上（地图 v1 里 roofs 的下标）。没有经营模式的记录时为 null。 */
export function roofIndexOfStation(state: SimState, station: number): number | null {
  const info = state.campaign?.stations[station];
  return info === undefined ? null : info.roof;
}

/**
 * 片区名在世界里占的矩形：字距拉开，字的中心在城市里记的位置上，宽度是字数乘字号加字距，高度大约一个字号加上下的描边。
 * 只算已经显示的片区。选屋顶时文字躲着它，不盖在片区名上。
 */
export function districtLabelRects(labels: readonly Label[], modes: readonly DistrictMode[]): Rect[] {
  const { font, spacing } = LABEL_METRICS;
  const out: Rect[] = [];
  for (const label of labels) {
    if ((modes[label.district] ?? 'hidden') === 'hidden') continue;
    const chars = [...districtName(label.district as DistrictIndex)].length;
    const w = chars * font + (chars - 1) * spacing + 8;
    out.push({ x: label.x - w / 2, y: label.y - 16, w, h: 36 });
  }
  return out;
}

/** 站所在的屋顶最多放几个停机位，取自屋顶的大小（核心的 bayCap）。没有经营模式的记录、屋顶不在地图里时为 null。 */
export function bayLimitOf(state: SimState, station: number): number | null {
  const roof = roofIndexOfStation(state, station);
  const info = roof === null ? undefined : MAP_V1.roofs[roof];
  return info === undefined ? null : bayCap(info.size);
}

/** 店有没有开张。沙盒模式的店一直开着。 */
export function shopIsOpen(state: SimState, shop: number): boolean {
  return state.campaign === null || state.campaign.shopOpen[shop] === true;
}

/** 一座站的屋顶在世界里的矩形。 */
export interface StationBox {
  readonly id: number;
  readonly rect: Rect;
}

/** 还在用的站，按编号从小到大。 */
export function stationBoxes(state: SimState, roofs: ReadonlyMap<number, StationRoof>): StationBox[] {
  const out: StationBox[] = [];
  for (const s of state.stations) {
    if (s.removed) continue;
    out.push({ id: s.id, rect: stationRoofRect(roofs, state, s.id, roofIndexOfStation(state, s.id)).rect });
  }
  return out;
}

/** 选屋顶时的一块候选屋顶在世界里的矩形。 */
export interface RoofBox {
  readonly roof: number;
  readonly rect: Rect;
}

/** 候选屋顶的矩形，取城市里那块屋顶。城市里没有的（不在画面里）不给。 */
export function roofBoxes(candidates: readonly CandidateRoof[], roofs: ReadonlyMap<number, StationRoof>): RoofBox[] {
  const out: RoofBox[] = [];
  for (const c of candidates) {
    const found = roofs.get(c.roof);
    if (found !== undefined) out.push({ roof: c.roof, rect: found.rect });
  }
  return out;
}

/** 一个片区在世界里的矩形，以及它开通了没有。 */
export interface DistrictBox {
  readonly index: number;
  readonly rect: Rect;
  readonly open: boolean;
}

export function districtBoxes(state: SimState): DistrictBox[] {
  const campaign = state.campaign;
  return state.world.districts.map((d, index) => ({
    index,
    rect: { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 },
    open: campaign === null || campaign.districts[index]?.open === true,
  }));
}

/** 选中的站在窗口里的位置：屋顶转了角之后的外接框，中心加宽高。小卡摆在它旁边。 */
export function stationAnchor(board: Board, camera: Camera, box: StationBox): StationAnchor {
  const r = worldRectToScreen(board, camera, box.rect);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h };
}

/** 一个片区在窗口里的位置：转了角之后的外接框，左上角加宽高。开通价签摆在它的中间。 */
export function districtAnchor(board: Board, camera: Camera, box: DistrictBox): DistrictAnchor {
  const r = worldRectToScreen(board, camera, box.rect);
  return { district: box.index, x: r.x, y: r.y, w: r.w, h: r.h };
}

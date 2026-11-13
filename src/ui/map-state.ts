// 地图和状态之间的对接：站建在哪块屋顶上，店有没有开张，站、候选屋顶、片区在世界里的矩形，以及它们在窗口里的位置
// （站的小卡、开通价签贴着它们摆）。纯函数，只读状态，不碰 DOM。
// 世界里的矩形是正的，转了角的画板和镜头的缩放平移在 src/render/camera.ts 里换算。
import { MAP_V1 } from '../content/map_v1.ts';
import type { SimState } from '../core/index.ts';
import { fitCamera, worldRectToScreen } from '../render/camera.ts';
import type { Camera, Insets } from '../render/camera.ts';
import type { StationRoof } from '../render/city-types.ts';
import { planMapBoard } from '../render/map-spec.ts';
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

/** 窗口对应的镜头：整张地图转 7° 之后取外接框，放进窗口，顶部和底部留出界面的位置。 */
export function cameraFor(view: WindowGeometry): Camera {
  return fitCamera(MAP_PLAN.content, view.width, view.height, insetsFor(view.uiScale), view.dpr);
}

/** 站建在哪块候选屋顶上（地图 v1 里 roofs 的下标）。没有经营模式的记录时为 null。 */
export function roofIndexOfStation(state: SimState, station: number): number | null {
  const info = state.campaign?.stations[station];
  return info === undefined ? null : info.roof;
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

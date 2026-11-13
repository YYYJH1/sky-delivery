// 地图上的点击和悬停：鼠标在哪个东西上。纯函数，只看窗口坐标、镜头、世界里的屋顶矩形和画板上的小票位置。
// 选屋顶的状态下只认候选屋顶，其余时候先认站点，再认票杆上的小票。
// 屋顶在世界里是正的矩形，窗口里转了 7°，所以先把鼠标位置换成世界坐标再判断，边缘和转了角的屋顶一致。
import { boardToScreen, markerUnits, screenPointInWorldRect, screenToWorld } from '../render/camera.ts';
import type { Camera } from '../render/camera.ts';
import type { Board, Rect } from '../render/geometry.ts';
import { contains } from '../render/geometry.ts';
import type { TicketPoint } from '../render/scene.ts';
import type { DistrictBox, RoofBox, StationBox } from './map-state.ts';

export type Hit =
  | { readonly kind: 'roof'; readonly roof: number }
  | { readonly kind: 'station'; readonly id: number }
  | { readonly kind: 'ticket'; readonly orderId: number };

/** 窗口和画板：换算用。 */
export interface Surface {
  readonly board: Board;
  readonly camera: Camera;
}

/** 站的屋顶外面多算几个窗口像素，好点。 */
export const STATION_PAD = 4;

/** 点中小票的距离：离小票中心不超过这么多窗口像素。小票在窗口里大约 12 乘 15。 */
export const TICKET_REACH = 11;

/** 点中小票的距离：不小于 TICKET_REACH，窗口很大、小票画得更大时跟着放大。 */
export function ticketReach(camera: Camera): number {
  return Math.max(TICKET_REACH, 12.5 * camera.scale * markerUnits(camera.scale).ticket);
}

/** 鼠标所在位置的站，重叠时取后画的（在上面的）。 */
export function pickStation(surface: Surface, stations: readonly StationBox[], sx: number, sy: number, pad = STATION_PAD): number | null {
  for (let i = stations.length - 1; i >= 0; i--) {
    const s = stations[i] as StationBox;
    if (screenPointInWorldRect(surface.board, surface.camera, s.rect, sx, sy, pad)) return s.id;
  }
  return null;
}

/** 鼠标所在位置的候选屋顶。 */
export function pickRoof(surface: Surface, roofs: readonly RoofBox[], sx: number, sy: number): number | null {
  for (let i = roofs.length - 1; i >= 0; i--) {
    const r = roofs[i] as RoofBox;
    if (screenPointInWorldRect(surface.board, surface.camera, r.rect, sx, sy)) return r.roof;
  }
  return null;
}

/** 鼠标附近最近的一张小票，离中心不超过 reach 个窗口像素。小票挨得近时取最近的。 */
export function pickTicket(surface: Surface, tickets: readonly TicketPoint[], sx: number, sy: number, reach = TICKET_REACH): number | null {
  let best: number | null = null;
  let bestD = reach * reach;
  for (const t of tickets) {
    const p = boardToScreen(surface.camera, t.x, t.y);
    const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
    if (d <= bestD) {
      bestD = d;
      best = t.order;
    }
  }
  return best;
}

/** 点击和悬停要看的东西。 */
export interface MapTargets {
  readonly stations: readonly StationBox[];
  /** 选屋顶时的候选屋顶，不在这个状态时为空。 */
  readonly roofs: readonly RoofBox[];
  readonly tickets: readonly TicketPoint[];
}

/** 鼠标所在位置的东西。 */
export function hitTest(surface: Surface, targets: MapTargets, sx: number, sy: number, buildMode: boolean, reach = TICKET_REACH): Hit | null {
  if (buildMode) {
    const roof = pickRoof(surface, targets.roofs, sx, sy);
    return roof === null ? null : { kind: 'roof', roof };
  }
  const station = pickStation(surface, targets.stations, sx, sy);
  if (station !== null) return { kind: 'station', id: station };
  const order = pickTicket(surface, targets.tickets, sx, sy, reach);
  return order === null ? null : { kind: 'ticket', orderId: order };
}

/** 鼠标所在位置的片区，只认已经开通的。点片区在片区纸条上切换要看的片区。 */
export function pickDistrict(surface: Surface, districts: readonly DistrictBox[], sx: number, sy: number): number | null {
  const p = screenToWorld(surface.board, surface.camera, sx, sy);
  for (const d of districts) {
    if (d.open && contains(d.rect as Rect, p.x, p.y)) return d.index;
  }
  return null;
}

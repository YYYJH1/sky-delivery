// 便签贴在哪里：每张便签说的是一样具体的东西，就贴在那样东西的旁边。
// 订单的小票画在地图上，位置由地图场景给出（窗口坐标），页面上的部件（价签、调度台、开通价签）由页面量出来。
// 这里放两样东西：便签对应的目标，以及在目标旁边挑位置的函数（不压住目标、站、别的小票和页面上的物件，尽量不压地图上的字）。
// 纯函数加一个信号，不碰 DOM。
import { signal } from '@preact/signals';
import { boardToScreen } from '../render/camera.ts';
import type { Camera } from '../render/camera.ts';
import type { TicketPoint } from '../render/scene.ts';
import { ticketReach } from './map-hit.ts';
import { placeLabels } from './map-layout.ts';
import type { Rect } from './map-layout.ts';

/** 便签说的东西：订单的小票，或者页面上带 data-part 的部件。 */
export type TipTarget =
  | { readonly kind: 'order'; readonly urgent: boolean }
  | { readonly kind: 'part'; readonly part: string };

/**
 * 每张便签对应的目标，键是便签的 id。
 * 点订单、自动派单贴在小票旁边，变红的订单那一张贴在变红的小票旁边，调度台、价签和开通价签贴在各自旁边，
 * 起降拥堵和数据员的便签贴在改装的价签旁边。
 * 没有对应目标的 id 返回 null，便签贴在日程纸条旁边。
 */
export function tipTarget(id: string): TipTarget | null {
  switch (id) {
    case 'firstOrder':
    case 'autoDispatchOn':
      return { kind: 'order', urgent: false };
    case 'firstRedOrder':
      return { kind: 'order', urgent: true };
    case 'boardReady':
      return { kind: 'part', part: 'board' };
    case 'canAddBay':
      return { kind: 'part', part: 'tag-bay' };
    case 'gateBusy':
    case 'dataClerk':
      // 数据员的便签说点「推演」，推演的入口在改装单里，贴在改装的价签旁边
      return { kind: 'part', part: 'tag-upgrades' };
    case 'openOffice':
      return { kind: 'part', part: 'open-tag-1' };
    default:
      return null;
  }
}

/** 便签上的字一个字占多宽，加上左右的内边距，设计像素。 */
const TIP_EM = 22;
const TIP_PAD = 36;
/** 便签最窄、最宽多少设计像素。 */
export const TIP_MIN_WIDTH = 204;
export const TIP_MAX_WIDTH = 304;
/** 便签折行的地方：逗号、句号、顿号、分号、冒号、叹号、问号之后。 */
const BREAK_AFTER = String.fromCodePoint(0xff0c, 0x3002, 0x3001, 0xff1b, 0xff1a, 0xff01, 0xff1f);

/**
 * 便签的宽度：十一个字以内一行写完，再长的折成几行，宽度刚好放得下最长的一段（一段到逗号或句号为止）。
 * 这样短的便签窄，贴在窄的地方也放得下，长的便签折在标点后面，不把一个词拆开。
 */
export function tipWidth(text: string): number {
  const chars = [...text].length;
  const longest = Math.max(...text.split(new RegExp(`(?<=[${BREAK_AFTER}])`, 'u')).map((part) => [...part].length));
  const cells = chars <= 11 ? chars : longest;
  return Math.min(TIP_MAX_WIDTH, Math.max(TIP_MIN_WIDTH, cells * TIP_EM + TIP_PAD + 4));
}

/** 便签歪几度：按 id 取，每张便签总是歪同样的角度，不同的便签歪法不一样。 */
const TILTS: readonly number[] = [-2.2, 1.8, -1.2, 2.6, -2.8, 1.2, 2.2];

export function tipTilt(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILTS[h % TILTS.length] ?? 1.6;
}

/** 订单便签要贴的地方：小票在窗口里的框，不能压的东西（站、别的小票），尽量不压的东西（地图上的字）。 */
export interface TipSpot {
  readonly anchor: Rect;
  readonly avoid: readonly Rect[];
  readonly soft: readonly Rect[];
}

/** 订单便签的位置，没有订单便签或者找不到小票时为 null。地图场景每帧更新。 */
export const tipSpot = signal<TipSpot | null>(null);

function sameRects(a: readonly Rect[], b: readonly Rect[]): boolean {
  return a.length === b.length && a.every((r, i) => r.x === b[i]?.x && r.y === b[i]?.y && r.w === b[i]?.w && r.h === b[i]?.h);
}

export function sameSpot(a: TipSpot | null, b: TipSpot | null): boolean {
  if (a === null || b === null) return a === b;
  return sameRects([a.anchor], [b.anchor]) && sameRects(a.avoid, b.avoid) && sameRects(a.soft, b.soft);
}

/**
 * 订单便签贴在哪张小票旁边：urgent 为真时贴最早的一张变红的小票，没有变红的就贴最早的一张，urgent 为假时也贴最早的一张。
 * points 是票杆上等待中的小票在画板上的位置，isUrgent 说一张订单变红没有。订单 id 小的下单早。
 * 站和别的小票不能压，店名和片区名尽量不压。没有小票时返回 null。
 */
export function orderSpot(
  points: readonly TicketPoint[],
  camera: Camera,
  urgent: boolean,
  isUrgent: (order: number) => boolean,
  stations: readonly Rect[],
  texts: readonly Rect[],
): TipSpot | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.order - b.order);
  const target = (urgent ? sorted.find((p) => isUrgent(p.order)) : undefined) ?? (sorted[0] as TicketPoint);
  const reach = ticketReach(camera);
  const box = (p: TicketPoint): Rect => {
    const at = boardToScreen(camera, p.x, p.y);
    return { x: at.x - reach, y: at.y - reach, w: 2 * reach, h: 2 * reach };
  };
  return {
    anchor: box(target),
    avoid: [...stations, ...sorted.filter((p) => p.order !== target.order).map(box)],
    soft: texts,
  };
}

/** 便签离目标的几档距离，窗口像素，紧贴的四个位置都放不下时由近到远试。 */
const RINGS: readonly number[] = [24, 48, 90];

/**
 * 在目标旁边给一张 w 乘 h 的便签挑位置：先试目标的下方、上方、右边、左边，再试离开一段的八个方向，
 * 取第一个不压住目标和 avoid 的，也尽量不压 soft。位置夹在 bounds 里面。返回便签左上角在窗口里的位置。
 */
export function placeTip(w: number, h: number, anchor: Rect, avoid: readonly Rect[], soft: readonly Rect[], bounds: Rect, gap = 10): { left: number; top: number } {
  const placed = placeLabels([{ id: 0, anchor, w, h }], [anchor, ...avoid], bounds, gap, RINGS, soft)[0];
  return placed === undefined ? { left: anchor.x + anchor.w + gap, top: anchor.y } : { left: placed.x, top: placed.y };
}

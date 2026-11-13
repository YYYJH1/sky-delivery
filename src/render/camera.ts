// 镜头：画板坐标和窗口坐标的换算，把已经显示的片区放进窗口的算法，以及镜头从一处挪到另一处的插值。纯函数，不碰 DOM 和 Pixi。
//
// 地图的世界坐标先转一个固定的角度放进画板（geometry.ts），镜头再把画板等比缩放并平移到窗口里：
//   窗口坐标 = 画板坐标 × scale + (x, y)
// 所以屏幕和世界之间的换算要同时考虑这两步：世界到画板有转角，画板到窗口有缩放和偏移。
// 点选、悬停、选中站的小卡的位置、开通价签的位置都用这里的函数，和画出来的东西一致。
import { clamp } from './geometry.ts';
import type { Board, Rect, Vec } from './geometry.ts';

export interface Camera {
  /** 画板的 1 个单位在窗口里是几个逻辑像素。 */
  readonly scale: number;
  /** 画板原点在窗口里的位置，逻辑像素。 */
  readonly x: number;
  readonly y: number;
}

/** 窗口顶部和底部留给界面物件的高度，逻辑像素。 */
export interface Insets {
  readonly top: number;
  readonly bottom: number;
}

/** 数值对齐到设备像素：dpr 为 2 时对齐到半个逻辑像素。 */
export function snapToDevice(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

/**
 * 镜头缩放的上限，对 1920×1080 的窗口。屋顶和街上的细节是按缩放 1 画的，地图不放得比它还大：
 * 再放大，细节就比画的时候还大，纹理要拉伸，也不再是同一个样子。窗口比 1920×1080 大时，
 * 界面物件按窗口等比放大，上限跟着乘同一个倍数。
 */
export const MAX_ZOOM = 1;

/**
 * 把画板上的 content 等比放进 width 乘 height 的窗口，顶部和底部各留 insets，居中。缩放不超过 maxScale。
 * 偏移对齐设备像素，静态层烘焙成设备像素一一对应的纹理之后，画出来才不会发糊。
 */
export function fitCamera(content: Rect, width: number, height: number, insets: Insets, dpr = 1, maxScale = Number.POSITIVE_INFINITY): Camera {
  const paneHeight = Math.max(1, height - insets.top - insets.bottom);
  const scale = Math.min(Math.max(1, width) / content.w, paneHeight / content.h, maxScale);
  const x = (width - content.w * scale) / 2 - content.x * scale;
  const y = insets.top + (paneHeight - content.h * scale) / 2 - content.y * scale;
  return { scale, x: snapToDevice(x, dpr), y: snapToDevice(y, dpr) };
}

// ---- 镜头的移动 ----

/** 片区第一次显示时，镜头拉远到新的外框用多久，毫秒。 */
export const CAMERA_MOVE_MS = 800;

/** 缓动：先慢后快再慢。进度 t 取 0 到 1，输出也是 0 到 1。 */
export function easeInOut(t: number): number {
  const c = clamp(t, 0, 1);
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}

/**
 * 两个镜头之间 t 处的镜头，t 取 0 到 1。缩放和偏移各自线性插值：
 * 窗口坐标是画板坐标的双线性函数，所以画板上的每个点都沿直线从起点的位置挪到终点的位置。
 */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return { scale: a.scale + (b.scale - a.scale) * t, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** 一次镜头的移动：从 from 到 to，从 startMs 起用 durationMs。时间用同一个时钟的毫秒数，由调用者给。 */
export interface CameraMove {
  readonly from: Camera;
  readonly to: Camera;
  readonly startMs: number;
  readonly durationMs: number;
}

/** 移动进行到 nowMs 时的镜头，以及移动是否已经结束。结束时给的就是 to 本身，偏移保持对齐设备像素。 */
export function cameraMoveAt(move: CameraMove, nowMs: number): { readonly camera: Camera; readonly done: boolean } {
  const progress = move.durationMs <= 0 ? 1 : clamp((nowMs - move.startMs) / move.durationMs, 0, 1);
  if (progress >= 1) return { camera: move.to, done: true };
  return { camera: lerpCamera(move.from, move.to, easeInOut(progress)), done: false };
}

export function boardToScreen(camera: Camera, bx: number, by: number): Vec {
  return { x: bx * camera.scale + camera.x, y: by * camera.scale + camera.y };
}

export function screenToBoard(camera: Camera, sx: number, sy: number): Vec {
  return { x: (sx - camera.x) / camera.scale, y: (sy - camera.y) / camera.scale };
}

/** 世界坐标到窗口坐标：先转角放进画板，再缩放平移。 */
export function worldToScreen(board: Board, camera: Camera, x: number, y: number): Vec {
  const b = board.toBoard(x, y);
  return boardToScreen(camera, b.x, b.y);
}

/** 窗口坐标到世界坐标，worldToScreen 的逆。 */
export function screenToWorld(board: Board, camera: Camera, sx: number, sy: number): Vec {
  const b = screenToBoard(camera, sx, sy);
  return board.toWorld(b.x, b.y);
}

/** 世界里的一块矩形在窗口里的外接框：转了角之后矩形不再和窗口的边平行，外接框比它大一点。 */
export function worldRectToScreen(board: Board, camera: Camera, rect: Rect): Rect {
  const b = board.boundsOf(rect);
  return { x: b.x * camera.scale + camera.x, y: b.y * camera.scale + camera.y, w: b.w * camera.scale, h: b.h * camera.scale };
}

/** 窗口盖住画板上的哪一块，画板坐标。 */
export function visibleBoardRect(camera: Camera, width: number, height: number): Rect {
  const a = screenToBoard(camera, 0, 0);
  const b = screenToBoard(camera, width, height);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/**
 * 窗口里的点 (sx, sy) 落在世界里的矩形 rect（左上角加宽高）之内，padPx 是四周多算的窗口像素。
 * 在世界坐标里判断：世界里的矩形是正的，转角由点的换算带上，所以转了角的屋顶也能按它真实的形状点中。
 */
export function screenPointInWorldRect(board: Board, camera: Camera, rect: Rect, sx: number, sy: number, padPx = 0): boolean {
  const p = screenToWorld(board, camera, sx, sy);
  const pad = padPx / camera.scale;
  return p.x >= rect.x - pad && p.x <= rect.x + rect.w + pad && p.y >= rect.y - pad && p.y <= rect.y + rect.h + pad;
}

/** 烘焙静态层的倍率：设备像素每画板单位。静态层烘焙成这个倍率，镜头再按 scale 缩放，纹理像素和设备像素一一对应。 */
export function bakeScaleFor(camera: Camera, dpr: number): number {
  return camera.scale * dpr;
}

/**
 * 会动的东西和文字的放大倍数：地图整张放进窗口时缩放比 1 小得多，飞机、小票和字按缩放比缩小就看不清了。
 * 每一项是 目标缩放 / 镜头缩放，夹在 1 和上限之间：镜头缩放比目标大时不放大（倍数为 1），所以镜头缩放为 1 时画出来的东西不变。
 */
export interface MarkerUnits {
  /** 飞行中的飞机、送餐目的地的接收垫。停在停机位上的飞机跟着屋顶走，不放大。 */
  readonly drone: number;
  /** 票杆上的小票和票杆本身的长度，名次圈。 */
  readonly ticket: number;
  /** 地图上的字：等降落的架数，超出的张数，店名。 */
  readonly text: number;
  /** 送达和退单的记号。 */
  readonly mark: number;
  /** 航线的线宽和虚线的长度。 */
  readonly line: number;
}

const MARKER_TARGETS: Readonly<Record<keyof MarkerUnits, readonly [target: number, max: number]>> = {
  drone: [0.72, 2],
  ticket: [0.9, 2.2],
  text: [0.9, 2.2],
  mark: [0.8, 2],
  line: [0.7, 1.8],
};

export function markerUnits(zoom: number): MarkerUnits {
  const z = Math.max(1e-6, zoom);
  const pick = (key: keyof MarkerUnits): number => {
    const [target, max] = MARKER_TARGETS[key];
    return clamp(target / z, 1, max);
  };
  return { drone: pick('drone'), ticket: pick('ticket'), text: pick('text'), mark: pick('mark'), line: pick('line') };
}

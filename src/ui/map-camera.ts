// 镜头的调度：框住哪几个片区，什么时候开始挪，每一帧挪到哪里。纯逻辑，时间由调用者传进来，不读时钟，不碰 DOM 和 Pixi。
// 开局和读档时镜头直接框住已经显示的片区，没有挪动。之后有片区第一次显示，镜头从现在的位置缓动到新的外框，用 CAMERA_MOVE_MS。
// 窗口大小变了，进行中的挪动作废，镜头直接换成新窗口里的。
import { CAMERA_MOVE_MS, cameraMoveAt } from '../render/camera.ts';
import type { Camera, CameraMove } from '../render/camera.ts';
import type { DistrictMode } from '../render/districts.ts';
import type { Rect } from '../render/geometry.ts';
import { cameraFor, contentFor, framedOf, sameFramed } from './map-state.ts';
import type { Framed, WindowGeometry } from './map-state.ts';

/** 一帧里镜头的情况。 */
export interface CameraStep {
  /** 这一帧的镜头。 */
  readonly camera: Camera;
  /** 镜头要放进窗口的范围，画板坐标，字和标签待在里面。 */
  readonly content: Rect;
  /** 镜头这一帧有没有动过：开始挪、挪的过程中、刚挪完都算。贴着地图上东西的界面物件要重新定位。 */
  readonly moved: boolean;
  /** 这一帧开始了一次挪动，值是它要挪到的镜头。渲染器要先照顾好挪动过程中窗口会看到的地方。 */
  readonly started: Camera | null;
  /** 这一帧挪完了：静态层要按新的倍率重新烘焙。 */
  readonly finished: boolean;
}

export class CameraDirector {
  private view: WindowGeometry;
  private framed: Framed;
  private cam: Camera;
  private region: Rect;
  private move: CameraMove | null = null;

  constructor(view: WindowGeometry, modes: readonly DistrictMode[]) {
    this.view = view;
    this.framed = framedOf(modes);
    this.cam = cameraFor(view, this.framed);
    this.region = contentFor(this.framed);
  }

  get camera(): Camera {
    return this.cam;
  }

  get content(): Rect {
    return this.region;
  }

  /** 镜头正在挪向新的外框。 */
  get moving(): boolean {
    return this.move !== null;
  }

  /** 正在挪向的镜头，没有在挪时为 null。 */
  get target(): Camera | null {
    return this.move === null ? null : this.move.to;
  }

  /**
   * 挪动刚开始时渲染器要先花一点时间准备（把底层铺大），从现在起重新计时，准备的耗时不吃掉挪动的头几帧。
   * 没有在挪的时候什么也不做。
   */
  restartClock(nowMs: number): void {
    if (this.move !== null) this.move = { ...this.move, startMs: nowMs };
  }

  /** 窗口大小变了：进行中的挪动作废，镜头直接换成新窗口里框住同样片区的镜头。 */
  resize(view: WindowGeometry): void {
    this.view = view;
    this.move = null;
    this.cam = cameraFor(view, this.framed);
    this.region = contentFor(this.framed);
  }

  /**
   * 每帧调用一次。modes 是各片区现在的显示状态，nowMs 是这一帧的时间，毫秒。
   * 框住的片区变了（有片区第一次显示）就从现在的镜头起挪向新的外框，上一次的挪动没完时也是从它挪到的位置接着挪。
   */
  update(modes: readonly DistrictMode[], nowMs: number): CameraStep {
    let started: Camera | null = null;
    const next = framedOf(modes);
    if (!sameFramed(next, this.framed)) {
      this.framed = next;
      this.region = contentFor(next);
      const to = cameraFor(this.view, next);
      this.move = { from: this.cam, to, startMs: nowMs, durationMs: CAMERA_MOVE_MS };
      started = to;
    }
    if (this.move === null) return { camera: this.cam, content: this.region, moved: false, started, finished: false };
    const at = cameraMoveAt(this.move, nowMs);
    this.cam = at.camera;
    if (at.done) this.move = null;
    return { camera: this.cam, content: this.region, moved: true, started, finished: at.done };
  }
}

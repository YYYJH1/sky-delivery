// 游戏页面的地图：生成城市，起 PixiJS 的渲染器，镜头框住已经显示的片区，窗口大小变了换镜头，大小定下来再重新烘焙静态层。
// 这个文件碰浏览器（字体、画布、定时器、时钟）和渲染器，页面的其余部分通过它画地图、换算位置。
// 城市只生成一次：它只跟地图数据和种子有关，不跟窗口大小有关，窗口变了只换镜头。
// 片区第一次显示时，镜头在 CAMERA_MOVE_MS 里平滑地拉远到新的外框：这段时间里静态层还是旧倍率烘焙的纹理，随镜头缩放，
// 挪完之后按新的倍率重新烘焙一次。浏览器没有 WebGL 时不画地图，其余照常，见 MapView.drawn。
// 地图的画面状态跟着游戏内的时刻走：每帧按画面时刻算出这一刻是白天、傍晚、夜间，还是两种之间的渐变（render/daynight.ts），交给渲染器。
// 下一种状态在要用之前就一层一层提前烘焙好，烘焙放在空闲的帧里：窗口大小在变和镜头在挪的时候不烘焙。
// 网址里的 look= 是调试参数，给了就固定用那一种，不随时刻变。
import { MAP_V1 } from '../content/map_v1.ts';
import { SHOPS, districtName } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import type { Camera } from '../render/camera.ts';
import { generateCity } from '../render/city.ts';
import type { City, StationRoof } from '../render/city-types.ts';
import type { DistrictMode } from '../render/districts.ts';
import { lookAtStep, looksWithin } from '../render/daynight.ts';
import type { Look } from '../render/look.ts';
import { MapRenderer } from '../render/map-renderer.ts';
import type { RenderFrame, RenderStats } from '../render/map-renderer.ts';
import { HELIPAD_NEAR, citySpecFromMap } from '../render/map-spec.ts';
import { roofsByIndex } from '../render/scene.ts';
import type { TicketPoint } from '../render/scene.ts';
import type { Board } from '../render/geometry.ts';
import type { Surface } from './map-hit.ts';
import { parseGameParams } from './debug-params.ts';
import { CameraDirector } from './map-camera.ts';
import { DISTRICT_RECTS, MAP_PLAN, bayLimitOf, roofIndexOfStation, shopIsOpen } from './map-state.ts';
import type { WindowGeometry } from './map-state.ts';

/** 窗口大小定下来之后过多久重新烘焙静态层，毫秒。窗口大小变化的过程中不烘焙。 */
export const REBAKE_DELAY_MS = 250;

/**
 * 提前多少步烘焙下一种状态：一倍速下是 30 秒，三倍速下是 10 秒。烘焙一种状态要几帧，每帧只烘焙一层，来得及。
 * 只在没有渐变的时候烘焙：白天里提前烘焙傍晚，傍晚保持不变的半小时里提前烘焙夜间。
 * 烘焙好的纹理留着复用，每种状态只烘焙一次，除非窗口大小变了。
 */
export const PREBAKE_AHEAD_STEPS = 300;

export interface MapView {
  readonly city: City;
  readonly board: Board;
  /** 城市里的候选屋顶，按地图里 roofs 的下标取。 */
  readonly roofs: ReadonlyMap<number, StationRoof>;
  /** 载入时各步花的毫秒：生成城市，起渲染器并烘焙第一次。 */
  readonly boot: { readonly cityMs: number; readonly createMs: number };
  /** 地图画出来了没有。浏览器没有 WebGL（或者渲染器起不来）时为假：城市、镜头和位置的换算照常，只是不画。 */
  readonly drawn: boolean;
  camera(): Camera;
  surface(): Surface;
  /** 镜头正在挪向新的外框。 */
  moving(): boolean;
  /** 票杆上等待中的小票在画板上的位置，上一帧画出来的。不画地图时为空。 */
  ticketPoints(): readonly TicketPoint[];
  /** 店名在画板上的框，上一帧画出来的，调试用。不画地图时为空。 */
  nameBoxes(): readonly { readonly shop: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number }[];
  /** 数据员在画板上的外接框，上一帧画出来的，调试用。没到岗，或者不画地图时为空。 */
  clerkBoxes(): readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number }[];
  /** 渲染器的统计，调试用。不画地图时都是 0。 */
  stats(): RenderStats & { readonly tiles: number };
  /** 窗口大小变了：镜头立刻换，静态层等大小定下来之后重新烘焙一次。 */
  resize(view: WindowGeometry): void;
  /**
   * 每帧先调用：按各片区现在的显示状态定镜头要框住的片区，变了就开始挪，并把镜头挪到这一帧的位置。
   * 镜头这一帧动过时返回真，贴着地图上东西的界面物件要跟着重新定位。
   */
  moveCamera(modes: readonly DistrictMode[]): boolean;
  /** 画一帧：更新动态层，画出来。 */
  draw(frame: RenderFrame): void;
  /** 每个模拟步之后调用一次，记下飞机的位置，画尾迹用。 */
  recordStep(state: RenderFrame['state']): void;
  resetHistory(): void;
  destroy(): void;
}

export interface MapViewOptions {
  readonly canvas: HTMLCanvasElement;
  /** 画面状态的起点：第一次烘焙用它，之后每帧按时刻重新定（网址给了 look= 的话固定是它）。 */
  readonly look: Look;
  /** 游戏现在的步数。给了就直接烘焙这一刻用的状态，读档停在傍晚或夜里时省掉一次多余的烘焙。 */
  readonly step?: number;
  readonly view: WindowGeometry;
  /** 各片区现在的显示状态，开局的镜头直接框住已经显示的片区，没有挪动的过程。读档时也是这样。 */
  readonly modes: readonly DistrictMode[];
}

const NO_STATS: RenderStats = { drones: 0, tickets: 0, stations: 0, routeQuads: 0, updateMs: 0, renderMs: 0, bakes: 0, bakeMs: 0, lookFrom: 0, lookTo: 0, mix: 0, staticBytes: 0, looksResident: 0, switchMs: 0 };

/** 网址里的 look= 调试参数。给了就固定用这一种状态，没给（或者没有网址的环境）为 null，按游戏内的时刻变。 */
function pinnedLook(): Look | null {
  if (typeof location === 'undefined') return null;
  return parseGameParams(location.search).look;
}

/** 等字体载入完再烘焙：片区名、站号、店名、手写的字都要用到。载入失败时用系统的字体，不拦着页面。 */
async function loadFonts(): Promise<void> {
  const faces = ['700 30px SkySerif', '20px SkyHand', '16px SkySans'];
  const sample = String.fromCodePoint(0x4e00, 0x31, 0x8001);
  try {
    await Promise.all(faces.map((face) => document.fonts.load(face, sample)));
  } catch {
    // 字体文件读不到，画面里的字退回系统的字体
  }
}

/**
 * 浏览器能不能建 WebGL 的上下文。用一块临时画布试，不碰页面上的画布：
 * 画布一旦要过一种上下文，就换不成另一种了。
 */
export function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    if (gl === null) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export async function createMapView(opts: MapViewOptions): Promise<MapView> {
  const canDraw = webglAvailable();
  if (canDraw) await loadFonts();
  const pinned = pinnedLook();
  const startLook = pinned ?? (opts.step === undefined ? opts.look : lookAtStep(opts.step).from);
  const t0 = performance.now();
  const city = generateCity(citySpecFromMap(MAP_V1, MAP_PLAN.region, HELIPAD_NEAR));
  const t1 = performance.now();
  const director = new CameraDirector(opts.view, opts.modes);
  let renderer: MapRenderer | null = null;
  if (canDraw) {
    try {
      renderer = await MapRenderer.create({
        canvas: opts.canvas,
        width: opts.view.width,
        height: opts.view.height,
        resolution: opts.view.dpr,
        city,
        board: MAP_PLAN.board,
        camera: director.camera,
        content: director.content,
        layout: { kind: 'districts', districts: DISTRICT_RECTS },
        look: startLook,
        fonts: { serif: 'SkySerif', hand: 'SkyHand' },
        sansFont: 'SkySans',
        districtName: (d) => districtName(d as DistrictIndex),
        shopName: (shop) => SHOPS[shop]?.name ?? null,
        roofOfStation: roofIndexOfStation,
        shopOpen: shopIsOpen,
        bayLimit: bayLimitOf,
        seed: MAP_V1.mapSeed,
      });
    } catch (error) {
      // 渲染器起不来：页面照常运行，只是没有地图
      console.error(error);
    }
  }
  const t2 = performance.now();

  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelRebake(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  const view: MapView = {
    city,
    board: MAP_PLAN.board,
    roofs: roofsByIndex(city),
    boot: { cityMs: t1 - t0, createMs: t2 - t1 },
    drawn: renderer !== null,
    camera: () => director.camera,
    surface: () => ({ board: MAP_PLAN.board, camera: director.camera }),
    moving: () => director.moving,
    ticketPoints: () => renderer?.ticketPoints ?? [],
    nameBoxes: () => renderer?.nameBoxes ?? [],
    clerkBoxes: () => renderer?.clerkBoxes ?? [],
    stats: () => ({ ...(renderer?.stats ?? NO_STATS), tiles: renderer?.staticTiles ?? 0 }),
    resize(next) {
      // 窗口大小变了：镜头立刻换成新窗口里的，大小定下来之后再烘焙
      director.resize(next);
      renderer?.setView({ width: next.width, height: next.height, resolution: next.dpr, camera: director.camera, content: director.content });
      cancelRebake();
      timer = setTimeout(() => {
        timer = null;
        renderer?.refreshStatic();
      }, REBAKE_DELAY_MS);
    },
    moveCamera(modes) {
      const step = director.update(modes, performance.now());
      if (step.started !== null) {
        // 有片区第一次显示：先把底层铺到够大，挪动期间窗口会看到更多地方。挪完才烘焙，这段时间里不烘焙
        cancelRebake();
        renderer?.prepareMove(step.started);
        director.restartClock(performance.now());
      }
      if (!step.moved) return false;
      renderer?.setCamera(step.camera, step.content, director.target ?? undefined);
      // 挪完了：按新的倍率把静态层重新烘焙一次
      if (step.finished) renderer?.refreshStatic();
      return true;
    },
    draw(frame) {
      if (renderer === null) return;
      const blend = lookAtStep(frame.nowSteps, pinned);
      renderer.setBlend(blend);
      // 空闲的帧里把接下来要用的状态提前烘焙好：渐变进行中、窗口大小在变（倍率马上要变）和镜头在挪的时候不烘焙，免得卡在渐变的画面上
      if (blend.mix === 0 && timer === null && !director.moving) renderer.warmAhead(looksWithin(frame.nowSteps, PREBAKE_AHEAD_STEPS, pinned));
      renderer.update(frame);
      renderer.render();
    },
    recordStep: (state) => renderer?.recordStep(state),
    resetHistory: () => renderer?.resetHistory(),
    destroy() {
      cancelRebake();
      renderer?.destroy();
    },
  };
  return view;
}

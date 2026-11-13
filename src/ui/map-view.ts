// 游戏页面的地图：生成城市，起 PixiJS 的渲染器，窗口大小变了换镜头，大小定下来再重新烘焙静态层。
// 这个文件碰浏览器（字体、画布、定时器）和渲染器，页面的其余部分通过它画地图、换算位置。
// 城市只生成一次：它只跟地图数据和种子有关，不跟窗口大小有关，窗口变了只换镜头。
import { MAP_V1 } from '../content/map_v1.ts';
import { SHOPS, districtName } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import type { Camera } from '../render/camera.ts';
import { generateCity } from '../render/city.ts';
import type { City, StationRoof } from '../render/city-types.ts';
import type { Look } from '../render/look.ts';
import { MapRenderer } from '../render/map-renderer.ts';
import type { RenderFrame } from '../render/map-renderer.ts';
import { HELIPAD_NEAR, citySpecFromMap } from '../render/map-spec.ts';
import { roofsByIndex } from '../render/scene.ts';
import type { Board } from '../render/geometry.ts';
import type { Surface } from './map-hit.ts';
import { DISTRICT_RECTS, MAP_PLAN, cameraFor, roofIndexOfStation, shopIsOpen } from './map-state.ts';
import type { WindowGeometry } from './map-state.ts';

/** 窗口大小定下来之后过多久重新烘焙静态层，毫秒。窗口大小变化的过程中不烘焙。 */
export const REBAKE_DELAY_MS = 250;

export interface MapView {
  readonly renderer: MapRenderer;
  readonly city: City;
  readonly board: Board;
  /** 城市里的候选屋顶，按地图里 roofs 的下标取。 */
  readonly roofs: ReadonlyMap<number, StationRoof>;
  /** 载入时各步花的毫秒：生成城市，起渲染器并烘焙第一次。 */
  readonly boot: { readonly cityMs: number; readonly createMs: number };
  camera(): Camera;
  surface(): Surface;
  /** 窗口大小变了：镜头立刻换，静态层等大小定下来之后重新烘焙一次。 */
  resize(view: WindowGeometry): void;
  /** 画一帧：更新动态层，画出来。 */
  draw(frame: RenderFrame): void;
  /** 每个模拟步之后调用一次，记下飞机的位置，画尾迹用。 */
  recordStep(state: RenderFrame['state']): void;
  resetHistory(): void;
  destroy(): void;
}

export interface MapViewOptions {
  readonly canvas: HTMLCanvasElement;
  readonly look: Look;
  readonly view: WindowGeometry;
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

export async function createMapView(opts: MapViewOptions): Promise<MapView> {
  await loadFonts();
  const t0 = performance.now();
  const city = generateCity(citySpecFromMap(MAP_V1, MAP_PLAN.region, HELIPAD_NEAR));
  const t1 = performance.now();
  let current = opts.view;
  let camera = cameraFor(current);
  const renderer = await MapRenderer.create({
    canvas: opts.canvas,
    width: current.width,
    height: current.height,
    resolution: current.dpr,
    city,
    board: MAP_PLAN.board,
    camera,
    content: MAP_PLAN.content,
    layout: { kind: 'districts', districts: DISTRICT_RECTS },
    look: opts.look,
    fonts: { serif: 'SkySerif', hand: 'SkyHand' },
    sansFont: 'SkySans',
    districtName: (d) => districtName(d as DistrictIndex),
    shopName: (shop) => SHOPS[shop]?.name ?? null,
    roofOfStation: roofIndexOfStation,
    shopOpen: shopIsOpen,
    seed: MAP_V1.mapSeed,
  });
  const t2 = performance.now();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const view: MapView = {
    renderer,
    city,
    board: MAP_PLAN.board,
    roofs: roofsByIndex(city),
    boot: { cityMs: t1 - t0, createMs: t2 - t1 },
    camera: () => camera,
    surface: () => ({ board: MAP_PLAN.board, camera }),
    resize(next) {
      current = next;
      camera = cameraFor(current);
      renderer.setView({ width: current.width, height: current.height, resolution: current.dpr, camera });
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        renderer.refreshStatic();
      }, REBAKE_DELAY_MS);
    },
    draw(frame) {
      renderer.update(frame);
      renderer.render();
    },
    recordStep: (state) => renderer.recordStep(state),
    resetHistory: () => renderer.resetHistory(),
    destroy() {
      if (timer !== null) clearTimeout(timer);
      renderer.destroy();
    },
  };
  return view;
}

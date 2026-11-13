// 地图的 PixiJS 渲染：输入是核心的状态（只读）和视图设置，输出是画面。不依赖界面层（src/ui），游戏页面（index.html）用它。
//
// 分两层：
// - 静态层：片区底色、街道和街区、屋顶和屋顶物件、树、河、桥、片区名。载入时用 Canvas 2D 画一次，烘焙成纹理（bake.ts、static-layers.ts），
//   每种状态一套。整张地图放进窗口时分片区烘焙，片区的显示状态只换透明度。窗口大小变了、烘焙倍率跟着变时才重新烘焙，平时每帧不烘焙。
//   昼夜渐变时两种状态的静态层叠在一起按比例混合，下一种状态在要用之前就一层一层提前烘焙好，烘焙好的纹理留着复用（setBlend、warmAhead）。
// - 动态层：每帧更新的精灵和对象池：站点和停机位，选中的站，候选屋顶，店的门面和票杆上的小票，飞机和影子，航线（一个网格一次绘制），
//   送餐目的地，送达和退单的记号，等降落的圈和架数，雨。动态层的画法（色板）不渐变：渐变过半时从一种状态换到另一种，
//   两种色板混合出来的墨色和纸色会撞在一起，字和飞机的轮廓就看不清了。
// 画板是屏幕朝向的：世界坐标先转一个固定的角度再摆放（geometry.ts），所以排线永远是 45°。镜头（camera.ts）把画板缩放平移到窗口里，
// 缩放只作用在整个画板上，不影响烘焙。镜头缩放比 1 小时，会动的东西和字按 camera.ts 的 markerUnits 放大一些，才看得清。镜头在片区第一次显示时拉远，
// 拉远的过程中静态层的纹理按旧倍率随镜头缩放，挪完才按新倍率重新烘焙（setCamera、prepareMove、refreshStatic）。
import { Application, Container, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import type { BLEND_MODES } from 'pixi.js';
import { STATION_COLOR_NAMES } from '../content/palette.ts';
import { STR, fmt } from '../content/strings.zh.ts';
import { DroneState, LAND_STEPS, LOW_BATTERY, RANGE, STEPS_PER_SECOND, TAKEOFF_STEPS } from '../core/index.ts';
import type { Drone, SimState } from '../core/index.ts';
import { grainTile } from './bake.ts';
import { bakeScaleFor, boardToScreen, markerUnits, screenToBoard, visibleBoardRect } from './camera.ts';
import type { Camera, MarkerUnits } from './camera.ts';
import type { City, ShopFront, StationRoof } from './city-types.ts';
import { assignDistricts } from './districts.ts';
import type { DistrictMode } from './districts.ts';
import { dominantLook } from './daynight.ts';
import type { LookBlend } from './daynight.ts';
import { clipOutside, headingOf, inflate, lerp, moveClear, overlapArea, unionRect } from './geometry.ts';
import type { Board, Rect, Vec } from './geometry.ts';
import { slotSize } from './layout.ts';
import { LOOK_NAMES, hexToInt, mixColor, palFor, stationColor, themeFor } from './look.ts';
import type { Look, Theme } from './look.ts';
import { districtFootprints, placeNames } from './names.ts';
import type { NameSite, NameWorld } from './names.ts';
import { QuadBatch } from './quads.ts';
import { createRand, mixSeed } from './rng.ts';
import {
  HOLD_OMEGA,
  SlotTracker,
  TrailTracker,
  activeMarks,
  destinations,
  firstOrderSince,
  frontDepth,
  frontPoint,
  frontZone,
  holdEase,
  holdingSlots,
  nearestStationOf,
  orbitOffset,
  placeTickets,
  railEnds,
  roofsByIndex,
  simplify,
  slotWorldPositions,
  stationRoofRect,
  waitingTickets,
} from './scene.ts';
import type { TicketPoint } from './scene.ts';
import { MIN_MIX, StaticLayers } from './static-layers.ts';
import type { StaticLayout } from './static-layers.ts';
import { Atlas, DynamicTextures, SPIN_FRAMES, TEXTURE_RESOLUTION } from './textures.ts';
import type { FontNames } from './textures.ts';

// ---- 对象池 ----
class Pool<T extends Container> {
  private readonly items: T[] = [];
  private used = 0;
  private readonly make: () => T;
  private readonly parent: Container;

  constructor(parent: Container, make: () => T) {
    this.parent = parent;
    this.make = make;
  }

  begin(): void {
    this.used = 0;
  }

  next(): T {
    if (this.used === this.items.length) {
      const item = this.make();
      this.parent.addChild(item);
      this.items.push(item);
    }
    const item = this.items[this.used++] as T;
    item.visible = true;
    return item;
  }

  end(): void {
    for (let i = this.used; i < this.items.length; i++) (this.items[i] as T).visible = false;
  }

  get active(): number {
    return this.used;
  }

  destroy(): void {
    for (const item of this.items) item.destroy();
    this.items.length = 0;
  }
}

export interface MapRendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** 画面的逻辑大小，像素。 */
  readonly width: number;
  readonly height: number;
  /** 设备像素比。 */
  readonly resolution: number;
  readonly city: City;
  readonly board: Board;
  /** 镜头：画板怎样放进窗口，窗口大小变了用 setView 换。 */
  readonly camera: Camera;
  /** 画板上字和标签要待在里面的范围，缺省是窗口盖住的那一块画板。 */
  readonly content?: Rect;
  /** 静态层的分法，缺省整块烘焙成一层。 */
  readonly layout?: StaticLayout;
  readonly look: Look;
  readonly fonts: FontNames;
  /** 小字（店名）的字体。 */
  readonly sansFont: string;
  readonly districtName: (district: number) => string;
  /** 店名。没有名字时不写。 */
  readonly shopName: (shop: number) => string | null;
  /** 站点建在哪块候选屋顶上（地图里 roofs 的下标）。没有时用站点的坐标另画一块默认大小的屋顶。 */
  readonly roofOfStation: (state: SimState, station: number) => number | null;
  /** 店有没有开张。 */
  readonly shopOpen: (state: SimState, shop: number) => boolean;
  /** 站所在的屋顶最多放几个停机位。停机位按它排好位置，买新的停机位时已停的飞机不动。没有时（沙盒模式）按现有的个数排。 */
  readonly bayLimit?: (state: SimState, station: number) => number | null;
  /** 整块烘焙时静态层的烘焙倍率，缺省取设备像素比。分片区烘焙时倍率由镜头缩放乘设备像素比定，不用这一项。 */
  readonly bakeScale?: number;
  /** 烘焙的种子。 */
  readonly seed: number;
}

/** 窗口和镜头，窗口大小变了换一次。 */
export interface ViewSettings {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly camera: Camera;
  /** 画板上字和标签要待在里面的范围，不给就不变。 */
  readonly content?: Rect;
}

/** 选屋顶时要画的一块候选屋顶。 */
export interface RoofFrame {
  /** 候选屋顶的序号：地图里 roofs 的下标。 */
  readonly roof: number;
  /** 鼠标在它上面。 */
  readonly hovered: boolean;
  /** 现在买得起，买不起的画淡一点。 */
  readonly ok: boolean;
}

/** 每一帧的输入。 */
export interface RenderFrame {
  readonly state: SimState;
  /** 画面时刻在上一步和当前步之间的位置，0 到 1。 */
  readonly alpha: number;
  /** 上一步结束时各飞机的位置，按飞机编号。 */
  readonly prevX: ArrayLike<number>;
  readonly prevY: ArrayLike<number>;
  /** 画面时刻，步，可以带小数。 */
  readonly nowSteps: number;
  /** 派单名次：订单编号到名次（从 1 起）。只标 rankLimit 以内的。 */
  readonly ranks: ReadonlyMap<number, number>;
  readonly rankLimit: number;
  /** 各片区现在的样子，下标是片区序号。不给就都当作开通。整块烘焙时不用。 */
  readonly districts?: readonly DistrictMode[];
  /** 选中的站，画一圈粗框。 */
  readonly selected?: number | null;
  /** 选屋顶时要画的候选屋顶。 */
  readonly roofs?: readonly RoofFrame[];
  /** 界面物件盖着的地方，窗口坐标：等降落的字躲开它们，免得被小卡之类挡住。 */
  readonly reserved?: readonly Rect[];
}

export interface RenderStats {
  drones: number;
  tickets: number;
  stations: number;
  routeQuads: number;
  /** 上一帧更新精灵和航线花的毫秒。 */
  updateMs: number;
  /** 上一帧提交绘制花的毫秒，只是 CPU 这边的时间，不含 GPU 画完的时间。 */
  renderMs: number;
  /** 静态层烘焙了几次，最近一次花的毫秒。 */
  bakes: number;
  bakeMs: number;
  /** 静态层现在显示的两种状态，值是它们在 LOOK_NAMES 里的下标：下面一种和上面一种。不在渐变时两个相同。 */
  lookFrom: number;
  lookTo: number;
  /** 上面一种状态叠在下面一种上的比例，0 到 1。不在渐变时是 0。 */
  mix: number;
  /** 烘焙好的静态层纹理一共占多少字节（RGBA），所有状态加起来，以及有几种状态的纹理在内存里。 */
  staticBytes: number;
  looksResident: number;
  /** 动态层最近一次换画法（图集、动态纹理、字、纸纹重画）花的毫秒。 */
  switchMs: number;
}

const PARKED_SCALE = 0.44;
/** 航线的粗细：载货 4，空飞 2.6，指向目的地的点线 1.6。 */
const LOADED_WIDTH = 4;
const EMPTY_WIDTH = 2.6;
const LEAD_WIDTH = 1.6;
const TAIL_ALPHA: readonly number[] = [0.34, 0.64, 1];
const LEAD_ALPHA = 0.8;
const NO_MODES: readonly DistrictMode[] = [];

function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

export class MapRenderer {
  readonly app: Application;
  readonly stats: RenderStats = { drones: 0, tickets: 0, stations: 0, routeQuads: 0, updateMs: 0, renderMs: 0, bakes: 0, bakeMs: 0, lookFrom: 0, lookTo: 0, mix: 0, staticBytes: 0, looksResident: 0, switchMs: 0 };
  /** 上一次 update 里挂在票杆上的小票，画板坐标。 */
  readonly ticketPoints: TicketPoint[] = [];
  /** 上一次 update 里画出来的店名的框，画板坐标。选屋顶的文字用它躲开店名，也给调试用。 */
  readonly nameBoxes: { shop: number; x: number; y: number; w: number; h: number }[] = [];
  private readonly opts: MapRendererOptions;
  private readonly layout: StaticLayout;
  private readonly staticRoot = new Container();
  private readonly grainHolder = new Container();
  private readonly camera = new Container();
  private readonly layers = {
    frames: new Container(),
    shops: new Container(),
    stations: new Container(),
    selection: new Container(),
    parked: new Container(),
    dest: new Container(),
    routes: new Container(),
    marks: new Container(),
    tickets: new Container(),
    shadows: new Container(),
    drones: new Container(),
    labels: new Container(),
  };
  private statics!: StaticLayers;
  private theme: Theme;
  private atlas: Atlas;
  private dyn: DynamicTextures;
  /** 动态层现在用的画法：渐变过半之前是下面一种状态，过半之后是上面一种。 */
  private look: Look;
  /** 静态层现在显示的：下面一种满不透明度，上面一种按比例叠上去。 */
  private blend: LookBlend;
  private width: number;
  private height: number;
  private resolution: number;
  private cam: Camera;
  private content: Rect | null;
  private units: MarkerUnits;
  private grain: TilingSprite | null = null;
  private readonly slotTracker = new SlotTracker();
  private readonly trails = new TrailTracker();
  private readonly headings = new Map<number, number>();
  private readonly stationRoofs: Map<number, StationRoof>;
  private tail: QuadBatch[][] = [];
  private lead: QuadBatch[] = [];
  private pools!: {
    shopFronts: Pool<Sprite>;
    shopNames: Pool<Sprite>;
    stationRoofs: Pool<Sprite>;
    selection: Pool<Sprite>;
    roofFrames: Pool<Sprite>;
    slots: Pool<Sprite>;
    parked: Pool<Sprite>;
    dest: Pool<Sprite>;
    rings: Pool<Sprite>;
    marks: Pool<Sprite>;
    tickets: Pool<Sprite>;
    digits: Pool<Sprite>;
    shadows: Pool<Sprite>;
    drones: Pool<Sprite>;
    holdTexts: Pool<Text>;
    overflowTexts: Pool<Text>;
  };
  private textResolution = 2;
  private rainFar: TilingSprite | null = null;
  private rainNear: TilingSprite | null = null;
  private lastSeconds = 0;
  /** 上一次 update 的墙上时间，毫秒。片区的淡入淡出按它走，游戏暂停时也在走。第一次 update 时没有，片区直接到位。 */
  private lastWallMs: number | null = null;
  private readonly frontByShop = new Map<number, ShopFront>();
  /** 分片区烘焙时店名按现在的字号重新挑位置用的：城市里的屋顶，每个片区的街区范围，每座屋顶在哪个片区。整块烘焙时没有。 */
  private readonly nameWorld: NameWorld | null;
  private readonly footprints: readonly (readonly Rect[])[];
  private readonly districtOfBuilding: Int8Array | null;
  /** 店名摆好的位置，同样的字号和同样的开张的店不重新挑。 */
  private nameCache: { key: string; origins: ReadonlyMap<number, Vec> } | null = null;
  /** 镜头正在挪向的那个镜头的放大倍数：挪动期间店名按挪完之后的字号挑位置，不随每帧的缩放跳来跳去。 */
  private moveUnits: MarkerUnits | null = null;

  private constructor(app: Application, opts: MapRendererOptions) {
    this.app = app;
    this.opts = opts;
    this.layout = opts.layout ?? { kind: 'whole' };
    this.look = opts.look;
    this.blend = { from: opts.look, to: opts.look, mix: 0 };
    this.width = opts.width;
    this.height = opts.height;
    this.resolution = opts.resolution;
    this.cam = opts.camera;
    this.content = opts.content ?? null;
    this.units = markerUnits(opts.camera.scale);
    this.theme = themeFor(opts.look);
    this.atlas = new Atlas(this.theme, opts.fonts, this.mipmaps);
    this.dyn = new DynamicTextures(this.theme, opts.fonts, this.mipmaps);
    for (const f of opts.city.shops) this.frontByShop.set(f.shop, f);
    this.stationRoofs = roofsByIndex(opts.city);
    if (this.layout.kind === 'districts') {
      this.nameWorld = { buildings: opts.city.buildings.map((b) => b.rect), roofs: opts.city.stations.map((r) => r.rect) };
      this.footprints = districtFootprints(opts.city, this.layout.districts);
      this.districtOfBuilding = assignDistricts(opts.city, this.layout.districts).buildings;
    } else {
      this.nameWorld = null;
      this.footprints = [];
      this.districtOfBuilding = null;
    }
  }

  /** 镜头缩放比 1 小时，动态纹理缩小的倍数不是整数，开 mipmap 才不会闪。整块烘焙是 1 比 1 的，不开。 */
  private get mipmaps(): boolean {
    return this.layout.kind === 'districts';
  }

  /** 建渲染器：起 Pixi，烘焙当前状态的静态层，摆好各层。字体要在这之前加载好。 */
  static async create(opts: MapRendererOptions): Promise<MapRenderer> {
    const app = new Application();
    await app.init({
      canvas: opts.canvas,
      width: opts.width,
      height: opts.height,
      resolution: opts.resolution,
      autoDensity: false,
      antialias: false,
      backgroundAlpha: 1,
      background: themeFor(opts.look).pal.paper,
      preference: 'webgl',
      autoStart: false,
      sharedTicker: false,
      powerPreference: 'high-performance',
      // 点选和悬停由页面自己处理，Pixi 的事件系统不需要
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    const r = new MapRenderer(app, opts);
    r.build();
    return r;
  }

  private build(): void {
    const { camera, layers } = this;
    this.applyCamera();
    for (const layer of Object.values(layers)) camera.addChild(layer);
    this.app.stage.addChild(this.staticRoot);
    this.app.stage.addChild(this.grainHolder);
    this.app.stage.addChild(camera);
    this.statics = new StaticLayers(this.staticRoot, {
      city: this.opts.city,
      board: this.opts.board,
      layout: this.layout,
      seed: this.opts.seed,
      districtName: this.opts.districtName,
      labelFont: this.opts.fonts.serif,
    });
    this.refreshStatic();
    this.buildGrain();

    const mk = (layer: Container, texture: Texture): Pool<Sprite> => new Pool<Sprite>(layer, () => new Sprite(texture));
    this.textResolution = this.pickTextResolution();
    this.pools = {
      shopFronts: mk(layers.shops, Texture.WHITE),
      shopNames: mk(layers.shops, Texture.WHITE),
      stationRoofs: mk(layers.stations, Texture.WHITE),
      selection: mk(layers.selection, Texture.WHITE),
      roofFrames: mk(layers.frames, Texture.WHITE),
      slots: mk(layers.stations, this.atlas.get('slot')),
      parked: mk(layers.parked, this.atlas.drone(0, 0, 0, false, false)),
      dest: mk(layers.dest, this.atlas.get('dest:0')),
      rings: mk(layers.routes, Texture.WHITE),
      marks: mk(layers.marks, this.atlas.get('cancel')),
      tickets: mk(layers.tickets, this.atlas.ticket('ok', 0, 10)),
      digits: mk(layers.labels, this.atlas.get('digit:1')),
      shadows: mk(layers.shadows, this.atlas.shadow(0)),
      drones: mk(layers.drones, this.atlas.drone(0, 0, 0, true, false)),
      holdTexts: new Pool<Text>(layers.labels, () => this.makeText(22, this.theme.pal.ink)),
      overflowTexts: new Pool<Text>(layers.labels, () => this.makeText(21, this.theme.pal.red)),
    };
    // 航线：每种站点颜色三档尾迹加一档点线，各一个网格
    const blend = this.routeBlend();
    this.tail = STATION_COLOR_NAMES.map((_, c) =>
      TAIL_ALPHA.map((a) => {
        const batch = new QuadBatch(4096, hexToInt(stationColor(this.theme.pal, c)), a, blend);
        layers.routes.addChild(batch.mesh);
        return batch;
      }),
    );
    this.lead = STATION_COLOR_NAMES.map((_, c) => {
      const batch = new QuadBatch(4096, hexToInt(stationColor(this.theme.pal, c)), LEAD_ALPHA, blend);
      layers.routes.addChild(batch.mesh);
      return batch;
    });
    this.buildRain();
  }

  private routeBlend(): BLEND_MODES {
    return this.theme.dark ? 'normal' : 'multiply';
  }

  // ---- 镜头和窗口 ----
  private applyCamera(): void {
    for (const c of [this.staticRoot, this.camera]) {
      c.position.set(this.cam.x, this.cam.y);
      c.scale.set(this.cam.scale);
    }
  }

  /** 画板上窗口盖住的那一块。 */
  private visible(): Rect {
    return visibleBoardRect(this.cam, this.width, this.height);
  }

  /** 静态层烘焙的倍率：整块烘焙时取设备像素比（取整），分片区烘焙时是 镜头缩放 × 设备像素比。 */
  private bakeScale(): number {
    if (this.layout.kind === 'whole') return this.opts.bakeScale ?? Math.min(2, Math.max(1, Math.round(this.resolution)));
    return bakeScaleFor(this.cam, this.resolution);
  }

  /** Pixi 的字的分辨率：够用就行，字在窗口里画出来多大，纹理就按多大的设备像素烘焙。 */
  private pickTextResolution(): number {
    if (this.layout.kind === 'whole') return Math.max(2, this.resolution);
    return Math.max(1, Math.ceil(this.resolution * this.cam.scale * this.units.text));
  }

  /**
   * 换窗口大小和镜头。立刻生效：画板按新的镜头摆放，静态层的纹理按新的比例拉伸，一时有点糊。
   * 静态层的重新烘焙要另外调 refreshStatic：窗口大小变化的过程中不用每次都烘焙，定下来再烘焙一次。
   */
  setView(view: ViewSettings): void {
    const resChanged = view.resolution !== this.resolution;
    this.width = view.width;
    this.height = view.height;
    this.resolution = view.resolution;
    this.app.renderer.resize(view.width, view.height, view.resolution);
    for (const rain of [this.rainFar, this.rainNear]) {
      if (rain !== null) {
        rain.width = view.width;
        rain.height = view.height;
      }
    }
    if (resChanged) this.buildGrain();
    else this.layoutGrain();
    this.setCamera(view.camera, view.content);
  }

  /**
   * 只换镜头，窗口大小不变，立刻生效：画板按新的镜头摆放，静态层的纹理按新的比例拉伸，会动的东西和字的放大倍数按新的缩放重算。
   * 镜头在几十帧里逐帧挪动时每帧调用它，很便宜，moveTo 是它要挪到的镜头，挪动期间店名按挪完之后的字号挑位置。
   * 静态层的重新烘焙要另外调 refreshStatic，挪完之后烘焙一次。
   */
  setCamera(camera: Camera, content?: Rect, moveTo?: Camera): void {
    this.cam = camera;
    if (content !== undefined) this.content = content;
    this.moveUnits = moveTo === undefined ? null : markerUnits(moveTo.scale);
    this.units = markerUnits(camera.scale);
    this.applyCamera();
    const textRes = this.pickTextResolution();
    if (textRes !== this.textResolution) {
      this.textResolution = textRes;
      this.rebuildTexts();
    }
  }

  /** 现在显示着的状态：没有渐变时一种，渐变中两种。 */
  private displayed(): Look[] {
    return this.blend.mix > 0 ? [this.blend.from, this.blend.to] : [this.blend.from];
  }

  /** 把现在的画面摆到静态层上。要显示的状态都要先烘焙好。纹理没有换过时只改不透明度。 */
  private showStatics(): void {
    this.statics.show(this.blend.from, this.blend.to, this.blend.mix);
    this.stats.lookFrom = LOOK_NAMES.indexOf(this.blend.from);
    this.stats.lookTo = LOOK_NAMES.indexOf(this.blend.to);
    this.stats.mix = this.blend.mix;
  }

  private syncBakeStats(): void {
    this.stats.bakes = this.statics.bakes;
    this.stats.bakeMs = this.statics.lastBakeMs;
    this.stats.staticBytes = this.statics.textureBytes();
    this.stats.looksResident = this.statics.bakedLooks().length;
  }

  /**
   * 镜头马上要挪向 target：先让底层（河）盖住挪动过程中窗口会看到的全部地方。
   * 底层只烘焙窗口盖住的一块，镜头拉远之后窗口盖住的更大，所以这里把现在和 target 两处窗口盖住的并集都烘焙进去，倍率还是现在的。
   * 其余各层是整个片区一块，已经烘焙好了，不用动。挪完之后调 refreshStatic，按新的倍率把所有层重新烘焙一次。
   * 渐变期间显示着两种状态，两种都要铺大。
   */
  prepareMove(target: Camera): void {
    const cover = unionRect(this.visible(), visibleBoardRect(target, this.width, this.height));
    for (const look of this.displayed()) this.statics.ensure(look, this.bakeScale(), cover);
    this.showStatics();
    this.syncBakeStats();
  }

  /** 静态层要不要重新烘焙：倍率变了，或者窗口比烘焙的范围大了。 */
  get staticStale(): boolean {
    return this.displayed().some((look) => this.statics.needsBake(look, this.bakeScale(), this.visible()));
  }

  /** 重新烘焙静态层，没有要烘焙的就什么也不做。返回这次烘焙花的毫秒。显示着的状态都要烘焙，倍率变了的话别的状态的纹理作废。 */
  refreshStatic(): number {
    let ms = 0;
    for (const look of this.displayed()) ms += this.statics.ensure(look, this.bakeScale(), this.visible());
    this.showStatics();
    this.syncBakeStats();
    return ms;
  }

  /** 把另一种状态的静态层也烘焙好，一次一种，每烘焙一种返回。切换时就不用等。 */
  warm(look: Look): void {
    this.statics.ensure(look, this.bakeScale(), this.visible());
    this.syncBakeStats();
  }

  /**
   * 把接下来要用的状态提前烘焙好：空闲时每帧调用一次，一次只烘焙一层，把耗时摊到几帧里。
   * looks 是接下来一段时间里要用到的状态。烘焙好的纹理留着复用，一天里每种状态只烘焙一次，窗口大小变了才重新烘焙。
   * 窗口刚变过、静态层还没按新的倍率烘焙时什么也不做。返回这次花的毫秒，没有要烘焙的为 0。
   */
  warmAhead(looks: readonly Look[]): number {
    const scale = this.bakeScale();
    const resident = this.statics.scale();
    if (resident !== null && Math.abs(resident - scale) > 1e-9) return 0;
    let ms = 0;
    for (const look of looks) {
      ms = this.statics.bakeOne(look, scale, this.visible());
      if (ms > 0) break;
    }
    if (ms > 0) {
      // 显示着的状态的某一层重新烘焙过（窗口比烘焙的范围大了）时，换上新的纹理
      this.showStatics();
      this.syncBakeStats();
    }
    return ms;
  }

  /**
   * 换这一刻的画面：静态层下面一种状态满不透明度，上面一种按比例叠上去，底色按同样的比例混合。
   * 动态层的画法渐变过半时换一次，不渐变（见文件开头）。
   * 要显示的状态没烘焙好就现在补上，平时已经由 warmAhead 提前烘焙好了。每帧调用都行，没有变化时只比较几个值。
   */
  setBlend(blend: LookBlend): void {
    const mix = blend.to !== blend.from && blend.mix > MIN_MIX ? Math.min(1, blend.mix) : 0;
    const next: LookBlend = { from: blend.from, to: mix > 0 ? blend.to : blend.from, mix };
    const prev = this.blend;
    if (next.from !== prev.from || next.to !== prev.to || next.mix !== prev.mix) {
      this.blend = next;
      let baked = false;
      for (const look of this.displayed()) {
        if (this.statics.hasAll(look)) continue;
        // 倍率和已有的纹理一致：窗口大小变化的过程中，正在显示的纹理不会被换掉
        this.statics.ensure(look, this.statics.scale() ?? this.bakeScale(), this.visible());
        baked = true;
      }
      this.showStatics();
      this.app.renderer.background.color = mixColor(palFor(next.from).paper, palFor(next.to).paper, next.mix);
      if (baked) this.syncBakeStats();
    }
    const look = dominantLook(this.blend);
    if (look !== this.look) this.applyDynamicLook(look);
  }

  /** 固定用一种状态，不渐变。 */
  setLook(look: Look): void {
    this.setBlend({ from: look, to: look, mix: 0 });
  }

  /** 动态层换一种画法：图集和动态纹理按新色板重画，航线的混合模式、字的描边和纸纹跟着换。 */
  private applyDynamicLook(look: Look): void {
    const t0 = performance.now();
    this.look = look;
    this.theme = themeFor(look);
    this.atlas.destroy();
    this.dyn.destroy();
    this.atlas = new Atlas(this.theme, this.opts.fonts, this.mipmaps);
    this.dyn = new DynamicTextures(this.theme, this.opts.fonts, this.mipmaps);
    const mode = this.routeBlend();
    for (const batch of [...this.tail.flat(), ...this.lead]) batch.setBlendMode(mode);
    this.rebuildTexts();
    this.buildGrain();
    this.updateRainVisibility();
    this.stats.switchMs = performance.now() - t0;
  }

  /** 手写体的字，纸白描边。描边的颜色跟着状态的纸面走，所以换状态时要重建。 */
  private makeText(size: number, fill: string): Text {
    return new Text({
      text: '',
      style: { fontFamily: this.opts.fonts.hand, fontSize: size, fill, stroke: { color: this.theme.pal.paper, width: 4, join: 'round' } },
      resolution: this.textResolution,
    });
  }

  private rebuildTexts(): void {
    this.pools.holdTexts.destroy();
    this.pools.overflowTexts.destroy();
    this.pools.holdTexts = new Pool<Text>(this.layers.labels, () => this.makeText(22, this.theme.pal.ink));
    this.pools.overflowTexts = new Pool<Text>(this.layers.labels, () => this.makeText(21, this.theme.pal.red));
  }

  /** 动态层现在用的画法对应的状态。 */
  get currentLook(): Look {
    return this.look;
  }

  /** 静态层现在显示的画面。 */
  get currentBlend(): LookBlend {
    return this.blend;
  }

  /** 静态层现在有多少块纹理，调试用。 */
  get staticTiles(): number {
    return this.statics.tileCount();
  }

  // ---- 纸纹 ----
  /**
   * 分片区烘焙时纸纹不在静态层里，而是盖在整个窗口上的一层平铺图，设备像素一比一，在静态层和会动的东西之间。
   * 整块烘焙时纸纹已经画在静态层里了。
   */
  private buildGrain(): void {
    if (this.layout.kind !== 'districts') return;
    if (this.grain !== null) {
      this.grain.texture.destroy(true);
      this.grain.destroy();
      this.grain = null;
    }
    const tex = Texture.from(grainTile(this.theme, mixSeed(this.opts.seed, 21)), true);
    tex.source.addressMode = 'repeat';
    tex.source.resolution = this.resolution;
    tex.source.scaleMode = 'nearest';
    const sprite = new TilingSprite({ texture: tex, width: this.width, height: this.height });
    this.grainHolder.addChild(sprite);
    this.grain = sprite;
  }

  private layoutGrain(): void {
    if (this.grain === null) return;
    this.grain.width = this.width;
    this.grain.height = this.height;
  }

  // ---- 雨 ----
  private buildRain(): void {
    const make = (seed: number, count: number, length: number, alpha: number): TilingSprite => {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      const rand = createRand(seed);
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.1;
      // 斜向的细线：向右下倾约 14 度，雨线首尾相接地平铺，所以画两次让穿过边缘的线不断
      for (let i = 0; i < count; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const len = length * (0.7 + 0.6 * rand());
        for (const [ox, oy] of [[0, 0], [size, 0], [0, size], [-size, 0], [0, -size]] as const) {
          ctx.beginPath();
          ctx.moveTo(x + ox, y + oy);
          ctx.lineTo(x + ox + len * 0.25, y + oy + len * 0.97);
          ctx.strokeStyle = `rgba(${this.inkRgb()},${alpha})`;
          ctx.stroke();
        }
      }
      const tex = Texture.from(canvas, true);
      tex.source.addressMode = 'repeat';
      const sprite = new TilingSprite({ texture: tex, width: this.width, height: this.height });
      sprite.visible = false;
      this.app.stage.addChild(sprite);
      return sprite;
    };
    this.rainFar = make(5, 38, 16, 0.3);
    this.rainNear = make(9, 22, 26, 0.38);
    this.updateRainVisibility();
  }

  private inkRgb(): string {
    const n = hexToInt(this.theme.pal.ink);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }

  private updateRainVisibility(): void {
    const rain = this.look === 'rain';
    if (this.rainFar !== null) this.rainFar.visible = rain;
    if (this.rainNear !== null) this.rainNear.visible = rain;
  }

  // ---- 飞机的历史 ----
  /** 每个模拟步之后调用一次：记下各飞机的位置，画尾迹用。 */
  recordStep(state: SimState): void {
    this.trails.record(state);
  }

  /** 状态跳了（读档、快进之后）：清掉尾迹和停机位的记忆。 */
  resetHistory(): void {
    this.trails.reset();
    this.slotTracker.reset();
    this.headings.clear();
  }

  // ---- 每帧 ----
  update(frame: RenderFrame): void {
    const t0 = performance.now();
    const { state, nowSteps } = frame;
    const board = this.opts.board;
    const U = this.units;
    const seconds = nowSteps / STEPS_PER_SECOND;
    const dt = Math.max(0, Math.min(0.1, seconds - this.lastSeconds));
    this.lastSeconds = seconds;
    const P = this.pools;
    for (const pool of Object.values(P)) pool.begin();
    this.ticketPoints.length = 0;
    this.nameBoxes.length = 0;
    const wallDt = this.lastWallMs === null ? Number.POSITIVE_INFINITY : Math.max(0, (t0 - this.lastWallMs) / 1000);
    this.lastWallMs = t0;
    this.statics.setModes(frame.districts ?? NO_MODES, wallDt);

    // 选屋顶时的候选屋顶
    for (const r of frame.roofs ?? []) {
      const roof = this.stationRoofs.get(r.roof);
      if (roof === undefined) continue;
      const spr = P.roofFrames.next();
      const tex = this.dyn.roofFrame(roof.rect.w, roof.rect.h, r.hovered);
      spr.texture = tex;
      spr.anchor.set(tex.defaultAnchor?.x ?? 0, tex.defaultAnchor?.y ?? 0);
      const p = board.toBoard(roof.rect.x, roof.rect.y);
      spr.position.set(p.x, p.y);
      spr.rotation = board.angle;
      spr.scale.set(1);
      spr.alpha = r.ok ? 1 : 0.62;
    }

    // 站点
    const slotOf = this.slotTracker.update(state);
    const { slots: holdSlot, counts: holdCount } = holdingSlots(state, nowSteps);
    const stationGeo = new Map<number, { rect: Rect; center: Vec; slots: Vec[]; radius: number }>();
    const roofRects: Rect[] = [];
    const pendingHold: { cx: number; cy: number; radius: number; count: number }[] = [];
    /** 画板上已经被占着的地方：站点屋顶、店的门面和票杆、店名、界面物件盖着的地方，等降落的字要躲开。 */
    const occupied: Rect[] = [];
    for (const r of frame.reserved ?? []) {
      occupied.push({ x: (r.x - this.cam.x) / this.cam.scale, y: (r.y - this.cam.y) / this.cam.scale, w: r.w / this.cam.scale, h: r.h / this.cam.scale });
    }
    for (const st of state.stations) {
      if (st.removed) continue;
      const { rect, center } = stationRoofRect(this.stationRoofs, state, st.id, this.opts.roofOfStation(state, st.id));
      const limit = this.opts.bayLimit?.(state, st.id) ?? st.bays;
      const slots = slotWorldPositions(rect.x, rect.y, rect.w, rect.h, st.bays, limit);
      const radius = Math.max(60, Math.sqrt(rect.w * rect.w + rect.h * rect.h) / 2 + 16);
      stationGeo.set(st.id, { rect, center, slots, radius });
      roofRects.push(inflate(rect, 3));
      const color = st.id % STATION_COLOR_NAMES.length;
      const base = P.stationRoofs.next();
      const tex = this.dyn.station({ w: Math.round(rect.w), h: Math.round(rect.h), color, number: String(st.id + 1) });
      base.texture = tex;
      base.anchor.set(tex.defaultAnchor?.x ?? 0, tex.defaultAnchor?.y ?? 0);
      const p = board.toBoard(rect.x, rect.y);
      base.position.set(p.x, p.y);
      base.rotation = board.angle;
      base.scale.set(1);
      // 选中的站：外面一圈粗框
      if (frame.selected === st.id) {
        const sel = P.selection.next();
        const st2 = this.dyn.selection(rect.w, rect.h);
        sel.texture = st2;
        sel.anchor.set(st2.defaultAnchor?.x ?? 0, st2.defaultAnchor?.y ?? 0);
        sel.position.set(p.x, p.y);
        sel.rotation = board.angle;
        sel.scale.set(1);
      }
      // 停机位
      const size = slotSize(rect.h, st.bays, limit);
      for (const sp of slots) {
        const slot = P.slots.next();
        const q = board.toBoard(sp.x, sp.y);
        slot.texture = this.atlas.get('slot');
        slot.anchor.set(0.5, 0.5);
        slot.position.set(q.x, q.y);
        slot.rotation = board.angle;
        slot.scale.set(size / 17);
      }
      // 等降落的圈和架数
      const count = holdCount.get(st.id) ?? 0;
      if (count > 0) {
        const ring = P.rings.next();
        const rt = this.dyn.holdRing(color, radius, U.line);
        ring.texture = rt;
        ring.anchor.set(rt.defaultAnchor?.x ?? 0.5, rt.defaultAnchor?.y ?? 0.5);
        const c = board.toBoard(center.x, center.y);
        ring.position.set(c.x, c.y);
        ring.rotation = seconds * 0.35;
        ring.scale.set(1);
        ring.blendMode = this.routeBlend();
        ring.alpha = 0.9;
        pendingHold.push({ cx: c.x, cy: c.y, radius, count });
      }
      occupied.push(board.boundsOf(rect));
    }
    this.stats.stations = P.stationRoofs.active;

    // 店的门面和票杆上的小票
    const first = firstOrderSince(state, Math.floor(nowSteps) - 2400);
    const shops = waitingTickets(state, nowSteps, first);
    const open = new Set<number>();
    const depth = frontDepth(U.ticket);
    const placedNames = this.shopNameOrigins(state);
    for (const front of this.opts.city.shops) {
      if (!this.opts.shopOpen(state, front.shop)) continue;
      open.add(front.shop);
      const [r0, r1] = railEnds(front, U.ticket);
      const tex = this.dyn.shopFront(front.awningStart, front.awningWidth, r0, r1);
      const spr = P.shopFronts.next();
      spr.texture = tex;
      spr.anchor.set(tex.defaultAnchor?.x ?? 0, tex.defaultAnchor?.y ?? 0);
      const p = board.toBoard(front.origin.x, front.origin.y);
      spr.position.set(p.x, p.y);
      spr.rotation = board.angle + (front.angle * Math.PI) / 180;
      spr.scale.set(1);
      const corners = [frontPoint(front, r0 - 6, 0), frontPoint(front, r1 + 6, 0), frontPoint(front, r0 - 6, depth), frontPoint(front, r1 + 6, depth)].map((w) => board.toBoard(w.x, w.y));
      const zx0 = Math.min(...corners.map((q) => q.x));
      const zy0 = Math.min(...corners.map((q) => q.y));
      const zone: Rect = { x: zx0, y: zy0, w: Math.max(...corners.map((q) => q.x)) - zx0, h: Math.max(...corners.map((q) => q.y)) - zy0 };
      occupied.push(zone);
      const name = this.opts.shopName(front.shop);
      if (name !== null) {
        const nt = this.dyn.label(name, this.opts.sansFont, 13);
        const ns = P.shopNames.next();
        ns.texture = nt;
        ns.anchor.set(nt.defaultAnchor?.x ?? 0, nt.defaultAnchor?.y ?? 0);
        // 分片区烘焙时店名的位置是按现在的字号重新挑的，整块烘焙时用城市生成时挑的
        const origin = placedNames?.get(front.shop) ?? front.name;
        const q = board.toBoard(origin.x, origin.y);
        ns.position.set(q.x, q.y);
        ns.rotation = board.angle;
        ns.scale.set(U.text);
        // 店名也算占着的地方，等降落的字不压在它上面
        const lw = nt.width * U.text;
        const lh = nt.height * U.text;
        const ax = (nt.defaultAnchor?.x ?? 0) * lw;
        const ay = (nt.defaultAnchor?.y ?? 0) * lh;
        const cos = Math.cos(board.angle);
        const sin = Math.sin(board.angle);
        const nameCorners = (
          [
            [-ax, -ay],
            [lw - ax, -ay],
            [-ax, lh - ay],
            [lw - ax, lh - ay],
          ] as const
        ).map(([lx, ly]) => ({ x: q.x + lx * cos - ly * sin, y: q.y + lx * sin + ly * cos }));
        const nx0 = Math.min(...nameCorners.map((c) => c.x));
        const ny0 = Math.min(...nameCorners.map((c) => c.y));
        const nameRect: Rect = { x: nx0, y: ny0, w: Math.max(...nameCorners.map((c) => c.x)) - nx0, h: Math.max(...nameCorners.map((c) => c.y)) - ny0 };
        // 小票放大之后票杆和小票伸得更远，可能压住店名：把店名挪到小票和票杆外面。不放大时城市生成已经让开了。
        // 重新挑过位置的店名已经躲开了自己的门面，不用再挪
        const away = placedNames === null && U.ticket > 1 ? moveClear(nameRect, zone, occupied.slice(0, -1)) : { x: 0, y: 0 };
        let shown = nameRect;
        if (away.x !== 0 || away.y !== 0) {
          ns.position.set(q.x + away.x, q.y + away.y);
          shown = { x: nameRect.x + away.x, y: nameRect.y + away.y, w: nameRect.w, h: nameRect.h };
        }
        occupied.push(shown);
        this.nameBoxes.push({ shop: front.shop, ...shown });
      }
    }
    let ticketCount = 0;
    for (const group of shops) {
      const front = this.frontByShop.get(group.shop);
      if (front === undefined || !open.has(group.shop)) continue;
      const color = Math.max(0, group.nearestStation) % STATION_COLOR_NAMES.length;
      for (const placed of placeTickets(front, group.shown, U.ticket)) {
        const t = placed.ticket;
        const sprite = P.tickets.next();
        sprite.texture = this.atlas.ticket(t.state, color, t.bar);
        sprite.anchor.set(sprite.texture.defaultAnchor?.x ?? 0.5, sprite.texture.defaultAnchor?.y ?? 0);
        const p = board.toBoard(placed.clip.x, placed.clip.y);
        sprite.position.set(p.x, p.y);
        sprite.rotation = board.angle + (front.angle * Math.PI) / 180 + (placed.tilt * Math.PI) / 180;
        sprite.scale.set(U.ticket);
        ticketCount += 1;
        const cp = board.toBoard(placed.center.x, placed.center.y);
        this.ticketPoints.push({ order: t.order, x: cp.x, y: cp.y });
        const rank = frame.ranks.get(t.order);
        if (rank !== undefined && rank <= frame.rankLimit) {
          const dt2 = this.atlas.digit(rank);
          if (dt2 !== null) {
            const d = P.digits.next();
            d.texture = dt2;
            d.anchor.set(0.5, 0.5);
            const dp = board.toBoard(placed.rank.x, placed.rank.y);
            d.position.set(dp.x, dp.y);
            d.rotation = 0;
            d.scale.set(U.ticket);
          }
        }
      }
      if (group.overflow > 0) {
        const [, r1] = railEnds(front, U.ticket);
        const text = P.overflowTexts.next();
        const label = fmt(STR.hud.overflow, { count: group.overflow });
        if (text.text !== label) text.text = label;
        text.anchor.set(0, 0.5);
        const w = frontPoint(front, r1 + 8 * U.ticket, 14.2 + 5.8 * U.ticket);
        const p = board.toBoard(w.x, w.y);
        text.position.set(p.x, p.y);
        text.rotation = 0;
        text.scale.set(U.text);
      }
    }
    this.stats.tickets = ticketCount;
    this.placeHoldLabels(pendingHold, occupied, P.holdTexts);

    // 送餐目的地
    for (const dest of destinations(state)) {
      const spr = P.dest.next();
      spr.texture = this.atlas.get(dest.active ? 'dest:1' : 'dest:0');
      spr.anchor.set(0.5, 0.5);
      const p = board.toBoard(dest.x, dest.y);
      spr.position.set(p.x, p.y);
      spr.rotation = board.angle;
      spr.scale.set(U.mark);
    }

    // 送达和退单的记号
    for (const mark of activeMarks(state, nowSteps, first)) {
      const spr = P.marks.next();
      spr.texture = this.atlas.get(mark.kind);
      spr.anchor.set(0.5, 0.5);
      // 退单的叉留在票杆的左端，原来挂小票的地方旁边
      const front = mark.shop >= 0 ? this.frontByShop.get(mark.shop) : undefined;
      const at = front === undefined ? mark : frontPoint(front, railEnds(front, U.ticket)[0] - 11 * U.mark, 14);
      const p = board.toBoard(at.x, at.y);
      spr.position.set(p.x, p.y);
      spr.rotation = board.angle;
      spr.scale.set(U.mark);
      spr.alpha = mark.alpha;
    }

    // 飞机、影子、航线
    for (const batch of [...this.tail.flat(), ...this.lead]) batch.begin();
    let droneCount = 0;
    for (const d of state.drones) {
      if (d.removed) continue;
      droneCount += 1;
      this.placeDrone(frame, d, stationGeo, slotOf, holdSlot, seconds, roofRects, P);
    }
    this.stats.drones = droneCount;
    let quads = 0;
    for (const batch of [...this.tail.flat(), ...this.lead]) {
      batch.end();
      quads += batch.quads;
    }
    this.stats.routeQuads = quads;
    for (const pool of Object.values(P)) pool.end();

    // 雨
    if (this.look === 'rain' && this.rainFar !== null && this.rainNear !== null) {
      this.rainFar.tilePosition.x += 18 * dt;
      this.rainFar.tilePosition.y += 210 * dt;
      this.rainNear.tilePosition.x += 34 * dt;
      this.rainNear.tilePosition.y += 330 * dt;
    }
    this.stats.updateMs = performance.now() - t0;
  }

  private placeDrone(
    frame: RenderFrame,
    d: Drone,
    geo: Map<number, { rect: Rect; center: Vec; slots: Vec[]; radius: number }>,
    slotOf: Map<number, number>,
    holdSlot: ReturnType<typeof holdingSlots>['slots'],
    seconds: number,
    roofRects: readonly Rect[],
    P: MapRenderer['pools'],
  ): void {
    const { state, alpha, nowSteps } = frame;
    const board = this.opts.board;
    const U = this.units;
    const color = d.home % STATION_COLOR_NAMES.length;
    const low = d.battery < LOW_BATTERY * RANGE;
    const station = d.station >= 0 ? geo.get(d.station) : undefined;
    const slotPos = station !== undefined && slotOf.has(d.id) ? station.slots[slotOf.get(d.id) as number] : undefined;
    let x = lerp(frame.prevX[d.id] ?? d.x, d.x, alpha);
    let y = lerp(frame.prevY[d.id] ?? d.y, d.y, alpha);
    let scale = 1;
    let altitude = 0.85;
    let casing = true;
    let parked = false;
    let heading: number | null = null;
    switch (d.state) {
      case DroneState.Dock:
      case DroneState.TakeoffQueue:
        if (station !== undefined && slotPos !== undefined) {
          x = slotPos.x;
          y = slotPos.y;
        } else if (station !== undefined) {
          x = station.center.x;
          y = station.center.y;
        }
        parked = true;
        scale = PARKED_SCALE;
        altitude = 0;
        casing = false;
        break;
      case DroneState.Takeoff: {
        const p = ease(1 - (d.tEnd - nowSteps) / TAKEOFF_STEPS);
        if (station !== undefined && slotPos !== undefined) {
          x = lerp(slotPos.x, station.center.x, p);
          y = lerp(slotPos.y, station.center.y, p);
        }
        scale = lerp(PARKED_SCALE, 1, p);
        altitude = p;
        casing = p > 0.35;
        const stop = d.route[0];
        if (stop !== undefined) {
          const order = state.orders[stop.order];
          const m = order === undefined ? undefined : state.world.merchants[order.merchant];
          if (m !== undefined) heading = headingOf(x, y, m.x, m.y);
        }
        break;
      }
      case DroneState.Land: {
        const p = ease(1 - (d.tEnd - nowSteps) / LAND_STEPS);
        if (station !== undefined && slotPos !== undefined) {
          x = lerp(station.center.x, slotPos.x, p);
          y = lerp(station.center.y, slotPos.y, p);
        }
        scale = lerp(1, PARKED_SCALE, p);
        altitude = 1 - p;
        casing = p < 0.65;
        break;
      }
      case DroneState.LandQueue: {
        const slot = holdSlot.get(d.id);
        if (station !== undefined) {
          const e = holdEase(nowSteps - d.queuedAt);
          if (slot !== undefined) {
            const o = orbitOffset(station.radius, slot.index, slot.count, seconds);
            x = lerp(station.center.x, station.center.x + o.x, e);
            y = lerp(station.center.y, station.center.y + o.y, e);
            // 顺时针转，机头朝切线方向
            heading = headingOf(0, 0, -o.y, o.x);
          } else {
            x = station.center.x;
            y = station.center.y;
          }
        }
        altitude = 0.8;
        break;
      }
      default:
        break;
    }
    if (d.state === DroneState.Fly) {
      heading = headingOf(x, y, d.tx, d.ty);
      this.drawRoute(d, x, y, color, roofRects, board);
    }
    const bp = board.toBoard(x, y);
    // 朝向：世界里的朝向加上画板的转角
    let h = heading === null ? this.headings.get(d.id) : heading + board.angle;
    if (h === undefined) h = board.angle;
    if (d.state === DroneState.Fly && Math.hypot(d.tx - x, d.ty - y) < 0.5) h = this.headings.get(d.id) ?? h;
    this.headings.set(d.id, h);
    const cargo = d.onboard.length === 0 ? 0 : d.load >= 2 || d.onboard.length >= 2 ? 2 : 1;
    if (parked) {
      const spr = P.parked.next();
      spr.texture = this.atlas.drone(color, 0, 0, false, low);
      spr.anchor.set(0.5, 0.5);
      spr.position.set(bp.x, bp.y);
      spr.rotation = board.angle;
      spr.scale.set(scale);
      return;
    }
    // 飞起来之后才放大：停在停机位上的飞机跟着屋顶的大小走，升空时越高放得越大
    const drawScale = scale * (1 + (U.drone - 1) * Math.min(1, altitude));
    const frameIndex = Math.floor(seconds * 16 + d.id * 3) % SPIN_FRAMES;
    const spr = P.drones.next();
    spr.texture = this.atlas.drone(color, cargo, frameIndex, casing, low);
    spr.anchor.set(0.5, 0.5);
    spr.position.set(bp.x, bp.y);
    spr.rotation = h;
    spr.scale.set(drawScale);
    if (altitude > 0.02) {
      const sh = P.shadows.next();
      sh.texture = this.atlas.shadow(cargo);
      sh.anchor.set(0.5, 0.5);
      sh.position.set(bp.x + 7 * altitude * drawScale, bp.y + 9 * altitude * drawScale);
      sh.rotation = h;
      sh.scale.set(drawScale);
      sh.alpha = this.theme.shadowAlpha;
    }
  }

  /**
   * 分片区烘焙时给开着的店重新挑店名的位置（names.ts），按字号和开张的店缓存，字号和开张的店没变就不重新挑。
   * 整块烘焙时返回 null，店名用城市生成时挑的位置。返回的是字的原点（左端基线），世界坐标。
   */
  private shopNameOrigins(state: SimState): ReadonlyMap<number, Vec> | null {
    const world = this.nameWorld;
    const buildingDistrict = this.districtOfBuilding;
    if (world === null || buildingDistrict === null) return null;
    const units = this.moveUnits ?? this.units;
    const fronts = this.opts.city.shops.filter((f) => this.opts.shopOpen(state, f.shop) && this.opts.shopName(f.shop) !== null);
    const key = `${units.text}|${units.ticket}|${fronts.map((f) => f.shop).join(',')}`;
    if (this.nameCache !== null && this.nameCache.key === key) return this.nameCache.origins;
    const sites: NameSite[] = fronts.map((front) => {
      const nt = this.dyn.label(this.opts.shopName(front.shop) as string, this.opts.sansFont, 13);
      const w = nt.width * units.text;
      const h = nt.height * units.text;
      const district = buildingDistrict[front.building] as number;
      return {
        shop: front.shop,
        front,
        zone: frontZone(front, units.ticket),
        rail: railEnds(front, units.ticket),
        depth: frontDepth(units.ticket),
        size: { w, h, ax: (nt.defaultAnchor?.x ?? 0) * w, ay: (nt.defaultAnchor?.y ?? 0) * h },
        footprint: this.footprints[district] ?? [],
      };
    });
    const origins = placeNames(sites, world);
    this.nameCache = { key, origins };
    return origins;
  }

  /**
   * 站点上空「{n} 架等降落」的字：先试圈的正上方，再试右上、左上、下面、两侧，取压住别的东西最少的位置，
   * 躲开站点屋顶、店的门面和票杆、店名、已经放好的字，也尽量不出画面。
   */
  private placeHoldLabels(list: readonly { cx: number; cy: number; radius: number; count: number }[], occupied: readonly Rect[], pool: Pool<Text>): void {
    const placed: Rect[] = [];
    const view: Rect = this.content ?? this.visible();
    const k = this.units.text;
    for (const h of list) {
      const text = pool.next();
      const label = fmt(STR.hud.holding, { count: h.count });
      if (text.text !== label) text.text = label;
      text.anchor.set(0.5, 0.5);
      text.rotation = 0;
      text.scale.set(k);
      const w = text.width;
      const ht = text.height;
      const r = h.radius;
      const candidates: Vec[] = [
        { x: h.cx - 6 * k, y: h.cy - r - 14 * k },
        { x: h.cx + r * 0.75 + w / 2 - 20 * k, y: h.cy - r * 0.9 - 8 * k },
        { x: h.cx - r * 0.75 - w / 2 + 20 * k, y: h.cy - r * 0.9 - 8 * k },
        { x: h.cx - 6 * k, y: h.cy + r + 16 * k },
        { x: h.cx + r + w / 2 + 6 * k, y: h.cy },
        { x: h.cx - r - w / 2 - 6 * k, y: h.cy },
        { x: h.cx + r * 0.75 + w / 2 - 20 * k, y: h.cy + r * 0.9 + 10 * k },
        { x: h.cx - r * 0.75 - w / 2 + 20 * k, y: h.cy + r * 0.9 + 10 * k },
      ];
      let best = candidates[0] as Vec;
      let bestScore = Infinity;
      for (const c of candidates) {
        const box: Rect = { x: c.x - w / 2, y: c.y - ht / 2, w, h: ht };
        let score = 0;
        for (const o of occupied) score += overlapArea(box, o);
        for (const o of placed) score += 3 * overlapArea(box, o);
        score += 4 * (w * ht - overlapArea(box, view));
        if (score < bestScore) {
          bestScore = score;
          best = c;
          if (score === 0) break;
        }
      }
      text.position.set(best.x, best.y);
      placed.push({ x: best.x - w / 2, y: best.y - ht / 2, w, h: ht });
    }
  }

  /** 航线：尾迹（三段逐段变淡，载货实线，空飞虚线）和指向目的地的点线，都在站点屋顶之外。 */
  private drawRoute(d: Drone, x: number, y: number, color: number, roofRects: readonly Rect[], board: Board): void {
    const k = this.units.line;
    const hist = this.trails.history(d.id);
    const pts: { x: number; y: number; loaded: boolean }[] = [...hist, { x, y, loaded: d.onboard.length > 0 }];
    const n = pts.length;
    if (n >= 2) {
      const buckets = 3;
      for (let b = 0; b < buckets; b++) {
        const lo = Math.floor(((n - 1) * b) / buckets);
        const hi = Math.floor(((n - 1) * (b + 1)) / buckets);
        if (hi <= lo) continue;
        // 这一档里按载货与否分成连续的几段
        let j = lo;
        while (j < hi) {
          const loaded = (pts[j + 1] as { loaded: boolean }).loaded;
          let m = j + 1;
          while (m < hi && (pts[m + 1] as { loaded: boolean }).loaded === loaded) m++;
          const run = simplify(pts.slice(j, m + 1));
          const batch = (this.tail[color] as QuadBatch[])[b] as QuadBatch;
          for (const piece of this.clipRun(run, roofRects)) {
            const flat = piece.flatMap((p) => {
              const q = board.toBoard(p.x, p.y);
              return [q.x, q.y];
            });
            if (loaded) batch.solid(flat, LOADED_WIDTH * k);
            else batch.dashed(flat, EMPTY_WIDTH * k, 7 * k, 6 * k, 0);
          }
          j = m;
        }
      }
    }
    // 指向目的地的点线
    const lead = this.lead[color] as QuadBatch;
    for (const piece of this.clipRun([{ x, y }, { x: d.tx, y: d.ty }], roofRects)) {
      const flat = piece.flatMap((p) => {
        const q = board.toBoard(p.x, p.y);
        return [q.x, q.y];
      });
      lead.dashed(flat, LEAD_WIDTH * k, 1.5 * k, 6 * k, 0);
    }
  }

  /** 折线被站点屋顶盖住的部分去掉，返回屋顶之外的几段折线。 */
  private clipRun(run: readonly Vec[], rects: readonly Rect[]): Vec[][] {
    let pieces: Vec[][] = [run.slice()];
    for (const r of rects) {
      const next: Vec[][] = [];
      for (const piece of pieces) {
        let current: Vec[] = [];
        for (let i = 0; i + 1 < piece.length; i++) {
          const a = piece[i] as Vec;
          const b = piece[i + 1] as Vec;
          const outside = clipOutside(a.x, a.y, b.x, b.y, r);
          if (outside.length === 0) {
            if (current.length > 1) next.push(current);
            current = [];
            continue;
          }
          for (const seg of outside) {
            const start = { x: seg[0], y: seg[1] };
            const end = { x: seg[2], y: seg[3] };
            const last = current[current.length - 1];
            if (last === undefined || Math.abs(last.x - start.x) > 1e-6 || Math.abs(last.y - start.y) > 1e-6) {
              if (current.length > 1) next.push(current);
              current = [start];
            }
            current.push(end);
          }
        }
        if (current.length > 1) next.push(current);
      }
      pieces = next;
    }
    return pieces;
  }

  /** 画出这一帧。 */
  render(): void {
    const t0 = performance.now();
    this.app.render();
    this.stats.renderMs = performance.now() - t0;
  }

  /** 屏幕坐标（画面逻辑像素）对应的世界坐标。 */
  screenToWorld(sx: number, sy: number): Vec {
    const b = screenToBoard(this.cam, sx, sy);
    return this.opts.board.toWorld(b.x, b.y);
  }

  worldToScreen(x: number, y: number): Vec {
    const b = this.opts.board.toBoard(x, y);
    return boardToScreen(this.cam, b.x, b.y);
  }

  /** 现在的镜头。 */
  get currentCamera(): Camera {
    return this.cam;
  }

  destroy(): void {
    this.statics.destroy();
    this.app.destroy(false, { children: true, texture: true });
  }

  /** 供调试：图集分辨率。 */
  static readonly textureResolution = TEXTURE_RESOLUTION;

  /** 供调试：站点圈的转速。 */
  static readonly holdOmega = HOLD_OMEGA;

  /** 供测试和页面用：离某个点最近的站。 */
  nearestStation(state: SimState, x: number, y: number): number {
    return nearestStationOf(state, x, y);
  }
}

// 静态地图层的管理：烘焙，上传成纹理，摆成精灵，随片区的状态换透明度。
// 两种分法：
// - whole：整块画板烘焙成一层，带纸面和纸纹。同一份数据画出同一张图。
// - districts：河一层（铺满窗口，一直流到窗口的边），桥一层，每个片区各一层，透明底。片区的状态变了只是换这一层的透明度，不用重新烘焙。
// 烘焙倍率是 镜头缩放 × 设备像素比，纹理像素和设备像素一一对应。倍率变了（窗口大小变了）才要重新烘焙，
// 同一个倍率下换状态（白天、夜间……）是另一套烘焙好的纹理，换起来不用等。这个文件碰 Pixi 和画布。
// 同一时刻最多显示两种状态：下面一种满不透明度，渐变期间上面一种按比例叠上去，所以每一层有两个容器，各摆一种状态的纹理。
// 河是半透明的蓝色线条，各种状态里画得一样，纸面的颜色由渲染器的底色给，所以河只烘焙一套，所有状态共用，只摆在下面一层。
// 窗口那么大的纹理只有河这一层，别的层都只盖一个片区，所以多存一种状态只多存片区那几层。
// 每种状态烘焙好的纹理留着复用，只有倍率变了才全部作废。烘焙一层是一整块同步的画布绘制，
// 提前烘焙时一次只烘焙一个片区的一层，把耗时摊到几帧里。
import { Container, Sprite, Texture } from 'pixi.js';
import { bakeStaticLayer } from './bake.ts';
import type { Baked } from './bake.ts';
import type { City } from './city-types.ts';
import { DISTRICT_MARGIN, approachAlpha, assignDistricts, cityOfDistrict, modeAlpha, riverCity } from './districts.ts';
import type { DistrictMode } from './districts.ts';
import type { Board, Rect } from './geometry.ts';
import { themeFor } from './look.ts';
import type { Look } from './look.ts';

export type StaticLayout =
  | { readonly kind: 'whole' }
  | { readonly kind: 'districts'; readonly districts: readonly Rect[]; readonly margin?: number };

export interface StaticLayersOptions {
  readonly city: City;
  readonly board: Board;
  readonly layout: StaticLayout;
  readonly seed: number;
  readonly districtName: (district: number) => string;
  readonly labelFont: string;
}

/** 一层的定义：画哪些东西，烘焙画板上的哪一块。 */
interface LayerDef {
  readonly key: string;
  /** 片区序号，河、桥和整块是 -1。 */
  readonly district: number;
  readonly city: City;
  readonly paper: boolean;
  readonly grain: boolean;
  readonly river: boolean;
  /** 各种状态里画得一样：只烘焙一套，所有状态共用，只摆在下面一层。 */
  readonly shared: boolean;
  /** 烘焙的范围，画板坐标。河随窗口，其余固定。 */
  area(visible: Rect): Rect;
}

interface BakedLayer {
  readonly def: LayerDef;
  readonly baked: Baked;
  readonly textures: readonly Texture[];
}

interface LayerSet {
  readonly scale: number;
  readonly layers: Map<string, BakedLayer>;
  /** 烘焙或重新烘焙过一层就加一，摆精灵时据此知道纹理换过没有。 */
  version: number;
}

/** 一种状态占一套精灵：每一层一个容器。 */
interface Slot {
  readonly containers: Map<string, Container>;
  /** 现在摆着的是哪一套烘焙的哪一版，没有摆为 null。共用的那套只摆在下面一层。 */
  placed: { readonly set: LayerSet; readonly version: number; readonly shared: LayerSet | null; readonly sharedVersion: number } | null;
}

/** 河比窗口多烘焙一圈，窗口小幅变大时不用重新烘焙。画板单位。 */
const BASE_PAD = 48;
/** 河向两端延长多少，画板单位。 */
const RIVER_REACH = 6000;
/** 渐变的比例小到这个数以下时不叠第二套：叠上去的颜色差不到一级。 */
export const MIN_MIX = 1 / 255;
/** 烘焙出来不到这么多像素的层很便宜，提前烘焙时不单独占一帧。 */
const TINY_PIXELS = 64 * 1024;

function unionRect(a: Rect | null, b: Rect): Rect {
  if (a === null) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

function inflateRect(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/**
 * 把一块范围对齐到烘焙的像素格：左上角落在 1 / scale 的整数倍上，宽高乘 scale 是整数。
 * 镜头的偏移已经对齐设备像素，所以这一块纹理画出来，每个纹理像素正好盖一个设备像素。
 */
export function snapArea(area: Rect, scale: number): Rect {
  const x0 = Math.floor(area.x * scale);
  const y0 = Math.floor(area.y * scale);
  const x1 = Math.ceil((area.x + area.w) * scale);
  const y1 = Math.ceil((area.y + area.h) * scale);
  return { x: x0 / scale, y: y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale };
}

function covers(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x + 1e-6 && outer.y <= inner.y + 1e-6 && outer.x + outer.w >= inner.x + inner.w - 1e-6 && outer.y + outer.h >= inner.y + inner.h - 1e-6;
}

/** 一层纹理占的字节数：画布的像素数乘 4（RGBA）。 */
function layerBytes(layer: BakedLayer): number {
  let bytes = 0;
  for (const tile of layer.baked.tiles) bytes += tile.canvas.width * tile.canvas.height * 4;
  return bytes;
}

function setBytes(set: LayerSet): number {
  let bytes = 0;
  for (const layer of set.layers.values()) bytes += layerBytes(layer);
  return bytes;
}

export class StaticLayers {
  private readonly opts: StaticLayersOptions;
  private readonly defs: readonly LayerDef[];
  /** 下标 0 是下面一层，满不透明度。下标 1 叠在上面，不透明度是渐变的比例。 */
  private readonly slots: readonly [Slot, Slot];
  private readonly sets = new Map<Look, LayerSet>();
  /** 各状态共用的那些层，没有这样的层或者还没烘焙时为 null。 */
  private common: LayerSet | null = null;
  /** 各片区这一层现在的不透明度，下标是片区序号。 */
  private readonly fade: number[] = [];
  private shown: { readonly from: Look; readonly to: Look; readonly mix: number } | null = null;
  /** 累计烘焙次数和最近一次的耗时，毫秒，调试和性能记录用。每次调用烘焙了至少一层算一次。 */
  bakes = 0;
  lastBakeMs = 0;

  constructor(root: Container, opts: StaticLayersOptions) {
    this.opts = opts;
    this.defs = this.makeDefs();
    const below: Slot = { containers: new Map<string, Container>(), placed: null };
    const above: Slot = { containers: new Map<string, Container>(), placed: null };
    // 同一层的两个容器挨着放：上面一种状态叠在同一层的上面，不越过上一层的内容
    for (const def of this.defs) {
      for (const slot of [below, above]) {
        const container = new Container();
        slot.containers.set(def.key, container);
        root.addChild(container);
      }
    }
    this.slots = [below, above];
  }

  get layout(): StaticLayout {
    return this.opts.layout;
  }

  private makeDefs(): LayerDef[] {
    const { city, board, layout } = this.opts;
    if (layout.kind === 'whole') {
      return [{ key: 'all', district: -1, city, paper: true, grain: true, river: true, shared: false, area: () => ({ x: 0, y: 0, w: board.width, h: board.height }) }];
    }
    const margin = layout.margin ?? DISTRICT_MARGIN;
    const membership = assignDistricts(city, layout.districts, margin);
    const water = riverCity(city);
    const defs: LayerDef[] = [
      {
        key: 'river',
        district: -1,
        city: { ...water, bridges: [] },
        paper: false,
        grain: false,
        river: true,
        shared: true,
        area: (visible) => inflateRect(visible, BASE_PAD),
      },
    ];
    if (water.bridges.length > 0) {
      // 桥面是纸白的，桥边是线条，随状态换颜色，只盖桥那一小块
      let box: Rect | null = null;
      for (const b of water.bridges) box = unionRect(box, board.boundsOf(b.rect));
      const area = inflateRect(box ?? { x: 0, y: 0, w: 1, h: 1 }, 6);
      defs.push({ key: 'bridges', district: -1, city: water, paper: false, grain: false, river: false, shared: false, area: () => area });
    }
    layout.districts.forEach((_, index) => {
      const part = cityOfDistrict(city, membership, index);
      // 这一层要烘焙的范围：成员街区的外接框（转了角之后在画板上的外接框），四周多一圈放阴影、描边和片区名
      let box: Rect | null = null;
      for (const b of part.blocks) box = unionRect(box, board.boundsOf(b.rect));
      for (const l of part.labels) box = unionRect(box, board.boundsOf({ x: l.x - 90, y: l.y - 30, w: 180, h: 60 }));
      const area = inflateRect(box ?? { x: 0, y: 0, w: 1, h: 1 }, 28);
      defs.push({ key: `d${String(index)}`, district: index, city: part, paper: false, grain: false, river: false, shared: false, area: () => area });
    });
    return defs;
  }

  /** 这一层所在的那套烘焙：共用的层在共用的一套里，别的在这个状态的一套里。 */
  private holder(def: LayerDef, set: LayerSet | undefined): LayerSet | undefined {
    return def.shared ? (this.common ?? undefined) : set;
  }

  /** 这一层现在要不要烘焙：没烘焙过，或者河不再盖住窗口。 */
  private stale(def: LayerDef, set: LayerSet | undefined, visible: Rect): boolean {
    const layer = this.holder(def, set)?.layers.get(def.key);
    if (layer === undefined) return true;
    return def.key === 'river' && !covers(layer.baked.area, visible);
  }

  /** 这个状态要不要重新烘焙：倍率变了，或者有一层没烘焙过，或者河不再盖住窗口。 */
  needsBake(look: Look, scale: number, visible: Rect): boolean {
    const set = this.sets.get(look);
    if (set === undefined || Math.abs(set.scale - scale) > 1e-9) return true;
    if (this.common !== null && Math.abs(this.common.scale - scale) > 1e-9) return true;
    return this.defs.some((def) => this.stale(def, set, visible));
  }

  /** 这个状态的每一层都烘焙过了，不管倍率对不对，河盖不盖得住窗口。能显示就够了，换倍率另有重新烘焙。 */
  hasAll(look: Look): boolean {
    const set = this.sets.get(look);
    if (set === undefined) return false;
    return this.defs.every((def) => this.holder(def, set)?.layers.has(def.key) === true);
  }

  /** 缓存里的纹理是按什么倍率烘焙的，没有缓存为 null。所有状态的倍率相同。 */
  scale(): number | null {
    for (const set of this.sets.values()) return set.scale;
    return this.common?.scale ?? null;
  }

  /** 缓存里的纹理都是别的倍率烘焙的就作废：纹理都是旧倍率的，没法再用。 */
  private dropOtherScales(scale: number): void {
    for (const [other, set] of [...this.sets]) {
      if (Math.abs(set.scale - scale) > 1e-9) {
        this.release(set);
        this.sets.delete(other);
      }
    }
    if (this.common !== null && Math.abs(this.common.scale - scale) > 1e-9) {
      this.release(this.common);
      this.common = null;
    }
  }

  /**
   * 保证这个状态在这个倍率下烘焙好了。倍率和缓存里的不同时，整个缓存（所有状态）作废，因为纹理都是旧倍率的。
   * 返回这次烘焙花的毫秒，没有要烘焙的为 0。
   */
  ensure(look: Look, scale: number, visible: Rect): number {
    this.dropOtherScales(scale);
    return this.bake(look, scale, visible, Number.POSITIVE_INFINITY);
  }

  /**
   * 提前烘焙用：这个状态还差几层就烘焙一层（很小的层不算，顺带一起烘焙），返回这次花的毫秒，没有要烘焙的为 0。
   * 缓存里有别的倍率的纹理时什么也不做：那是窗口刚变过，等重新烘焙显示着的状态之后再说，免得把正在显示的纹理释放掉。
   */
  bakeOne(look: Look, scale: number, visible: Rect): number {
    for (const set of this.sets.values()) if (Math.abs(set.scale - scale) > 1e-9) return 0;
    if (this.common !== null && Math.abs(this.common.scale - scale) > 1e-9) return 0;
    return this.bake(look, scale, visible, 1);
  }

  /** 这一层烘焙出来有多少像素。 */
  private pixelsOf(def: LayerDef, scale: number, visible: Rect): number {
    const area = this.opts.layout.kind === 'whole' ? def.area(visible) : snapArea(def.area(visible), scale);
    return area.w * scale * area.h * scale;
  }

  private bake(look: Look, scale: number, visible: Rect, limit: number): number {
    const t0 = performance.now();
    let set = this.sets.get(look);
    if (set === undefined) {
      set = { scale, layers: new Map(), version: 0 };
      this.sets.set(look, set);
    }
    if (this.common === null && this.defs.some((def) => def.shared)) this.common = { scale, layers: new Map(), version: 0 };
    let done = 0;
    let baked = false;
    for (const def of this.defs) {
      if (!this.stale(def, set, visible)) continue;
      const big = this.pixelsOf(def, scale, visible) >= TINY_PIXELS;
      if (big && done >= limit) break;
      const target = this.holder(def, set) as LayerSet;
      const have = target.layers.get(def.key);
      if (have !== undefined) for (const t of have.textures) t.destroy(true);
      target.layers.set(def.key, this.bakeLayer(def, look, scale, visible));
      target.version += 1;
      baked = true;
      if (big) done += 1;
    }
    if (!baked) return 0;
    this.bakes += 1;
    this.lastBakeMs = performance.now() - t0;
    return this.lastBakeMs;
  }

  private bakeLayer(def: LayerDef, look: Look, scale: number, visible: Rect): BakedLayer {
    const { board, seed, districtName, labelFont } = this.opts;
    const wanted = def.area(visible);
    const area = this.opts.layout.kind === 'whole' ? wanted : snapArea(wanted, scale);
    const baked = bakeStaticLayer({
      city: def.city,
      board,
      // 共用的层各种状态里画得一样，不管是哪个状态触发的烘焙，都按白天的色板画
      theme: themeFor(def.shared ? 'day' : look),
      scale,
      seed,
      districtName,
      labelFont,
      area,
      paper: def.paper,
      grain: def.grain,
      river: def.river,
      ...(def.key === 'river' ? { extendRiver: RIVER_REACH } : {}),
    });
    const textures = baked.tiles.map((t) => {
      const tex = Texture.from(t.canvas, true);
      tex.source.resolution = scale;
      tex.source.scaleMode = 'linear';
      return tex;
    });
    return { def, baked, textures };
  }

  /** 烘焙好了的状态，调试和测试用。 */
  bakedLooks(): Look[] {
    return [...this.sets.keys()];
  }

  /** 把一种状态的纹理摆到一套精灵上。withCommon 为真时连各状态共用的层也摆上，只有下面一层要摆。 */
  private place(slot: Slot, look: Look, withCommon: boolean): void {
    const set = this.sets.get(look);
    if (set === undefined) throw new Error(`render: look ${look} is not baked`);
    for (const def of this.defs) {
      const container = slot.containers.get(def.key);
      if (container === undefined) continue;
      const layer = def.shared ? (withCommon ? this.common?.layers.get(def.key) : undefined) : set.layers.get(def.key);
      const tiles = layer === undefined ? [] : layer.baked.tiles;
      while (container.children.length > tiles.length) (container.removeChildAt(container.children.length - 1) as Sprite).destroy();
      tiles.forEach((tile, i) => {
        let sprite = container.children[i] as Sprite | undefined;
        if (sprite === undefined) {
          sprite = new Sprite(Texture.EMPTY);
          container.addChild(sprite);
        }
        sprite.texture = (layer as BakedLayer).textures[i] as Texture;
        sprite.position.set(tile.x, tile.y);
        sprite.width = tile.width;
        sprite.height = tile.height;
      });
    }
    slot.placed = { set, version: set.version, shared: withCommon ? this.common : null, sharedVersion: withCommon ? (this.common?.version ?? 0) : 0 };
  }

  /** 一套精灵不再显示：精灵换成空纹理，不再引用烘焙的纹理，那些纹理随时可能被释放。 */
  private unplace(slot: Slot): void {
    for (const container of slot.containers.values()) for (const child of container.children) (child as Sprite).texture = Texture.EMPTY;
    slot.placed = null;
  }

  /** 这一套精灵摆着的纹理还是不是最新的。 */
  private placedCurrent(slot: Slot, set: LayerSet, withCommon: boolean): boolean {
    const p = slot.placed;
    if (p === null || p.set !== set || p.version !== set.version) return false;
    return !withCommon || (p.shared === this.common && p.sharedVersion === (this.common?.version ?? 0));
  }

  /**
   * 显示这一刻的画面：下面一层是 from，满不透明度。mix 大于 0 并且 to 和 from 不同时，to 叠在上面，不透明度是 mix。
   * 两种状态都要先烘焙好。纹理没有换过时只改不透明度，所以渐变期间每帧调用也很便宜。
   */
  show(from: Look, to: Look, mix: number): void {
    const two = to !== from && mix > MIN_MIX;
    const [below, above] = this.slots;
    const lower = this.sets.get(from);
    if (lower === undefined) throw new Error(`render: look ${from} is not baked`);
    if (!this.placedCurrent(below, lower, true)) this.place(below, from, true);
    if (two) {
      const upper = this.sets.get(to);
      if (upper === undefined) throw new Error(`render: look ${to} is not baked`);
      if (!this.placedCurrent(above, upper, false)) this.place(above, to, false);
    } else if (above.placed !== null) {
      this.unplace(above);
    }
    this.shown = { from, to: two ? to : from, mix: two ? Math.min(1, mix) : 0 };
    this.applyAlpha();
  }

  /**
   * 各片区这一层的显示：没显示的藏起来，淡画的降低不透明度。整块烘焙时没有片区，什么也不做。
   * 状态变了，不透明度在 FADE_SECONDS 里渐变过去，dt 是离上一次调用过了多少秒（墙上的时间，游戏暂停时也在走）。不给 dt 时直接到位。
   */
  setModes(modes: readonly DistrictMode[], dt = Number.POSITIVE_INFINITY): void {
    for (const def of this.defs) {
      if (def.district < 0) continue;
      const target = modeAlpha(modes[def.district] ?? 'open');
      this.fade[def.district] = approachAlpha(this.fade[def.district] ?? 1, target, dt);
    }
    this.applyAlpha();
  }

  /** 把片区的淡入淡出和状态之间的渐变合成各个容器的可见和不透明度。共用的层只在下面一层显示。 */
  private applyAlpha(): void {
    const mix = this.shown?.mix ?? 0;
    const [below, above] = this.slots;
    for (const def of this.defs) {
      const own = def.district < 0 ? 1 : (this.fade[def.district] ?? 1);
      const lower = below.containers.get(def.key);
      const upper = above.containers.get(def.key);
      if (lower !== undefined) {
        lower.visible = own > 0;
        lower.alpha = own;
      }
      if (upper !== undefined) {
        upper.visible = !def.shared && own > 0 && mix > 0;
        upper.alpha = own * mix;
      }
    }
  }

  /** 现在在显示的下面一层有多少块纹理，调试用。 */
  tileCount(): number {
    const set = this.shown === null ? undefined : this.sets.get(this.shown.from);
    if (set === undefined) return 0;
    let n = 0;
    for (const layer of set.layers.values()) n += layer.textures.length;
    for (const layer of this.common?.layers.values() ?? []) n += layer.textures.length;
    return n;
  }

  /** 烘焙好的纹理一共占多少字节：画布的像素数乘 4。给了状态就只算它自己的层，不含各状态共用的，不给就算全部。 */
  textureBytes(look?: Look): number {
    if (look !== undefined) {
      const set = this.sets.get(look);
      return set === undefined ? 0 : setBytes(set);
    }
    let bytes = this.common === null ? 0 : setBytes(this.common);
    for (const set of this.sets.values()) bytes += setBytes(set);
    return bytes;
  }

  private release(set: LayerSet): void {
    for (const slot of this.slots) if (slot.placed?.set === set || slot.placed?.shared === set) this.unplace(slot);
    for (const layer of set.layers.values()) for (const t of layer.textures) t.destroy(true);
    set.layers.clear();
  }

  destroy(): void {
    for (const set of this.sets.values()) this.release(set);
    this.sets.clear();
    if (this.common !== null) this.release(this.common);
    this.common = null;
    for (const slot of this.slots) {
      for (const container of slot.containers.values()) container.destroy({ children: true });
      slot.containers.clear();
    }
  }
}

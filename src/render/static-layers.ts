// 静态地图层的管理：烘焙，上传成纹理，摆成精灵，随片区的状态换透明度。
// 两种分法：
// - whole：整块画板烘焙成一层，带纸面和纸纹。同一份数据画出同一张图。
// - districts：河和桥一层（铺满窗口，一直流到窗口的边），每个片区各一层，透明底。片区的状态变了只是换这一层的透明度，不用重新烘焙。
// 烘焙倍率是 镜头缩放 × 设备像素比，纹理像素和设备像素一一对应。倍率变了（窗口大小变了）才要重新烘焙，
// 同一个倍率下换状态（白天、夜间……）是另一套烘焙好的纹理，换起来不用等。这个文件碰 Pixi 和画布。
import { Container, Sprite, Texture } from 'pixi.js';
import { bakeStaticLayer } from './bake.ts';
import type { Baked } from './bake.ts';
import type { City } from './city-types.ts';
import { DISTRICT_MARGIN, assignDistricts, cityOfDistrict, modeAlpha, riverCity } from './districts.ts';
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
  /** 片区序号，底层和整块是 -1。 */
  readonly district: number;
  readonly city: City;
  readonly paper: boolean;
  readonly grain: boolean;
  readonly river: boolean;
  /** 烘焙的范围，画板坐标。底层随窗口，其余固定。 */
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
}

/** 底层（河）比窗口多烘焙一圈，窗口小幅变大时不用重新烘焙。画板单位。 */
const BASE_PAD = 48;
/** 河向两端延长多少，画板单位。 */
const RIVER_REACH = 6000;

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

export class StaticLayers {
  private readonly opts: StaticLayersOptions;
  private readonly defs: readonly LayerDef[];
  private readonly containers = new Map<string, Container>();
  private readonly sets = new Map<Look, LayerSet>();
  private shown: Look | null = null;
  /** 累计烘焙次数和最近一次的耗时，毫秒，调试和性能记录用。 */
  bakes = 0;
  lastBakeMs = 0;

  constructor(root: Container, opts: StaticLayersOptions) {
    this.opts = opts;
    this.defs = this.makeDefs();
    for (const def of this.defs) {
      const container = new Container();
      this.containers.set(def.key, container);
      root.addChild(container);
    }
  }

  get layout(): StaticLayout {
    return this.opts.layout;
  }

  private makeDefs(): LayerDef[] {
    const { city, board, layout } = this.opts;
    if (layout.kind === 'whole') {
      return [{ key: 'all', district: -1, city, paper: true, grain: true, river: true, area: () => ({ x: 0, y: 0, w: board.width, h: board.height }) }];
    }
    const margin = layout.margin ?? DISTRICT_MARGIN;
    const membership = assignDistricts(city, layout.districts, margin);
    const defs: LayerDef[] = [
      {
        key: 'base',
        district: -1,
        city: riverCity(city),
        paper: false,
        grain: false,
        river: true,
        area: (visible) => inflateRect(visible, BASE_PAD),
      },
    ];
    layout.districts.forEach((_, index) => {
      const part = cityOfDistrict(city, membership, index);
      // 这一层要烘焙的范围：成员街区的外接框（转了角之后在画板上的外接框），四周多一圈放阴影、描边和片区名
      let box: Rect | null = null;
      for (const b of part.blocks) box = unionRect(box, board.boundsOf(b.rect));
      for (const l of part.labels) box = unionRect(box, board.boundsOf({ x: l.x - 90, y: l.y - 30, w: 180, h: 60 }));
      const area = inflateRect(box ?? { x: 0, y: 0, w: 1, h: 1 }, 28);
      defs.push({ key: `d${String(index)}`, district: index, city: part, paper: false, grain: false, river: false, area: () => area });
    });
    return defs;
  }

  /** 这一层现在要不要重新烘焙：倍率变了，或者底层不再盖住窗口。 */
  needsBake(look: Look, scale: number, visible: Rect): boolean {
    const set = this.sets.get(look);
    if (set === undefined || Math.abs(set.scale - scale) > 1e-9) return true;
    for (const def of this.defs) {
      const layer = set.layers.get(def.key);
      if (layer === undefined) return true;
      if (def.key === 'base' && !covers(layer.baked.area, visible)) return true;
    }
    return false;
  }

  /**
   * 保证这个状态在这个倍率下烘焙好了。倍率和缓存里的不同时，整个缓存（所有状态）作废，因为纹理都是旧倍率的。
   * 返回这次烘焙花的毫秒，没有要烘焙的为 0。
   */
  ensure(look: Look, scale: number, visible: Rect): number {
    const t0 = performance.now();
    let work = false;
    for (const [other, set] of [...this.sets]) {
      if (Math.abs(set.scale - scale) > 1e-9) {
        this.release(set);
        this.sets.delete(other);
      }
    }
    let set = this.sets.get(look);
    if (set === undefined) {
      set = { scale, layers: new Map() };
      this.sets.set(look, set);
    }
    for (const def of this.defs) {
      const have = set.layers.get(def.key);
      if (have !== undefined && !(def.key === 'base' && !covers(have.baked.area, visible))) continue;
      if (have !== undefined) {
        for (const t of have.textures) t.destroy(true);
      }
      set.layers.set(def.key, this.bakeLayer(def, look, scale, visible));
      work = true;
    }
    if (!work) return 0;
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
      theme: themeFor(look),
      scale,
      seed,
      districtName,
      labelFont,
      area,
      paper: def.paper,
      grain: def.grain,
      river: def.river,
      ...(def.key === 'base' ? { extendRiver: RIVER_REACH } : {}),
    });
    const textures = baked.tiles.map((t) => {
      const tex = Texture.from(t.canvas, true);
      tex.source.resolution = scale;
      tex.source.scaleMode = 'linear';
      return tex;
    });
    return { def, baked, textures };
  }

  /** 把这个状态的纹理摆到各层的精灵上。要先 ensure。 */
  show(look: Look): void {
    const set = this.sets.get(look);
    if (set === undefined) throw new Error(`render: look ${look} is not baked`);
    for (const def of this.defs) {
      const layer = set.layers.get(def.key);
      const container = this.containers.get(def.key);
      if (layer === undefined || container === undefined) continue;
      const tiles = layer.baked.tiles;
      while (container.children.length > tiles.length) (container.removeChildAt(container.children.length - 1) as Sprite).destroy();
      tiles.forEach((tile, i) => {
        let sprite = container.children[i] as Sprite | undefined;
        if (sprite === undefined) {
          sprite = new Sprite(Texture.EMPTY);
          container.addChild(sprite);
        }
        sprite.texture = layer.textures[i] as Texture;
        sprite.position.set(tile.x, tile.y);
        sprite.width = tile.width;
        sprite.height = tile.height;
      });
    }
    this.shown = look;
  }

  /** 各片区这一层的显示：没显示的藏起来，淡画的降低不透明度。整块烘焙时没有片区，什么也不做。 */
  setModes(modes: readonly DistrictMode[]): void {
    for (const def of this.defs) {
      if (def.district < 0) continue;
      const container = this.containers.get(def.key);
      if (container === undefined) continue;
      const alpha = modeAlpha(modes[def.district] ?? 'open');
      container.visible = alpha > 0;
      container.alpha = alpha;
    }
  }

  /** 现在在显示的这套烘焙有多少块纹理，调试用。 */
  tileCount(): number {
    const set = this.shown === null ? undefined : this.sets.get(this.shown);
    if (set === undefined) return 0;
    let n = 0;
    for (const layer of set.layers.values()) n += layer.textures.length;
    return n;
  }

  private release(set: LayerSet): void {
    for (const layer of set.layers.values()) for (const t of layer.textures) t.destroy(true);
    set.layers.clear();
  }

  destroy(): void {
    for (const set of this.sets.values()) this.release(set);
    this.sets.clear();
    for (const container of this.containers.values()) container.destroy({ children: true });
    this.containers.clear();
  }
}

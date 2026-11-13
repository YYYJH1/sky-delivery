// 静态地图层的烘焙：用 Canvas 2D 把一座城市画成一张图，再切成不超过 4096 的几块，上传成纹理。
// 载入时每种状态画一次，运行时只是几个精灵。套印偏移、毛边、纸纹都只在这里算一次，并且用固定种子，同一份数据画出同一张图。
//
// 层次从下到上：
//   纸面 → 填色层（街区、绿地、河）→ 线稿层（街区描边、河纹、桥、操场、树）→ 建筑排线阴影 → 屋顶填色层 → 屋顶线稿和物件
//   → 片区名 → 亮窗 → 纸纹。
// 填色层和屋顶填色层相对线稿偏 (1.5, 1) 个像素，边缘用位移图毛一点，像孔版套印。
// 默认烘焙整块画板，带纸面和纸纹。整张地图分层烘焙时，每一层只烘焙画板上的一块（area），不带纸面和纸纹（透明底，
// 纸面由渲染器的底色给，纸纹盖在最上面），河和桥单独一层。
import { context2d, fillWith, hatchCurrentPath, makeCanvas, rect, strokeLine, strokeWith } from './draw/ctx.ts';
import type { Ctx } from './draw/ctx.ts';
import { drawCourt, drawStadium, drawTreeCrown, propAc, propAntenna, propClothesline, propCooling, propHeaters, propHelipad, propPlanters, propPv, propShed, propSkylight, propStair, propTank, treeShadow } from './draw/props.ts';
import type { Building, City, Prop } from './city-types.ts';
import type { Board, Rect, Vec } from './geometry.ts';
import { riverEdge } from './river.ts';
import { withAlpha } from './look.ts';
import type { Theme } from './look.ts';
import { RIVER_HALF_WIDTH } from './city.ts';
import { createRand, mixSeed } from './rng.ts';

/** 套印偏移，画板像素。 */
const REGISTRATION = { x: 1.5, y: 1 };
/** 毛边的位移幅度，画板像素。 */
const ROUGHNESS = 2;
const MAX_TILE = 4096;
/** 亮窗的半径，画板像素。 */
const WINDOW_RADIUS = 1.5;
/** 亮窗在窗口里至少这么宽，设备像素。 */
const MIN_WINDOW_PIXELS = 2.2;

export interface BakeOptions {
  readonly city: City;
  readonly board: Board;
  readonly theme: Theme;
  /** 烘焙倍率：设备像素每画板像素。 */
  readonly scale: number;
  readonly seed: number;
  /** 片区名，下标是片区序号。 */
  readonly districtName: (district: number) => string;
  /** 地图上片区名的字体，CSS 的 font-family 写法，要先加载好。 */
  readonly labelFont: string;
  /**
   * 烘焙画板上的哪一块，画板坐标。缺省是整块画板。左上角最好落在 1 / scale 的整数倍上，宽高乘 scale 最好是整数，
   * 这样纹理像素和设备像素一一对应，画出来不会发糊。
   */
  readonly area?: Rect;
  /** 画纸面，缺省画。透明底的分层烘焙不画。 */
  readonly paper?: boolean;
  /** 画纸纹，缺省画。 */
  readonly grain?: boolean;
  /** 画河（河面和岸边的细线），缺省画。街区绿地和描边躲开河的做法不受它影响。 */
  readonly river?: boolean;
  /** 河向两端各多画这么长（画板单位），让河一直流到窗口的边缘。缺省不延长。 */
  readonly extendRiver?: number;
}

export interface BakedTile {
  readonly canvas: HTMLCanvasElement;
  /** 这一块左上角在画板上的位置，画板像素。 */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Baked {
  readonly tiles: readonly BakedTile[];
  readonly scale: number;
  /** 烘焙的范围，画板坐标。 */
  readonly area: Rect;
}

/** 世界坐标到画布设备像素的变换矩阵：转角，再平移，再减去烘焙范围的左上角，再乘烘焙倍率。 */
function worldMatrix(board: Board, scale: number, area: Rect): [number, number, number, number, number, number] {
  const c = Math.cos(board.angle);
  const s = Math.sin(board.angle);
  const e = board.width / 2 - (board.focus.x * c - board.focus.y * s) - area.x;
  const f = board.height / 2 - (board.focus.x * s + board.focus.y * c) - area.y;
  return [scale * c, scale * s, -scale * s, scale * c, scale * e, scale * f];
}

/** 河中心线的两端各沿末段的方向延长 extra，河流出窗口的边缘。 */
function extendedRiver(river: City['river'], extra: number): City['river'] {
  const c = river.center;
  if (extra <= 0 || c.length < 2) return river;
  const dir = (a: Vec, b: Vec): Vec => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const first = c[0] as Vec;
  const last = c[c.length - 1] as Vec;
  const d0 = dir(c[1] as Vec, first);
  const d1 = dir(c[c.length - 2] as Vec, last);
  return { ...river, center: [{ x: first.x + d0.x * extra, y: first.y + d0.y * extra }, ...c, { x: last.x + d1.x * extra, y: last.y + d1.y * extra }] };
}

// ---- 位移图：毛边 ----
interface Displacement {
  readonly size: number;
  readonly dx: Float32Array;
  readonly dy: Float32Array;
}

/** 一块能无缝平铺的平滑噪声，两个八度，值在 [-0.5, 0.5]。lattice 是格点间距（像素）。 */
function smoothNoise(size: number, lattice: number, seed: number): Float32Array {
  const rand = createRand(seed);
  const n = Math.round(size / lattice);
  const grid = new Float32Array(n * n);
  for (let i = 0; i < grid.length; i++) grid[i] = rand() - 0.5;
  const out = new Float32Array(size * size);
  const g = (x: number, y: number): number => grid[((y % n) + n) % n * n + (((x % n) + n) % n)] as number;
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * n;
    const y0 = Math.floor(fy);
    const ty = smooth(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * n;
      const x0 = Math.floor(fx);
      const tx = smooth(fx - x0);
      const a = g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx;
      const b = g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx;
      out[y * size + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

function makeDisplacement(seed: number): Displacement {
  const size = 256;
  const a1 = smoothNoise(size, 3.2, mixSeed(seed, 11));
  const a2 = smoothNoise(size, 1.6, mixSeed(seed, 12));
  const b1 = smoothNoise(size, 3.2, mixSeed(seed, 13));
  const b2 = smoothNoise(size, 1.6, mixSeed(seed, 14));
  const dx = new Float32Array(size * size);
  const dy = new Float32Array(size * size);
  for (let i = 0; i < dx.length; i++) {
    dx[i] = ((a1[i] as number) * 1.2 + (a2[i] as number) * 0.6) * 2;
    dy[i] = ((b1[i] as number) * 1.2 + (b2[i] as number) * 0.6) * 2;
  }
  return { size, dx, dy };
}

/** 用位移图把一块填色层的边缘毛一点。按预乘的颜色双线性取样，没有变化的地方直接复制。 */
function roughen(canvas: HTMLCanvasElement, disp: Displacement, amplitude: number): void {
  const ctx = context2d(canvas);
  const { width, height } = canvas;
  const src = ctx.getImageData(0, 0, width, height);
  const out = ctx.createImageData(width, height);
  const s8 = src.data;
  const o8 = out.data;
  const s32 = new Uint32Array(s8.buffer);
  const o32 = new Uint32Array(o8.buffer);
  const sz = disp.size;
  const sample = (px: number, py: number, o: number): void => {
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const tx = px - x0;
    const ty = py - y0;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let k = 0; k < 4; k++) {
      const xi = x0 + (k & 1);
      const yi = y0 + (k >> 1);
      if (xi < 0 || yi < 0 || xi >= width || yi >= height) continue;
      const w = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty);
      const i = (yi * width + xi) * 4;
      const al = (s8[i + 3] as number) / 255;
      r += w * (s8[i] as number) * al;
      g += w * (s8[i + 1] as number) * al;
      b += w * (s8[i + 2] as number) * al;
      a += w * al;
    }
    if (a <= 0.002) {
      o8[o] = 0;
      o8[o + 1] = 0;
      o8[o + 2] = 0;
      o8[o + 3] = 0;
      return;
    }
    o8[o] = Math.round(r / a);
    o8[o + 1] = Math.round(g / a);
    o8[o + 2] = Math.round(b / a);
    o8[o + 3] = Math.round(a * 255);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const c = s32[i] as number;
      const uniform =
        (x < 2 || (s32[i - 2] as number) === c) && (x >= width - 2 || (s32[i + 2] as number) === c) && (y < 2 || (s32[i - 2 * width] as number) === c) && (y >= height - 2 || (s32[i + 2 * width] as number) === c);
      if (uniform) {
        o32[i] = c;
        continue;
      }
      const t = (y & (sz - 1)) * sz + (x & (sz - 1));
      sample(x + (disp.dx[t] as number) * amplitude, y + (disp.dy[t] as number) * amplitude, i * 4);
    }
  }
  ctx.putImageData(out, 0, 0);
}

// ---- 纸纹 ----
/** 纸纹的一块 256 乘 256 的图：墨色的随机点，不透明度很低，铺满就是纸的颗粒。 */
export function grainTile(theme: Theme, seed: number): HTMLCanvasElement {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = context2d(canvas);
  const img = ctx.createImageData(size, size);
  const rand = createRand(seed);
  const [r, g, b] = [theme.pal.ink.slice(1, 3), theme.pal.ink.slice(3, 5), theme.pal.ink.slice(5, 7)].map((h) => Number.parseInt(h, 16));
  const strength = theme.dark ? 0.06 : 0.11;
  for (let i = 0; i < size * size; i++) {
    const a = Math.max(0, strength * rand() - 0.039 * (strength / 0.11));
    img.data[i * 4] = r as number;
    img.data[i * 4 + 1] = g as number;
    img.data[i * 4 + 2] = b as number;
    img.data[i * 4 + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---- 画法 ----
function drawProp(ctx: Ctx, theme: Theme, p: Prop): void {
  const pal = theme.pal;
  switch (p.kind) {
    case 'tank':
      return propTank(ctx, pal, p.x, p.y, p.a);
    case 'heaters':
      return propHeaters(ctx, pal, p.x, p.y, p.a);
    case 'ac':
      return propAc(ctx, pal, p.x, p.y);
    case 'clothesline':
      return propClothesline(ctx, pal, p.x, p.y, p.a);
    case 'planters':
      return propPlanters(ctx, pal, p.x, p.y);
    case 'shed':
      return propShed(ctx, pal, p.x, p.y, p.a, p.b);
    case 'cooling':
      return propCooling(ctx, pal, p.x, p.y, p.a);
    case 'pv':
      return propPv(ctx, pal, p.x, p.y, p.a, p.b);
    case 'helipad':
      return propHelipad(ctx, pal, p.x, p.y, p.a);
    case 'stair':
      return propStair(ctx, pal, p.x, p.y);
    case 'antenna':
      return propAntenna(ctx, pal, p.x, p.y);
    case 'skylight':
      return propSkylight(ctx, pal, p.x, p.y, p.a, p.b);
  }
}

function rectPath(ctx: Ctx, r: Rect): void {
  ctx.rect(r.x, r.y, r.w, r.h);
}

function roofShadowPath(ctx: Ctx, b: Building): void {
  const { x, y, w, h } = b.rect;
  const sh = b.shadow;
  ctx.moveTo(x + w, y + sh);
  ctx.lineTo(x + w + sh, y + sh);
  ctx.lineTo(x + w + sh, y + h + sh);
  ctx.lineTo(x + sh, y + h + sh);
  ctx.lineTo(x + sh, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function riverPolygon(city: City): Vec[] {
  const left = riverEdge(city.river, RIVER_HALF_WIDTH, -1);
  const right = riverEdge(city.river, RIVER_HALF_WIDTH, 1);
  return [...left, ...right.reverse()];
}

/** 烘焙一种状态的静态层。 */
export function bakeStaticLayer(opts: BakeOptions): Baked {
  const { city, board, theme, scale } = opts;
  const pal = theme.pal;
  const area: Rect = opts.area ?? { x: 0, y: 0, w: board.width, h: board.height };
  const drawRiver = opts.river !== false;
  const W = Math.round(area.w * scale);
  const H = Math.round(area.h * scale);
  const canvas = makeCanvas(W, H);
  const ctx = context2d(canvas);
  const matrix = worldMatrix(board, scale, area);
  const setWorld = (c: Ctx): void => c.setTransform(...matrix);
  const setBoard = (c: Ctx): void => c.setTransform(scale, 0, 0, scale, -area.x * scale, -area.y * scale);
  const boardBounds = { x: area.x - 4, y: area.y - 4, w: area.w + 8, h: area.h + 8 };
  const disp = makeDisplacement(opts.seed);
  const riverToDraw = drawRiver ? extendedRiver(city.river, opts.extendRiver ?? 0) : city.river;

  // 纸面
  if (opts.paper !== false) {
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, W, H);
  }

  // ---- 填色层：街区、绿地、河。毛边加套印偏移 ----
  // 填色层画完要读回像素做毛边，所以在内存里画
  const fills = makeCanvas(W, H);
  {
    const f = context2d(fills, true);
    setWorld(f);
    f.beginPath();
    for (const bl of city.blocks) if (bl.kind === 'normal' || bl.kind === 'track') rectPath(f, bl.rect);
    f.fillStyle = pal.block;
    f.fill();
    // 绿地不画进河里：整块区域减去河再填
    f.save();
    f.beginPath();
    f.rect(city.region.x - 100, city.region.y - 100, city.region.w + 200, city.region.h + 200);
    riverPolygon(city).forEach((p, i) => (i === 0 ? f.moveTo(p.x, p.y) : f.lineTo(p.x, p.y)));
    f.closePath();
    f.clip('evenodd');
    f.beginPath();
    for (const bl of city.blocks) if (bl.kind === 'park' || bl.kind === 'bank') rectPath(f, bl.rect);
    f.fillStyle = withAlpha(pal.green, 0.18);
    f.fill();
    f.restore();
    // 河：一条粗线，中心线两侧各一个半宽
    if (drawRiver) {
      f.beginPath();
      riverToDraw.center.forEach((p, i) => (i === 0 ? f.moveTo(p.x, p.y) : f.lineTo(p.x, p.y)));
      f.lineWidth = RIVER_HALF_WIDTH * 2;
      f.lineJoin = 'round';
      f.lineCap = 'butt';
      f.strokeStyle = withAlpha(pal.steel, 0.22);
      f.stroke();
    }
  }
  roughen(fills, disp, ROUGHNESS * scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(fills, REGISTRATION.x * scale, REGISTRATION.y * scale);

  // ---- 线稿层：街区描边，河纹，桥，操场，篮球场 ----
  setWorld(ctx);
  ctx.save();
  // 描边不画进河里：整块区域减去河
  const poly = riverPolygon(city);
  ctx.beginPath();
  ctx.rect(city.region.x - 100, city.region.y - 100, city.region.w + 200, city.region.h + 200);
  poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.clip('evenodd');
  ctx.beginPath();
  for (const bl of city.blocks) rectPath(ctx, bl.rect);
  strokeWith(ctx, pal.ink, 0.8, 0.35);
  ctx.restore();
  // 河纹：沿两岸各三条与岸线平行的细线
  for (const side of drawRiver ? ([-1, 1] as const) : []) {
    for (let k = 0; k < 3; k++) {
      const pts = riverEdge(riverToDraw, RIVER_HALF_WIDTH - 1.5 - 4 * k, side);
      if (pts.length < 2) continue;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      strokeWith(ctx, pal.steel, 0.8, 0.55);
    }
  }
  // 桥：纸白的桥面，两条蓝黑边线
  for (const br of city.bridges) {
    const r = br.rect;
    rect(ctx, r.x, r.y, r.w, r.h);
    fillWith(ctx, pal.paper);
    if (br.horizontal) {
      strokeLine(ctx, r.x, r.y, r.x + r.w, r.y, pal.ink, 1.1, 0.85);
      strokeLine(ctx, r.x, r.y + r.h, r.x + r.w, r.y + r.h, pal.ink, 1.1, 0.85);
    } else {
      strokeLine(ctx, r.x, r.y, r.x, r.y + r.h, pal.ink, 1.1, 0.85);
      strokeLine(ctx, r.x + r.w, r.y, r.x + r.w, r.y + r.h, pal.ink, 1.1, 0.85);
    }
  }
  for (const bl of city.blocks) {
    if (bl.track !== null) {
      // 竖着放的操场（街区是竖的）
      const t = bl.track;
      const ws = t.h - 6;
      const hs = 78;
      ctx.save();
      ctx.translate(t.x + t.w / 2, t.y + t.h / 2);
      ctx.rotate(Math.PI / 2);
      drawStadium(ctx, pal, -ws / 2, -hs / 2, ws, hs);
      ctx.restore();
    }
    if (bl.court !== null) {
      const c = bl.court;
      drawCourt(ctx, pal, c.x + (c.w - 52) / 2, c.y + (c.h - 30) / 2, 52, 30);
    }
  }
  // 小院的淡线
  ctx.beginPath();
  for (const y of city.yards) if (y.w >= 18 && y.h >= 14) rectPath(ctx, y);
  strokeWith(ctx, pal.ink, 0.6, 0.32);

  // 树：右下方一小块排线阴影，再画树冠
  setWorld(ctx);
  ctx.beginPath();
  for (const t of city.trees) {
    const s = treeShadow(t.x, t.y, t.r);
    ctx.moveTo(s.cx + s.rx, s.cy);
    ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
  }
  hatchCurrentPathOnBoard(ctx, setBoard, pal, boardBounds, theme.hatchAlpha * 1.4, 1, 4);
  setWorld(ctx);
  for (const t of city.trees) drawTreeCrown(ctx, pal, t.x, t.y, t.r, t.seed);

  // 建筑的排线阴影
  setWorld(ctx);
  ctx.beginPath();
  for (const b of city.buildings) roofShadowPath(ctx, b);
  hatchCurrentPathOnBoard(ctx, setBoard, pal, boardBounds, theme.hatchAlpha, 1.5, 4);

  // ---- 屋顶填色层：纸白，写字楼的彩钢蓝淡色，天井 ----
  const roofFills = makeCanvas(W, H);
  {
    const f = context2d(roofFills, true);
    setWorld(f);
    f.beginPath();
    for (const b of city.buildings) rectPath(f, b.rect);
    f.fillStyle = pal.paper;
    f.fill();
    f.beginPath();
    for (const b of city.buildings) if (b.tinted) rectPath(f, b.rect);
    f.fillStyle = withAlpha(pal.steel, 0.1);
    f.fill();
    f.beginPath();
    for (const b of city.buildings) if (b.patio !== null) rectPath(f, b.patio);
    f.fillStyle = pal.block;
    f.fill();
  }
  roughen(roofFills, disp, ROUGHNESS * scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(roofFills, REGISTRATION.x * scale, REGISTRATION.y * scale);

  // ---- 屋顶线稿和物件 ----
  setWorld(ctx);
  ctx.beginPath();
  for (const b of city.buildings) rectPath(ctx, b.rect);
  strokeWith(ctx, pal.ink, 0.9, 0.92);
  // 写字楼：内侧一圈女儿墙线
  ctx.beginPath();
  for (const b of city.buildings) if (b.tinted) ctx.rect(b.rect.x + 5, b.rect.y + 5, b.rect.w - 10, b.rect.h - 10);
  strokeWith(ctx, pal.ink, 0.7, 0.45);
  // 老街：约一半的屋顶画屋脊线和一侧的瓦线
  const ridges: Path2D = new Path2D();
  const tiles: Path2D = new Path2D();
  for (const b of city.buildings) {
    if (b.ridge === null) continue;
    const { x, y, w, h } = b.rect;
    if (b.ridge.horizontal) {
      const ym = y + h / 2;
      ridges.moveTo(x + 2, ym);
      ridges.lineTo(x + w - 2, ym);
      const ye = b.ridge.side ? y + 2 : y + h - 2;
      for (let k = x + 3; k < x + w - 2; k += 3.5) {
        tiles.moveTo(k, ym);
        tiles.lineTo(k, ye);
      }
    } else {
      const xm = x + w / 2;
      ridges.moveTo(xm, y + 2);
      ridges.lineTo(xm, y + h - 2);
      const xe = b.ridge.side ? x + 2 : x + w - 2;
      for (let k = y + 3; k < y + h - 2; k += 3.5) {
        tiles.moveTo(xm, k);
        tiles.lineTo(xe, k);
      }
    }
  }
  ctx.strokeStyle = withAlpha(pal.ink, 0.75);
  ctx.lineWidth = 0.9;
  ctx.stroke(ridges);
  ctx.strokeStyle = withAlpha(pal.ink, 0.22);
  ctx.lineWidth = 0.7;
  ctx.stroke(tiles);
  // 天井的线
  ctx.beginPath();
  for (const b of city.buildings) if (b.patio !== null) rectPath(ctx, b.patio);
  strokeWith(ctx, pal.ink, 0.6, 0.45);
  for (const b of city.buildings) for (const p of b.props) drawProp(ctx, theme, p);

  // ---- 片区名：字距拉开，随地图转，四周纸白描边，不加底板 ----
  for (const label of city.labels) {
    const text = opts.districtName(label.district);
    ctx.save();
    ctx.font = `700 30px ${opts.labelFont}`;
    ctx.letterSpacing = '12px';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = pal.paper;
    ctx.strokeText(text, label.x + 6, label.y + 11);
    ctx.fillStyle = withAlpha(pal.ink, 0.85);
    ctx.fillText(text, label.x + 6, label.y + 11);
    ctx.restore();
  }

  // ---- 亮窗：傍晚亮三成，夜间亮八成，便签黄的实色点。整张地图缩小放进窗口时点跟着变小，所以缩得很小时放大一些，在窗口里至少两个像素宽 ----
  const lit = theme.look === 'night' ? 0.82 : theme.look === 'dusk' ? 0.3 : 0;
  if (lit > 0) {
    const radius = Math.max(WINDOW_RADIUS, MIN_WINDOW_PIXELS / 2 / scale);
    ctx.beginPath();
    for (const b of city.buildings) {
      for (const w of b.windows) {
        if (w.t >= lit) continue;
        ctx.moveTo(w.x + radius, w.y);
        ctx.arc(w.x, w.y, radius, 0, Math.PI * 2);
      }
    }
    fillWith(ctx, pal.note);
  }

  // ---- 纸纹 ----
  if (opts.grain !== false) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const pattern = ctx.createPattern(grainTile(theme, mixSeed(opts.seed, 21)), 'repeat');
    if (pattern !== null) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, W, H);
    }
  }

  return { tiles: splitTiles(canvas, scale, area), scale, area };
}

/**
 * 当前路径（用地图的变换构造）铺 45° 排线：路径已经换到设备坐标，换成画板方向的变换再画线。
 */
function hatchCurrentPathOnBoard(ctx: Ctx, setBoard: (c: Ctx) => void, pal: Theme['pal'], bounds: { x: number; y: number; w: number; h: number }, alpha: number, width: number, spacing: number): void {
  setBoard(ctx);
  hatchCurrentPath(ctx, pal, bounds, alpha, width, spacing);
}

/** 画布超过 4096 时切成几块，每块记下它在画板上的位置。 */
function splitTiles(canvas: HTMLCanvasElement, scale: number, area: Rect): BakedTile[] {
  const { width, height } = canvas;
  if (width <= MAX_TILE && height <= MAX_TILE) return [{ canvas, x: area.x, y: area.y, width: width / scale, height: height / scale }];
  const tiles: BakedTile[] = [];
  for (let y = 0; y < height; y += MAX_TILE) {
    for (let x = 0; x < width; x += MAX_TILE) {
      const w = Math.min(MAX_TILE, width - x);
      const h = Math.min(MAX_TILE, height - y);
      const tile = makeCanvas(w, h);
      context2d(tile).drawImage(canvas, x, y, w, h, 0, 0, w, h);
      tiles.push({ canvas: tile, x: area.x + x / scale, y: area.y + y / scale, width: w / scale, height: h / scale });
    }
  }
  return tiles;
}


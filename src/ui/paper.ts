// 界面物件的纸：小票、便签、白板、价签、纸条的背景图，用代码画一次，之后当作 CSS 背景图用，不用图片素材。
// 每张图带一块错位的蓝黑色块当投影（不透明度不超过 14%，没有模糊），纸的边缘有一点毛，纸面撒一层很淡的颗粒。
// 图比元素大一圈（BLEED 个像素），多出来的是投影，所以元素的背景要画在伪元素上，不能被元素自己的边框盒裁掉。
// 种子固定，同样的种子和尺寸画出同样的图。颜色只来自色表。
import { BASE_COLORS } from '../content/palette.ts';
import { withAlpha } from '../render/look.ts';
import { createRand, mixSeed } from './seeded.ts';
import type { Rand } from './seeded.ts';

/** 投影的偏移，像素。 */
export const SHADOW = 3;
/** 图比元素多出的像素：投影加上边线的余量。 */
export const BLEED = SHADOW + 2;
/** 画布的分辨率倍数：界面按 1920×1080 的尺寸写，窗口放大到两倍时仍然清楚。 */
const SCALE = 2;

export type PaperKind = 'slip' | 'sticky' | 'board' | 'tag' | 'strip' | 'tape';

type Ctx = CanvasRenderingContext2D;
type Point = readonly [number, number];

/** 小票下沿锯齿的步长。 */
const TOOTH_STEP = 8;

function newCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((w + BLEED) * SCALE);
  canvas.height = Math.ceil((h + BLEED) * SCALE);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context is not available');
  ctx.scale(SCALE, SCALE);
  return { canvas, ctx };
}

/** 一圈边缘有一点毛的路径：每 step 个像素抖一下，幅度 amp。 */
function roughPoints(points: readonly Point[], rand: Rand, step: number, amp: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t + (k === 0 ? 0 : (rand() - 0.5) * 2 * amp), a[1] + (b[1] - a[1]) * t + (k === 0 ? 0 : (rand() - 0.5) * 2 * amp)]);
    }
  }
  return out;
}

function pathOf(ctx: Ctx, points: readonly Point[]): void {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

/** 纸面的颗粒：在当前路径里撒一层很淡的蓝黑点。 */
function grain(ctx: Ctx, w: number, h: number, rand: Rand, density: number): void {
  ctx.save();
  ctx.clip();
  const n = Math.floor(w * h * density);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = withAlpha(BASE_COLORS.ink, 0.025 + rand() * 0.05);
    ctx.fillRect(rand() * w, rand() * h, 0.9, 0.9);
  }
  ctx.restore();
}

const SHADOW_FILL = withAlpha(BASE_COLORS.ink, 0.12);

/** 热敏小票：小票白，下沿锯齿（步长 8，深 depth），左右上三边一道很淡的边线。 */
function drawSlip(w: number, h: number, seed: number, depth: number): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas(w, h);
  const rand = createRand(mixSeed(seed, w, h));
  const teeth = Math.floor(w / TOOTH_STEP);
  const outline: Point[] = [
    [0, 0],
    [w, 0],
    [w, h - depth],
  ];
  for (let i = 0; i < teeth; i++) {
    outline.push([w - (i + 0.5) * TOOTH_STEP, h]);
    outline.push([w - (i + 1) * TOOTH_STEP, h - depth]);
  }
  outline.push([0, h - depth]);
  ctx.save();
  ctx.translate(SHADOW, SHADOW);
  pathOf(ctx, outline);
  ctx.fillStyle = SHADOW_FILL;
  ctx.fill();
  ctx.restore();
  pathOf(ctx, outline);
  ctx.fillStyle = BASE_COLORS.slip;
  ctx.fill();
  grain(ctx, w, h, rand, 0.012);
  ctx.beginPath();
  ctx.moveTo(0.5, h - depth);
  ctx.lineTo(0.5, 0.5);
  ctx.lineTo(w - 0.5, 0.5);
  ctx.lineTo(w - 0.5, h - depth);
  ctx.strokeStyle = withAlpha(BASE_COLORS.ink, 0.28);
  ctx.lineWidth = 1;
  ctx.stroke();
  return canvas;
}

/** 便签：便签黄，四边略毛，一块错位的投影，上沿一道略深的粘条。 */
function drawSticky(w: number, h: number, seed: number): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas(w, h);
  const rand = createRand(mixSeed(seed, w, h));
  const outline = roughPoints(
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
    rand,
    10,
    0.45,
  );
  ctx.save();
  ctx.translate(SHADOW, SHADOW);
  pathOf(ctx, outline);
  ctx.fillStyle = SHADOW_FILL;
  ctx.fill();
  ctx.restore();
  pathOf(ctx, outline);
  ctx.fillStyle = BASE_COLORS.note;
  ctx.fill();
  grain(ctx, w, h, rand, 0.01);
  ctx.save();
  pathOf(ctx, outline);
  ctx.clip();
  ctx.fillStyle = withAlpha(BASE_COLORS.ink, 0.05);
  ctx.fillRect(0, 0, w, 7);
  ctx.restore();
  return canvas;
}

/** 白板：白板白，铝框灰的边框，圆角半径 6，一块错位的投影。 */
function drawBoard(w: number, h: number, seed: number): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas(w, h);
  const rand = createRand(mixSeed(seed, w, h));
  ctx.save();
  ctx.translate(SHADOW, SHADOW);
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 6);
  ctx.fillStyle = SHADOW_FILL;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.roundRect(1, 1, w - 2, h - 2, 6);
  ctx.fillStyle = BASE_COLORS.board;
  ctx.fill();
  grain(ctx, w, h, rand, 0.006);
  ctx.beginPath();
  ctx.roundRect(1, 1, w - 2, h - 2, 6);
  ctx.strokeStyle = BASE_COLORS.alu;
  ctx.lineWidth = 2;
  ctx.stroke();
  return canvas;
}

/** 价签：纸白，蓝黑细边，左上角切角并有一个打孔圆，一块错位的投影。 */
function drawTag(w: number, h: number, seed: number): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas(w, h);
  const rand = createRand(mixSeed(seed, w, h));
  const cut = 12;
  const outline: Point[] = [
    [cut, 0.5],
    [w - 0.5, 0.5],
    [w - 0.5, h - 0.5],
    [0.5, h - 0.5],
    [0.5, cut],
  ];
  const hole = (c: Ctx): void => {
    c.moveTo(9.5 + 2.6, 9.5);
    c.arc(9.5, 9.5, 2.6, 0, Math.PI * 2);
  };
  ctx.save();
  ctx.translate(SHADOW, SHADOW);
  pathOf(ctx, outline);
  hole(ctx);
  ctx.fillStyle = SHADOW_FILL;
  ctx.fill('evenodd');
  ctx.restore();
  pathOf(ctx, outline);
  hole(ctx);
  ctx.fillStyle = BASE_COLORS.paper;
  ctx.fill('evenodd');
  ctx.save();
  pathOf(ctx, outline);
  ctx.clip();
  grain(ctx, w, h, rand, 0.008);
  ctx.restore();
  pathOf(ctx, outline);
  hole(ctx);
  ctx.strokeStyle = BASE_COLORS.ink;
  ctx.lineWidth = 1;
  ctx.stroke();
  return canvas;
}

/** 纸条（日程、速度、片区、菜单等）：纸白，蓝黑细边，直角，一块错位的投影。 */
function drawStrip(w: number, h: number, seed: number): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas(w, h);
  const rand = createRand(mixSeed(seed, w, h));
  ctx.fillStyle = SHADOW_FILL;
  ctx.fillRect(SHADOW, SHADOW, w, h);
  ctx.fillStyle = BASE_COLORS.paper;
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  grain(ctx, w, h, rand, 0.008);
  ctx.strokeStyle = BASE_COLORS.ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  return canvas;
}

/** 胶带：半透明的一小段，两头剪成锯齿，贴在白板底部的小票条上。 */
function drawTape(w: number, h: number): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas(w, h);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w - 3, h / 4);
  ctx.lineTo(w, h / 2);
  ctx.lineTo(w - 3, (3 * h) / 4);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.lineTo(3, (3 * h) / 4);
  ctx.lineTo(0, h / 2);
  ctx.lineTo(3, h / 4);
  ctx.closePath();
  ctx.fillStyle = withAlpha(BASE_COLORS.ink, 0.16);
  ctx.fill();
  return canvas;
}

function draw(kind: PaperKind, w: number, h: number, seed: number, depth: number): HTMLCanvasElement {
  switch (kind) {
    case 'slip':
      return drawSlip(w, h, seed, depth);
    case 'sticky':
      return drawSticky(w, h, seed);
    case 'board':
      return drawBoard(w, h, seed);
    case 'tag':
      return drawTag(w, h, seed);
    case 'strip':
      return drawStrip(w, h, seed);
    case 'tape':
      return drawTape(w, h);
  }
}

/** 画过的纸按种类、大小、种子记着，同样的东西不重画。最多记这么多张，满了丢掉最早的。 */
const CACHE_LIMIT = 48;
const cache = new Map<string, string>();

/** 一张纸的背景图，CSS 的 url(...) 写法。depth 只对小票有用：下沿锯齿的深度。 */
export function paperImage(kind: PaperKind, w: number, h: number, seed: number, depth = 4): string {
  const key = `${kind}:${w}x${h}:${seed}:${depth}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // 最近用过的放到最后
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const url = `url(${draw(kind, w, h, seed, depth).toDataURL('image/png')})`;
  cache.set(key, url);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  return url;
}

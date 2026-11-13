// 画布绘制的小工具。
// 所有绘制函数收一个二维画布上下文，坐标是调用者已经设好的变换下的局部坐标，颜色用传进来的色板。
import { withAlpha } from '../look.ts';
import type { Pal } from '../look.ts';

export type Ctx = CanvasRenderingContext2D;

export type { Pal };

/** 新建一块画布。浏览器里用 canvas 元素，纹理上传给 Pixi 时用得上。 */
export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function context2d(canvas: HTMLCanvasElement): Ctx {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context is not available');
  return ctx;
}

export function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

export function polyline(ctx: Ctx, pts: readonly (readonly [number, number])[], close = false): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  if (close) ctx.closePath();
}

export function circle(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

/** 圆角矩形，半径限在边长的一半以内。 */
export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export function fillWith(ctx: Ctx, color: string, alpha = 1): void {
  ctx.fillStyle = alpha === 1 ? color : withAlpha(color, alpha);
  ctx.fill();
}

export function strokeWith(ctx: Ctx, color: string, width: number, alpha = 1, cap: CanvasLineCap = 'butt'): void {
  ctx.strokeStyle = alpha === 1 ? color : withAlpha(color, alpha);
  ctx.lineWidth = width;
  ctx.lineCap = cap;
  ctx.stroke();
}

/** 一笔直线：用颜色、线宽、不透明度。 */
export function strokeLine(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, width: number, alpha = 1, cap: CanvasLineCap = 'butt'): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  strokeWith(ctx, color, width, alpha, cap);
}

/**
 * 45° 的蓝黑排线，铺满当前路径所围的区域（先 clip 再画线）。线是「/」方向，垂直间隔 spacing，线宽 width。
 * 调用时的变换应当是画板方向的（不带地图的转角），排线在屏幕上才永远是 45°。路径要在这之前用地图的变换构造好，
 * 画布的路径在构造时就已经换到设备坐标，之后换变换不影响它。
 * bounds 是当前变换下排线要铺的范围。
 */
export function hatchCurrentPath(ctx: Ctx, pal: Pal, bounds: { x: number; y: number; w: number; h: number }, alpha: number, width = 1.5, spacing = 4): void {
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = withAlpha(pal.ink, alpha);
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  const step = spacing * Math.SQRT2;
  // 「/」线：x + y = k × step
  const k0 = Math.floor((bounds.x + bounds.y) / step);
  const k1 = Math.ceil((bounds.x + bounds.w + bounds.y + bounds.h) / step);
  ctx.beginPath();
  for (let k = k0; k <= k1; k++) {
    const c = k * step;
    ctx.moveTo(bounds.x - 2, c - (bounds.x - 2));
    ctx.lineTo(bounds.x + bounds.w + 2, c - (bounds.x + bounds.w + 2));
  }
  ctx.stroke();
  ctx.restore();
}

/** 把角度（弧度）规整到 -π 到 π。 */
export function wrapAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v < -Math.PI) v += 2 * Math.PI;
  return v;
}

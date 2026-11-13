// 屋顶上的十二种物件，加上树、操场和篮球场。每种原大不超过 30 像素。
// 只用蓝黑细线和色表里的淡色。坐标是物件中心，单位是画板像素（地图 1 个单位）。
import { circle, fillWith, polyline, rect, strokeLine, strokeWith } from './ctx.ts';
import type { Ctx, Pal } from './ctx.ts';

/** 水箱：圆，十字加强筋，中心一个小圆，侧面两道短线表示爬梯。 */
export function propTank(ctx: Ctx, pal: Pal, x: number, y: number, r = 5): void {
  circle(ctx, x, y, r);
  fillWith(ctx, pal.paper);
  strokeWith(ctx, pal.ink, 1);
  strokeLine(ctx, x - r, y, x + r, y, pal.ink, 0.7, 0.6);
  strokeLine(ctx, x, y - r, x, y + r, pal.ink, 0.7, 0.6);
  circle(ctx, x, y, r * 0.3);
  strokeWith(ctx, pal.ink, 0.7);
  strokeLine(ctx, x + r, y - 1.2, x + r + 2.6, y - 1.2, pal.ink, 0.7);
  strokeLine(ctx, x + r, y + 1.2, x + r + 2.6, y + 1.2, pal.ink, 0.7);
}

/** 太阳能热水器：三到五个并排的集热板，淡蓝填充，板上两道竖线，每块板上方一个横放的水罐。 */
export function propHeaters(ctx: Ctx, pal: Pal, x: number, y: number, n = 4): void {
  for (let i = 0; i < n; i++) {
    const px = x + (i - (n - 1) / 2) * 7.2;
    rect(ctx, px - 2.6, y - 3.4, 5.2, 8);
    fillWith(ctx, pal.steel, 0.32);
    strokeWith(ctx, pal.ink, 0.75);
    strokeLine(ctx, px - 0.9, y - 3.4, px - 0.9, y + 4.6, pal.ink, 0.5, 0.7);
    strokeLine(ctx, px + 0.9, y - 3.4, px + 0.9, y + 4.6, pal.ink, 0.5, 0.7);
    ctx.beginPath();
    ctx.roundRect(px - 3.1, y - 6, 6.2, 2.6, 1.3);
    fillWith(ctx, pal.paper);
    strokeWith(ctx, pal.ink, 0.75);
  }
}

/** 空调外机：小方盒，里面一个风扇圆，一侧一道短线。 */
export function propAc(ctx: Ctx, pal: Pal, x: number, y: number): void {
  ctx.beginPath();
  ctx.roundRect(x - 4, y - 3.2, 8, 6.4, 0.8);
  fillWith(ctx, pal.paper);
  strokeWith(ctx, pal.ink, 0.85);
  circle(ctx, x - 0.8, y, 2.1);
  strokeWith(ctx, pal.ink, 0.7);
  strokeLine(ctx, x + 2.4, y - 1.8, x + 2.4, y + 1.8, pal.ink, 0.6);
}

/** 晾衣绳：两个杆头圆点，一条细线，线下挂四件大小不同的色块，用彩钢蓝、琥珀、球场绿和蓝黑，不用红色。 */
export function propClothesline(ctx: Ctx, pal: Pal, x: number, y: number, w = 26): void {
  strokeLine(ctx, x - w / 2, y, x + w / 2, y, pal.ink, 0.7);
  circle(ctx, x - w / 2, y, 1.1);
  fillWith(ctx, pal.ink);
  circle(ctx, x + w / 2, y, 1.1);
  fillWith(ctx, pal.ink);
  const colors = [pal.steel, pal.amber, pal.green, pal.ink];
  const xs = [-w / 2 + 3.5, -w / 2 + 9.5, -w / 2 + 16, -w / 2 + 21];
  const ws = [4.6, 5.4, 3.6, 3.2];
  const hs = [5.6, 3.8, 5, 3.4];
  for (let i = 0; i < 4; i++) {
    rect(ctx, x + (xs[i] as number), y + 0.4, ws[i] as number, hs[i] as number);
    fillWith(ctx, colors[i] as string, i < 3 ? 0.62 : 0.32);
  }
}

/** 种植箱：两排三列的小方格，淡绿填充，每格一个绿点。 */
export function propPlanters(ctx: Ctx, pal: Pal, x: number, y: number): void {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const px = x + (c - 1) * 5.6;
      const py = y + (r - 0.5) * 5.6;
      rect(ctx, px - 2.3, py - 2.3, 4.6, 4.6);
      fillWith(ctx, pal.green, 0.26);
      strokeWith(ctx, pal.ink, 0.6, 0.8);
      circle(ctx, px, py, 1);
      fillWith(ctx, pal.green, 0.85);
    }
  }
}

/** 彩钢棚：彩钢蓝 50% 填充，一道道纸白棱线，中间一条屋脊线。 */
export function propShed(ctx: Ctx, pal: Pal, x: number, y: number, w = 30, h = 20): void {
  rect(ctx, x - w / 2 + 1, y - h / 2 + 0.8, w, h);
  fillWith(ctx, pal.steel, 0.5);
  const n = Math.max(2, Math.floor(w / 3.6));
  for (let i = 1; i < n; i++) {
    const px = x - w / 2 + (i * w) / n;
    strokeLine(ctx, px, y - h / 2, px, y + h / 2, pal.paper, 0.9, 0.9);
  }
  strokeLine(ctx, x - w / 2, y, x + w / 2, y, pal.ink, 0.8, 0.65);
  rect(ctx, x - w / 2, y - h / 2, w, h);
  strokeWith(ctx, pal.ink, 1);
}

/** 冷却塔：圆筒，内侧一圈细线，四片风扇叶。 */
export function propCooling(ctx: Ctx, pal: Pal, x: number, y: number, r = 7): void {
  circle(ctx, x, y, r);
  fillWith(ctx, pal.paper);
  strokeWith(ctx, pal.ink, 1.1);
  circle(ctx, x, y, r * 0.72);
  strokeWith(ctx, pal.ink, 0.7, 0.7);
  for (const a of [20, 110, 200, 290]) {
    const rad = (a * Math.PI) / 180;
    const rad2 = ((a + 55) * Math.PI) / 180;
    polyline(
      ctx,
      [
        [x, y],
        [x + r * 0.66 * Math.cos(rad), y + r * 0.66 * Math.sin(rad)],
        [x + r * 0.4 * Math.cos(rad2), y + r * 0.4 * Math.sin(rad2)],
      ],
      true,
    );
    fillWith(ctx, pal.ink, 0.5);
  }
  circle(ctx, x, y, 1.3);
  fillWith(ctx, pal.ink);
}

/** 光伏板：彩钢蓝 50% 填充，纸白格线。 */
export function propPv(ctx: Ctx, pal: Pal, x: number, y: number, cols = 4, rows = 2): void {
  const cw = 6.4;
  const ch = 8.6;
  const w = cols * cw;
  const h = rows * ch;
  rect(ctx, x - w / 2 + 0.8, y - h / 2 + 0.6, w, h);
  fillWith(ctx, pal.steel, 0.5);
  for (let c = 1; c < cols; c++) strokeLine(ctx, x - w / 2 + c * cw, y - h / 2, x - w / 2 + c * cw, y + h / 2, pal.paper, 1);
  for (let r = 1; r < rows; r++) strokeLine(ctx, x - w / 2, y - h / 2 + r * ch, x + w / 2, y - h / 2 + r * ch, pal.paper, 1);
  rect(ctx, x - w / 2, y - h / 2, w, h);
  strokeWith(ctx, pal.ink, 0.9);
}

/** 停机坪：一个圆，内侧一圈虚线，中间字母 H（用线画，不用字体）。 */
export function propHelipad(ctx: Ctx, pal: Pal, x: number, y: number, r = 15): void {
  circle(ctx, x, y, r);
  strokeWith(ctx, pal.ink, 1.3, 0.8);
  ctx.setLineDash([2, 2.4]);
  circle(ctx, x, y, r - 3.2);
  strokeWith(ctx, pal.ink, 0.6, 0.7);
  ctx.setLineDash([]);
  strokeLine(ctx, x - 4.2, y - 5.6, x - 4.2, y + 5.6, pal.ink, 2.1, 0.8);
  strokeLine(ctx, x + 4.2, y - 5.6, x + 4.2, y + 5.6, pal.ink, 2.1, 0.8);
  strokeLine(ctx, x - 4.2, y, x + 4.2, y, pal.ink, 2.1, 0.8);
}

/** 楼梯间：小方块，一条对角线，一侧留出门的位置。 */
export function propStair(ctx: Ctx, pal: Pal, x: number, y: number): void {
  rect(ctx, x - 5, y - 4, 10, 8);
  fillWith(ctx, pal.block);
  strokeWith(ctx, pal.ink, 0.9);
  strokeLine(ctx, x - 5, y - 4, x + 5, y + 4, pal.ink, 0.6, 0.7);
  strokeLine(ctx, x - 1.6, y + 4, x + 1.6, y + 4, pal.paper, 1.4);
}

/** 基站：杆的圆点，三片朝外的板状天线。 */
export function propAntenna(ctx: Ctx, pal: Pal, x: number, y: number): void {
  circle(ctx, x, y, 1.6);
  fillWith(ctx, pal.ink);
  for (const a of [-90, 30, 150]) {
    const rad = (a * Math.PI) / 180;
    const ax = 4.6 * Math.cos(rad);
    const ay = 4.6 * Math.sin(rad);
    ctx.save();
    ctx.translate(x + ax, y + ay);
    ctx.rotate(((a + 90) * Math.PI) / 180);
    rect(ctx, -2.4, -0.9, 4.8, 1.8);
    fillWith(ctx, pal.paper);
    strokeWith(ctx, pal.ink, 0.7);
    ctx.restore();
    strokeLine(ctx, x, y, x + ax, y + ay, pal.ink, 0.6);
  }
}

/** 天窗：淡蓝玻璃，十字窗棂。 */
export function propSkylight(ctx: Ctx, pal: Pal, x: number, y: number, w = 16, h = 10): void {
  rect(ctx, x - w / 2 + 0.7, y - h / 2 + 0.5, w, h);
  fillWith(ctx, pal.steel, 0.2);
  rect(ctx, x - w / 2, y - h / 2, w, h);
  strokeWith(ctx, pal.ink, 0.9);
  strokeLine(ctx, x, y - h / 2, x, y + h / 2, pal.ink, 0.6, 0.7);
  strokeLine(ctx, x - w / 2, y, x + w / 2, y, pal.ink, 0.6, 0.7);
}

/** 操场：三条同心的跑道线，中间是球场，画中线、中圈和两个禁区，球场绿淡色填充。原点在左上角。 */
export function drawStadium(ctx: Ctx, pal: Pal, x: number, y: number, w: number, h: number): void {
  [0, 5, 10].forEach((ins, i) => {
    ctx.beginPath();
    ctx.roundRect(x + ins, y + ins, w - 2 * ins, h - 2 * ins, (h - 2 * ins) / 2);
    if (i === 0) fillWith(ctx, pal.paper);
    strokeWith(ctx, pal.ink, i === 0 ? 1.2 : 0.8, i === 0 ? 1 : 0.6);
  });
  const fx = x + 15 + h * 0.2;
  const fy = y + 16;
  const fw = w - 30 - h * 0.4;
  const fh = h - 32;
  rect(ctx, fx + 0.8, fy + 0.6, fw, fh);
  fillWith(ctx, pal.green, 0.3);
  rect(ctx, fx, fy, fw, fh);
  strokeWith(ctx, pal.ink, 0.9, 0.75);
  strokeLine(ctx, fx + fw / 2, fy, fx + fw / 2, fy + fh, pal.ink, 0.8, 0.7);
  circle(ctx, fx + fw / 2, fy + fh / 2, fh * 0.2);
  strokeWith(ctx, pal.ink, 0.8, 0.7);
  const bw = fw * 0.13;
  const bh = fh * 0.5;
  rect(ctx, fx, fy + (fh - bh) / 2, bw, bh);
  strokeWith(ctx, pal.ink, 0.8, 0.7);
  rect(ctx, fx + fw - bw, fy + (fh - bh) / 2, bw, bh);
  strokeWith(ctx, pal.ink, 0.8, 0.7);
}

/** 篮球场：边线、中线、中圈、两端的三分弧和罚球区，琥珀淡色填充。原点在左上角。 */
export function drawCourt(ctx: Ctx, pal: Pal, x: number, y: number, w = 44, h = 26): void {
  rect(ctx, x + 0.8, y + 0.6, w, h);
  fillWith(ctx, pal.amber, 0.2);
  rect(ctx, x, y, w, h);
  strokeWith(ctx, pal.ink, 1, 0.8);
  strokeLine(ctx, x + w / 2, y, x + w / 2, y + h, pal.ink, 0.7, 0.75);
  circle(ctx, x + w / 2, y + h / 2, h * 0.16);
  strokeWith(ctx, pal.ink, 0.7, 0.75);
  const r = h * 0.4;
  ctx.beginPath();
  ctx.arc(x, y + h / 2, r, -Math.PI / 2, Math.PI / 2);
  strokeWith(ctx, pal.ink, 0.7, 0.75);
  ctx.beginPath();
  ctx.arc(x + w, y + h / 2, r, Math.PI / 2, (3 * Math.PI) / 2);
  strokeWith(ctx, pal.ink, 0.7, 0.75);
  rect(ctx, x, y + h / 2 - h * 0.17, w * 0.14, h * 0.34);
  strokeWith(ctx, pal.ink, 0.7, 0.75);
  rect(ctx, x + w - w * 0.14, y + h / 2 - h * 0.17, w * 0.14, h * 0.34);
  strokeWith(ctx, pal.ink, 0.7, 0.75);
}

/**
 * 一丛树：两三个大小不同的圆叠在一起，淡绿填充，绿色细边，每个圆上一道树冠的短弧线。
 * 右下方的排线阴影由调用者先画（要用画板方向的变换），这里只画圆。
 */
export function drawTreeCrown(ctx: Ctx, pal: Pal, x: number, y: number, r: number, seed: number): void {
  const offs: [number, number, number][] = [
    [0, 0, 1],
    [r * 0.72, r * 0.36, 0.72],
    [-r * 0.5, r * 0.62, 0.6],
  ];
  const n = 2 + (seed % 2);
  for (let i = 0; i < n; i++) {
    const [dx, dy, k] = offs[i] as [number, number, number];
    circle(ctx, x + dx + 0.6, y + dy + 0.5, r * k);
    fillWith(ctx, pal.green, 0.3);
  }
  for (let i = 0; i < n; i++) {
    const [dx, dy, k] = offs[i] as [number, number, number];
    circle(ctx, x + dx, y + dy, r * k);
    strokeWith(ctx, pal.green, 1, 0.85);
    ctx.beginPath();
    ctx.moveTo(x + dx - r * k * 0.34, y + dy - r * k * 0.1);
    ctx.quadraticCurveTo(x + dx - r * k * 0.34 + r * k * 0.3, y + dy - r * k * 0.1 - r * k * 0.42, x + dx - r * k * 0.34 + r * k * 0.62, y + dy - r * k * 0.1 - r * k * 0.08);
    strokeWith(ctx, pal.green, 0.8, 0.7);
  }
}

/** 树影的椭圆参数（相对树中心），排线阴影用。 */
export function treeShadow(x: number, y: number, r: number): { cx: number; cy: number; rx: number; ry: number } {
  return { cx: x + r * 0.5, cy: y + r * 0.62, rx: r * 1.05, ry: r * 0.86 };
}


// 手画的线：圈、下划线、五角星。返回 SVG 路径，不碰 DOM。
// 线是几十个点平滑连起来的，每个点按种子抖一点，同一个种子画出同一条线。圈首尾不完全对上，略微向外放大。
import { createRand } from './seeded.ts';

type Point = readonly [number, number];

/** 平滑地连过一串点的 SVG 路径（Catmull-Rom 换成三次贝塞尔）。 */
export function smoothPath(pts: readonly Point[]): string {
  const n = pts.length;
  const first = pts[0];
  if (first === undefined) return '';
  let d = `M${first[0].toFixed(1)},${first[1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)] as Point;
    const p1 = pts[i] as Point;
    const p2 = pts[i + 1] as Point;
    const p3 = pts[Math.min(n - 1, i + 2)] as Point;
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** 一圈手画的椭圆，中心 (cx, cy)，半轴 rx 和 ry。turns 是绕的圈数，jitter 是每个点抖动的幅度。 */
export function handCircle(cx: number, cy: number, rx: number, ry: number, seed: number, turns = 1.13, jitter = 1.1): string {
  const rand = createRand(seed);
  const a0 = -2.9 + rand() * 0.6;
  const n = 30;
  const m = Math.floor(n * turns);
  const pts: Point[] = [];
  for (let k = 0; k <= m; k++) {
    const a = a0 + 2 * Math.PI * turns * (k / m);
    const grow = 1 + 0.07 * (k / m);
    pts.push([cx + (rx * grow + (rand() * 2 - 1) * jitter) * Math.cos(a), cy + (ry * grow + (rand() * 2 - 1) * jitter) * Math.sin(a)]);
  }
  return smoothPath(pts);
}

/** 一条手画的线，从 (x0, y0) 到 (x1, y1)，中间略有起伏。 */
export function handLine(x0: number, y0: number, x1: number, y1: number, seed: number, jitter = 0.7): string {
  const rand = createRand(seed);
  const n = Math.max(3, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 16));
  const pts: Point[] = [];
  for (let k = 0; k <= n; k++) pts.push([x0 + ((x1 - x0) * k) / n + (rand() - 0.5) * jitter, y0 + ((y1 - y0) * k) / n + (rand() * 2 - 1) * jitter]);
  return smoothPath(pts);
}

/** 一颗手画的五角星，外半径 r，内半径约为外半径的 0.47，闭合的路径。 */
export function handStar(cx: number, cy: number, r: number, seed: number): string {
  const rand = createRand(seed);
  const pts: string[] = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5 + (rand() - 0.5) * 0.12;
    const rr = (k % 2 === 0 ? r : r * 0.47) * (0.92 + rand() * 0.14);
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join(' L')} Z`;
}

/** 缩放到元素大小的手画圈：画在 100 乘 40 的坐标里，元素用 preserveAspectRatio="none" 拉伸，线宽用 non-scaling-stroke。 */
export function stretchCircle(seed: number): string {
  return handCircle(50, 20, 46, 16, seed, 1.15, 1);
}

/** 缩放到元素宽度的手画下划线：画在 100 乘 8 的坐标里。 */
export function stretchUnderline(seed: number): string {
  return handLine(1, 4, 99, 3.2, seed, 0.9);
}

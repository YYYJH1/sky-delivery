// 街道：把画面要覆盖的区域一刀一刀切成街区。
//
// 做法（确定的，同一份输入得到同一份街道）：
// 1. 从整块区域开始，量一下宽高，超过街区的上限就沿长边切一刀，没超过的有三成的机会再切一刀，让街区有大有小。
// 2. 每一刀是一条街。前两层的街宽 30（大街），再往下宽 22（小巷），小巷里偶尔有一条宽 30。街只在被切的这一块里延伸，
//    所以相邻的街不对齐，街区是丁字路口，不是整齐的方格。
// 3. 切的位置从中间三成里取 16 个候选，取代价最小的。候选屋顶（硬障碍）不能被街压住，压住的候选直接不要。
//    店和送餐的楼（软障碍）可以被街压住，每压住一个加一份代价，压得越深代价越大，切完之后由 city.ts 把它们挪进街区里面。
//    代价相同的取随机数小的，所以不会总切在正中间。
// 4. 切下来的两块各自缩进半个街宽，所以叶子就是街区，街是街区之间露出的纸白。
import type { Street } from './city-types.ts';
import type { Rect } from './geometry.ts';
import { overlaps } from './geometry.ts';
import type { Rand } from './rng.ts';

export const MAIN_WIDTH = 30;
export const LANE_WIDTH = 22;
const MAX_W = 236;
const MAX_H = 196;
const MIN_W = 88;
const MIN_H = 80;
/** 街带离候选屋顶的最小间隙。 */
const CLEARANCE = 8;
/** 软障碍的代价：压住一个算 1，每深入 30 个单位再加 1。 */
const DEPTH_UNIT = 30;
const CANDIDATES = 16;

export interface Subdivision {
  streets: Street[];
  leaves: Rect[];
}

/**
 * 把 region 切成街区。hard 是不能压住的屋顶，soft 是尽量别压住的屋顶。
 * 返回街和叶子（街区的矩形）。
 */
export function subdivide(region: Rect, hard: readonly Rect[], soft: readonly Rect[], rand: Rand): Subdivision {
  const streets: Street[] = [];
  const leaves: Rect[] = [];

  function split(rect: Rect, depth: number, hardIn: readonly Rect[], softIn: readonly Rect[]): void {
    const { x, y, w, h } = rect;
    let axis: 'v' | 'h' | null = null;
    const overW = w > MAX_W;
    const overH = h > MAX_H;
    if (overW && overH) axis = w / MAX_W >= h / MAX_H ? 'v' : 'h';
    else if (overW) axis = 'v';
    else if (overH) axis = 'h';
    else if (w > 160 && h > 138 && rand() < 0.3) axis = w * 0.82 >= h ? 'v' : 'h';
    if (axis === null) {
      leaves.push(rect);
      return;
    }
    const sw = depth <= 1 ? MAIN_WIDTH : rand() < 0.1 ? MAIN_WIDTH : LANE_WIDTH;
    const lo = axis === 'v' ? x : y;
    const len = axis === 'v' ? w : h;
    const minSide = axis === 'v' ? MIN_W : MIN_H;
    const first = lo + minSide + sw / 2;
    const last = lo + len - minSide - sw / 2;
    if (last < first) {
      leaves.push(rect);
      return;
    }
    const span = (f: Rect): [number, number] => (axis === 'v' ? [f.x, f.x + f.w] : [f.y, f.y + f.h]);
    let best = Number.NaN;
    let bestCost = Infinity;
    const tryCandidate = (c: number, jitter: number): void => {
      if (c < first || c > last) return;
      const bandLo = c - sw / 2;
      const bandHi = c + sw / 2;
      for (const f of hardIn) {
        const [a, b] = span(f);
        if (bandLo - CLEARANCE < b && a < bandHi + CLEARANCE) return;
      }
      let cost = jitter;
      for (const f of softIn) {
        const [a, b] = span(f);
        const depthIn = Math.min(bandHi, b) - Math.max(bandLo, a);
        if (depthIn > 0) cost += 1 + depthIn / DEPTH_UNIT;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    };
    for (let k = 0; k < CANDIDATES; k++) tryCandidate(lo + len * (0.3 + 0.4 * rand()), 0.01 * rand());
    if (Number.isNaN(best)) {
      // 中间三成里全被候选屋顶挡住：从中线向两边一格一格扫
      const mid = lo + len / 2;
      for (let step = 0; step <= len / 2 && Number.isNaN(best); step += 6) {
        tryCandidate(mid + step, 0);
        if (Number.isNaN(best)) tryCandidate(mid - step, 0);
      }
    }
    if (Number.isNaN(best)) {
      leaves.push(rect);
      return;
    }
    const c = best;
    const a: Rect = axis === 'v' ? { x, y, w: c - sw / 2 - x, h } : { x, y, w, h: c - sw / 2 - y };
    const b: Rect = axis === 'v' ? { x: c + sw / 2, y, w: x + w - (c + sw / 2), h } : { x, y: c + sw / 2, w, h: y + h - (c + sw / 2) };
    streets.push(axis === 'v' ? { orient: 'v', c, w: sw, a: y, b: y + h, main: sw >= MAIN_WIDTH } : { orient: 'h', c, w: sw, a: x, b: x + w, main: sw >= MAIN_WIDTH });
    // 软障碍的中心在哪一侧就归哪一侧
    const centerSide = (f: Rect): boolean => (axis === 'v' ? f.x + f.w / 2 < c : f.y + f.h / 2 < c);
    split(a, depth + 1, hardIn.filter((f) => overlaps(f, a)), softIn.filter((f) => centerSide(f)));
    split(b, depth + 1, hardIn.filter((f) => overlaps(f, b)), softIn.filter((f) => !centerSide(f)));
  }

  split(region, 0, hard.filter((f) => overlaps(f, region)), soft.filter((f) => overlaps(f, region)));
  return { streets, leaves };
}

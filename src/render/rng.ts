// 画面层的随机数：固定种子，同一个种子永远得到同一个序列。纸纹、毛边、套印偏移、街区和屋顶物件的摆放都从这里取，
// 所以同一份地图数据画出同一张图。核心的随机数在 src/core/rng.ts，画面层不碰它，也不用 Math.random。

export interface Rand {
  /** [0, 1) 的小数。 */
  (): number;
}

/** mulberry32：一个 32 位整数的状态，够快，对画面来说足够均匀。 */
export function createRand(seed: number): Rand {
  let s = seed >>> 0;
  return () => {
    s = (s + 1831565813) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把几个整数混成一个种子：同一组输入得到同一个种子，不同的输入互不相关。 */
export function mixSeed(...parts: number[]): number {
  let h = -2128831035;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 15;
    h = Math.imul(h, 739786861);
    h ^= h >>> 12;
  }
  return h >>> 0;
}

export function range(rand: Rand, lo: number, hi: number): number {
  return lo + (hi - lo) * rand();
}

/** [lo, hi] 的整数。 */
export function int(rand: Rand, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

export function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))] as T;
}

/** 按权重抽一项，权重不必加起来等于 1。 */
export function weighted<T>(rand: Rand, items: readonly T[], weights: readonly number[]): T {
  let total = 0;
  for (const w of weights) total += w;
  let u = rand() * total;
  for (let i = 0; i < items.length; i++) {
    u -= weights[i] as number;
    if (u < 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}

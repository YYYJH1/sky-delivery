// 界面画纸、毛边和手画线用的随机数：固定种子，同一个种子永远得到同一个序列。纯函数，不读系统时钟，不用 Math.random。

/** [0, 1) 的小数，每次调用给下一个。 */
export interface Rand {
  (): number;
}

/** mulberry32：一个 32 位整数的状态，够快，对画纸来说足够均匀。 */
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
  let h = 2166136261;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

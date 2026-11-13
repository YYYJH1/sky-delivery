// 带种子的随机数（sfc32）。状态是四个整数，可以直接序列化，放在模拟状态里。
import { detExp } from './detmath.ts';

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** 用 splitmix32 把一个整数种子展开成四个整数，再空转几轮，使相邻的种子得到互不相关的序列。 */
export function createRng(seed: number): RngState {
  let s = seed | 0;
  const mix = (): number => {
    s = (s + 0x9e3779b9) | 0;
    let z = s ^ (s >>> 16);
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return z | 0;
  };
  const r: RngState = { a: mix(), b: mix(), c: mix(), d: mix() };
  for (let i = 0; i < 15; i++) nextU32(r);
  return r;
}

/** 下一个 32 位无符号整数。 */
export function nextU32(r: RngState): number {
  const t = (((r.a + r.b) | 0) + r.d) | 0;
  r.d = (r.d + 1) | 0;
  r.a = r.b ^ (r.b >>> 9);
  r.b = (r.c + (r.c << 3)) | 0;
  r.c = (r.c << 21) | (r.c >>> 11);
  r.c = (r.c + t) | 0;
  return t >>> 0;
}

/** [0, 1) 的小数。 */
export function nextFloat(r: RngState): number {
  return nextU32(r) / 4294967296;
}

/** [0, n) 的整数。 */
export function nextInt(r: RngState, n: number): number {
  return Math.floor(nextFloat(r) * n);
}

/** [lo, hi) 的小数。 */
export function nextRange(r: RngState, lo: number, hi: number): number {
  return lo + (hi - lo) * nextFloat(r);
}

/** Fisher-Yates 洗牌。 */
export function shuffleInPlace<T>(r: RngState, items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = nextInt(r, i + 1);
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
}

/** 泊松分布。λ 很小（每步的来单率），用连乘法。 */
export function poisson(r: RngState, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 100) throw new RangeError('poisson lambda is too large');
  const limit = detExp(-lambda);
  let k = 0;
  let p = nextFloat(r);
  while (p > limit) {
    k++;
    p *= nextFloat(r);
  }
  return k;
}

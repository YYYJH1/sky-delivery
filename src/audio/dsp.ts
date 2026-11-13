// 声音合成用到的小工具：带种子的随机数，状态变量滤波器，粉红噪声，包络，电平测量。
// 全部是纯函数，或者只在函数内部持有状态的闭包。不碰浏览器，不读时钟，不用 Math.random。

export const TWO_PI = Math.PI * 2;

/** 带种子的随机数（mulberry32）。同一个种子给出同一串 [0, 1) 的小数。 */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用带种子的随机数把数组填成 [-1, 1) 的白噪声。结果和 makeRandom(seed) 依次给出的数乘 2 减 1 逐位相同，只是少了函数调用，填几十万个采样时快得多。 */
export function fillNoise(out: Float32Array, seed: number): void {
  let a = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** x 从 0 到 1 时输出从 0 到 1，两端的斜率都是 0。x 超出范围时取端点。 */
export function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** 在 from 和 to 之间按比例取值，x 为 0 到 1。按指数插值，所以音高和截止频率听起来是匀速变化的。 */
export function expLerp(from: number, to: number, x: number): number {
  return from * Math.pow(to / from, clamp(x, 0, 1));
}

/** 状态变量滤波器的输出。每次 tick 之后读取。 */
export interface StateVariable {
  /** 低通。 */
  lp: number;
  /** 带通，中心频率处的增益是 1。 */
  bp: number;
  /** 高通。 */
  hp: number;
  /** 改截止频率（赫兹）和品质因数。可以每个采样改一次，扫频不会出现杂音。 */
  set(freq: number, q: number): void;
  /** 送入一个采样，更新 lp、bp、hp。 */
  tick(x: number): void;
}

/** 两个积分器的状态变量滤波器（TPT 结构）。频率上限取采样率的 0.45 倍，保证稳定。 */
export function stateVariable(sampleRate: number): StateVariable {
  let ic1 = 0;
  let ic2 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  let k = 1;
  const filter: StateVariable = {
    lp: 0,
    bp: 0,
    hp: 0,
    set(freq: number, q: number): void {
      const g = Math.tan((Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate);
      k = 1 / q;
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    },
    tick(x: number): void {
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      filter.lp = v2;
      filter.bp = k * v1;
      filter.hp = x - k * v1 - v2;
    },
  };
  filter.set(1000, 0.7071);
  return filter;
}

/** 把白噪声变成粉红噪声的滤波器（三个一阶滤波器叠加的近似）。输入输出幅度大致都在 ±1 以内。 */
export function pinkFilter(): (white: number) => number {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return (white: number) => {
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    return (b0 + b1 + b2 + white * 0.1848) * 0.35;
  };
}

/** 粉红噪声。每次调用给出一个采样。 */
export function pinkNoise(random: () => number): () => number {
  const filter = pinkFilter();
  return () => filter(random() * 2 - 1);
}

/** 全部采样乘上同一个数，使峰值等于 peak。全是零时不动。返回传入的数组。 */
export function scaleToPeak(samples: Float32Array, peak: number): Float32Array {
  const current = peakOf(samples);
  if (current === 0) return samples;
  const gain = peak / current;
  for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] as number) * gain;
  return samples;
}

/** 全部采样乘上同一个数，使均方根等于 rms。全是零时不动。返回传入的数组。 */
export function scaleToRms(samples: Float32Array, rms: number): Float32Array {
  const current = rmsOf(samples);
  if (current === 0) return samples;
  const gain = rms / current;
  for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] as number) * gain;
  return samples;
}

/**
 * 在开头和结尾各加一段半个余弦的淡入和淡出，首尾的采样因此一定是 0，不会有爆音。
 * 淡入或淡出的秒数为 0 时，那一端不处理。
 */
export function fadeEdges(samples: Float32Array, sampleRate: number, fadeInSeconds: number, fadeOutSeconds: number): void {
  const n = samples.length;
  const fadeIn = Math.min(n, Math.round(fadeInSeconds * sampleRate));
  const fadeOut = Math.min(n, Math.round(fadeOutSeconds * sampleRate));
  for (let i = 0; i < fadeIn; i++) samples[i] = (samples[i] as number) * (0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn));
  for (let i = 0; i < fadeOut; i++) {
    const at = n - 1 - i;
    samples[at] = (samples[at] as number) * (0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut));
  }
}

// ---- 电平测量 ----

/** 绝对值最大的采样。 */
export function peakOf(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number);
    if (v > peak) peak = v;
  }
  return peak;
}

/** 均方根。空数组为 0。 */
export function rmsOf(samples: ArrayLike<number>, from = 0, to = samples.length): number {
  const end = Math.min(to, samples.length);
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i++) {
    const v = samples[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum / (end - from));
}

/** 线性幅度换成相对满刻度的分贝。0 给出负无穷。 */
export function toDecibels(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY;
}

/**
 * 有声音的那一段的均方根：把声音切成 10 毫秒一块，只算均方根不低于最响一块的 1% 的那些块（比最响的低 40 分贝以内）。
 * 短促的声音大部分时间是安静的，整段的均方根会被拉得很低，这一项更接近听起来的响度。
 */
export function activeRms(samples: ArrayLike<number>, sampleRate: number): number {
  const block = Math.max(1, Math.round(sampleRate * 0.01));
  const levels: number[] = [];
  for (let at = 0; at < samples.length; at += block) levels.push(rmsOf(samples, at, at + block));
  const loudest = levels.reduce((m, v) => Math.max(m, v), 0);
  if (loudest === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const level of levels) {
    if (level >= loudest * 0.01) {
      sum += level * level;
      count += 1;
    }
  }
  return Math.sqrt(sum / count);
}

// 城市环境声：白天和夜间各一条，可以无缝循环。和音效一样是确定性的纯函数，给定采样率和时长，返回单声道的 Float32Array。
// 无缝的做法：
//   噪声层的每一级滤波都先用数组的最后 0.3 秒预热，再处理整段。滤波器的记忆只有几十毫秒，开头因此接着结尾，首尾是连续的。
//   周期成分（缓慢的起伏、电器的嗡声）在整个循环里正好走整数个周期。
//   单独的事件（过路的车、鸟叫、虫鸣）按取模写进数组，越过末尾的部分绕回开头。
// 电平很低，主要能量放在 200 到 2000 Hz，笔记本的小扬声器也听得见，但不抢音效。
import { TWO_PI, fillNoise, makeRandom, scaleToRms, stateVariable } from './dsp.ts';

/** 环境声的合成采样率。内容里没有 6 kHz 以上的成分，用比音效低的采样率，省内存也省合成时间。 */
export const AMBIENT_RATE = 24000;

/** 白天和夜间两段循环的时长（秒）。两段的长度不同，交替时不会听出同步的重复。 */
export const AMBIENT_SECONDS = { day: 24, night: 28 } as const;

/** 两段环境声的均方根（线性幅度）。白天约 -32 分贝，夜间约 -35 分贝，都比音效低得多。 */
export const AMBIENT_RMS = { day: 0.025, night: 0.018 } as const;

/** 预热的时长（秒）。要比滤波器的记忆长得多。 */
const WARM_SECONDS = 0.3;

interface Stage {
  readonly kind: 'lp' | 'hp' | 'bp' | 'pink';
  readonly freq: number;
  readonly q: number;
}

const lp = (freq: number): Stage => ({ kind: 'lp', freq, q: 0.7071 });
const hp = (freq: number): Stage => ({ kind: 'hp', freq, q: 0.7071 });
const bp = (freq: number, q: number): Stage => ({ kind: 'bp', freq, q });
const PINK: Stage = { kind: 'pink', freq: 0, q: 1 };

/** 对一个环形的数组原地做一级滤波：先用数组的结尾预热，再处理整段，处理完首尾仍然相接。 */
function filterLoop(buf: Float32Array, sampleRate: number, stage: Stage): void {
  const n = buf.length;
  const warm = Math.min(n, Math.round(WARM_SECONDS * sampleRate));
  if (stage.kind === 'pink') {
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = n - warm; i < n; i++) {
      const white = buf[i] as number;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
    }
    for (let i = 0; i < n; i++) {
      const white = buf[i] as number;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      buf[i] = (b0 + b1 + b2 + white * 0.1848) * 0.35;
    }
    return;
  }
  const g = Math.tan((Math.PI * Math.min(stage.freq, sampleRate * 0.45)) / sampleRate);
  const k = 1 / stage.q;
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  // 输出是输入、带通积分器、低通积分器的线性组合：低通取 v2，带通取 k * v1，高通取 x - k * v1 - v2
  const ox = stage.kind === 'hp' ? 1 : 0;
  const o1 = stage.kind === 'bp' ? k : stage.kind === 'hp' ? -k : 0;
  const o2 = stage.kind === 'lp' ? 1 : stage.kind === 'hp' ? -1 : 0;
  let ic1 = 0;
  let ic2 = 0;
  for (let i = n - warm; i < n; i++) {
    const v3 = (buf[i] as number) - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
  }
  for (let i = 0; i < n; i++) {
    const x = buf[i] as number;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    buf[i] = ox * x + o1 * v1 + o2 * v2;
  }
}

/** 环形的滤波噪声：白噪声依次过各级滤波，长度 n，均方根为 1。首尾相接。 */
function loopNoise(n: number, sampleRate: number, seed: number, stages: readonly Stage[]): Float32Array {
  const out = new Float32Array(n);
  fillNoise(out, seed);
  for (const stage of stages) filterLoop(out, sampleRate, stage);
  return scaleToRms(out, 1);
}

/** 在整个循环里正好走 cycles 个周期的正弦，i 是采样序号，n 是循环的长度。 */
function cycleSine(cycles: number, phase: number, i: number, n: number): number {
  return Math.sin((TWO_PI * cycles * i) / n + phase);
}

/** 一辆车从远处驶过：噪声经带通，中心频率先升后降，幅度按平方正弦起落。越过末尾的部分绕回开头。 */
function addPassBy(out: Float32Array, sampleRate: number, random: () => number, startSeconds: number, seconds: number, gain: number): void {
  const n = out.length;
  const length = Math.round(seconds * sampleRate);
  const start = Math.round(startSeconds * sampleRate);
  const filter = stateVariable(sampleRate);
  const soften = stateVariable(sampleRate);
  soften.set(1600, 0.7071);
  let swell = 0;
  for (let i = 0; i < length; i++) {
    // 起落很慢，每 16 个采样更新一次包络和中心频率就够了
    if ((i & 15) === 0) {
      swell = Math.sin((Math.PI * i) / length);
      filter.set(300 + 520 * swell, 0.8);
    }
    filter.tick(random() * 2 - 1);
    soften.tick(filter.bp);
    const at = (start + i) % n;
    out[at] = (out[at] as number) + soften.lp * swell * swell * gain;
  }
}

/** 一声鸟叫：正弦的音高从 f0 滑到 f1，幅度按平方正弦起落。 */
function addChirp(out: Float32Array, sampleRate: number, startSeconds: number, f0: number, f1: number, seconds: number, gain: number): void {
  const n = out.length;
  const length = Math.round(seconds * sampleRate);
  const start = Math.round(startSeconds * sampleRate);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const u = i / length;
    phase += (TWO_PI * (f0 + (f1 - f0) * u)) / sampleRate;
    const at = (start + i) % n;
    const envelope = Math.sin(Math.PI * u);
    out[at] = (out[at] as number) + Math.sin(phase) * envelope * envelope * gain;
  }
}

/** 一串鸟叫：count 声，间隔 gap 秒，音高依次升高一点。 */
function addBirdCall(out: Float32Array, sampleRate: number, startSeconds: number, base: number, count: number, gap: number, gain: number): void {
  for (let k = 0; k < count; k++) addChirp(out, sampleRate, startSeconds + k * gap, base * (1 + 0.04 * k), base * (1.22 + 0.04 * k), 0.06, gain);
}

/** 白天的城市环境声：车流的隆隆声和人声般的嗡嗡声缓缓起伏，偶尔有风、远处驶过的车和几声鸟叫。 */
export function renderAmbientDay(sampleRate: number, seconds: number = AMBIENT_SECONDS.day): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const rumble = loopNoise(n, sampleRate, 0x6461_0001, [lp(220), lp(220), hp(50)]);
  const murmur = loopNoise(n, sampleRate, 0x6461_0002, [PINK, hp(200), hp(200), lp(1400), lp(1400)]);
  const air = loopNoise(n, sampleRate, 0x6461_0003, [bp(2200, 0.7), lp(4000)]);
  const out = new Float32Array(n);
  let swell = 1;
  let gust = 0;
  for (let i = 0; i < n; i++) {
    // 起伏很慢，每 32 个采样更新一次就够了
    if ((i & 31) === 0) {
      swell = 1 + 0.25 * cycleSine(2, 0.7, i, n) + 0.12 * cycleSine(5, 2.1, i, n);
      gust = 0.5 + 0.5 * cycleSine(3, 1.3, i, n);
    }
    out[i] = (rumble[i] as number) * 0.55 * swell + (murmur[i] as number) * 1.0 * (1.1 - 0.2 * swell) + (air[i] as number) * 0.16 * gust * gust;
  }
  const cars = makeRandom(0x6461_0004);
  const length = n / sampleRate;
  for (const share of [0.1, 0.45, 0.78]) addPassBy(out, sampleRate, cars, length * share, 4, 4);
  const birds = makeRandom(0x6461_0005);
  addBirdCall(out, sampleRate, length * 0.18, 3300 + 300 * birds(), 3, 0.14, 0.65);
  addBirdCall(out, sampleRate, length * 0.46, 3700 + 300 * birds(), 2, 0.17, 0.6);
  addBirdCall(out, sampleRate, length * 0.74, 3100 + 300 * birds(), 4, 0.12, 0.65);
  return scaleToRms(out, AMBIENT_RMS.day);
}

/** 一只蟋蟀：载频 carrier，每隔 gap 秒左右叫一阵，一阵是四个短脉冲。越过末尾的部分绕回开头。 */
function addCricket(out: Float32Array, sampleRate: number, random: () => number, carrier: number, gap: number, gain: number): void {
  const n = out.length;
  const seconds = n / sampleRate;
  const pulse = Math.round(0.024 * sampleRate);
  const step = Math.round(0.04 * sampleRate);
  const inc = (TWO_PI * carrier) / sampleRate;
  for (let at = random() * gap; at < seconds; at += gap * (0.85 + 0.3 * random())) {
    const start = Math.round(at * sampleRate);
    for (let k = 0; k < 4; k++) {
      let phase = 0;
      for (let i = 0; i < pulse; i++) {
        const envelope = Math.sin((Math.PI * i) / pulse);
        const to = (start + k * step + i) % n;
        out[to] = (out[to] as number) + Math.sin(phase) * envelope * envelope * gain;
        phase += inc;
      }
    }
  }
}

/** 电器的嗡声：几个正弦叠加，每个在整个循环里正好走整数个周期。用递推算正弦，比每个采样调一次 Math.sin 快得多。 */
function addHum(out: Float32Array, sampleRate: number, hum: readonly { readonly freq: number; readonly amp: number }[]): void {
  const n = out.length;
  for (const { freq, amp } of hum) {
    const theta = (TWO_PI * Math.max(1, Math.round((freq * n) / sampleRate))) / n;
    const c = 2 * Math.cos(theta);
    let previous = -Math.sin(theta);
    let current = 0;
    for (let i = 0; i < n; i++) {
      out[i] = (out[i] as number) + amp * current;
      const next = c * current - previous;
      previous = current;
      current = next;
    }
  }
}

/** 夜间的城市环境声：车流更远更轻，远处空调的低嗡声和风扇声，几只蟋蟀，偶尔有一辆车驶过。 */
export function renderAmbientNight(sampleRate: number, seconds: number = AMBIENT_SECONDS.night): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const rumble = loopNoise(n, sampleRate, 0x6e69_0001, [lp(200), lp(200), hp(45)]);
  const murmur = loopNoise(n, sampleRate, 0x6e69_0002, [PINK, hp(180), hp(180), lp(900), lp(900)]);
  const fan = loopNoise(n, sampleRate, 0x6e69_0003, [bp(900, 3)]);
  const out = new Float32Array(n);
  let swell = 1;
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) swell = 1 + 0.2 * cycleSine(2, 1.9, i, n) + 0.1 * cycleSine(7, 0.4, i, n);
    out[i] = (rumble[i] as number) * 0.6 * swell + (murmur[i] as number) * 0.7 * (1.1 - 0.2 * swell) + (fan[i] as number) * 0.1;
  }
  addHum(out, sampleRate, [
    { freq: 100, amp: 0.12 },
    { freq: 200, amp: 0.07 },
    { freq: 300, amp: 0.04 },
  ]);
  const random = makeRandom(0x6e69_0004);
  const length = n / sampleRate;
  for (const share of [0.22, 0.66]) addPassBy(out, sampleRate, random, length * share, 4.5, 3.5);
  addCricket(out, sampleRate, random, 4300, 1.7, 0.35);
  addCricket(out, sampleRate, random, 4650, 2.1, 0.28);
  addCricket(out, sampleRate, random, 4950, 1.45, 0.24);
  return scaleToRms(out, AMBIENT_RMS.night);
}

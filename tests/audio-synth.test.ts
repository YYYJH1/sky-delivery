// 声音的合成：每个声音是确定性的纯函数，按采样率给出 Float32Array。
// 检查确定性、时长、峰值、没有 NaN、开头结尾没有爆音、环境声首尾能接上，以及 WAV 编码。
import { describe, expect, it } from 'vitest';
import { AMBIENT_RATE, AMBIENT_RMS, AMBIENT_SECONDS } from '../src/audio/ambient.ts';
import { AMBIENT_IDS, AMBIENT_PEAK_LIMIT, EFFECT_PEAK_LIMIT, SOUND_IDS, renderAmbient, renderSound } from '../src/audio/catalog.ts';
import type { AmbientId, SoundId } from '../src/audio/catalog.ts';
import { activeRms, fadeEdges, fillNoise, makeRandom, peakOf, rmsOf, scaleToPeak, scaleToRms, smoothstep, stateVariable, toDecibels } from '../src/audio/dsp.ts';
import { EFFECT_PEAKS } from '../src/audio/effects.ts';
import { encodeWav } from '../src/audio/wav.ts';

const RATE = 44100;

/** 每个音效的时长范围（秒）。都是短音效，最长的高峰开始的铃声不到两秒。 */
const DURATION: Readonly<Record<SoundId, readonly [number, number]>> = {
  takeoff: [0.3, 0.8],
  onTime: [0.3, 0.8],
  bigOrder: [0.5, 1.2],
  cancel: [0.3, 0.8],
  rule: [0.1, 0.4],
  summary: [0.4, 1.2],
  peakStart: [1, 2.5],
  starUp: [0.5, 1.4],
  noteRead: [0.15, 0.5],
};

const cache = new Map<string, Float32Array>();
function effect(id: SoundId, rate = RATE): Float32Array {
  const key = `${id}@${rate}`;
  let samples = cache.get(key);
  if (samples === undefined) {
    samples = renderSound(id, rate);
    cache.set(key, samples);
  }
  return samples;
}
function ambient(id: AmbientId, rate = AMBIENT_RATE, seconds?: number): Float32Array {
  const key = `${id}@${rate}x${seconds ?? 'default'}`;
  let samples = cache.get(key);
  if (samples === undefined) {
    samples = renderAmbient(id, rate, seconds);
    cache.set(key, samples);
  }
  return samples;
}

/** 两个数组逐位相同。 */
function sameBits(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
}

function maxStep(samples: Float32Array): number {
  let max = 0;
  for (let i = 1; i < samples.length; i++) max = Math.max(max, Math.abs((samples[i] as number) - (samples[i - 1] as number)));
  return max;
}

function stepRms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += ((samples[i] as number) - (samples[i - 1] as number)) ** 2;
  return Math.sqrt(sum / (samples.length - 1));
}

describe('目录', () => {
  it('九个音效和两条环境声，名字对得上游戏里发生的事', () => {
    expect([...SOUND_IDS]).toEqual(['takeoff', 'onTime', 'bigOrder', 'cancel', 'rule', 'summary', 'peakStart', 'starUp', 'noteRead']);
    expect([...AMBIENT_IDS]).toEqual(['ambientDay', 'ambientNight']);
    expect(Object.keys(EFFECT_PEAKS).sort()).toEqual([...SOUND_IDS].sort());
  });
});

describe.each([...SOUND_IDS])('音效 %s', (id) => {
  const samples = effect(id);

  it('是确定性的：同样的采样率，两次合成逐位相同', () => {
    expect(sameBits(samples, renderSound(id, RATE))).toBe(true);
  });

  it('时长在预期范围内，并且很短', () => {
    const [lo, hi] = DURATION[id];
    expect(samples.length / RATE).toBeGreaterThanOrEqual(lo);
    expect(samples.length / RATE).toBeLessThanOrEqual(hi);
    expect(samples.length / RATE).toBeLessThan(2.5);
  });

  it('没有 NaN 和无穷大', () => {
    expect(samples.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('峰值固定在目标值上，不为零，不超过上限', () => {
    const peak = peakOf(samples);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(EFFECT_PEAK_LIMIT);
    expect(peak).toBeCloseTo(EFFECT_PEAKS[id], 4);
  });

  it('开头结尾有包络：第一个和最后一个采样是 0，开头缓缓进入，结尾已经衰减完，不会有爆音', () => {
    const peak = peakOf(samples);
    expect(Math.abs(samples[0] as number)).toBeLessThan(1e-6);
    expect(Math.abs(samples[samples.length - 1] as number)).toBeLessThan(1e-6);
    // 开头的几个采样还没有走到峰值
    for (let i = 0; i < 3; i++) expect(Math.abs(samples[i] as number)).toBeLessThan(0.3 * peak);
    // 最后 20 毫秒几乎听不见
    expect(rmsOf(samples, samples.length - Math.round(RATE * 0.02), samples.length)).toBeLessThan(0.02 * peak);
  });

  it('没有直流偏移', () => {
    let mean = 0;
    for (const v of samples) mean += v;
    expect(Math.abs(mean / samples.length)).toBeLessThan(0.01 * peakOf(samples));
  });

  it('音量低：有声段的均方根在 -36 到 -17 分贝之间', () => {
    const level = toDecibels(activeRms(samples, RATE));
    expect(level).toBeGreaterThan(-36);
    expect(level).toBeLessThan(-17);
  });

  it('换采样率：时长不变，峰值不变，响度相差不到 3 分贝', () => {
    for (const rate of [22050, 48000]) {
      const other = effect(id, rate);
      expect(other.length / rate).toBeCloseTo(samples.length / RATE, 2);
      expect(peakOf(other)).toBeCloseTo(peakOf(samples), 4);
      expect(Math.abs(toDecibels(activeRms(other, rate)) - toDecibels(activeRms(samples, RATE)))).toBeLessThan(3);
      expect(other.every((v) => Number.isFinite(v))).toBe(true);
      expect(Math.abs(other[0] as number)).toBeLessThan(1e-6);
      expect(Math.abs(other[other.length - 1] as number)).toBeLessThan(1e-6);
    }
  });
});

describe('音效之间', () => {
  it('每一个都不一样', () => {
    const lengths = new Set(SOUND_IDS.map((id) => effect(id).length));
    // 时长相同的几对，波形也不同
    expect(lengths.size).toBeGreaterThanOrEqual(7);
    for (const a of SOUND_IDS) for (const b of SOUND_IDS) if (a < b && effect(a).length === effect(b).length) expect(sameBits(effect(a), effect(b))).toBe(false);
  });

  it('退单的音最低，高峰开始的铃声居中，准时送达的提示音最高', () => {
    // 用主要能量的频率粗略比较：数过零点的速度
    const crossings = (samples: Float32Array): number => {
      let n = 0;
      for (let i = 1; i < samples.length; i++) if (((samples[i - 1] as number) < 0) !== ((samples[i] as number) < 0)) n++;
      return n / (samples.length / RATE);
    };
    expect(crossings(effect('cancel'))).toBeLessThan(crossings(effect('peakStart')));
    expect(crossings(effect('peakStart'))).toBeLessThan(crossings(effect('onTime')));
  });
});

describe.each([...AMBIENT_IDS])('环境声 %s', (id) => {
  const day = id === 'ambientDay';
  const samples = ambient(id);

  it('时长是十几秒到几十秒，采样数正好是时长乘采样率', () => {
    const seconds = day ? AMBIENT_SECONDS.day : AMBIENT_SECONDS.night;
    expect(seconds).toBeGreaterThanOrEqual(12);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(samples.length).toBe(Math.round(seconds * AMBIENT_RATE));
  });

  it('是确定性的，没有 NaN', () => {
    expect(sameBits(samples, renderAmbient(id))).toBe(true);
    expect(samples.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('电平很低：均方根等于目标值，峰值不超过上限，比任何音效的峰值都低', () => {
    expect(rmsOf(samples)).toBeCloseTo(day ? AMBIENT_RMS.day : AMBIENT_RMS.night, 4);
    expect(toDecibels(rmsOf(samples))).toBeLessThan(-30);
    expect(peakOf(samples)).toBeGreaterThan(0);
    expect(peakOf(samples)).toBeLessThanOrEqual(AMBIENT_PEAK_LIMIT);
    for (const sound of SOUND_IDS) expect(peakOf(samples)).toBeLessThan(peakOf(effect(sound)));
  });

  it('首尾能接上：第一个采样接在最后一个采样后面，和别处相邻采样的差一样小', () => {
    for (const [rate, seconds] of [
      [AMBIENT_RATE, undefined],
      [16000, 6],
      [24000, 8],
    ] as const) {
      const loop = ambient(id, rate, seconds);
      const seam = Math.abs((loop[0] as number) - (loop[loop.length - 1] as number));
      expect(seam).toBeLessThan(4 * stepRms(loop));
      expect(seam).toBeLessThanOrEqual(maxStep(loop));
    }
  });

  it('整段没有掉空：任何一秒的均方根都不低于整体的六成', () => {
    const window = AMBIENT_RATE;
    let lowest = Number.POSITIVE_INFINITY;
    for (let at = 0; at + window <= samples.length; at += window / 4) lowest = Math.min(lowest, rmsOf(samples, at, at + window));
    expect(lowest).toBeGreaterThan(0.6 * rmsOf(samples));
  });

  it('时长可以缩短，缩短之后仍然首尾相接', () => {
    const short = ambient(id, 16000, 6);
    expect(short.length).toBe(96000);
    expect(peakOf(short)).toBeLessThanOrEqual(AMBIENT_PEAK_LIMIT);
  });
});

describe('环境声：白天和夜间', () => {
  it('两条不一样，长度也不一样，交替时不会听出同步的重复', () => {
    expect(ambient('ambientDay').length).not.toBe(ambient('ambientNight').length);
    expect(AMBIENT_SECONDS.day).not.toBe(AMBIENT_SECONDS.night);
  });

  it('夜间比白天暗：高频成分的占比更小，也更轻', () => {
    const brightness = (samples: Float32Array): number => stepRms(samples) / rmsOf(samples);
    expect(brightness(ambient('ambientNight'))).toBeLessThan(brightness(ambient('ambientDay')));
    expect(AMBIENT_RMS.night).toBeLessThan(AMBIENT_RMS.day);
  });
});

describe('WAV 编码', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);
  const bytes = encodeWav(samples, 44100);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, n: number): string => String.fromCharCode(...bytes.slice(at, at + n));

  it('文件头：RIFF、WAVE、单声道、16 位、采样率和长度都对', () => {
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(text(36, 4)).toBe('data');
    expect(bytes.length).toBe(44 + samples.length * 2);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(88200);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('采样换成 16 位整数，超出 1 的部分截断', () => {
    const decoded = Array.from({ length: samples.length }, (_, i) => view.getInt16(44 + i * 2, true));
    expect(decoded).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
  });

  it('空的采样也能编码', () => {
    expect(encodeWav(new Float32Array(0), 8000).length).toBe(44);
  });
});

describe('合成用的小工具', () => {
  it('带种子的随机数：同一个种子同一串数，在 [0, 1) 里，不同的种子不同', () => {
    const a = makeRandom(7);
    const b = makeRandom(7);
    const c = makeRandom(8);
    const first = Array.from({ length: 1000 }, () => a());
    expect(first).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(first).not.toEqual(Array.from({ length: 1000 }, () => c()));
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(first.reduce((s, v) => s + v, 0) / 1000).toBeGreaterThan(0.45);
    expect(first.reduce((s, v) => s + v, 0) / 1000).toBeLessThan(0.55);
  });

  it('fillNoise 和 makeRandom 给出同一串数：同一个种子，填出来的是随机数乘 2 减 1', () => {
    const filled = new Float32Array(5000);
    fillNoise(filled, 12345);
    const random = makeRandom(12345);
    const expected = Float32Array.from({ length: 5000 }, () => random() * 2 - 1);
    expect(sameBits(filled, expected)).toBe(true);
    expect(filled.every((v) => v >= -1 && v < 1)).toBe(true);
    expect(rmsOf(filled)).toBeCloseTo(Math.sqrt(1 / 3), 1);
  });

  it('smoothstep：两端是 0 和 1，超出范围取端点', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
  });

  it('scaleToPeak 和 scaleToRms 把电平调到目标值，全是零时不动', () => {
    const x = Float32Array.from([0.1, -0.4, 0.2]);
    expect(peakOf(scaleToPeak(x, 0.8))).toBeCloseTo(0.8, 6);
    const y = Float32Array.from([0.1, -0.4, 0.2, 0.3]);
    expect(rmsOf(scaleToRms(y, 0.05))).toBeCloseTo(0.05, 6);
    expect(Array.from(scaleToPeak(new Float32Array(3), 0.5))).toEqual([0, 0, 0]);
    expect(Array.from(scaleToRms(new Float32Array(3), 0.5))).toEqual([0, 0, 0]);
  });

  it('fadeEdges 让首尾归零，中间不动', () => {
    const x = new Float32Array(1000).fill(1);
    fadeEdges(x, 1000, 0.1, 0.1);
    expect(x[0]).toBe(0);
    expect(x[999]).toBe(0);
    expect(x[500]).toBe(1);
    expect(x[50]).toBeCloseTo(0.5, 6);
    const untouched = new Float32Array(10).fill(1);
    fadeEdges(untouched, 1000, 0, 0);
    expect(untouched.every((v) => v === 1)).toBe(true);
  });

  it('状态变量滤波器：低通放过低频，压低高频，高通相反，带通的中心增益是 1', () => {
    const rate = 44100;
    const gainAt = (kind: 'lp' | 'bp' | 'hp', cutoff: number, freq: number): number => {
      const f = stateVariable(rate);
      f.set(cutoff, 0.7071);
      const out: number[] = [];
      for (let i = 0; i < rate; i++) {
        f.tick(Math.sin((2 * Math.PI * freq * i) / rate));
        out.push(f[kind]);
      }
      return rmsOf(out.slice(rate / 2)) / Math.SQRT1_2;
    };
    expect(gainAt('lp', 1000, 100)).toBeGreaterThan(0.95);
    expect(gainAt('lp', 1000, 8000)).toBeLessThan(0.05);
    expect(gainAt('hp', 1000, 8000)).toBeGreaterThan(0.95);
    expect(gainAt('hp', 1000, 100)).toBeLessThan(0.05);
    expect(gainAt('bp', 1000, 1000)).toBeGreaterThan(0.95);
    expect(gainAt('bp', 1000, 100)).toBeLessThan(0.3);
  });

  it('电平测量：空数组为 0，有声段的均方根只算响的那些块', () => {
    expect(rmsOf([])).toBe(0);
    expect(peakOf([])).toBe(0);
    expect(toDecibels(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(toDecibels(1)).toBe(0);
    expect(toDecibels(0.1)).toBeCloseTo(-20, 6);
    const rate = 1000;
    const x = new Float32Array(2000);
    x.fill(0.5, 0, 1000);
    // 后一半是静音：整段的均方根被拉低，有声段的均方根不受影响
    expect(rmsOf(x)).toBeCloseTo(0.5 / Math.SQRT2, 6);
    expect(activeRms(x, rate)).toBeCloseTo(0.5, 6);
    expect(activeRms(new Float32Array(100), rate)).toBe(0);
  });
});

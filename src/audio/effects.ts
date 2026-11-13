// 九个短音效的合成。每个函数是确定性的纯函数：给定采样率，返回一个单声道的 Float32Array，
// 随机的部分都用带种子的随机数，所以同样的采样率总是得到同样的采样。
// 所有音效都有包络，首尾的采样是 0，峰值固定在各自的目标值上。时长短，音量低，高频成分有限，听久了也不刺耳。
import { TWO_PI, expLerp, fadeEdges, makeRandom, pinkNoise, scaleToPeak, smoothstep, stateVariable } from './dsp.ts';

/** 各个音效的峰值（相对满刻度的线性幅度）。整体都在 -7 分贝以下，彼此的响度再按听感微调，低音为主的音效峰值高一些。 */
export const EFFECT_PEAKS = {
  takeoff: 0.232,
  onTime: 0.212,
  bigOrder: 0.214,
  cancel: 0.434,
  rule: 0.35,
  summary: 0.225,
  peakStart: 0.275,
  starUp: 0.24,
  noteRead: 0.256,
} as const;

/**
 * 噪声的幅度按采样率修正。白噪声的总功率摊在 0 到采样率一半的频带上，采样率高了，同一个频带里的噪声就少，
 * 乘上这个系数，同一个频带里的噪声量不随采样率变化，几层声音叠加时的比例在各种采样率下一致。
 */
function noiseScale(sampleRate: number): number {
  return Math.sqrt(sampleRate / 44100);
}

/** 单个采样的脉冲，采样率高了面积就小，要按比例放大，激起的共振才一样强。 */
function impulseScale(sampleRate: number): number {
  return sampleRate / 44100;
}

/** 铃音的一个分音：频率是基频的倍数，amp 是相对幅度，tau 是振幅衰减到 1/e 的秒数。 */
interface Overtone {
  readonly ratio: number;
  readonly amp: number;
  readonly tau: number;
}

/**
 * 在 out 里从 startSeconds 起叠加一个铃音：一组各自指数衰减的正弦，开头有一小段平滑的起音。
 * 超过奈奎斯特频率 0.45 倍的分音不加，所以低采样率下不会出现混叠的尖声。
 */
function addTone(out: Float32Array, sampleRate: number, startSeconds: number, freq: number, partials: readonly Overtone[], attackSeconds: number, gain: number): void {
  const start = Math.round(startSeconds * sampleRate);
  const slowest = partials.reduce((m, p) => Math.max(m, p.tau), 0);
  const length = Math.min(out.length - start, Math.round(slowest * 9 * sampleRate));
  const usable = partials.filter((p) => freq * p.ratio < sampleRate * 0.45);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (const p of usable) v += p.amp * Math.exp(-t / p.tau) * Math.sin(TWO_PI * freq * p.ratio * t);
    out[start + i] = (out[start + i] as number) + v * smoothstep(t / attackSeconds) * gain;
  }
}

/** 起飞：短促的气流声。粉红噪声经过中心频率向上扫的带通，开头缓缓起来，随后指数衰减。 */
export function renderTakeoff(sampleRate: number): Float32Array {
  const n = Math.round(0.5 * sampleRate);
  const out = new Float32Array(n);
  const noise = pinkNoise(makeRandom(0x7a4e01));
  const scale = noiseScale(sampleRate);
  const filter = stateVariable(sampleRate);
  const roof = stateVariable(sampleRate);
  roof.set(4500, 0.7071);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    filter.set(expLerp(420, 2600, smoothstep(t / 0.34)), 0.9);
    filter.tick(noise() * scale);
    roof.tick(filter.bp);
    const decay = t < 0.08 ? 1 : Math.exp(-(t - 0.08) / 0.12);
    out[i] = roof.lp * smoothstep(t / 0.08) * decay;
  }
  fadeEdges(out, sampleRate, 0, 0.05);
  return scaleToPeak(out, EFFECT_PEAKS.takeoff);
}

/** 准时送达：清脆的提示音。一个高音的铃音，两个更高的分音衰减得更快，像轻轻敲了一下小玻璃杯。 */
export function renderOnTime(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(0.5 * sampleRate));
  addTone(
    out,
    sampleRate,
    0,
    1318.5,
    [
      { ratio: 1, amp: 1, tau: 0.11 },
      { ratio: 2, amp: 0.36, tau: 0.08 },
      { ratio: 2.76, amp: 0.2, tau: 0.05 },
    ],
    0.003,
    1,
  );
  fadeEdges(out, sampleRate, 0, 0.06);
  return scaleToPeak(out, EFFECT_PEAKS.onTime);
}

/** 大单送达：一串硬币声。七下金属的轻响，间隔先密后疏，最后一下最亮，每一下是几个不成整数倍的分音加一点触碰的脆声。 */
export function renderBigOrder(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(0.9 * sampleRate));
  const random = makeRandom(0x636f69);
  const hits = [0, 0.075, 0.14, 0.2, 0.27, 0.35, 0.47];
  const levels = [0.7, 0.85, 0.72, 0.9, 0.78, 0.88, 1];
  const clink: Overtone[] = [
    { ratio: 1, amp: 1, tau: 0.05 },
    { ratio: 1.58, amp: 0.55, tau: 0.04 },
    { ratio: 2.31, amp: 0.3, tau: 0.03 },
    { ratio: 3.17, amp: 0.14, tau: 0.02 },
  ];
  const click = stateVariable(sampleRate);
  const scale = noiseScale(sampleRate);
  click.set(2800, 0.7);
  hits.forEach((at, k) => {
    const freq = 1750 + random() * 650;
    addTone(out, sampleRate, at, freq, clink, 0.0015, (levels[k] as number) * 0.55);
    // 触碰的一声脆响：1.5 毫秒的噪声，高通之后加在每一下的开头
    const start = Math.round(at * sampleRate);
    const length = Math.round(0.004 * sampleRate);
    for (let i = 0; i < length && start + i < out.length; i++) {
      const t = i / sampleRate;
      click.tick((random() * 2 - 1) * scale);
      out[start + i] = (out[start + i] as number) + click.hp * Math.exp(-t / 0.0012) * smoothstep(t / 0.0003) * (levels[k] as number) * 0.12;
    }
  });
  // 把最高的分音压一压，硬币声不刺耳
  const soften = stateVariable(sampleRate);
  soften.set(6500, 0.7071);
  for (let i = 0; i < out.length; i++) {
    soften.tick(out[i] as number);
    out[i] = soften.lp;
  }
  fadeEdges(out, sampleRate, 0, 0.12);
  return scaleToPeak(out, EFFECT_PEAKS.bigOrder);
}

/** 退单：低沉的提示音。两个下行的低音（四度，从 A3 到 E3），音色圆而闷，起音慢一点。 */
export function renderCancel(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(0.55 * sampleRate));
  const body: Overtone[] = [
    { ratio: 1, amp: 1, tau: 0.16 },
    { ratio: 2, amp: 0.4, tau: 0.09 },
    { ratio: 3, amp: 0.12, tau: 0.05 },
  ];
  addTone(out, sampleRate, 0, 220, body, 0.012, 1);
  addTone(out, sampleRate, 0.17, 164.8, body, 0.012, 0.85);
  fadeEdges(out, sampleRate, 0, 0.08);
  return scaleToPeak(out, EFFECT_PEAKS.cancel);
}

/**
 * 换策略卡：磁贴贴上白板。一次吸合是一声短促的「嗒」，由三部分叠成：
 * 触碰的脆响（高通噪声，1 毫秒多就衰减完），白板板面的共鸣（约 1 kHz 的阻尼正弦），
 * 低一点的闷响（音高从 320 Hz 很快降到 190 Hz）。磁铁弹一下再吸牢，所以 28 毫秒之后还有一声更轻的。
 */
export function renderRule(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(0.2 * sampleRate));
  const random = makeRandom(0x6d6167);
  const click = stateVariable(sampleRate);
  const scale = noiseScale(sampleRate);
  click.set(2500, 0.7);
  for (const [at, gain] of [
    [0, 1],
    [0.028, 0.42],
  ] as const) {
    const start = Math.round(at * sampleRate);
    let phase = 0;
    for (let i = 0; start + i < out.length; i++) {
      const t = i / sampleRate;
      if (t > 0.12) break;
      click.tick((random() * 2 - 1) * scale);
      const tap = click.hp * Math.exp(-t / 0.0012) * smoothstep(t / 0.0003) * 0.9;
      const board = Math.sin(TWO_PI * 1050 * t) * Math.exp(-t / 0.009) * 0.6;
      phase += (TWO_PI * (190 + 130 * Math.exp(-t / 0.012))) / sampleRate;
      const thump = Math.sin(phase) * Math.exp(-t / 0.016) * smoothstep(t / 0.0015);
      out[start + i] = (out[start + i] as number) + (tap + board + thump) * gain;
    }
  }
  fadeEdges(out, sampleRate, 0, 0.05);
  return scaleToPeak(out, EFFECT_PEAKS.rule);
}

/**
 * 高峰小结：热敏打印机出纸。步进电机每走一步是一个小脉冲，速度先升到每秒 170 步，稳一会儿再降，
 * 脉冲连成一阵嗡嗡的响。每个脉冲激起两个很快衰减的共振（机壳和打印头），再垫一层纸张滑过的沙沙声。
 */
export function renderSummary(sampleRate: number): Float32Array {
  const n = Math.round(0.8 * sampleRate);
  const out = new Float32Array(n);
  const random = makeRandom(0x707269);
  const body = stateVariable(sampleRate);
  const head = stateVariable(sampleRate);
  const housing = stateVariable(sampleRate);
  const paper = stateVariable(sampleRate);
  body.set(1500, 4);
  head.set(3300, 6);
  housing.set(650, 8);
  paper.set(2200, 0.8);
  const noise = pinkNoise(random);
  const scale = noiseScale(sampleRate);
  const kick = 40 * impulseScale(sampleRate);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const rate = t < 0.12 ? 60 + 110 * smoothstep(t / 0.12) : t < 0.66 ? 170 : 170 - 80 * smoothstep((t - 0.66) / 0.12);
    // 步进的间隔有一点不均匀，听起来是机械，不是电子的蜂鸣
    phase += (rate * (1 + 0.08 * (random() - 0.5))) / sampleRate;
    let impulse = 0;
    if (phase >= 1) {
      phase -= 1;
      impulse = 0.8 + 0.2 * random();
    }
    body.tick(impulse * kick);
    head.tick(impulse * kick);
    housing.tick(impulse * kick * 0.75);
    paper.tick(noise() * scale);
    const sound = body.bp * 0.5 + head.bp * 0.3 + housing.bp * 0.8 + paper.bp * 0.1;
    out[i] = sound * smoothstep(t / 0.012);
  }
  // 两级低通，把 4.5 kHz 以上的尖锐成分压下去
  const soften = [stateVariable(sampleRate), stateVariable(sampleRate)];
  for (const filter of soften) filter.set(4500, 0.7071);
  for (let i = 0; i < n; i++) {
    let v = out[i] as number;
    for (const filter of soften) {
      filter.tick(v);
      v = filter.lp;
    }
    out[i] = v;
  }
  fadeEdges(out, sampleRate, 0, 0.07);
  return scaleToPeak(out, EFFECT_PEAKS.summary);
}

/**
 * 高峰开始：远处的铃声。钟的分音（含一个偏亮的三度）各自缓慢衰减，敲两下，第二下轻一些。
 * 整体过低通并垫一层稀疏的混响尾巴，听起来像从街对面传来的。
 */
export function renderPeakStart(sampleRate: number): Float32Array {
  const length = Math.round(1.9 * sampleRate);
  const dry = new Float32Array(length);
  const bell: Overtone[] = [
    { ratio: 0.5, amp: 0.3, tau: 0.9 },
    { ratio: 1, amp: 1, tau: 0.7 },
    { ratio: 1.25, amp: 0.45, tau: 0.5 },
    { ratio: 1.5, amp: 0.28, tau: 0.42 },
    { ratio: 2, amp: 0.5, tau: 0.34 },
    { ratio: 2.5, amp: 0.2, tau: 0.24 },
    { ratio: 3, amp: 0.14, tau: 0.17 },
  ];
  addTone(dry, sampleRate, 0, 587.3, bell, 0.006, 1);
  addTone(dry, sampleRate, 0.55, 587.3, bell, 0.006, 0.62);
  // 远处的声音高频衰减得多
  const far = stateVariable(sampleRate);
  far.set(2600, 0.7071);
  for (let i = 0; i < length; i++) {
    far.tick(dry[i] as number);
    dry[i] = far.lp;
  }
  const out = withDiffuseTail(dry, sampleRate, 0.22);
  fadeEdges(out, sampleRate, 0, 0.3);
  return scaleToPeak(out, EFFECT_PEAKS.peakStart);
}

/** 四条带阻尼的梳状滤波器并联，给声音加一层稀疏的混响尾巴。wet 是混响的比例。 */
function withDiffuseTail(dry: Float32Array, sampleRate: number, wet: number): Float32Array {
  const out = new Float32Array(dry.length);
  const delays = [0.0311, 0.0377, 0.0433, 0.0479].map((s) => Math.round(s * sampleRate));
  const lines = delays.map((d) => new Float32Array(d));
  const damp = [0, 0, 0, 0];
  for (let i = 0; i < dry.length; i++) {
    let tail = 0;
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k] as Float32Array;
      const at = i % line.length;
      const echoed = line[at] as number;
      damp[k] = (damp[k] as number) + 0.45 * (echoed - (damp[k] as number));
      line[at] = (dry[i] as number) + 0.72 * (damp[k] as number);
      tail += echoed;
    }
    out[i] = (dry[i] as number) + (wet * tail) / lines.length;
  }
  return out;
}

/** 升星：上行的短音。G 大调的四个音（G5、B5、D6、G6）依次响起，音色像木琴，最后一个音拖得长一些。 */
export function renderStarUp(sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(1 * sampleRate));
  const notes = [
    { at: 0, freq: 784, tau: 0.16 },
    { at: 0.085, freq: 987.8, tau: 0.16 },
    { at: 0.17, freq: 1174.7, tau: 0.17 },
    { at: 0.26, freq: 1568, tau: 0.3 },
  ];
  for (const note of notes) {
    addTone(
      out,
      sampleRate,
      note.at,
      note.freq,
      [
        { ratio: 1, amp: 1, tau: note.tau },
        { ratio: 2, amp: 0.22, tau: note.tau * 0.55 },
        { ratio: 4, amp: 0.06, tau: note.tau * 0.25 },
      ],
      0.004,
      1,
    );
  }
  fadeEdges(out, sampleRate, 0, 0.12);
  return scaleToPeak(out, EFFECT_PEAKS.starUp);
}

/**
 * 便签读过收起：便签从本子上撕下来。撕纸的声音是一阵越来越密的细小噼啪声，
 * 脉冲的密度从每秒 500 个升到 1600 个，经带通拉出短促的「啪」，连成一阵沙哑的撕裂声，再垫一层很轻的纸张沙沙声。
 */
export function renderNoteRead(sampleRate: number): Float32Array {
  const n = Math.round(0.3 * sampleRate);
  const out = new Float32Array(n);
  const random = makeRandom(0x746561);
  const crackle = stateVariable(sampleRate);
  const rustle = stateVariable(sampleRate);
  const roof = stateVariable(sampleRate);
  const scale = noiseScale(sampleRate);
  const kick = 30 * impulseScale(sampleRate);
  rustle.set(1800, 0.7071);
  roof.set(7000, 0.7071);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const rate = 500 + 1100 * smoothstep(t / 0.2);
    const pulse = random() < rate / sampleRate ? (random() * 2 - 1) * (0.5 + 0.5 * random()) : 0;
    crackle.set(2800 + 1200 * smoothstep(t / 0.25), 1.4);
    crackle.tick(pulse * kick);
    rustle.tick((random() * 2 - 1) * scale);
    const envelope = smoothstep(t / 0.004) * (0.6 + 0.4 * smoothstep(t / 0.15)) * (1 - smoothstep((t - 0.2) / 0.1));
    roof.tick(crackle.bp + rustle.hp * 0.07);
    out[i] = roof.lp * envelope;
  }
  fadeEdges(out, sampleRate, 0, 0.04);
  return scaleToPeak(out, EFFECT_PEAKS.noteRead);
}

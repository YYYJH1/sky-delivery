// 播放器：用假的 AudioContext 和假的浏览器环境，检查解锁、出声、限频、环境声的交替、音量、焦点和可见性、设置的存取、释放。
import { describe, expect, it } from 'vitest';
import { AMBIENT_RATE, AMBIENT_SECONDS } from '../src/audio/ambient.ts';
import { SOUND_IDS, SOUND_INFO, renderSound } from '../src/audio/catalog.ts';
import type { SoundId } from '../src/audio/catalog.ts';
import { AMBIENT_FADE_SECONDS, createAudioPlayer } from '../src/audio/player.ts';
import type { AudioBufferLike, AudioContextLike, AudioNodeLike, AudioParamLike, BufferSourceLike, GainNodeLike, PlayerEnv } from '../src/audio/player.ts';
import { BLUR_GAIN, DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/audio/settings.ts';
import type { StorageLike } from '../src/audio/settings.ts';
import { DAY_STEPS } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { outcomeOrder, quietState } from './campaign-helpers.ts';

// ---- 假的 Web Audio ----
class FakeParam implements AudioParamLike {
  value: number;
  readonly calls: { kind: string; args: number[] }[] = [];
  constructor(value: number) {
    this.value = value;
  }
  setValueAtTime(value: number, startTime: number): void {
    this.calls.push({ kind: 'set', args: [value, startTime] });
    this.value = value;
  }
  linearRampToValueAtTime(value: number, endTime: number): void {
    this.calls.push({ kind: 'ramp', args: [value, endTime] });
  }
  setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
    this.calls.push({ kind: 'target', args: [target, startTime, timeConstant] });
  }
  cancelScheduledValues(cancelTime: number): void {
    this.calls.push({ kind: 'cancel', args: [cancelTime] });
  }
  /** 最近一次要去的目标值：线性渐变的终点或指数趋近的目标。 */
  goal(): number | undefined {
    const last = [...this.calls].reverse().find((c) => c.kind === 'ramp' || c.kind === 'target');
    return last?.args[0];
  }
}

class FakeNode implements AudioNodeLike {
  readonly connectedTo: AudioNodeLike[] = [];
  disconnected = false;
  connect(destination: AudioNodeLike): AudioNodeLike {
    this.connectedTo.push(destination);
    return destination;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam(1);
}

class FakeBuffer implements AudioBufferLike {
  readonly data: Float32Array;
  readonly sampleRate: number;
  constructor(length: number, sampleRate: number) {
    this.data = new Float32Array(length);
    this.sampleRate = sampleRate;
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeSource extends FakeNode implements BufferSourceLike {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeContext implements AudioContextLike {
  state = 'suspended';
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly sources: FakeSource[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  /** 为真时 resume 一直不落地（浏览器还没收到用户操作）。 */
  blocked = false;
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    const buffer = new FakeBuffer(length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    // 浏览器还没收到用户操作时，resume 的 Promise 一直不落地
    if (this.blocked) return new Promise<void>(() => undefined);
    await Promise.resolve();
    if (this.state !== 'closed') this.state = 'running';
  }
  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    await Promise.resolve();
    if (this.state !== 'closed') this.state = 'suspended';
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
  /** 循环播放的环境声，按创建的先后。 */
  layers(): FakeSource[] {
    return this.sources.filter((s) => s.loop);
  }
  /** 播过的音效，按先后。 */
  shots(): FakeSource[] {
    return this.sources.filter((s) => !s.loop && s.started);
  }
}

// ---- 假的浏览器环境 ----
type Listener = () => void;
interface Registered {
  readonly type: string;
  readonly listener: Listener;
  readonly capture: boolean;
}

function fakeEnv(options: { storage?: StorageLike | null; webAudio?: boolean } = {}) {
  const contexts: FakeContext[] = [];
  const windowListeners: Registered[] = [];
  const documentListeners: Registered[] = [];
  const timers = new Map<number, { callback: () => void; due: number }>();
  let nextTimer = 1;
  let clock = 1_000_000;
  const page = { visibilityState: 'visible', focused: true };
  const storage = options.storage === undefined ? null : options.storage;
  const env: PlayerEnv = {
    createContext: () => {
      if (options.webAudio === false) return null;
      const context = new FakeContext();
      contexts.push(context);
      return context;
    },
    storage,
    now: () => clock,
    document: {
      get visibilityState() {
        return page.visibilityState;
      },
      hasFocus: () => page.focused,
      addEventListener: (type, listener) => void documentListeners.push({ type, listener, capture: false }),
      removeEventListener: (type, listener) => {
        const at = documentListeners.findIndex((r) => r.type === type && r.listener === listener);
        if (at >= 0) documentListeners.splice(at, 1);
      },
    },
    window: {
      addEventListener: (type, listener, capture = false) => void windowListeners.push({ type, listener, capture }),
      removeEventListener: (type, listener, capture = false) => {
        const at = windowListeners.findIndex((r) => r.type === type && r.listener === listener && r.capture === capture);
        if (at >= 0) windowListeners.splice(at, 1);
      },
    },
    setTimeout: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { callback, due: clock + ms });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
  };
  return {
    env,
    contexts,
    context: (): FakeContext => contexts[contexts.length - 1] as FakeContext,
    page,
    fireWindow(type: string): void {
      for (const r of [...windowListeners]) if (r.type === type) r.listener();
    },
    fireDocument(type: string): void {
      for (const r of [...documentListeners]) if (r.type === type) r.listener();
    },
    listeners: () => [...windowListeners, ...documentListeners].map((r) => r.type).sort(),
    /** 真实时间过了 ms 毫秒：到点的定时器按先后执行。 */
    advance(ms: number): void {
      clock += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (timer.due <= clock && timers.delete(id)) timer.callback();
      }
    },
    pendingTimers: () => timers.size,
  };
}

/** 让已经发出的 Promise 都落地。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ---- 假的游戏状态 ----
/** 经营模式的安静状态，放在一天里的 tick 步。 */
function stateAt(tick: number, day = 0): SimState {
  const state = quietState();
  state.step = day * DAY_STEPS + tick;
  return state;
}

/** 按 id 找出一个 AudioBuffer 里放的是哪个音效，找不到返回 null。 */
const rendered = new Map<SoundId, Float32Array>();
function soundIn(buffer: FakeBuffer | null, sampleRate = 48000): SoundId | null {
  if (buffer === null) return null;
  for (const id of SOUND_IDS) {
    let samples = rendered.get(id);
    if (samples === undefined) {
      samples = renderSound(id, sampleRate);
      rendered.set(id, samples);
    }
    if (samples.length === buffer.data.length && Buffer.compare(Buffer.from(samples.buffer), Buffer.from(buffer.data.buffer)) === 0) return id;
  }
  return null;
}

/** 创建播放器并完成解锁，返回播放器和假环境。 */
async function started(options: { storage?: StorageLike | null } = {}) {
  const fake = fakeEnv(options);
  const player = createAudioPlayer(fake.env);
  player.attach();
  fake.fireWindow('pointerdown');
  await settle();
  return { fake, player, ctx: fake.context() };
}

/** 一张在 at 步送达的订单，放进状态。 */
function delivered(state: SimState, at: number, big = false): void {
  const order = outcomeOrder(state, { district: 0, tOrder: at - 100, delivered: at });
  if (big) order.portion = 2;
}

describe('解锁：第一次点击或按键才创建 AudioContext', () => {
  it('创建之前：状态是 locked，观察状态不创建 AudioContext，也不出声', () => {
    const fake = fakeEnv();
    const player = createAudioPlayer(fake.env);
    expect(player.status()).toBe('locked');
    player.attach();
    player.observe(stateAt(100));
    expect(fake.contexts).toHaveLength(0);
    expect(player.status()).toBe('locked');
  });

  it('第一次点击、按键（任何一种用户操作）创建并启动，之后不再监听这些事件', async () => {
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'touchend']) {
      const fake = fakeEnv();
      const player = createAudioPlayer(fake.env);
      player.attach();
      expect(fake.listeners()).toContain(type);
      fake.fireWindow(type);
      expect(fake.contexts).toHaveLength(1);
      expect(fake.context().resumeCalls).toBe(1);
      await settle();
      expect(player.status()).toBe('running');
      for (const gesture of ['pointerdown', 'pointerup', 'keydown', 'touchend']) expect(fake.listeners(), `${type} 之后 ${gesture}`).not.toContain(gesture);
      // 焦点和可见性的监听还在
      expect(fake.listeners()).toEqual(['blur', 'focus', 'visibilitychange']);
    }
  });

  it('只创建一个 AudioContext：再来多少次点击也不重复创建', async () => {
    const fake = fakeEnv();
    const player = createAudioPlayer(fake.env);
    player.attach();
    fake.fireWindow('keydown');
    fake.fireWindow('pointerdown');
    player.unlock();
    await settle();
    expect(fake.contexts).toHaveLength(1);
  });

  it('浏览器还不让出声（resume 没有成功）时继续监听，下一次点击再试', async () => {
    const fake = fakeEnv();
    const player = createAudioPlayer(fake.env);
    player.attach();
    const ctx = (() => {
      // 上下文在第一次点击时创建，这时浏览器还不让出声
      const original = fake.env.createContext;
      fake.env.createContext = () => {
        const created = original() as FakeContext;
        created.blocked = true;
        return created;
      };
      fake.fireWindow('pointerdown');
      return fake.context();
    })();
    await settle();
    expect(player.status()).toBe('suspended');
    expect(fake.listeners()).toContain('pointerdown');
    ctx.blocked = false;
    fake.fireWindow('keydown');
    expect(ctx.resumeCalls).toBe(2);
    await settle();
    expect(player.status()).toBe('running');
    expect(fake.contexts).toHaveLength(1);
    expect(fake.listeners()).not.toContain('pointerdown');
  });

  it('浏览器没有 Web Audio：状态是 unavailable，不再监听点击，观察状态也不出错', () => {
    const fake = fakeEnv({ webAudio: false });
    const player = createAudioPlayer(fake.env);
    player.attach();
    fake.fireWindow('pointerdown');
    expect(player.status()).toBe('unavailable');
    expect(fake.listeners()).not.toContain('pointerdown');
    expect(() => player.observe(stateAt(100))).not.toThrow();
  });

  it('attach 返回摘掉全部监听的函数，重复 attach 不重复登记', async () => {
    const fake = fakeEnv();
    const player = createAudioPlayer(fake.env);
    const detach = player.attach();
    expect(player.attach()).toBe(detach);
    expect(fake.listeners().filter((t) => t === 'blur')).toHaveLength(1);
    detach();
    expect(fake.listeners()).toEqual([]);
  });
});

describe('出声：读状态，限频，播音效', () => {
  it('第一次观察只记基线，不出声。之后发生了什么，下一次观察才出声', async () => {
    const { player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    expect(ctx.shots()).toHaveLength(0);
    delivered(state, 1002);
    state.step = 1005;
    player.observe(state);
    expect(ctx.shots().map((s) => soundIn(s.buffer))).toEqual(['onTime']);
    const [shot] = ctx.shots();
    expect(shot?.connectedTo).toHaveLength(1);
    expect(shot?.loop).toBe(false);
  });

  it('各种事件放各自的声音：大单、退单、高峰开始、换策略卡', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(590);
    player.observe(state);
    delivered(state, 592, true);
    state.step = 600; // 午高峰开始
    player.observe(state);
    expect(ctx.shots().map((s) => soundIn(s.buffer))).toEqual(['peakStart', 'bigOrder']);
    fake.advance(10_000);
    outcomeOrder(state, { district: 0, tOrder: 520, cancelled: 603 });
    state.step = 605;
    player.observe(state);
    expect(ctx.shots().map((s) => soundIn(s.buffer)).at(-1)).toBe('cancel');
    fake.advance(10_000);
    state.stats.ruleChanges.push({ step: 606, column: 'select', from: 'a', to: 'b' });
    player.observe(state);
    expect(ctx.shots().map((s) => soundIn(s.buffer)).at(-1)).toBe('rule');
  });

  it('限频：间隔之内同一个声音只放一次，间隔过了再放；真实时间由环境的时钟给出', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    delivered(state, 1002);
    state.step = 1005;
    player.observe(state);
    fake.advance(1000);
    delivered(state, 1007);
    state.step = 1010;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(1);
    fake.advance(SOUND_INFO.onTime.gapMs);
    delivered(state, 1012);
    state.step = 1015;
    player.observe(state);
    expect(ctx.shots().map((s) => soundIn(s.buffer))).toEqual(['onTime', 'onTime']);
  });

  it('游戏暂停（状态不变）时不出新的世界声音', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    delivered(state, 995); // 暂停之前的事，基线里已经有
    for (let i = 0; i < 20; i++) {
      fake.advance(5000);
      player.observe(state);
    }
    expect(ctx.shots()).toHaveLength(0);
  });

  it('同一个声音的缓冲只合成一次，每次播放新建一个 source，播完摘掉', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    for (let k = 0; k < 3; k++) {
      fake.advance(SOUND_INFO.onTime.gapMs);
      delivered(state, state.step + 2);
      state.step += 5;
      player.observe(state);
    }
    const shots = ctx.shots();
    expect(shots).toHaveLength(3);
    expect(new Set(shots.map((s) => s.buffer)).size).toBe(1);
    shots[0]?.onended?.();
    expect(shots[0]?.disconnected).toBe(true);
  });

  it('常有的声音音高有 2% 以内的小变化，别的不变', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    for (let k = 0; k < 6; k++) {
      fake.advance(SOUND_INFO.onTime.gapMs);
      delivered(state, state.step + 2);
      state.step += 5;
      player.observe(state);
    }
    const rates = ctx.shots().map((s) => s.playbackRate.value);
    for (const rate of rates) expect(Math.abs(rate - 1)).toBeLessThanOrEqual(0.02);
    expect(new Set(rates).size).toBeGreaterThan(1);
    // 玩家操作的声音不变调
    fake.advance(1000);
    state.stats.ruleChanges.push({ step: state.step, column: 'zone', from: 'a', to: 'b' });
    player.observe(state);
    expect(ctx.shots().at(-1)?.playbackRate.value).toBe(1);
  });

  it('AudioContext 没有在运行时不播音效，也不攒着，恢复运行后从新的基线开始', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    ctx.state = 'suspended';
    delivered(state, 1002);
    state.step = 1005;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(0);
    ctx.state = 'running';
    fake.advance(10_000);
    state.step = 1010;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(0);
  });

  it('reset：换了一份状态之后，下一次观察只记基线', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    delivered(state, 1002);
    state.step = 1005;
    player.reset();
    player.observe(state);
    expect(ctx.shots()).toHaveLength(0);
    fake.advance(10_000);
    delivered(state, 1007);
    state.step = 1010;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(1);
  });

  it('步退回去（读了存档）时什么也不出', async () => {
    const { player, ctx } = await started();
    player.observe(stateAt(2000));
    const loaded = stateAt(100);
    loaded.stats.ruleChanges.push({ step: 50, column: 'select', from: 'a', to: 'b' });
    player.observe(loaded);
    expect(ctx.shots()).toHaveLength(0);
  });
});

describe('环境声：白天夜间交替', () => {
  it('启动时按游戏内的时刻放一条，循环，淡入', async () => {
    const { player, ctx } = await started();
    player.observe(stateAt(500));
    const layers = ctx.layers();
    expect(layers).toHaveLength(1);
    expect(layers[0]?.buffer?.data.length).toBe(AMBIENT_SECONDS.day * AMBIENT_RATE);
    expect(layers[0]?.buffer?.sampleRate).toBe(AMBIENT_RATE);
    expect(layers[0]?.started).toBe(true);
    const gain = layers[0]?.connectedTo[0] as FakeGain;
    expect(gain.gain.value).toBe(0);
    expect(gain.gain.goal()).toBe(1);
    expect(gain.gain.calls.find((c) => c.kind === 'ramp')?.args[1]).toBeCloseTo(ctx.currentTime + AMBIENT_FADE_SECONDS, 6);
  });

  it('游戏内到了晚上：夜间的一条淡入，白天的一条淡出，淡出完了停掉', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(2700);
    player.observe(state);
    state.step = 2851;
    player.observe(state);
    const [day, night] = ctx.layers();
    expect(day?.buffer?.data.length).toBe(AMBIENT_SECONDS.day * AMBIENT_RATE);
    expect(night?.buffer?.data.length).toBe(AMBIENT_SECONDS.night * AMBIENT_RATE);
    expect((day?.connectedTo[0] as FakeGain).gain.goal()).toBe(0);
    expect((night?.connectedTo[0] as FakeGain).gain.goal()).toBe(1);
    expect(day?.stopped).toBe(false);
    fake.advance((AMBIENT_FADE_SECONDS + 0.5) * 1000);
    expect(day?.stopped).toBe(true);
    expect(night?.stopped).toBe(false);
  });

  it('第二天早晨换回白天，两条的缓冲都只合成一次', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(3000);
    player.observe(state);
    expect(ctx.layers()).toHaveLength(1);
    expect(ctx.layers()[0]?.buffer?.data.length).toBe(AMBIENT_SECONDS.night * AMBIENT_RATE);
    state.step = DAY_STEPS + 1;
    player.observe(state);
    fake.advance(6000);
    expect(ctx.layers()).toHaveLength(2);
    expect(ctx.layers()[1]?.buffer?.data.length).toBe(AMBIENT_SECONDS.day * AMBIENT_RATE);
    // 又到晚上：夜间的缓冲是同一个
    state.step = DAY_STEPS + 2900;
    player.observe(state);
    const nights = ctx.layers().filter((s) => s.buffer?.data.length === AMBIENT_SECONDS.night * AMBIENT_RATE);
    expect(nights).toHaveLength(2);
    expect(nights[0]?.buffer).toBe(nights[1]?.buffer);
  });

  it('时刻没有变，环境声不重复调度', async () => {
    const { player, ctx } = await started();
    const state = stateAt(500);
    player.observe(state);
    const gain = ctx.layers()[0]?.connectedTo[0] as FakeGain;
    const calls = gain.gain.calls.length;
    for (let i = 0; i < 50; i++) {
      state.step += 1;
      player.observe(state);
    }
    expect(ctx.layers()).toHaveLength(1);
    expect(gain.gain.calls.length).toBe(calls);
  });

  it('第一条放起来之后，别的声音一个一个合成好，用到的时候不再合成，合成完了不再留定时器', async () => {
    const { fake, player, ctx } = await started();
    player.observe(stateAt(500));
    expect(ctx.buffers).toHaveLength(1);
    for (let i = 0; i < 30; i++) fake.advance(400);
    expect(ctx.buffers).toHaveLength(2 + SOUND_IDS.length);
    expect(fake.pendingTimers()).toBe(0);
    const count = ctx.buffers.length;
    for (const id of SOUND_IDS) player.preview(id);
    expect(ctx.buffers).toHaveLength(count);
    expect(ctx.shots().map((s) => soundIn(s.buffer))).toEqual([...SOUND_IDS]);
  });

  it('另一条延后合成，不挡第一次出声', async () => {
    const { fake, player, ctx } = await started();
    player.observe(stateAt(500));
    const before = ctx.buffers.length;
    fake.advance(5000);
    expect(ctx.buffers.length).toBe(before + 1);
    expect(ctx.buffers.some((b) => b.data.length === AMBIENT_SECONDS.night * AMBIENT_RATE)).toBe(true);
  });
});

describe('音量、开关和设置', () => {
  it('启动时读本地存储里的设置，读不到或读到坏数据用默认值', () => {
    const stored = { getItem: () => '{"enabled":true,"volume":0.25,"muteOnBlur":true}', setItem: () => undefined };
    expect(createAudioPlayer(fakeEnv({ storage: stored }).env).settings()).toEqual({ enabled: true, volume: 0.25, muteOnBlur: true });
    expect(createAudioPlayer(fakeEnv({ storage: { getItem: () => '坏的', setItem: () => undefined } }).env).settings()).toEqual(DEFAULT_SETTINGS);
    expect(createAudioPlayer(fakeEnv({ storage: null }).env).settings()).toEqual(DEFAULT_SETTINGS);
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const player = createAudioPlayer(fakeEnv({ storage: throwing }).env);
    expect(player.settings()).toEqual(DEFAULT_SETTINGS);
    expect(() => player.setSettings({ volume: 0.1 })).not.toThrow();
    expect(player.settings().volume).toBe(0.1);
  });

  it('总音量：增益是音量的平方，过渡平滑，设置存进本地存储', async () => {
    const data = new Map<string, string>();
    const storage: StorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    const { player, ctx } = await started({ storage });
    const master = ctx.gains[0] as FakeGain;
    expect(master.gain.goal()).toBeCloseTo(DEFAULT_SETTINGS.volume ** 2, 10);
    expect(player.setSettings({ volume: 0.5 })).toEqual({ enabled: true, volume: 0.5, muteOnBlur: false });
    expect(master.gain.goal()).toBeCloseTo(0.25, 10);
    expect(master.gain.calls.at(-1)?.kind).toBe('target');
    expect(JSON.parse(data.get(SETTINGS_KEY) as string)).toMatchObject({ enabled: true, volume: 0.5, muteOnBlur: false });
    // 不合格的值被拒绝
    expect(player.setSettings({ volume: 9 }).volume).toBe(1);
    expect(player.setSettings({ volume: Number.NaN }).volume).toBe(1);
  });

  it('关掉声音：增益降到 0，稍后挂起 AudioContext，不再出声；打开之后恢复', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    player.setSettings({ enabled: false });
    expect((ctx.gains[0] as FakeGain).gain.goal()).toBe(0);
    fake.advance(500);
    await settle();
    expect(ctx.suspendCalls).toBe(1);
    expect(ctx.state).toBe('suspended');
    delivered(state, 1002);
    state.step = 1005;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(0);
    player.setSettings({ enabled: true });
    await settle();
    expect(ctx.state).toBe('running');
    expect((ctx.gains[0] as FakeGain).gain.goal()).toBeCloseTo(0.49, 10);
  });

  it('声音一直是关的：点击不创建 AudioContext，打开时才创建', async () => {
    const storage: StorageLike = { getItem: () => '{"enabled":false}', setItem: () => undefined };
    const fake = fakeEnv({ storage });
    const player = createAudioPlayer(fake.env);
    player.attach();
    fake.fireWindow('pointerdown');
    expect(fake.contexts).toHaveLength(0);
    player.setSettings({ enabled: true });
    await settle();
    expect(fake.contexts).toHaveLength(1);
    expect(player.status()).toBe('running');
  });
});

describe('焦点和可见性', () => {
  it('窗口失去焦点：音量降低，重新得到焦点：恢复', async () => {
    const { fake, player, ctx } = await started();
    const master = ctx.gains[0] as FakeGain;
    const full = DEFAULT_SETTINGS.volume ** 2;
    fake.fireWindow('blur');
    expect(master.gain.goal()).toBeCloseTo(full * BLUR_GAIN, 10);
    expect(player.status()).toBe('running');
    fake.fireWindow('focus');
    expect(master.gain.goal()).toBeCloseTo(full, 10);
    expect(ctx.suspendCalls).toBe(0);
  });

  it('失去焦点时仍然出声（只是轻一些）', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    fake.fireWindow('blur');
    delivered(state, 1002);
    state.step = 1005;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(1);
  });

  it('设置了失去焦点时静音：增益 0，挂起，不出声；回到窗口恢复，不补放错过的声音', async () => {
    const { fake, player, ctx } = await started();
    player.setSettings({ muteOnBlur: true });
    const state = stateAt(1000);
    player.observe(state);
    fake.fireWindow('blur');
    expect((ctx.gains[0] as FakeGain).gain.goal()).toBe(0);
    fake.advance(500);
    await settle();
    expect(ctx.state).toBe('suspended');
    delivered(state, 1002);
    state.step = 1005;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(0);
    fake.fireWindow('focus');
    await settle();
    expect(ctx.state).toBe('running');
    expect((ctx.gains[0] as FakeGain).gain.goal()).toBeCloseTo(0.49, 10);
    fake.advance(10_000);
    state.step = 1010;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(0);
  });

  it('页面不可见：增益 0，挂起，不播任何声音，包括音效和环境声；可见之后恢复', async () => {
    const { fake, player, ctx } = await started();
    const state = stateAt(1000);
    player.observe(state);
    fake.page.visibilityState = 'hidden';
    fake.fireDocument('visibilitychange');
    expect((ctx.gains[0] as FakeGain).gain.goal()).toBe(0);
    fake.advance(500);
    await settle();
    expect(ctx.suspendCalls).toBe(1);
    const sources = ctx.sources.length;
    delivered(state, 1002);
    state.step = 1005;
    player.observe(state);
    expect(ctx.sources.length).toBe(sources);
    fake.page.visibilityState = 'visible';
    fake.fireDocument('visibilitychange');
    await settle();
    expect(ctx.state).toBe('running');
    // 不可见期间错过的事不补放
    fake.advance(10_000);
    state.step = 1010;
    player.observe(state);
    expect(ctx.shots()).toHaveLength(0);
  });

  it('不可见之后很快又可见：已经排好的挂起取消，不会把刚恢复的声音挂起', async () => {
    const { fake, ctx } = await started();
    fake.page.visibilityState = 'hidden';
    fake.fireDocument('visibilitychange');
    fake.page.visibilityState = 'visible';
    fake.fireDocument('visibilitychange');
    fake.advance(1000);
    await settle();
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.state).toBe('running');
  });

  it('attach 时按页面当下的焦点和可见性起步', async () => {
    const fake = fakeEnv();
    fake.page.focused = false;
    const player = createAudioPlayer(fake.env);
    player.attach();
    fake.fireWindow('pointerdown');
    await settle();
    expect((fake.context().gains[0] as FakeGain).gain.goal()).toBeCloseTo(DEFAULT_SETTINGS.volume ** 2 * BLUR_GAIN, 10);
  });

  it('setFocused 和 setVisible 可以由页面自己调用，重复调用同一个值没有副作用', async () => {
    const { player, ctx } = await started();
    const master = ctx.gains[0] as FakeGain;
    player.setFocused(false);
    const calls = master.gain.calls.length;
    player.setFocused(false);
    player.setVisible(true);
    expect(master.gain.calls.length).toBe(calls);
  });
});

describe('释放', () => {
  it('dispose：停掉环境声，关闭 AudioContext，摘掉全部事件，之后不再出声', async () => {
    const { fake, player, ctx } = await started();
    player.observe(stateAt(500));
    const layers = ctx.layers();
    player.dispose();
    expect(player.status()).toBe('disposed');
    expect(layers.every((l) => l.stopped)).toBe(true);
    expect(ctx.closeCalls).toBe(1);
    expect(fake.listeners()).toEqual([]);
    expect(() => player.observe(stateAt(600))).not.toThrow();
    expect(() => player.setSettings({ volume: 0.2 })).not.toThrow();
    player.unlock();
    expect(fake.contexts).toHaveLength(1);
    player.dispose();
    expect(ctx.closeCalls).toBe(1);
  });

  it('释放之后已经排好的定时器不再动任何东西', async () => {
    const { fake, player, ctx } = await started();
    player.observe(stateAt(2700));
    player.observe(stateAt(2900));
    player.dispose();
    expect(() => fake.advance(20_000)).not.toThrow();
    expect(ctx.closeCalls).toBe(1);
  });
});

describe('试听', () => {
  it('preview 立刻放一个音效，不经过限频，九个音效都能放，内容和纯函数合成的一样', async () => {
    const { player, ctx } = await started();
    for (let k = 0; k < 2; k++) for (const id of SOUND_IDS) player.preview(id);
    const heard = ctx.shots().map((s) => soundIn(s.buffer));
    expect(heard).toEqual([...SOUND_IDS, ...SOUND_IDS]);
    // 九个缓冲各合成一次，加上环境声以外没有别的
    expect(ctx.buffers).toHaveLength(SOUND_IDS.length);
  });

  it('声音关着、窗口被设置为静音、页面不可见、AudioContext 没有在运行时不放', async () => {
    const { fake, player, ctx } = await started();
    player.setSettings({ enabled: false });
    player.preview('rule');
    player.setSettings({ enabled: true, muteOnBlur: true });
    await settle();
    fake.fireWindow('blur');
    player.preview('rule');
    fake.fireWindow('focus');
    fake.page.visibilityState = 'hidden';
    fake.fireDocument('visibilitychange');
    player.preview('rule');
    fake.page.visibilityState = 'visible';
    fake.fireDocument('visibilitychange');
    await settle();
    ctx.state = 'suspended';
    player.preview('rule');
    expect(ctx.shots()).toHaveLength(0);
    ctx.state = 'running';
    player.preview('rule');
    expect(ctx.shots()).toHaveLength(1);
  });

  it('解锁之前不放', () => {
    const fake = fakeEnv();
    const player = createAudioPlayer(fake.env);
    player.preview('rule');
    expect(fake.contexts).toHaveLength(0);
  });
});

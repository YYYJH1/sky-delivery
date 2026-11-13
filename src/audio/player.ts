// 浏览器里的播放器：管理 AudioContext、总音量、环境声的循环和白天夜间的交替、窗口焦点和页面可见性。
// 这个文件不直接碰浏览器的全局对象，需要的东西都由调用方通过 PlayerEnv 传入，测试里传假的。
// 真实的环境由 browser.ts 的 browserAudioEnv() 提供。用到的 Web Audio 接口只写了几个结构类型，
// 所以在没有 DOM 类型的配置下也能通过类型检查。
//
// 行为：
//   浏览器要求用户操作之后才能出声，所以 AudioContext 在第一次点击或按键时才创建。创建之前观察状态不出声。
//   页面不可见时静音并挂起 AudioContext，不播任何声音。
//   窗口失去焦点但还看得见时音量降低，设置里可以改成静音。
//   环境声按游戏内时刻在白天和夜间两条之间用淡入淡出切换。
//   AudioContext 没有在运行时不播音效，也不攒着，恢复运行之后不会把错过的声音一起放出来。
import type { SimState } from '../core/index.ts';
import { AMBIENT_RATE } from './ambient.ts';
import { AMBIENT_IDS, SOUND_IDS, SOUND_INFO, renderAmbient, renderSound } from './catalog.ts';
import type { AmbientId, SoundId } from './catalog.ts';
import { makeRandom } from './dsp.ts';
import { createLimiter } from './limiter.ts';
import { loadSettings, masterGain, mergeSettings, saveSettings } from './settings.ts';
import type { AudioSettings, StorageLike } from './settings.ts';
import { soundsBetween, takeSnapshot } from './triggers.ts';
import type { AudioSnapshot } from './triggers.ts';

// ---- Web Audio 的结构类型：只写用到的部分 ----
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  readonly playbackRate: AudioParamLike;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  createGain(): GainNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): BufferSourceLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

/** 播放器需要的浏览器环境。真实的环境见 browser.ts，测试里传假的。 */
export interface PlayerEnv {
  /** 新建一个 AudioContext。浏览器没有 Web Audio 时返回 null。要在用户操作的事件处理里调用，浏览器才让它出声。 */
  createContext(): AudioContextLike | null;
  /** 本地存储，用不了时为 null。 */
  readonly storage: StorageLike | null;
  /** 单调的毫秒时钟，限频用。 */
  now(): number;
  readonly document: {
    readonly visibilityState: string;
    hasFocus(): boolean;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
  readonly window: {
    addEventListener(type: string, listener: () => void, capture?: boolean): void;
    removeEventListener(type: string, listener: () => void, capture?: boolean): void;
  };
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** 环境声淡入淡出的秒数。 */
export const AMBIENT_FADE_SECONDS = 4;
/** 总增益变化的时间常数（秒）。音量、焦点、可见性变化时用它平滑过渡，避免杂音。 */
const GAIN_SMOOTHING = 0.05;
/** 不再需要出声之后，等这么久（毫秒）再挂起 AudioContext，让增益先降到 0。 */
const SUSPEND_DELAY_MS = 200;
/** 第一条环境声放起来之后，等这么久（毫秒）再开始把别的声音合成好，之后每隔 PREPARE_GAP_MS 合成一个，免得占住主线程。 */
const PREPARE_DELAY_MS = 3000;
const PREPARE_GAP_MS = 300;
/** 表示用户操作的事件。第一次收到其中任何一个，就创建 AudioContext。 */
const GESTURES = ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const;

export type PlayerStatus = 'locked' | 'unavailable' | 'suspended' | 'running' | 'disposed';

export interface AudioPlayer {
  /**
   * 每个渲染帧调用一次：读游戏状态，把这段时间里值得出声的事播出来，并让环境声跟上游戏内的时刻。
   * 只读状态。声音关掉、还没有解锁或不可见时只是记下基线，什么也不播。
   */
  observe(state: SimState): void;
  /** 换了一份状态之后调用（读档、导入）：下一次 observe 只记基线，不出声。 */
  reset(): void;
  /** 现在的设置，是一份拷贝。 */
  settings(): AudioSettings;
  /** 改设置：检查、存进本地存储、立刻生效。返回改完之后的设置。 */
  setSettings(patch: Partial<AudioSettings>): AudioSettings;
  /**
   * 立刻放一个音效试听，不经过限频。设置里拖动音量滑块之后放一个，玩家就能听到现在的音量。
   * 声音关着、AudioContext 没有在运行、窗口被设置为静音或页面不可见时不放。
   */
  preview(id: SoundId): void;
  /** 窗口有没有焦点。attach 之后由事件自动更新，不接 attach 时由页面自己调用。 */
  setFocused(focused: boolean): void;
  /** 页面是否可见。同上。 */
  setVisible(visible: boolean): void;
  /** 在用户操作的事件处理里调用：创建并启动 AudioContext。attach 之后由第一次点击或按键自动调用。 */
  unlock(): void;
  /** 接上浏览器事件：失去和重新得到焦点，页面可见性，第一次点击或按键。返回摘掉它们的函数。 */
  attach(): () => void;
  status(): PlayerStatus;
  /** 停掉全部声音，关闭 AudioContext，摘掉事件。之后不能再用。 */
  dispose(): void;
}

interface Layer {
  readonly source: BufferSourceLike;
  readonly gain: GainNodeLike;
  /** 正在淡出，淡出结束之后停掉。 */
  fadingOut: boolean;
}

export function createAudioPlayer(env: PlayerEnv): AudioPlayer {
  let settings: AudioSettings = loadSettings(env.storage);
  let focused = true;
  let visible = true;
  let ctx: AudioContextLike | null = null;
  let master: GainNodeLike | null = null;
  let unavailable = false;
  let disposed = false;
  let night = false;
  let clockKnown = false;
  let current: AmbientId | null = null;
  let previous: AudioSnapshot | null = null;
  let suspendTimer: number | null = null;
  let prepareTimer: number | null = null;
  let preparing = false;
  let listening = false;
  let detachEvents: (() => void) | null = null;
  const limiter = createLimiter();
  const buffers = new Map<string, AudioBufferLike>();
  const layers = new Map<AmbientId, Layer>();
  const pitch = makeRandom(0x706c6179);

  const wanted = (): boolean => settings.enabled && visible && (focused || !settings.muteOnBlur);
  const running = (): boolean => ctx !== null && ctx.state === 'running';

  function applyGain(): void {
    if (ctx === null || master === null) return;
    master.gain.setTargetAtTime(masterGain(settings, focused, visible), ctx.currentTime, GAIN_SMOOTHING);
  }

  /** 缓存里没有就合成一次，放进 AudioBuffer。 */
  function bufferFor(id: string, sampleRate: number, render: () => Float32Array): AudioBufferLike {
    const cached = buffers.get(id);
    if (cached !== undefined) return cached;
    const samples = render();
    const buffer = (ctx as AudioContextLike).createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    buffers.set(id, buffer);
    return buffer;
  }

  function play(id: SoundId): void {
    const context = ctx;
    if (context === null || master === null) return;
    const source = context.createBufferSource();
    source.buffer = bufferFor(id, context.sampleRate, () => renderSound(id, context.sampleRate));
    // 常有的声音每次的音高有 2% 以内的小变化，重复听到时不那么机械
    if (SOUND_INFO[id].kind === 'frequent') source.playbackRate.value = 1 + (pitch() - 0.5) * 0.04;
    source.connect(master);
    source.onended = () => source.disconnect();
    source.start();
  }

  // ---- 环境声 ----
  function startLayer(id: AmbientId): Layer {
    const context = ctx as AudioContextLike;
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(master as GainNodeLike);
    const source = context.createBufferSource();
    source.buffer = bufferFor(id, AMBIENT_RATE, () => renderAmbient(id));
    source.loop = true;
    source.connect(gain);
    source.start();
    const layer: Layer = { source, gain, fadingOut: false };
    layers.set(id, layer);
    return layer;
  }

  function fade(layer: Layer, target: number): void {
    const now = (ctx as AudioContextLike).currentTime;
    const param = layer.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + AMBIENT_FADE_SECONDS);
  }

  function stopWhenFaded(id: AmbientId, layer: Layer): void {
    env.setTimeout(() => {
      if (layers.get(id) !== layer || !layer.fadingOut) return;
      layers.delete(id);
      layer.source.stop();
      layer.source.disconnect();
      layer.gain.disconnect();
    }, (AMBIENT_FADE_SECONDS + 0.3) * 1000);
  }

  /** 让环境声是现在这个时刻该有的那一条：新的淡入，旧的淡出。 */
  function syncAmbient(): void {
    if (!running() || !clockKnown) return;
    const target: AmbientId = night ? 'ambientNight' : 'ambientDay';
    if (current === target) return;
    const other: AmbientId = night ? 'ambientDay' : 'ambientNight';
    const incoming = layers.get(target) ?? startLayer(target);
    incoming.fadingOut = false;
    fade(incoming, 1);
    const outgoing = layers.get(other);
    if (outgoing !== undefined) {
      outgoing.fadingOut = true;
      fade(outgoing, 0);
      stopWhenFaded(other, outgoing);
    }
    current = target;
    if (!preparing) {
      preparing = true;
      prepareTimer = env.setTimeout(prepareNext, PREPARE_DELAY_MS);
    }
  }

  /** 把还没合成的声音一个一个合成好，以后第一次用到时不会卡一下。另一条环境声最重，排在最前面。 */
  function prepareNext(): void {
    prepareTimer = null;
    if (disposed || ctx === null) return;
    const context = ctx;
    const jobs: { key: string; rate: number; render: () => Float32Array }[] = [
      ...AMBIENT_IDS.map((id) => ({ key: id, rate: AMBIENT_RATE, render: () => renderAmbient(id) })),
      ...SOUND_IDS.map((id) => ({ key: id, rate: context.sampleRate, render: () => renderSound(id, context.sampleRate) })),
    ];
    const job = jobs.find((j) => !buffers.has(j.key));
    if (job === undefined) return;
    bufferFor(job.key, job.rate, job.render);
    prepareTimer = env.setTimeout(prepareNext, PREPARE_GAP_MS);
  }

  // ---- 运行状态 ----
  function stopListeningForGestures(): void {
    if (!listening) return;
    listening = false;
    for (const type of GESTURES) env.window.removeEventListener(type, onGesture, true);
  }

  function afterRunning(): void {
    if (disposed || !running() || !wanted()) return;
    applyGain();
    syncAmbient();
    stopListeningForGestures();
  }

  /** 按现在的设置、焦点和可见性，让 AudioContext 运行或挂起。 */
  function syncRunState(): void {
    if (ctx === null) return;
    if (wanted()) {
      if (suspendTimer !== null) {
        env.clearTimeout(suspendTimer);
        suspendTimer = null;
      }
      if (ctx.state === 'running') afterRunning();
      else ctx.resume().then(afterRunning, () => undefined);
    } else {
      applyGain();
      if (ctx.state === 'running' && suspendTimer === null) {
        suspendTimer = env.setTimeout(() => {
          suspendTimer = null;
          if (ctx !== null && !wanted() && ctx.state === 'running') ctx.suspend().catch(() => undefined);
        }, SUSPEND_DELAY_MS);
      }
    }
  }

  function unlock(): void {
    if (disposed || unavailable || !settings.enabled) return;
    if (ctx === null) {
      const created = env.createContext();
      if (created === null) {
        unavailable = true;
        stopListeningForGestures();
        return;
      }
      ctx = created;
      master = created.createGain();
      master.gain.value = 0;
      master.connect(created.destination);
    }
    syncRunState();
  }

  function onGesture(): void {
    unlock();
  }

  function setFocused(next: boolean): void {
    if (focused === next) return;
    focused = next;
    syncRunState();
  }

  function setVisible(next: boolean): void {
    if (visible === next) return;
    visible = next;
    syncRunState();
  }

  return {
    observe(state: SimState): void {
      if (disposed || unavailable || !settings.enabled || !running() || !wanted()) {
        previous = null;
        return;
      }
      const snapshot = takeSnapshot(state);
      const candidates = soundsBetween(previous, snapshot);
      previous = snapshot;
      night = snapshot.night;
      clockKnown = true;
      syncAmbient();
      for (const id of limiter.admit(candidates, env.now())) play(id);
    },

    reset(): void {
      previous = null;
    },

    preview(id: SoundId): void {
      if (!disposed && running() && wanted()) play(id);
    },

    settings: () => ({ ...settings }),

    setSettings(patch: Partial<AudioSettings>): AudioSettings {
      const wasEnabled = settings.enabled;
      settings = mergeSettings(settings, patch);
      saveSettings(env.storage, settings);
      if (!wasEnabled && settings.enabled) unlock();
      else syncRunState();
      applyGain();
      return { ...settings };
    },

    setFocused,
    setVisible,
    unlock,

    attach(): () => void {
      if (detachEvents !== null) return detachEvents;
      focused = env.document.hasFocus();
      visible = env.document.visibilityState !== 'hidden';
      const onVisibility = (): void => setVisible(env.document.visibilityState !== 'hidden');
      const onBlur = (): void => setFocused(false);
      const onFocus = (): void => setFocused(true);
      env.document.addEventListener('visibilitychange', onVisibility);
      env.window.addEventListener('blur', onBlur);
      env.window.addEventListener('focus', onFocus);
      if (!running()) {
        listening = true;
        for (const type of GESTURES) env.window.addEventListener(type, onGesture, true);
      }
      detachEvents = () => {
        env.document.removeEventListener('visibilitychange', onVisibility);
        env.window.removeEventListener('blur', onBlur);
        env.window.removeEventListener('focus', onFocus);
        stopListeningForGestures();
        detachEvents = null;
      };
      return detachEvents;
    },

    status(): PlayerStatus {
      if (disposed) return 'disposed';
      if (unavailable) return 'unavailable';
      if (ctx === null) return 'locked';
      return ctx.state === 'running' ? 'running' : 'suspended';
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      detachEvents?.();
      if (suspendTimer !== null) env.clearTimeout(suspendTimer);
      if (prepareTimer !== null) env.clearTimeout(prepareTimer);
      for (const layer of layers.values()) {
        layer.source.stop();
        layer.source.disconnect();
        layer.gain.disconnect();
      }
      layers.clear();
      buffers.clear();
      if (ctx !== null) ctx.close().catch(() => undefined);
      ctx = null;
      master = null;
    },
  };
}

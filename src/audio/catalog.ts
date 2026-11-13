// 声音的目录：有哪些声音，各自怎么合成，属于哪一类，限频的参数。
import { AMBIENT_RATE, AMBIENT_SECONDS, renderAmbientDay, renderAmbientNight } from './ambient.ts';
import {
  renderBigOrder,
  renderCancel,
  renderNoteRead,
  renderOnTime,
  renderPeakStart,
  renderRule,
  renderStarUp,
  renderSummary,
  renderTakeoff,
} from './effects.ts';

/** 九个音效。名字对应游戏里发生的事：起飞，准时送达，大单送达，退单，换策略卡，高峰小结，高峰开始，升星，便签读过收起。 */
export const SOUND_IDS = ['takeoff', 'onTime', 'bigOrder', 'cancel', 'rule', 'summary', 'peakStart', 'starUp', 'noteRead'] as const;
export type SoundId = (typeof SOUND_IDS)[number];

/** 两条环境声，各自无缝循环。 */
export const AMBIENT_IDS = ['ambientDay', 'ambientNight'] as const;
export type AmbientId = (typeof AMBIENT_IDS)[number];

const EFFECT_RENDERERS: Readonly<Record<SoundId, (sampleRate: number) => Float32Array>> = {
  takeoff: renderTakeoff,
  onTime: renderOnTime,
  bigOrder: renderBigOrder,
  cancel: renderCancel,
  rule: renderRule,
  summary: renderSummary,
  peakStart: renderPeakStart,
  starUp: renderStarUp,
  noteRead: renderNoteRead,
};

const AMBIENT_RENDERERS: Readonly<Record<AmbientId, (sampleRate: number, seconds?: number) => Float32Array>> = {
  ambientDay: renderAmbientDay,
  ambientNight: renderAmbientNight,
};

/** 音效的峰值上限（线性幅度，约 -6 分贝）。每个音效的峰值都在它之下，见 EFFECT_PEAKS。 */
export const EFFECT_PEAK_LIMIT = 0.5;

/** 环境声的峰值上限（线性幅度，约 -14 分贝）。 */
export const AMBIENT_PEAK_LIMIT = 0.2;

/** 合成一个音效，返回单声道的采样。 */
export function renderSound(id: SoundId, sampleRate: number): Float32Array {
  return EFFECT_RENDERERS[id](sampleRate);
}

/**
 * 合成一条环境声，返回单声道的采样。不给采样率和时长时用 AMBIENT_RATE 和 AMBIENT_SECONDS。
 * 播放时把它设为循环，首尾可以直接相接。
 */
export function renderAmbient(id: AmbientId, sampleRate: number = AMBIENT_RATE, seconds?: number): Float32Array {
  return AMBIENT_RENDERERS[id](sampleRate, seconds ?? (id === 'ambientDay' ? AMBIENT_SECONDS.day : AMBIENT_SECONDS.night));
}

/**
 * 声音按出现的频繁程度分三类，限频的办法各不相同（见 limiter.ts）：
 *   frequent 世界里常有的：起飞、准时送达、大单送达、退单。共用一个预算，同时有间隔限制。
 *   rare 很少出现的：高峰小结、高峰开始、升星。各自只有间隔限制，不占预算，也不会被常有的挤掉。
 *   ui 玩家自己操作带来的：换策略卡、便签读过收起。间隔很短，操作一次响一次。
 */
export type SoundKind = 'frequent' | 'rare' | 'ui';

export interface SoundInfo {
  readonly kind: SoundKind;
  /** 同一个声音两次播放之间至少隔多少毫秒（真实时间，不是游戏时间，所以高速运行时也不会连成一片）。 */
  readonly gapMs: number;
  /** 同一时刻几个声音都该播时的先后，数字大的先。预算不够时先保住靠前的。 */
  readonly priority: number;
}

export const SOUND_INFO: Readonly<Record<SoundId, SoundInfo>> = {
  starUp: { kind: 'rare', gapMs: 2000, priority: 9 },
  summary: { kind: 'rare', gapMs: 8000, priority: 8 },
  peakStart: { kind: 'rare', gapMs: 20000, priority: 7 },
  bigOrder: { kind: 'frequent', gapMs: 4500, priority: 6 },
  cancel: { kind: 'frequent', gapMs: 6000, priority: 5 },
  onTime: { kind: 'frequent', gapMs: 3500, priority: 4 },
  takeoff: { kind: 'frequent', gapMs: 6000, priority: 3 },
  rule: { kind: 'ui', gapMs: 120, priority: 2 },
  noteRead: { kind: 'ui', gapMs: 200, priority: 1 },
};

/** 常有的四种声音共用的预算：任何 BUSY_WINDOW_MS 毫秒的时间里，最多放 BUSY_MAX 个。 */
export const BUSY_WINDOW_MS = 5000;
export const BUSY_MAX = 2;

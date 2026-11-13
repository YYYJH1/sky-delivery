// 声音模块的公开接口。游戏页面只从这里引用。
//
// 最少的用法：
//   const audio = createBrowserAudio()
//   audio.attach()                       接上失去和得到焦点、页面可见性、第一次点击或按键
//   audio.observe(state)                 每个渲染帧调用一次，只读状态
//   audio.reset()                        换了一份状态（读档、导入）之后调用
//   audio.setSettings({ volume: 0.5 })   改设置，存进本地存储，立刻生效
//   audio.preview('onTime')              拖动音量之后放一声试听
//
// 全部声音都由代码合成：catalog.ts 列出有哪些声音，effects.ts 和 ambient.ts 合成，
// triggers.ts 从状态得出要播哪些，limiter.ts 按真实时间限频，player.ts 播放，settings.ts 存设置。
export { AMBIENT_RATE, AMBIENT_RMS, AMBIENT_SECONDS } from './ambient.ts';
export { createBrowserAudio, browserAudioEnv } from './browser.ts';
export { AMBIENT_IDS, BUSY_MAX, BUSY_WINDOW_MS, SOUND_IDS, SOUND_INFO, renderAmbient, renderSound } from './catalog.ts';
export type { AmbientId, SoundId, SoundInfo, SoundKind } from './catalog.ts';
export { activeRms, peakOf, rmsOf, toDecibels } from './dsp.ts';
export { EFFECT_PEAKS } from './effects.ts';
export { createLimiter } from './limiter.ts';
export type { Limiter } from './limiter.ts';
export { AMBIENT_FADE_SECONDS, createAudioPlayer } from './player.ts';
export type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  AudioPlayer,
  BufferSourceLike,
  GainNodeLike,
  PlayerEnv,
  PlayerStatus,
} from './player.ts';
export { BLUR_GAIN, DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, masterGain, mergeSettings, parseSettings, saveSettings } from './settings.ts';
export type { AudioSettings, StorageLike } from './settings.ts';
export { MAX_GAP_STEPS, NIGHT_FROM_TICK, RECENT_STEPS, isNight, soundsBetween, takeSnapshot } from './triggers.ts';
export type { AudioSnapshot, OrderResult } from './triggers.ts';
export { encodeWav } from './wav.ts';

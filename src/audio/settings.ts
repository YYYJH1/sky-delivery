// 声音的设置：总开关，总音量，失去焦点时是否静音。存在 localStorage 里，读写都不会抛错，读不到或读到坏数据时用默认值。

export interface AudioSettings {
  /** 总开关。关掉之后什么声音也不出。 */
  enabled: boolean;
  /** 总音量，0 到 1。 */
  volume: number;
  /** 窗口失去焦点时是否静音。不勾选时，失去焦点只是把音量降低。 */
  muteOnBlur: boolean;
}

export const DEFAULT_SETTINGS: Readonly<AudioSettings> = { enabled: true, volume: 0.7, muteOnBlur: false };

/** 存设置的键。不放在存档的键前缀下，清空存档不会连设置一起清掉。 */
export const SETTINGS_KEY = 'sky-delivery-audio';

/** localStorage 用到的两个方法，浏览器的 Storage 满足这个形状。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 音量取 0 到 1，保留两位小数。不是有限的数字时返回 fallback。 */
function cleanVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function cleanFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 在 base 上改几项，每一项都检查类型和范围，不合格的项保持 base 里的值。 */
export function mergeSettings(base: Readonly<AudioSettings>, patch: Readonly<Partial<Record<keyof AudioSettings, unknown>>>): AudioSettings {
  return {
    enabled: cleanFlag(patch.enabled, base.enabled),
    volume: cleanVolume(patch.volume, base.volume),
    muteOnBlur: cleanFlag(patch.muteOnBlur, base.muteOnBlur),
  };
}

/** 从存下来的文字读设置。文字是 null、不是 JSON、不是对象，或者某一项不合格时，那一项用默认值。 */
export function parseSettings(text: string | null): AudioSettings {
  if (text === null) return { ...DEFAULT_SETTINGS };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  return isRecord(data) ? mergeSettings(DEFAULT_SETTINGS, data) : { ...DEFAULT_SETTINGS };
}

/** 读设置。没有本地存储、读的时候出错、存的内容坏了，都返回默认值。 */
export function loadSettings(storage: StorageLike | null): AudioSettings {
  if (storage === null) return { ...DEFAULT_SETTINGS };
  try {
    return parseSettings(storage.getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 存设置。没有本地存储或写的时候出错（空间满了、隐私模式）返回 false，不抛错。 */
export function saveSettings(storage: StorageLike | null, settings: Readonly<AudioSettings>): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, enabled: settings.enabled, volume: settings.volume, muteOnBlur: settings.muteOnBlur }));
    return true;
  } catch {
    return false;
  }
}

/** 窗口失去焦点但还看得见时，音量降到这个比例。 */
export const BLUR_GAIN = 0.35;

/**
 * 总增益。关掉声音或页面不可见时为 0。音量按平方换算成增益，滑块的手感更接近听感。
 * 窗口没有焦点时乘 BLUR_GAIN，设置了失去焦点时静音则为 0。
 */
export function masterGain(settings: Readonly<AudioSettings>, focused: boolean, visible: boolean): number {
  if (!settings.enabled || !visible) return 0;
  const base = settings.volume * settings.volume;
  if (focused) return base;
  return settings.muteOnBlur ? 0 : base * BLUR_GAIN;
}

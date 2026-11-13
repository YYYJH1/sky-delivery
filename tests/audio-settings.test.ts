// 声音的设置：总开关、总音量、失去焦点时是否静音。存在 localStorage 里，读写都包在 try/catch 里，读不到或读到坏数据时用默认值。
import { describe, expect, it } from 'vitest';
import { BLUR_GAIN, DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, masterGain, mergeSettings, parseSettings, saveSettings } from '../src/audio/settings.ts';
import type { AudioSettings, StorageLike } from '../src/audio/settings.ts';

/** 内存里的假 localStorage。 */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const DEFAULTS: AudioSettings = { enabled: true, volume: 0.7, muteOnBlur: false };

describe('默认值', () => {
  it('声音开着，音量 0.7，失去焦点时只降低音量不静音', () => {
    expect(DEFAULT_SETTINGS).toEqual(DEFAULTS);
  });

  it('键不放在存档的键前缀（sky-delivery.）下，清空存档不会连设置一起清掉', () => {
    expect(SETTINGS_KEY.startsWith('sky-delivery.')).toBe(false);
    expect(SETTINGS_KEY).toBe('sky-delivery-audio');
  });
});

describe('parseSettings：读存下来的文字', () => {
  it('合格的内容原样读出来', () => {
    expect(parseSettings('{"enabled":false,"volume":0.3,"muteOnBlur":true}')).toEqual({ enabled: false, volume: 0.3, muteOnBlur: true });
    expect(parseSettings('{"version":1,"enabled":true,"volume":1,"muteOnBlur":false}')).toEqual({ enabled: true, volume: 1, muteOnBlur: false });
  });

  it('没有存过（null）、空串、不是 JSON，都用默认值', () => {
    expect(parseSettings(null)).toEqual(DEFAULTS);
    expect(parseSettings('')).toEqual(DEFAULTS);
    expect(parseSettings('{坏了')).toEqual(DEFAULTS);
    expect(parseSettings('undefined')).toEqual(DEFAULTS);
  });

  it('JSON 但不是对象（数字、字符串、null、数组、布尔），都用默认值', () => {
    for (const text of ['5', '"abc"', 'null', '[1,2,3]', 'true', '[]']) expect(parseSettings(text), text).toEqual(DEFAULTS);
  });

  it('缺的项用默认值，多出来的项忽略', () => {
    expect(parseSettings('{"volume":0.2}')).toEqual({ enabled: true, volume: 0.2, muteOnBlur: false });
    expect(parseSettings('{"enabled":false}')).toEqual({ enabled: false, volume: 0.7, muteOnBlur: false });
    expect(parseSettings('{"volume":0.4,"theme":"dark","extra":[1]}')).toEqual({ enabled: true, volume: 0.4, muteOnBlur: false });
  });

  it('类型不对的项用默认值，别的项照常读', () => {
    expect(parseSettings('{"enabled":"yes","volume":"0.5","muteOnBlur":1}')).toEqual(DEFAULTS);
    expect(parseSettings('{"enabled":false,"volume":null,"muteOnBlur":true}')).toEqual({ enabled: false, volume: 0.7, muteOnBlur: true });
    expect(parseSettings('{"volume":{"a":1}}')).toEqual(DEFAULTS);
    expect(parseSettings('{"volume":[0.5]}')).toEqual(DEFAULTS);
  });

  it('音量超出范围就截到 0 到 1，保留两位小数', () => {
    expect(parseSettings('{"volume":7}').volume).toBe(1);
    expect(parseSettings('{"volume":-2}').volume).toBe(0);
    expect(parseSettings('{"volume":0.123456}').volume).toBe(0.12);
    expect(parseSettings('{"volume":1e-9}').volume).toBe(0);
    expect(parseSettings('{"volume":0}').volume).toBe(0);
  });

  it('音量不是有限的数字（JSON 写不出 NaN 和无穷大，但 1e999 会读成无穷大）用默认值', () => {
    expect(parseSettings('{"volume":1e999}').volume).toBe(0.7);
    expect(parseSettings('{"volume":-1e999}').volume).toBe(0.7);
  });

  it('读出来的是新对象，改它不会改默认值', () => {
    const a = parseSettings(null);
    a.volume = 0.1;
    expect(DEFAULT_SETTINGS.volume).toBe(0.7);
    expect(parseSettings(null).volume).toBe(0.7);
  });
});

describe('mergeSettings：在已有的设置上改几项', () => {
  it('只改给出的合格项', () => {
    expect(mergeSettings(DEFAULTS, { volume: 0.2 })).toEqual({ enabled: true, volume: 0.2, muteOnBlur: false });
    expect(mergeSettings(DEFAULTS, { enabled: false, muteOnBlur: true })).toEqual({ enabled: false, volume: 0.7, muteOnBlur: true });
    expect(mergeSettings(DEFAULTS, {})).toEqual(DEFAULTS);
  });

  it('不合格的项保持原值，音量截到 0 到 1', () => {
    const base: AudioSettings = { enabled: false, volume: 0.4, muteOnBlur: true };
    expect(mergeSettings(base, { enabled: 'x', volume: 'loud', muteOnBlur: 0 })).toEqual(base);
    expect(mergeSettings(base, { volume: Number.NaN })).toEqual(base);
    expect(mergeSettings(base, { volume: 3 }).volume).toBe(1);
    expect(mergeSettings(base, { volume: -3 }).volume).toBe(0);
  });

  it('不改传入的对象', () => {
    const base: AudioSettings = { enabled: true, volume: 0.5, muteOnBlur: false };
    mergeSettings(base, { volume: 0.9 });
    expect(base).toEqual({ enabled: true, volume: 0.5, muteOnBlur: false });
  });
});

describe('loadSettings 和 saveSettings：读写 localStorage', () => {
  it('存了再读，得到同样的设置，存下来的是带版本号的 JSON', () => {
    const storage = memoryStorage();
    expect(saveSettings(storage, { enabled: false, volume: 0.35, muteOnBlur: true })).toBe(true);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY) as string)).toEqual({ version: 1, enabled: false, volume: 0.35, muteOnBlur: true });
    expect(loadSettings(storage)).toEqual({ enabled: false, volume: 0.35, muteOnBlur: true });
  });

  it('没有存过、存的内容是坏数据，读到默认值', () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULTS);
    expect(loadSettings(memoryStorage({ [SETTINGS_KEY]: '{"volume":' }))).toEqual(DEFAULTS);
    expect(loadSettings(memoryStorage({ [SETTINGS_KEY]: '12345' }))).toEqual(DEFAULTS);
  });

  it('没有本地存储（null）：读到默认值，存返回 false', () => {
    expect(loadSettings(null)).toEqual(DEFAULTS);
    expect(saveSettings(null, DEFAULTS)).toBe(false);
  });

  it('读的时候抛错（隐私模式、被禁用）：读到默认值，不抛错', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    expect(loadSettings(broken)).toEqual(DEFAULTS);
  });

  it('写的时候抛错（空间满了）：返回 false，不抛错', () => {
    const full: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      },
    };
    expect(() => saveSettings(full, DEFAULTS)).not.toThrow();
    expect(saveSettings(full, DEFAULTS)).toBe(false);
  });

  it('别的键不受影响', () => {
    const storage = memoryStorage({ 'sky-delivery.main': 'save', other: 'x' });
    saveSettings(storage, DEFAULTS);
    expect(storage.data.get('sky-delivery.main')).toBe('save');
    expect(storage.data.get('other')).toBe('x');
  });
});

describe('masterGain：总增益', () => {
  const on: AudioSettings = { enabled: true, volume: 0.5, muteOnBlur: false };

  it('有焦点：音量的平方，滑块的手感更接近听感', () => {
    expect(masterGain(on, true, true)).toBeCloseTo(0.25, 10);
    expect(masterGain({ ...on, volume: 1 }, true, true)).toBe(1);
    expect(masterGain({ ...on, volume: 0 }, true, true)).toBe(0);
  });

  it('关掉声音，或者页面不可见：0', () => {
    expect(masterGain({ ...on, enabled: false }, true, true)).toBe(0);
    expect(masterGain(on, true, false)).toBe(0);
    expect(masterGain(on, false, false)).toBe(0);
  });

  it('失去焦点但还看得见：音量降低，设置了失去焦点时静音则是 0', () => {
    expect(masterGain(on, false, true)).toBeCloseTo(0.25 * BLUR_GAIN, 10);
    expect(masterGain(on, false, true)).toBeLessThan(masterGain(on, true, true));
    expect(masterGain(on, false, true)).toBeGreaterThan(0);
    expect(masterGain({ ...on, muteOnBlur: true }, false, true)).toBe(0);
    // 有焦点时 muteOnBlur 不起作用
    expect(masterGain({ ...on, muteOnBlur: true }, true, true)).toBeCloseTo(0.25, 10);
  });

  it('降低的幅度是 6 到 12 分贝', () => {
    const drop = 20 * Math.log10(BLUR_GAIN);
    expect(drop).toBeLessThan(-6);
    expect(drop).toBeGreaterThan(-12);
  });
});

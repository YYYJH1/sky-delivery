// 导出码：压缩、编码、校验和，以及导入时的各种失败。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRng, hashState, nextInt } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import {
  CODE_PREFIX,
  MemoryStore,
  SAVE_VERSION,
  crc32,
  decodeSaveCode,
  decodeSaveText,
  encodeSaveCode,
  encodeSaveText,
  loadGame,
  saveGame,
  serializeSave,
} from '../src/save/index.ts';
import type { FailureCode, Migration } from '../src/save/index.ts';
import { base64UrlDecode, base64UrlEncode, deflate, hex8, inflate, utf8Encode, utf8Length } from '../src/save/bytes.ts';
import { BUSY, WALL, hashOfSlot, runState } from './save-helpers.ts';

const STATE: SimState = runState(BUSY, 3000);

function randomBytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const rng = createRng(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = nextInt(rng, 256);
  return out;
}

async function codeOf(state: SimState = STATE, savedAt = WALL): Promise<string> {
  const result = await encodeSaveCode(state, savedAt);
  if (!result.ok) throw new Error(`encode failed: ${result.reason.message}`);
  return result.code;
}

/** 绕开压缩，用任意字节拼出一个校验和正确的导出码。 */
function craft(payload: Uint8Array<ArrayBuffer>): string {
  return `${CODE_PREFIX}.${base64UrlEncode(payload)}.${hex8(crc32(payload))}`;
}

async function failCode(code: unknown, options?: Parameters<typeof decodeSaveCode>[1]): Promise<FailureCode> {
  const result = await decodeSaveCode(code as string, options);
  if (result.ok) throw new Error('expected the code to be rejected');
  return result.reason.code;
}

/** 把字符串里第 index 个字符换成另一个 base64url 字符。 */
function swapChar(text: string, index: number): string {
  const was = text[index] as string;
  const now = was === 'A' ? 'B' : 'A';
  return text.slice(0, index) + now + text.slice(index + 1);
}

describe('校验和与编码的小工具', () => {
  it('CRC-32：标准的测试向量', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(utf8Encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(utf8Encode('a'))).toBe(0xe8b7be43);
    expect(crc32(utf8Encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('base64url：标准的测试向量，字母表里没有 + / = 和 .', () => {
    const enc = (s: string): string => base64UrlEncode(utf8Encode(s));
    expect([enc(''), enc('f'), enc('fo'), enc('foo'), enc('foob'), enc('fooba'), enc('foobar')]).toEqual(['', 'Zg', 'Zm8', 'Zm9v', 'Zm9vYg', 'Zm9vYmE', 'Zm9vYmFy']);
    expect(base64UrlEncode(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
    const all = base64UrlEncode(randomBytes(30000, 1));
    expect(all).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('base64url：长度 0 到 70 的随机字节和一份大数据，编码再解码都原样', () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = randomBytes(n, n + 100);
      expect(base64UrlDecode(base64UrlEncode(bytes)), `长度 ${n}`).toEqual(bytes);
    }
    const big = randomBytes(300_001, 7);
    expect(base64UrlDecode(base64UrlEncode(big))).toEqual(big);
  });

  it('base64url：字母表之外的字符、长度不可能的输入，解码得到 null', () => {
    for (const bad of ['Zm9v+', 'Zm9v/', 'Zm9v=', 'Zm 9v', 'Zm9v.', 'Z', 'Zm9vY', '中文', 'Zm9v\n']) {
      expect(base64UrlDecode(bad), bad).toBeNull();
    }
    expect(base64UrlDecode('')).toEqual(new Uint8Array(0));
  });

  it('UTF-8 长度与编码器一致，包括表情符号和单独的代理项', () => {
    for (const s of ['', 'abc', '存档', 'é', '😀', 'a😀b', '\ud800', 'x\udc00y', '𠮷']) {
      expect(utf8Length(s), s).toBe(new TextEncoder().encode(s).length);
    }
  });

  it('deflate 再 inflate 原样还原，包括空输入和比流的缓冲大得多的输入', async () => {
    expect(await inflate(await deflate(new Uint8Array(0)), 10)).toEqual(new Uint8Array(0));
    const text = utf8Encode('老街'.repeat(10000));
    expect(await inflate(await deflate(text), 1 << 20)).toEqual(text);
    const noise = randomBytes(2_000_000, 3);
    expect(await inflate(await deflate(noise), 3_000_000)).toEqual(noise);
  });

  it('inflate 超过上限时抛出，输入不是 deflate 数据时抛出', async () => {
    const zeros = await deflate(new Uint8Array(5_000_000));
    expect(zeros.length).toBeLessThan(10_000);
    await expect(inflate(zeros, 1_000_000)).rejects.toThrow(RangeError);
    await expect(inflate(randomBytes(500, 9), 1_000_000)).rejects.toThrow();
  });
});

describe('导出码的格式', () => {
  it('前缀、数据、校验和三段，用点隔开，只含字母数字和 _ - .，没有空白', async () => {
    const code = await codeOf();
    const parts = code.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(CODE_PREFIX);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]{8}$/);
    expect(code).not.toMatch(/\s/);
  });

  it('校验和是压缩数据的 CRC-32', async () => {
    const code = await codeOf();
    const [, body, sum] = code.split('.') as [string, string, string];
    const packed = base64UrlDecode(body) as Uint8Array<ArrayBuffer>;
    expect(sum).toBe(hex8(crc32(packed)));
    // 解压之后正是存档文本
    const serialized = serializeSave(STATE, WALL);
    if (!serialized.ok) throw new Error('serialize');
    expect(new TextDecoder().decode(await inflate(packed, 1 << 26))).toBe(serialized.text);
  });

  it('比存档文本短得多', async () => {
    const serialized = serializeSave(STATE, WALL);
    if (!serialized.ok) throw new Error('serialize');
    const code = await codeOf();
    expect(code.length).toBeLessThan(serialized.text.length / 3);
  });

  it('同一个状态编两次，得到同一个码', async () => {
    expect(await codeOf()).toBe(await codeOf());
  });
});

describe('导出码的往返', () => {
  it('导出再导入：状态完全相同，哈希相同，保存时间也在', async () => {
    const result = await decodeSaveCode(await codeOf(STATE, WALL + 123));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual(STATE);
    expect(hashState(result.state)).toBe(hashState(STATE));
    expect(result.savedAt).toBe(WALL + 123);
    expect(result.migratedFrom).toBeNull();
  });

  it('存档文本经过导出码再还原，逐字节相同，中文也不会变', async () => {
    for (const text of ['{"a":"老街，写字楼区"}', '😀', '']) {
      const back = await decodeSaveText(await encodeSaveText(text));
      expect(back).toEqual({ ok: true, text });
    }
  });

  it('复制粘贴时被折行、加了空格或首尾空白，照样能导入', async () => {
    const code = await codeOf();
    const wrapped = code.replace(/(.{76})/g, '$1\n');
    for (const pasted of [wrapped, `  ${code}\n`, code.replace(/(.{40})/g, '$1 \r\n  '), `\t${code}\t`]) {
      expect((await decodeSaveCode(pasted)).ok).toBe(true);
    }
  });

  it('校验和的大小写都认', async () => {
    const code = await codeOf();
    const upper = code.slice(0, code.lastIndexOf('.') + 1) + code.slice(code.lastIndexOf('.') + 1).toUpperCase();
    expect((await decodeSaveCode(upper)).ok).toBe(true);
  });

  it('状态没通过校验时不生成导出码', async () => {
    const state = structuredClone(STATE);
    (state.drones[0] as { battery: number }).battery = Number.NaN;
    const result = await encodeSaveCode(state, WALL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe('non-finite');
  });

  it('导入的存档版本旧时先迁移：和读存档用同一套', async () => {
    const serialized = serializeSave(STATE, WALL);
    if (!serialized.ok) throw new Error('serialize');
    const save = JSON.parse(serialized.text) as { version: number; state: Record<string, unknown> };
    save.version = 0;
    save.state.ruleSet = save.state.rules;
    delete save.state.rules;
    const code = await encodeSaveText(JSON.stringify(save));
    const rename: Migration = (data) => {
      const state = data.state as Record<string, unknown>;
      state.rules = state.ruleSet;
      delete state.ruleSet;
      return data;
    };
    expect(await failCode(code)).toBe('migrate');
    const result = await decodeSaveCode(code, { currentVersion: 1, migrations: { 0: rename } });
    expect(result.ok && result.migratedFrom).toBe(0);
    expect(result.ok && hashState(result.state)).toBe(hashState(STATE));
  });
});

describe('导出码的各种损坏', () => {
  it('校验和被改：先在校验和这一步就被发现，类型是 checksum', async () => {
    const code = await codeOf();
    const at = code.length - 1;
    const wrong = code.slice(0, at) + (code[at] === '0' ? '1' : '0');
    expect(await failCode(wrong)).toBe('checksum');
    const result = await decodeSaveCode(wrong);
    expect(!result.ok && result.reason.message).toContain('checksum');
  });

  it('数据里改了一个字符，类型是 checksum', async () => {
    const code = await codeOf();
    const start = code.indexOf('.') + 1;
    for (const offset of [0, 1, 50, 500]) expect(await failCode(swapChar(code, start + offset)), `偏移 ${offset}`).toBe('checksum');
  });

  it('数据里少了一个或几个字符：不通过（checksum 或 code）', async () => {
    const code = await codeOf();
    const start = code.indexOf('.') + 1;
    for (const drop of [1, 2, 3, 100]) {
      const cut = code.slice(0, start + 10) + code.slice(start + 10 + drop);
      expect(['checksum', 'code']).toContain(await failCode(cut));
    }
  });

  it('复制不完整，末尾缺了一截：类型是 code', async () => {
    const code = await codeOf();
    for (const keep of [0.2, 0.5, 0.9]) expect(await failCode(code.slice(0, Math.floor(code.length * keep)))).toBe('code');
    expect(await failCode(code.slice(0, -3))).toBe('code');
  });

  it('前缀不对、段数不对、校验和写法不对、数据里有别的字符：类型是 code', async () => {
    const code = await codeOf();
    const [prefix, body, sum] = code.split('.') as [string, string, string];
    for (const bad of [
      '',
      'hello',
      `SKYSAVE2.${body}.${sum}`,
      `skysave1.${body}.${sum}`,
      `${body}.${sum}`,
      `${prefix}.${body}`,
      `${prefix}.${body}.${sum}.extra`,
      `${prefix}.${body}.${sum.slice(1)}`,
      `${prefix}.${body}.${sum}0`,
      `${prefix}.${body}.zzzzzzzz`,
      `${prefix}..${sum}`,
      `${prefix}.${body}+.${sum}`,
      `${prefix}.${body.slice(0, 20)}=.${sum}`,
    ]) {
      expect(await failCode(bad), bad.slice(0, 40)).toBe('code');
    }
    for (const notText of [null, undefined, 5, {}, []]) expect(await failCode(notText)).toBe('code');
  });

  it('校验和对得上，但数据不是 deflate：类型是 inflate', async () => {
    expect(await failCode(craft(randomBytes(300, 5)))).toBe('inflate');
    expect(await failCode(craft(Uint8Array.from([1])))).toBe('inflate');
  });

  it('能解压，但解出来不是合法的 UTF-8：类型是 inflate', async () => {
    expect(await failCode(craft(await deflate(Uint8Array.from([0xff, 0xfe, 0x00]))))).toBe('inflate');
  });

  it('小数据解出巨大的内容（压缩炸弹）：超过上限就拒绝', async () => {
    const bomb = craft(await deflate(new Uint8Array(5_000_000)));
    expect(bomb.length).toBeLessThan(20_000);
    expect(await failCode(bomb, { maxInflatedBytes: 1_000_000 })).toBe('inflate');
    // 放宽上限之后能解出来，只是内容不是存档
    expect(await failCode(bomb)).toBe('parse');
  });

  it('能解压，但内容不是存档：沿用读存档的失败类型', async () => {
    const serialized = serializeSave(STATE, WALL);
    if (!serialized.ok) throw new Error('serialize');
    const cases: [string, FailureCode][] = [
      ['not json at all', 'parse'],
      [serialized.text.slice(0, serialized.text.length / 2), 'parse'],
      ['{"hello":1}', 'format'],
      [serialized.text.replace(`"version":${SAVE_VERSION}`, '"version":99'), 'newer-version'],
      [serialized.text.replace(`"version":${SAVE_VERSION}`, '"version":0'), 'migrate'],
      [serialized.text.replace(/"battery":[\d.]+/, '"battery":null'), 'non-finite'],
      [serialized.text.replace('"orders":', '"orderz":'), 'schema'],
    ];
    for (const [text, code] of cases) expect(await failCode(await encodeSaveText(text)), text.slice(0, 30)).toBe(code);
  });
});

describe('环境里没有压缩流（很旧的浏览器）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('导出和导入都返回失败，不抛出，也不影响不需要压缩的存档读写', async () => {
    const code = await codeOf();
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
    const encoded = await encodeSaveCode(STATE, WALL);
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) expect(encoded.reason.message).toContain('compressed');
    expect(await failCode(code)).toBe('inflate');
    // 存档照常存，只是退回写 JSON 原文，不压缩
    const store = new MemoryStore();
    const saved = await saveGame(store, STATE, WALL);
    expect(saved.ok && saved.packed).toBe(false);
    expect((await loadGame(store, WALL)).status).toBe('ok');
  });
});

describe('导入之后装进存档', () => {
  it('导入的存档成为主存档，原来的主存档挪进备份一，当前的进度不会丢', async () => {
    const store = new MemoryStore();
    const mine = runState(BUSY, 1500);
    await saveGame(store, mine, WALL);
    const theirs = runState({ ...BUSY, seed: 99 }, 2400);
    const imported = await decodeSaveCode(await codeOf(theirs, WALL + 500));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const outcome = await saveGame(store, imported.state, WALL + 1000);
    expect(outcome.ok).toBe(true);
    expect(await hashOfSlot(store, 'main')).toBe(hashState(theirs));
    expect(await hashOfSlot(store, 'backup1')).toBe(hashState(mine));
    const loaded = await loadGame(store, WALL + 2000);
    expect(loaded.state && hashState(loaded.state)).toBe(hashState(theirs));
  });

  it('导出码坏了的时候，现有的存档一点都没动', async () => {
    const store = new MemoryStore();
    await saveGame(store, runState(BUSY, 1500), WALL);
    const before = store.snapshot();
    const code = await codeOf();
    const result = await decodeSaveCode(swapChar(code, code.indexOf('.') + 5));
    expect(result.ok).toBe(false);
    expect(store.snapshot()).toEqual(before);
  });
});

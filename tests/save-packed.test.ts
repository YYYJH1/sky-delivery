// 存档写进存储时压缩：压缩的和没压缩的两种写法都能读，压缩的写法被改坏时的各种失败，滚动备份里新旧写法混着放。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advance, hashState } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import {
  CODE_PREFIX,
  MemoryStore,
  PACKED_PREFIX,
  SAVE_VERSION,
  crc32,
  decodeSaveCode,
  encodeSaveCode,
  isPackedText,
  listQuarantine,
  loadGame,
  parseStoredSave,
  saveGame,
  serializeSave,
  slotKey,
  unpackSaveText,
} from '../src/save/index.ts';
import type { FailureCode } from '../src/save/index.ts';
import { base64UrlDecode, base64UrlEncode, deflate, hex8, inflate } from '../src/save/bytes.ts';
import { BUSY, WALL, hashOfSlot, readJson, readStored, runState, slotHashes } from './save-helpers.ts';

const STATE: SimState = runState(BUSY, 1500);

/** 压缩的存档文本拆成三段：前缀，数据，校验和。 */
function parts(text: string): [string, string, string] {
  const p = text.split('.');
  if (p.length !== 3) throw new Error('not a packed save');
  return p as [string, string, string];
}

/** 用给定的字节拼出一个校验和正确的压缩写法。 */
function craft(payload: Uint8Array<ArrayBuffer>): string {
  return `${CODE_PREFIX}.${base64UrlEncode(payload)}.${hex8(crc32(payload))}`;
}

async function threeGenerations(store: MemoryStore, options = {}): Promise<{ hashes: string[]; state: SimState }> {
  const state = runState(BUSY, 0);
  const hashes: string[] = [];
  for (let i = 0; i < 3; i++) {
    advance(state, 360);
    const outcome = await saveGame(store, state, WALL + i * 1000, options);
    expect(outcome.ok).toBe(true);
    hashes.push(hashState(state));
  }
  return { hashes, state };
}

describe('存储里的写法：压缩的和没压缩的', () => {
  it('默认压缩：存储里的主存档以 SKYSAVE1. 开头，和导出码是同一种写法', async () => {
    const store = new MemoryStore();
    const outcome = await saveGame(store, STATE, WALL);
    expect(outcome.ok && outcome.packed).toBe(true);
    const stored = await readStored(store, 'main');
    expect(isPackedText(stored)).toBe(true);
    expect(stored.startsWith(PACKED_PREFIX)).toBe(true);
    expect(PACKED_PREFIX).toBe(`${CODE_PREFIX}.`);
    // 同一个状态、同样的保存时间，导出码和存储里的文本逐字相同
    const code = await encodeSaveCode(STATE, WALL);
    expect(code.ok && code.code).toBe(stored);
    // 反过来，存储里的文本可以直接当导出码导入
    const imported = await decodeSaveCode(stored);
    expect(imported.ok && hashState(imported.state)).toBe(hashState(STATE));
  });

  it('不压缩时存的是 JSON 原文，以 { 开头，isPackedText 认得出区别', async () => {
    const store = new MemoryStore();
    const outcome = await saveGame(store, STATE, WALL, { compress: false });
    expect(outcome.ok && outcome.packed).toBe(false);
    expect(outcome.ok && outcome.bytes).toBe(outcome.ok ? outcome.rawBytes : -1);
    const stored = await readStored(store, 'main');
    expect(stored.startsWith('{')).toBe(true);
    expect(isPackedText(stored)).toBe(false);
    expect(isPackedText('SKYSAVE1')).toBe(false);
    expect(isPackedText('')).toBe(false);
  });

  it('两种写法读出来是同一个状态，保存时间也一样', async () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    await saveGame(a, STATE, WALL + 5);
    await saveGame(b, STATE, WALL + 5, { compress: false });
    const la = await loadGame(a, WALL);
    const lb = await loadGame(b, WALL);
    expect(la.status).toBe('ok');
    expect(lb.status).toBe('ok');
    expect(la.state).toEqual(lb.state);
    expect(la.save?.savedAt).toBe(WALL + 5);
    expect(lb.save?.savedAt).toBe(WALL + 5);
    expect(await readJson(a, 'main')).toBe(await readJson(b, 'main'));
  });

  it('unpackSaveText 和 parseStoredSave：压缩的先解压，没压缩的原样，不是文本的报格式错误', async () => {
    const serialized = serializeSave(STATE, WALL);
    if (!serialized.ok) throw new Error('serialize');
    const code = await encodeSaveCode(STATE, WALL);
    if (!code.ok) throw new Error('encode');
    expect(await unpackSaveText(code.code)).toEqual({ ok: true, text: serialized.text });
    expect(await unpackSaveText(serialized.text)).toEqual({ ok: true, text: serialized.text });
    const bad = await unpackSaveText(7 as unknown as string);
    expect(!bad.ok && bad.reason.code).toBe('format');
    for (const text of [code.code, serialized.text]) {
      const parsed = await parseStoredSave(text);
      expect(parsed.ok && hashState(parsed.state)).toBe(hashState(STATE));
    }
  });

  it('滚动备份里新旧写法混着放：每一代按自己的写法读，挪动不改内容', async () => {
    const store = new MemoryStore();
    // 老的两代是没压缩的，新的两代是压缩的
    const old = await threeGenerations(store, { compress: false });
    const state = old.state;
    advance(state, 360);
    await saveGame(store, state, WALL + 9000);
    const stored = await Promise.all((['main', 'backup1', 'backup2', 'backup3'] as const).map((slot) => store.get(slotKey(slot))));
    expect(stored.map((text) => text !== null && isPackedText(text))).toEqual([true, false, false, false]);
    expect((await slotHashes(store)).every((h) => h !== null)).toBe(true);
    expect(await hashOfSlot(store, 'main')).toBe(hashState(state));
    expect(await hashOfSlot(store, 'backup1')).toBe(old.hashes[2]);
  });
});

describe('压缩的存档被改坏：回退到备份，原样留一份副本', () => {
  /** 备好三代压缩的存档，把主存档改成 bad，读档，检查回退和副本。 */
  async function expectFallback(bad: (good: string) => string | Promise<string>, code: FailureCode | readonly FailureCode[], why: string): Promise<void> {
    const store = new MemoryStore();
    const { hashes } = await threeGenerations(store);
    const good = await readStored(store, 'main');
    expect(isPackedText(good)).toBe(true);
    const text = await bad(good);
    expect(text, why).not.toBe(good);
    await store.set(slotKey('main'), text);

    const loaded = await loadGame(store, WALL + 5000);
    expect(loaded.status, why).toBe('restored');
    expect(loaded.source, why).toBe('backup1');
    expect(loaded.damaged, why).toBe(true);
    expect(loaded.state && hashState(loaded.state), why).toBe(hashes[1]);
    const failed = loaded.failures[0];
    expect(failed?.kind, why).toBe('invalid');
    if (failed?.kind === 'invalid') expect(typeof code === 'string' ? [code] : code, why).toContain(failed.reason.code);
    // 坏的存档原样留着，副本也是原样
    expect(await store.get(slotKey('main')), why).toBe(text);
    expect(loaded.quarantined, why).toHaveLength(1);
    expect(await store.get(loaded.quarantined[0]?.key ?? ''), why).toBe(text);
    expect(await listQuarantine(store), why).toHaveLength(1);
    // 同一份坏档反复读，不会越存越多
    await loadGame(store, WALL + 6000);
    expect(await listQuarantine(store), why).toHaveLength(1);
  }

  const swap = (text: string, at: number): string => text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);

  it('数据里一个字符被改：校验和对不上，在解压之前就发现，类型是 checksum', async () => {
    await expectFallback((good) => swap(good, PACKED_PREFIX.length + 200), 'checksum', 'swap one char');
  });

  it('数据里少了一段：类型是 checksum 或 code', async () => {
    // 少掉 30 个字符之后，数据的长度除以 4 的余数随存档内容变化，余数是 1 时不是合法的编码，先在编码这一步失败
    await expectFallback((good) => good.slice(0, PACKED_PREFIX.length + 50) + good.slice(PACKED_PREFIX.length + 80), ['checksum', 'code'], 'dropped middle');
  });

  it('末尾被截断：只剩前缀和一部分数据，类型是 code', async () => {
    await expectFallback((good) => good.slice(0, Math.floor(good.length * 0.7)), 'code', 'truncated tail');
    await expectFallback((good) => good.slice(0, good.lastIndexOf('.')), 'code', 'no checksum');
    await expectFallback((good) => good.slice(0, good.length - 3), 'code', 'short checksum');
  });

  it('校验和被改：类型是 checksum', async () => {
    await expectFallback((good) => `${good.slice(0, good.lastIndexOf('.') + 1)}00000000`, 'checksum', 'zero checksum');
  });

  it('数据是空的，或者只有前缀：类型是 code', async () => {
    await expectFallback(() => `${CODE_PREFIX}..00000000`, 'code', 'empty data');
    await expectFallback(() => PACKED_PREFIX, 'code', 'prefix only');
  });

  it('校验和对得上，但数据不是 deflate，或者 deflate 的数据里有一个字节被改：类型是 inflate', async () => {
    await expectFallback(() => craft(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), 'inflate', 'not deflate');
    // 解开、改一个字节、重新算校验和：zlib 自带的 Adler-32 会发现
    const store = new MemoryStore();
    await threeGenerations(store);
    const packed = base64UrlDecode(parts(await readStored(store, 'main'))[1]) as Uint8Array<ArrayBuffer>;
    const flipped = Uint8Array.from(packed);
    flipped[Math.floor(flipped.length / 2)] = (flipped[Math.floor(flipped.length / 2)] as number) ^ 0x55;
    const code = craft(flipped);
    const result = await decodeSaveCode(code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['inflate', 'parse', 'schema', 'non-finite']).toContain(result.reason.code);
  });

  it('解压出来不是存档：沿用读存档的失败类型', async () => {
    const serialized = serializeSave(STATE, WALL);
    if (!serialized.ok) throw new Error('serialize');
    const pack = async (text: string): Promise<string> => craft(await deflate(new TextEncoder().encode(text)));
    const cases: [string, string, FailureCode][] = [
      ['not json at all', 'not json at all', 'parse'],
      ['half of a save', serialized.text.slice(0, serialized.text.length / 2), 'parse'],
      ['wrong shape', '{"hello":1}', 'format'],
      ['newer version', serialized.text.replace(`"version":${SAVE_VERSION}`, '"version":99'), 'newer-version'],
      ['no migration', serialized.text.replace(`"version":${SAVE_VERSION}`, '"version":0'), 'migrate'],
      ['nan', serialized.text.replace(/"battery":[\d.]+/, '"battery":null'), 'non-finite'],
      ['no orders', serialized.text.replace('"orders":', '"orderz":'), 'schema'],
    ];
    for (const [why, text, code] of cases) await expectFallback(() => pack(text), code, why);
  });

  it('回退之后再保存：坏的压缩存档不会被挪进备份，好的备份一代也不丢', async () => {
    const store = new MemoryStore();
    const { hashes } = await threeGenerations(store);
    const good = await readStored(store, 'main');
    await store.set(slotKey('main'), swap(good, PACKED_PREFIX.length + 300));
    const loaded = await loadGame(store, WALL + 5000);
    const resumed = loaded.state as SimState;
    advance(resumed, 360);
    const outcome = await saveGame(store, resumed, WALL + 6000);
    expect(outcome.ok).toBe(true);
    expect(await slotHashes(store)).toEqual([hashState(resumed), hashes[1], hashes[0], null]);
  });

  it('压缩炸弹：很小的数据解出巨大的内容，读档当作坏档，回退到备份', async () => {
    const store = new MemoryStore();
    const { hashes } = await threeGenerations(store);
    const bomb = craft(await deflate(new Uint8Array(5_000_000)));
    expect(bomb.length).toBeLessThan(20_000);
    await store.set(slotKey('main'), bomb);
    // 上限放小，模拟比正式的上限大得多的内容
    const loaded = await loadGame(store, WALL + 5000, { maxInflatedBytes: 1_000_000 });
    expect(loaded.status).toBe('restored');
    const failed = loaded.failures[0];
    expect(failed?.kind === 'invalid' && failed.reason.code).toBe('inflate');
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[1]);
    // 解压之后超过上限的内容没有被留下来，只留了压缩的原文
    expect(loaded.quarantined[0] && (await store.get(loaded.quarantined[0].key))).toBe(bomb);
  });

  it('inflate 工具本身：输出超过上限时抛出', async () => {
    const packed = await deflate(new Uint8Array(100_000));
    await expect(inflate(packed, 1000)).rejects.toThrow();
  });
});

describe('保存时不重复检查刚写下的主存档', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 数一数解压了几次：每读一份压缩的存档来检查或读档，就要解压一次。 */
  function countInflates(): { count: () => number } {
    let n = 0;
    const Real = globalThis.DecompressionStream;
    class Counting extends Real {
      constructor(format: 'deflate' | 'deflate-raw' | 'gzip') {
        super(format);
        n += 1;
      }
    }
    vi.stubGlobal('DecompressionStream', Counting);
    return { count: () => n };
  }

  it('下一次保存时主存档还是上一次写下的那一份：不用再解压、解析、校验一遍，省下的是主线程上的一大段时间', async () => {
    const store = new MemoryStore();
    const state = runState(BUSY, 600);
    const inflates = countInflates();
    for (let i = 0; i < 4; i++) {
      advance(state, 100);
      expect((await saveGame(store, state, WALL + i)).ok).toBe(true);
    }
    expect(inflates.count()).toBe(0);
    expect((await slotHashes(store)).every((h) => h !== null)).toBe(true);
    // 四份都读一遍：每份解压一次，读的时候一次也没有省
    expect(inflates.count()).toBe(4);
  });

  it('主存档被别人改过（内容不是上次写下的那一份）：照常检查，坏的不挪进备份', async () => {
    const store = new MemoryStore();
    const state = runState(BUSY, 600);
    await saveGame(store, state, WALL);
    advance(state, 100);
    await saveGame(store, state, WALL + 1);
    const good = await readStored(store, 'main');
    // 改成另一份坏的，保存时必须发现
    await store.set(slotKey('main'), swapOne(good, PACKED_PREFIX.length + 100));
    advance(state, 100);
    const outcome = await saveGame(store, state, WALL + 2);
    expect(outcome.ok && outcome.quarantined).toHaveLength(1);
    // 改成另一份好的（内容不同），也要检查一遍，通过之后挪进备份
    const other = new MemoryStore();
    const a = runState(BUSY, 300);
    await saveGame(other, a, WALL);
    const goodMain = await readStored(other, 'main');
    await store.set(slotKey('main'), goodMain);
    const inflates = countInflates();
    advance(state, 100);
    const again = await saveGame(store, state, WALL + 3);
    expect(again.ok && again.quarantined).toHaveLength(0);
    expect(inflates.count()).toBe(1);
    expect(await readStored(store, 'backup1')).toBe(goodMain);
  });

  it('换了校验的办法（自己的字段表）：不信上一次的记录，每次都检查', async () => {
    const store = new MemoryStore();
    const state = runState(BUSY, 300);
    await saveGame(store, state, WALL);
    const inflates = countInflates();
    advance(state, 100);
    const options = { allowNonFinite: [] as string[] };
    await saveGame(store, state, WALL + 1, options);
    expect(inflates.count()).toBe(1);
  });

  /** 换掉第 at 个字符，不改变长度。 */
  function swapOne(text: string, at: number): string {
    return text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);
  }
});

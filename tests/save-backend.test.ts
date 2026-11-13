// 网页版选哪种存储：优先 IndexedDB，打不开退回 localStorage。localStorage 里的旧存档第一次用 IndexedDB 时复制过去。
import { describe, expect, it } from 'vitest';
import { advance, hashState } from '../src/core/index.ts';
import {
  DEFAULT_DB_NAME,
  DEFAULT_STORE_NAME,
  DENIED_STORAGE,
  IndexedDbStore,
  LocalStorageStore,
  MIGRATED_KEY,
  MemoryStore,
  SLOTS,
  isPackedText,
  loadGame,
  migrateLocalStorage,
  openGameStore,
  saveGame,
  serializeSave,
  slotKey,
} from '../src/save/index.ts';
import type { StorageLike } from '../src/save/index.ts';
import { FakeIdbFactory } from './fake-idb.ts';
import { BUSY, FakeStorage, WALL, runState } from './save-helpers.ts';

/** 往假的 localStorage 里放四份旧存档（没压缩的 JSON 原文，版本 1 的存档就是这样存的），加一份坏档的副本和一个无关的键。 */
async function legacyStorage(): Promise<{ storage: FakeStorage; texts: Record<string, string>; hashes: string[] }> {
  const storage = new FakeStorage();
  const local = new LocalStorageStore(storage);
  const state = runState(BUSY, 0);
  const hashes: string[] = [];
  for (let i = 0; i < 4; i++) {
    advance(state, 300);
    hashes.push(hashState(state));
    await saveGame(local, state, WALL + i * 1000, { compress: false });
  }
  storage.setItem('sky-delivery.bad.0001731400000000.main.100-deadbeef', 'garbage that was a corrupt save');
  storage.setItem('settings', '{"volume":3}');
  const texts: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i) as string;
    texts[key] = storage.getItem(key) as string;
  }
  return { storage, texts, hashes };
}

function idbKeys(factory: FakeIdbFactory): string[] {
  return factory.peekKeys(DEFAULT_DB_NAME, DEFAULT_STORE_NAME);
}

describe('从 localStorage 迁到 IndexedDB', () => {
  it('第一次用 IndexedDB：游戏的键（四份存档和坏档的副本）原样复制过去，不相干的键不动，记一个已迁移的标记', async () => {
    const { storage, texts } = await legacyStorage();
    const factory = new FakeIdbFactory();
    const opened = await openGameStore({ indexedDb: factory, storage, nowMs: WALL + 99 });
    expect(opened.kind).toBe('indexeddb');
    expect(opened.fallback).toBeUndefined();
    expect(opened.migration).toEqual({ status: 'migrated', copied: 5 });
    // 键和值都与 localStorage 里的逐字相同
    const gameKeys = Object.keys(texts).filter((k) => k.startsWith('sky-delivery.'));
    expect(gameKeys).toHaveLength(5);
    for (const key of gameKeys) expect(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, key), key).toBe(texts[key]);
    expect(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, 'settings')).toBeNull();
    // 已迁移的标记
    expect(idbKeys(factory)).toContain(MIGRATED_KEY);
    const flag = JSON.parse(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, MIGRATED_KEY) as string) as Record<string, unknown>;
    expect(flag).toEqual({ from: 'localStorage', at: WALL + 99, keys: 5, copied: 5 });
  });

  it('迁移成功之后，localStorage 里原来的一个键也不删，一个值也不改', async () => {
    const { storage, texts } = await legacyStorage();
    await openGameStore({ indexedDb: new FakeIdbFactory(), storage, nowMs: WALL });
    const after: Record<string, string> = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i) as string;
      after[key] = storage.getItem(key) as string;
    }
    expect(after).toEqual(texts);
  });

  it('迁过来的存档能读：主存档和三份备份都在，次序没变', async () => {
    const { storage, hashes } = await legacyStorage();
    const opened = await openGameStore({ indexedDb: new FakeIdbFactory(), storage, nowMs: WALL });
    const loaded = await loadGame(opened.store, WALL + 1);
    expect(loaded.status).toBe('ok');
    expect(loaded.source).toBe('main');
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[3]);
    for (const [i, slot] of SLOTS.entries()) {
      const text = await opened.store.get(slotKey(slot));
      expect(text, slot).not.toBeNull();
      const parsed = await loadGame(new MemoryStore({ [slotKey('main')]: text as string }), WALL);
      expect(parsed.state && hashState(parsed.state), slot).toBe(hashes[3 - i]);
    }
  });

  it('再打开：已经迁过，不再复制，localStorage 后来有变化也不管', async () => {
    const { storage } = await legacyStorage();
    const factory = new FakeIdbFactory();
    await openGameStore({ indexedDb: factory, storage, nowMs: WALL });
    const idbMain = factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, slotKey('main'));
    storage.setItem(slotKey('main'), 'something newer written by an old page');
    storage.setItem('sky-delivery.new', 'x');
    const second = await openGameStore({ indexedDb: factory, storage, nowMs: WALL + 1 });
    expect(second.kind).toBe('indexeddb');
    expect(second.migration).toEqual({ status: 'already', copied: 0 });
    expect(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, slotKey('main'))).toBe(idbMain);
    expect(idbKeys(factory)).not.toContain('sky-delivery.new');
  });

  it('localStorage 里没有游戏的存档：不用复制，也记下标记，以后不再去扫 localStorage', async () => {
    const storage = new FakeStorage();
    storage.setItem('settings', '1');
    const factory = new FakeIdbFactory();
    const opened = await openGameStore({ indexedDb: factory, storage, nowMs: WALL });
    expect(opened.migration).toEqual({ status: 'none', copied: 0 });
    expect(idbKeys(factory)).toEqual([MIGRATED_KEY]);
  });

  it('IndexedDB 里已经有的键不覆盖：只复制缺的', async () => {
    const { storage, texts } = await legacyStorage();
    const factory = new FakeIdbFactory();
    factory.poke(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, slotKey('main'), 'already here');
    const opened = await openGameStore({ indexedDb: factory, storage, nowMs: WALL });
    expect(opened.migration).toEqual({ status: 'migrated', copied: 4 });
    expect(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, slotKey('main'))).toBe('already here');
    expect(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, slotKey('backup1'))).toBe(texts[slotKey('backup1')]);
  });

  it('迁移之后接着用：新的存档压缩写进 IndexedDB，旧的没压缩的存档挪进备份，localStorage 不再被写', async () => {
    const { storage, texts, hashes } = await legacyStorage();
    const factory = new FakeIdbFactory();
    const opened = await openGameStore({ indexedDb: factory, storage, nowMs: WALL });
    const loaded = await loadGame(opened.store, WALL + 1);
    const state = loaded.state!;
    advance(state, 300);
    expect((await saveGame(opened.store, state, WALL + 2)).ok).toBe(true);
    const main = factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, slotKey('main')) as string;
    expect(isPackedText(main)).toBe(true);
    expect(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, slotKey('backup1'))).toBe(texts[slotKey('main')]);
    // localStorage 一点没变
    for (const [key, value] of Object.entries(texts)) expect(storage.getItem(key)).toBe(value);
    expect(storage.length).toBe(Object.keys(texts).length);
    // 重新打开读到新的一代
    const again = await openGameStore({ indexedDb: factory, storage, nowMs: WALL + 3 });
    const reloaded = await loadGame(again.store, WALL + 4);
    expect(reloaded.state && hashState(reloaded.state)).toBe(hashState(state));
    expect(hashes).toHaveLength(4);
  });

  it('IndexedDB 被浏览器清掉了、localStorage 还在：标记跟着一起没了，下一次打开再迁一次，玩家至少读得到旧的存档', async () => {
    const { storage, hashes } = await legacyStorage();
    const factory = new FakeIdbFactory();
    await openGameStore({ indexedDb: factory, storage, nowMs: WALL });
    factory.databases.clear();
    const opened = await openGameStore({ indexedDb: factory, storage, nowMs: WALL + 1 });
    expect(opened.migration?.status).toBe('migrated');
    const loaded = await loadGame(opened.store, WALL + 2);
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[3]);
  });
});

describe('IndexedDB 用不了：退回 localStorage', () => {
  it.each(['throw', 'error', 'blocked'] as const)('打开时出错（%s）：用 localStorage，已有的存档照常读，给出原因', async (mode) => {
    const { storage, hashes } = await legacyStorage();
    const factory = new FakeIdbFactory();
    factory.failOpen = mode;
    const opened = await openGameStore({ indexedDb: factory, storage, nowMs: WALL });
    expect(opened.kind).toBe('localstorage');
    expect(opened.migration).toBeNull();
    expect(typeof opened.fallback).toBe('string');
    const loaded = await loadGame(opened.store, WALL + 1);
    expect(loaded.status).toBe('ok');
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[3]);
    // 存档也存到 localStorage 里，压缩的
    const state = loaded.state!;
    advance(state, 300);
    expect((await saveGame(opened.store, state, WALL + 2)).ok).toBe(true);
    expect(isPackedText(storage.getItem(slotKey('main')) as string)).toBe(true);
  });

  it('浏览器根本没有 IndexedDB：同样退回 localStorage，没有原因要说', async () => {
    const { storage } = await legacyStorage();
    const opened = await openGameStore({ indexedDb: undefined, storage, nowMs: WALL });
    expect(opened.kind).toBe('localstorage');
    expect(opened.fallback).toBeUndefined();
    expect((await loadGame(opened.store, WALL)).status).toBe('ok');
  });

  it('IndexedDB 能打开，但写不进去（有的浏览器的隐私模式）：这一次退回 localStorage，没有记标记，下一次再试', async () => {
    const { storage, hashes } = await legacyStorage();
    const factory = new FakeIdbFactory();
    factory.quotaChars = 10; // 什么都写不进去
    const first = await openGameStore({ indexedDb: factory, storage, nowMs: WALL });
    expect(first.kind).toBe('localstorage');
    expect(first.migration?.status).toBe('failed');
    expect(first.fallback).toContain('migration failed');
    expect(idbKeys(factory)).not.toContain(MIGRATED_KEY);
    expect((await loadGame(first.store, WALL + 1)).state && hashState((await loadGame(first.store, WALL + 1)).state!)).toBe(hashes[3]);
    // 空间恢复之后下一次就迁成功了
    factory.quotaChars = Number.POSITIVE_INFINITY;
    const second = await openGameStore({ indexedDb: factory, storage, nowMs: WALL + 2 });
    expect(second.kind).toBe('indexeddb');
    expect(second.migration?.status).toBe('migrated');
    expect(idbKeys(factory)).toContain(MIGRATED_KEY);
  });

  it('迁到一半出错：已经复制的不会被下一次覆盖，没复制的补上，最后记标记', async () => {
    const { storage, texts } = await legacyStorage();
    const factory = new FakeIdbFactory();
    // 第三次写出错：先写了两个键
    let writes = 0;
    const realOpen = factory.open.bind(factory);
    void realOpen;
    const idb = await IndexedDbStore.open(factory);
    const local = new LocalStorageStore(storage);
    const flaky = {
      get: (key: string) => idb.get(key),
      remove: (key: string) => idb.remove(key),
      keys: (prefix?: string) => idb.keys(prefix),
      set: (key: string, value: string) => {
        writes += 1;
        if (writes === 3) return Promise.reject(new Error('disk hiccup'));
        return idb.set(key, value);
      },
    };
    const first = await migrateLocalStorage(local, flaky, WALL);
    expect(first.status).toBe('failed');
    expect(first.copied).toBe(2);
    expect(first.error).toContain('disk hiccup');
    expect(idbKeys(factory)).not.toContain(MIGRATED_KEY);
    const second = await migrateLocalStorage(local, idb, WALL + 1);
    expect(second.status).toBe('migrated');
    expect(second.copied).toBe(3);
    for (const key of Object.keys(texts).filter((k) => k.startsWith('sky-delivery.'))) {
      expect(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, key), key).toBe(texts[key]);
    }
  });

  it('localStorage 读不了（浏览器禁用了），IndexedDB 正常：用 IndexedDB，不知道有没有要迁的，所以不记标记', async () => {
    const factory = new FakeIdbFactory();
    const unreadable: StorageLike = {
      get length(): number {
        throw new Error('SecurityError: access is denied');
      },
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const denied = await openGameStore({ indexedDb: factory, storage: unreadable, nowMs: WALL });
    expect(denied.kind).toBe('indexeddb');
    expect(denied.migration?.status).toBe('source-unavailable');
    expect(denied.migration?.error).toContain('access is denied');
    expect(idbKeys(factory)).toEqual([]);
    // 没有 localStorage 这个东西时一样
    const none = await openGameStore({ indexedDb: factory, storage: undefined, nowMs: WALL });
    expect(none.kind).toBe('indexeddb');
    expect(none.migration).toBeNull();
    const state = runState(BUSY, 200);
    expect((await saveGame(none.store, state, WALL)).ok).toBe(true);
  });

  it('两种都没有：返回一个读写都出错的存储，读档说用不了，保存说没存上，页面照样能运行', async () => {
    const opened = await openGameStore({ nowMs: WALL });
    expect(opened.kind).toBe('none');
    expect((await loadGame(opened.store, WALL)).status).toBe('unavailable');
    const outcome = await saveGame(opened.store, runState(BUSY, 100), WALL);
    expect(outcome.ok).toBe(false);
    // 两种都打不开
    const factory = new FakeIdbFactory();
    factory.failOpen = 'error';
    const both = await openGameStore({ indexedDb: factory, storage: undefined, nowMs: WALL });
    expect(both.kind).toBe('none');
    expect(typeof both.fallback).toBe('string');
  });

  it('localStorage 的存档放不下的情形：IndexedDB 能放，不再有容量问题', async () => {
    // 假的 localStorage 只有 100 KB，一份没压缩的存档就放不下。IndexedDB 不受这个限制
    const storage = new FakeStorage(100_000);
    const state = runState(BUSY, 3000);
    const text = serializeSave(state, WALL);
    if (!text.ok) throw new Error('serialize');
    expect(text.text.length).toBeGreaterThan(100_000);
    expect((await saveGame(new LocalStorageStore(storage), state, WALL, { compress: false })).ok).toBe(false);
    const opened = await openGameStore({ indexedDb: new FakeIdbFactory(), storage, nowMs: WALL });
    expect((await saveGame(opened.store, state, WALL, { compress: false })).ok).toBe(true);
    expect((await loadGame(opened.store, WALL)).status).toBe('ok');
  });
});

describe('迁移函数本身', () => {
  it('只复制以游戏的前缀开头的键；源里读不到值（被并发删掉）的键跳过', async () => {
    const source = new MemoryStore({ 'sky-delivery.a': '1', 'sky-delivery.b': '2', other: '3' });
    const target = new MemoryStore();
    const report = await migrateLocalStorage(source, target, WALL);
    expect(report).toEqual({ status: 'migrated', copied: 2 });
    expect(await target.keys()).toEqual(['sky-delivery.a', 'sky-delivery.b', MIGRATED_KEY].sort());
    expect(await source.keys()).toEqual(['other', 'sky-delivery.a', 'sky-delivery.b']);
  });

  it('读标记时出错：IndexedDB 实际上用不了，按 failed 报告', async () => {
    const broken = {
      get: () => Promise.reject(new Error('cannot read')),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
    };
    const report = await migrateLocalStorage(new MemoryStore(), broken, WALL);
    expect(report.status).toBe('failed');
  });

  it('不是 DENIED_STORAGE 之外的东西：它的每一个方法都抛出', () => {
    const storage: StorageLike = DENIED_STORAGE;
    expect(() => storage.getItem('a')).toThrow();
    expect(() => storage.setItem('a', 'b')).toThrow();
    expect(() => storage.removeItem('a')).toThrow();
    expect(storage.length).toBe(0);
  });
});

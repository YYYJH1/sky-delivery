// IndexedDB 版存储本身：事务、出错、重新连接。键值存储的通用约定和滚动备份的测试在 save-store.test.ts 里，三种存储同一套。
// 这里用假的 IndexedDB（tests/fake-idb.ts）：回调是异步的，事务完成才提交，中止时写的东西作废。
import { describe, expect, it } from 'vitest';
import { advance, hashState } from '../src/core/index.ts';
import { DEFAULT_DB_NAME, DEFAULT_STORE_NAME, IndexedDbStore, StoreError, loadGame, saveGame, slotKey } from '../src/save/index.ts';
import { FakeIdbFactory } from './fake-idb.ts';
import { BUSY, WALL, runState, slotHashes } from './save-helpers.ts';

async function open(factory = new FakeIdbFactory()): Promise<{ factory: FakeIdbFactory; store: IndexedDbStore }> {
  return { factory, store: await IndexedDbStore.open(factory) };
}

describe('IndexedDB 存储：事务', () => {
  it('第一次打开建库：库名和对象仓库的名字是默认的，里面是空的', async () => {
    const { factory } = await open();
    expect([...factory.databases.keys()]).toEqual([DEFAULT_DB_NAME]);
    expect([...(factory.databases.get(DEFAULT_DB_NAME)?.stores.keys() ?? [])]).toEqual([DEFAULT_STORE_NAME]);
    expect(factory.peekKeys(DEFAULT_DB_NAME, DEFAULT_STORE_NAME)).toEqual([]);
  });

  it('可以指定库名和仓库名，不同的库互不干扰', async () => {
    const factory = new FakeIdbFactory();
    const a = await IndexedDbStore.open(factory, { name: 'a', storeName: 'x' });
    const b = await IndexedDbStore.open(factory, { name: 'b' });
    await a.set('k', '1');
    await b.set('k', '2');
    expect(await a.get('k')).toBe('1');
    expect(await b.get('k')).toBe('2');
    expect(factory.peek('a', 'x', 'k')).toBe('1');
    expect(factory.peek('b', DEFAULT_STORE_NAME, 'k')).toBe('2');
  });

  it('每次 set 是一个读写事务，要求写完刷到磁盘（strict）；读是只读事务', async () => {
    const { factory, store } = await open();
    await store.set('a', '1');
    await store.get('a');
    await store.keys();
    await store.remove('a');
    expect(factory.transactions.map((t) => [t.mode, t.durability])).toEqual([
      ['readwrite', 'strict'],
      ['readonly', undefined],
      ['readonly', undefined],
      ['readwrite', 'strict'],
    ]);
  });

  it('set 等事务完成才返回：返回之后，数据已经提交到库里', async () => {
    const { factory, store } = await open();
    await store.set('k', 'v');
    expect(factory.peek(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, 'k')).toBe('v');
  });

  it('同时发出的读写按发出的先后一个接一个做，不穿插', async () => {
    const { store } = await open();
    const calls = [
      store.set('k', '1'),
      store.get('k'),
      store.set('k', '2'),
      store.get('k'),
      store.remove('k'),
      store.get('k'),
    ];
    const results = await Promise.all(calls);
    expect(results).toEqual([undefined, '1', undefined, '2', undefined, null]);
  });

  it('值是别的东西（不是字符串）时，读出来当作没有，列键时忽略这样的键', async () => {
    const { factory, store } = await open();
    factory.poke(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, 'n', 5 as unknown as string);
    factory.poke(DEFAULT_DB_NAME, DEFAULT_STORE_NAME, 'ok', 'x');
    expect(await store.get('n')).toBeNull();
    expect(await store.get('ok')).toBe('x');
  });

  it('关闭再打开（新的连接）：数据都还在', async () => {
    const { factory, store } = await open();
    await store.set('k', 'v');
    store.close();
    const again = await IndexedDbStore.open(factory);
    expect(await again.get('k')).toBe('v');
    expect(factory.openCount).toBe(2);
  });
});

describe('IndexedDB 存储：出错', () => {
  it('空间不够：写入出错，StoreError 的种类是 quota，原来的值不变，事务里的写入作废', async () => {
    const { factory, store } = await open();
    factory.quotaChars = 40;
    await store.set('a', 'x'.repeat(10));
    const error = await store.set('a', 'y'.repeat(100)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).kind).toBe('quota');
    expect(await store.get('a')).toBe('x'.repeat(10));
    // 新的键也放不下，也不会留下半截
    await expect(store.set('b', 'z'.repeat(100))).rejects.toMatchObject({ kind: 'quota' });
    expect(await store.keys()).toEqual(['a']);
    // 空间恢复之后照常写
    factory.quotaChars = Number.POSITIVE_INFINITY;
    await store.set('a', 'y'.repeat(100));
    expect(await store.get('a')).toBe('y'.repeat(100));
  });

  it('别的写入错误：StoreError，种类是 unavailable，原值不变', async () => {
    const { factory, store } = await open();
    await store.set('a', '1');
    factory.failNextWrite = Object.assign(new Error('boom'), { name: 'UnknownError' });
    const error = await store.set('a', '2').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).kind).toBe('unavailable');
    expect(await store.get('a')).toBe('1');
  });

  it('打不开：open 本身抛出、打开请求报错、被别的连接挡住，都是 StoreError，种类是 unavailable', async () => {
    for (const mode of ['throw', 'error', 'blocked'] as const) {
      const factory = new FakeIdbFactory();
      factory.failOpen = mode;
      const error = await IndexedDbStore.open(factory).catch((e: unknown) => e);
      expect(error, mode).toBeInstanceOf(StoreError);
      expect((error as StoreError).kind, mode).toBe('unavailable');
    }
  });

  it('浏览器把连接关了：下一次读写自动重新打开，数据还在', async () => {
    const { factory, store } = await open();
    await store.set('k', 'v');
    factory.dropConnections();
    expect(await store.get('k')).toBe('v');
    expect(factory.openCount).toBe(2);
    await store.set('k', 'w');
    expect(await store.get('k')).toBe('w');
    // 连接关着的时候同时发出的几个读写，只重新打开一次
    factory.dropConnections();
    const before = factory.openCount;
    const results = await Promise.all([store.get('k'), store.get('k'), store.get('k')]);
    expect(results).toEqual(['w', 'w', 'w']);
    expect(factory.openCount).toBe(before + 1);
  });

  it('别的页面要升级数据库（versionchange）：放掉连接，不挡着它，之后的读写重新打开', async () => {
    const { factory, store } = await open();
    await store.set('k', 'v');
    const connection = factory.connections[factory.connections.length - 1];
    connection?.onversionchange?.({} as never);
    expect(connection?.closed).toBe(true);
    expect(await store.get('k')).toBe('v');
    expect(factory.openCount).toBe(2);
  });

  it('连接已经关了、重新打开也不行：读写返回 StoreError，不抛出别的东西', async () => {
    const { factory, store } = await open();
    factory.dropConnections();
    factory.failOpen = 'error';
    await expect(store.get('k')).rejects.toBeInstanceOf(StoreError);
    await expect(store.set('k', 'v')).rejects.toBeInstanceOf(StoreError);
    factory.failOpen = null;
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
  });
});

describe('IndexedDB 存储：放存档', () => {
  it('四份存档加滚动备份：和别的存储一样，每次保存四个写事务，次序是备份三、备份二、备份一、主存档', async () => {
    const { factory, store } = await open();
    const state = runState(BUSY, 0);
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      advance(state, 300);
      hashes.push(hashState(state));
      const before = factory.transactions.filter((t) => t.mode === 'readwrite').length;
      const outcome = await saveGame(store, state, WALL + i);
      expect(outcome.ok && outcome.warnings).toEqual([]);
      const writes = factory.transactions.filter((t) => t.mode === 'readwrite').length - before;
      expect(writes).toBe(Math.min(i + 1, 4));
    }
    expect(await slotHashes(store)).toEqual([hashes[4], hashes[3], hashes[2], hashes[1]]);
    expect(factory.peekKeys(DEFAULT_DB_NAME, DEFAULT_STORE_NAME)).toEqual(['main', 'backup1', 'backup2', 'backup3'].map((s) => slotKey(s as 'main')).sort());
  });

  it('写主存档时空间不够：这次保存失败，原因是 quota，上一代存档原样保留', async () => {
    const { factory, store } = await open();
    const state = runState(BUSY, 200);
    expect((await saveGame(store, state, WALL)).ok).toBe(true);
    const before = hashState(state);
    advance(state, 300);
    factory.quotaChars = 5000; // 一份压缩的存档比这大得多，什么都写不进去
    const outcome = await saveGame(store, state, WALL + 1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('store');
      expect(outcome.storeKind).toBe('quota');
    }
    factory.quotaChars = Number.POSITIVE_INFINITY;
    const loaded = await loadGame(store, WALL + 2);
    expect(loaded.status).toBe('ok');
    expect(loaded.state && hashState(loaded.state)).toBe(before);
  });

  it('保存到一半浏览器关了连接：读档照常得到好的存档，下一次保存恢复正常', async () => {
    const { factory, store } = await open();
    const state = runState(BUSY, 100);
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      advance(state, 300);
      hashes.push(hashState(state));
      await saveGame(store, state, WALL + i);
    }
    advance(state, 300);
    const pending = saveGame(store, state, WALL + 10);
    factory.dropConnections();
    await pending;
    // 不论这次存上没有，读到的都是好的存档：新的一代，或者上一代
    const loaded = await loadGame(store, WALL + 11);
    expect(['ok', 'restored']).toContain(loaded.status);
    expect(loaded.damaged).toBe(false);
    expect([hashState(state), hashes[2]]).toContain(loaded.state && hashState(loaded.state));
    advance(state, 300);
    expect((await saveGame(store, state, WALL + 12)).ok).toBe(true);
    expect((await loadGame(store, WALL + 13)).state && hashState((await loadGame(store, WALL + 13)).state!)).toBe(hashState(state));
  });
});

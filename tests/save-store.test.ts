// 键值存储、三份滚动备份、读档回退、坏存档的副本。
import { describe, expect, it } from 'vitest';
import { advance, hashState } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import {
  DEFAULT_NAMESPACE,
  IndexedDbStore,
  LocalStorageStore,
  MemoryStore,
  SAVE_FORMAT,
  SLOTS,
  StoreError,
  encodeSaveText,
  listQuarantine,
  loadGame,
  saveGame,
  serializeSave,
  slotKey,
} from '../src/save/index.ts';
import type { FailureCode, KeyValueStore } from '../src/save/index.ts';
import { FakeIdbFactory } from './fake-idb.ts';
import { BUSY, FakeStorage, FaultyStore, WALL, readJson, readStored, runState, slotHashes } from './save-helpers.ts';
import type { FaultMode } from './save-helpers.ts';

// ---- 三种存储，同一套测试 ----
interface Rig {
  readonly store: KeyValueStore;
  /** 模拟关闭再打开：数据还在，存储对象是新的。 */
  reopen(): Promise<KeyValueStore>;
}

function memoryRig(): Rig {
  let current = new MemoryStore();
  return {
    get store() {
      return current;
    },
    reopen() {
      current = new MemoryStore(current.snapshot());
      return Promise.resolve(current);
    },
  };
}

function localStorageRig(): Rig {
  const fake = new FakeStorage();
  let current = new LocalStorageStore(fake);
  return {
    get store() {
      return current;
    },
    reopen() {
      current = new LocalStorageStore(fake);
      return Promise.resolve(current);
    },
  };
}

/** 假的 IndexedDB：关闭再打开是用同一个工厂再开一个连接，旧连接放掉。 */
async function indexedDbRig(): Promise<Rig> {
  const factory = new FakeIdbFactory();
  let current = await IndexedDbStore.open(factory);
  return {
    get store() {
      return current;
    },
    async reopen() {
      current.close();
      current = await IndexedDbStore.open(factory);
      return current;
    },
  };
}

const RIGS: [string, () => Rig | Promise<Rig>][] = [
  ['内存存储', memoryRig],
  ['localStorage 存储', localStorageRig],
  ['IndexedDB 存储', indexedDbRig],
];

/** 在 state 上连续存 count 次，每次之前多走一段。返回每一次保存时状态的哈希。 */
async function saveSeries(store: KeyValueStore, state: SimState, count: number, wallStart = WALL): Promise<string[]> {
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    advance(state, 360);
    const outcome = await saveGame(store, state, wallStart + i * 1000);
    expect(outcome.ok, `第 ${i + 1} 次保存`).toBe(true);
    hashes.push(hashState(state));
  }
  return hashes;
}


describe.each(RIGS)('键值存储的约定：%s', (_name, make) => {
  it('读不存在的键得到 null；写了能读到，再写覆盖旧值；删除之后读不到，删除不存在的键不出错', async () => {
    const { store } = await make();
    expect(await store.get('a')).toBeNull();
    await store.set('a', '1');
    expect(await store.get('a')).toBe('1');
    await store.set('a', '二');
    expect(await store.get('a')).toBe('二');
    await store.remove('a');
    expect(await store.get('a')).toBeNull();
    await expect(store.remove('a')).resolves.toBeUndefined();
  });

  it('列出键：按前缀过滤，按字典序，不带前缀时列全部', async () => {
    const { store } = await make();
    for (const key of ['b.2', 'a.1', 'b.1', 'c']) await store.set(key, 'x');
    expect(await store.keys('b.')).toEqual(['b.1', 'b.2']);
    expect(await store.keys()).toEqual(['a.1', 'b.1', 'b.2', 'c']);
    expect(await store.keys('zzz')).toEqual([]);
  });

  it('空字符串、很长的值、中文都能原样存取', async () => {
    const { store } = await make();
    const long = 'x'.repeat(2_000_000);
    for (const value of ['', long, '存档：老街，第三天']) {
      await store.set('k', value);
      expect(await store.get('k')).toBe(value);
    }
  });
});

describe.each(RIGS)('滚动备份：%s', (_name, make) => {
  it('第一次保存只有主存档。之后每存一次，各份往后挪一位，最老的一份被顶掉', async () => {
    const { store } = await make();
    const state = runState(BUSY, 0);
    const hashes: string[] = [];
    for (let i = 0; i < 6; i++) {
      advance(state, 360);
      const outcome = await saveGame(store, state, WALL + i);
      expect(outcome.ok && outcome.warnings).toEqual([]);
      hashes.push(hashState(state));
      const expected = [0, 1, 2, 3].map((k) => hashes[i - k] ?? null);
      expect(await slotHashes(store), `第 ${i + 1} 次`).toEqual(expected);
    }
    expect(await store.keys(DEFAULT_NAMESPACE)).toEqual(SLOTS.map((slot) => slotKey(slot)).sort());
  });

  it('挪动不改内容：备份和当时的主存档逐字节相同', async () => {
    const { store } = await make();
    const state = runState(BUSY, 0);
    await saveSeries(store, state, 1);
    const first = await readStored(store, 'main');
    await saveSeries(store, state, 1);
    expect(await readStored(store, 'backup1')).toBe(first);
    const second = await readStored(store, 'main');
    await saveSeries(store, state, 1);
    expect(await readStored(store, 'backup1')).toBe(second);
    expect(await readStored(store, 'backup2')).toBe(first);
  });

  it('保存的结果里有字节数和保存时间', async () => {
    const { store } = await make();
    const outcome = await saveGame(store, runState(BUSY, 100), WALL + 7);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.savedAt).toBe(WALL + 7);
    expect(outcome.bytes).toBe(new TextEncoder().encode(await readStored(store, 'main')).length);
    // 默认压缩：存储里的比 JSON 原文小
    expect(outcome.packed).toBe(true);
    expect(outcome.rawBytes).toBe(new TextEncoder().encode(await readJson(store, 'main')).length);
    expect(outcome.bytes).toBeLessThan(outcome.rawBytes);
  });

  it('读档先读主存档：正常时来自 main，没有失败记录，也没有副本', async () => {
    const { store } = await make();
    const state = runState(BUSY, 0);
    const hashes = await saveSeries(store, state, 3);
    const loaded = await loadGame(store, WALL + 99);
    expect(loaded.status).toBe('ok');
    expect(loaded.source).toBe('main');
    expect(loaded.failures).toEqual([]);
    expect(loaded.damaged).toBe(false);
    expect(loaded.quarantined).toEqual([]);
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[2]);
    expect(loaded.save?.savedAt).toBe(WALL + 2000);
    expect(loaded.save?.migratedFrom).toBeNull();
    expect(await listQuarantine(store)).toEqual([]);
  });

  it('什么存档都没有：empty，该开新档', async () => {
    const { store } = await make();
    const loaded = await loadGame(store, WALL);
    expect(loaded.status).toBe('empty');
    expect(loaded.state).toBeNull();
    expect(loaded.damaged).toBe(false);
    expect(loaded.failures.map((f) => f.kind)).toEqual(['missing', 'missing', 'missing', 'missing']);
    expect(await store.keys()).toEqual([]);
  });

  it('同一个存储里的别的键原样保留，不同的前缀互不干扰', async () => {
    const { store } = await make();
    await store.set('settings', '{"volume":3}');
    const a = runState(BUSY, 500);
    const b = runState({ ...BUSY, seed: 7 }, 900);
    await saveGame(store, a, WALL, { namespace: 'a.' });
    await saveGame(store, b, WALL, { namespace: 'b.' });
    const la = await loadGame(store, WALL, { namespace: 'a.' });
    const lb = await loadGame(store, WALL, { namespace: 'b.' });
    expect(la.state && hashState(la.state)).toBe(hashState(a));
    expect(lb.state && hashState(lb.state)).toBe(hashState(b));
    expect((await loadGame(store, WALL)).status).toBe('empty');
    expect(await store.get('settings')).toBe('{"volume":3}');
  });

  it('状态没通过校验（有 NaN）时拒绝保存，存储里什么也没动', async () => {
    const { store } = await make();
    const state = runState(BUSY, 800);
    await saveSeries(store, state, 2);
    const before = await Promise.all((await store.keys()).map(async (key) => [key, await store.get(key)]));
    (state.drones[1] as { battery: number }).battery = Number.NaN;
    const outcome = await saveGame(store, state, WALL + 5);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('invalid-state');
    expect(outcome.reason?.code).toBe('non-finite');
    const after = await Promise.all((await store.keys()).map(async (key) => [key, await store.get(key)]));
    expect(after).toEqual(before);
  });

  it('保存的是调用那一刻的状态：保存之后状态再变，不影响已经写出的这一份', async () => {
    const { store } = await make();
    const state = runState(BUSY, 800);
    const hash = hashState(state);
    const pending = saveGame(store, state, WALL);
    advance(state, 500);
    await pending;
    const loaded = await loadGame(store, WALL);
    expect(loaded.state && hashState(loaded.state)).toBe(hash);
  });

  it('同时发出的几次保存排队执行，备份的次序不乱', async () => {
    const { store } = await make();
    const state = runState(BUSY, 0);
    const hashes: string[] = [];
    const calls: ReturnType<typeof saveGame>[] = [];
    for (let i = 0; i < 6; i++) {
      advance(state, 200);
      hashes.push(hashState(state));
      calls.push(saveGame(store, state, WALL + i));
    }
    for (const outcome of await Promise.all(calls)) expect(outcome.ok).toBe(true);
    expect(await slotHashes(store)).toEqual([hashes[5], hashes[4], hashes[3], hashes[2]]);
  });
});

// ---- 损坏的存档 ----
type Corruption = [name: string, edit: (text: string) => string, code: FailureCode];

function viaObject(edit: (save: Record<string, any>) => void): (text: string) => string {
  return (text) => {
    const save = JSON.parse(text) as Record<string, unknown>;
    edit(save);
    return JSON.stringify(save);
  };
}

const CORRUPTIONS: Corruption[] = [
  ['里的一个数值变成 NaN（写出去是 null）', viaObject((save) => (save.state.drones[0].battery = Number.NaN)), 'non-finite'],
  ['里的一个数值被写成 NaN 字样', (text) => text.replace(/"battery":[\d.]+/, '"battery":NaN'), 'parse'],
  ['里的一个数值变成无穷（1e999）', (text) => text.replace(/"battery":[\d.]+/, '"battery":1e999'), 'non-finite'],
  ['的 JSON 被截断', (text) => text.slice(0, Math.floor(text.length * 0.6)), 'parse'],
  ['的 JSON 只剩开头', (text) => text.slice(0, 40), 'parse'],
  ['的内容被清空', () => '', 'parse'],
  ['的版本号改成更新的', viaObject((save) => (save.version = 99)), 'newer-version'],
  ['的版本号改成字符串', viaObject((save) => (save.version = '1')), 'version'],
  ['的版本号降到 0', viaObject((save) => (save.version = 0)), 'migrate'],
  ['缺少订单这一项', viaObject((save) => delete save.state.orders), 'schema'],
  ['的格式标识被改', viaObject((save) => (save.format = 'something-else')), 'format'],
];

describe.each(RIGS)('损坏的存档：%s', (_name, make) => {
  /** 三次保存：main 是第三代，backup1 是第二代，backup2 是第一代。 */
  async function threeGenerations(rig: Rig): Promise<{ hashes: string[]; state: SimState }> {
    const state = runState(BUSY, 0);
    return { hashes: await saveSeries(rig.store, state, 3), state };
  }

  it.each(CORRUPTIONS)('主存档%s：回退到备份一，说明原因，坏的存档原样留着并另存一份副本', async (_what, edit, code) => {
    const rig = await make();
    const { hashes } = await threeGenerations(rig);
    const mainKey = slotKey('main');
    const bad = edit(await readJson(rig.store, 'main'));
    await rig.store.set(mainKey, bad);

    const loaded = await loadGame(rig.store, WALL + 5000);
    expect(loaded.status).toBe('restored');
    expect(loaded.source).toBe('backup1');
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[1]);
    expect(loaded.damaged).toBe(true);
    expect(loaded.failures).toHaveLength(1);
    const failed = loaded.failures[0];
    expect(failed?.slot).toBe('main');
    expect(failed?.kind).toBe('invalid');
    if (failed?.kind === 'invalid') {
      expect(failed.reason.code).toBe(code);
      expect(failed.reason.message.length).toBeGreaterThan(0);
    }

    // 副本：内容与坏的存档逐字相同，键里带时间
    expect(loaded.quarantined).toHaveLength(1);
    const copy = loaded.quarantined[0];
    expect(copy?.slot).toBe('main');
    expect(copy?.created).toBe(true);
    expect(copy?.key).toContain(`.bad.${String(WALL + 5000).padStart(13, '0')}.main.`);
    expect(await rig.store.get(copy?.key ?? '')).toBe(bad);
    expect(await listQuarantine(rig.store)).toEqual([copy?.key]);
    // 坏的存档本身没有被删除，也没有被覆盖
    expect(await rig.store.get(mainKey)).toBe(bad);
    // 好的备份没有被动过
    expect(await slotHashes(rig.store)).toEqual([null, hashes[1], hashes[0], null]);
  });

  it('同一份坏存档反复读档，只留一份副本，不会越存越多', async () => {
    const rig = await make();
    await threeGenerations(rig);
    await rig.store.set(slotKey('main'), (await readJson(rig.store, 'main')).slice(0, 5000));
    const first = await loadGame(rig.store, WALL + 1);
    const second = await loadGame(rig.store, WALL + 2);
    const third = await loadGame((await rig.reopen()), WALL + 3);
    expect(first.quarantined[0]?.created).toBe(true);
    expect(second.quarantined[0]?.created).toBe(false);
    expect(third.quarantined[0]?.created).toBe(false);
    expect(second.quarantined[0]?.key).toBe(first.quarantined[0]?.key);
    expect(await listQuarantine(rig.store)).toHaveLength(1);
  });

  it('不同的坏存档各留一份副本', async () => {
    const rig = await make();
    await threeGenerations(rig);
    const good = await readJson(rig.store, 'main');
    await rig.store.set(slotKey('main'), good.slice(0, 3000));
    await loadGame(rig.store, WALL + 1);
    await rig.store.set(slotKey('main'), good.slice(0, 4000));
    await loadGame(rig.store, WALL + 2);
    expect(await listQuarantine(rig.store)).toHaveLength(2);
  });

  it('回退之后再保存：坏的主存档不会被挪进备份，好的备份一代也不丢', async () => {
    const rig = await make();
    const { hashes } = await threeGenerations(rig);
    await rig.store.set(slotKey('main'), (await readJson(rig.store, 'main')).slice(0, 3000));
    const loaded = await loadGame(rig.store, WALL + 5000);
    expect(loaded.state).not.toBeNull();
    // 从备份一恢复，继续玩，再存
    const resumed = loaded.state as SimState;
    advance(resumed, 360);
    const outcome = await saveGame(rig.store, resumed, WALL + 6000);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 保存时主存档仍是坏的，副本已经有了，不重复写
    expect(outcome.quarantined).toHaveLength(1);
    expect(outcome.quarantined[0]?.created).toBe(false);
    expect(await listQuarantine(rig.store)).toHaveLength(1);
    // 新的主存档，原来的备份一和备份二原样保留，没有被坏的顶掉
    expect(await slotHashes(rig.store)).toEqual([hashState(resumed), hashes[1], hashes[0], null]);
  });

  it('保存时才发现主存档是坏的（中间没有读过档）：同样留副本，备份不动', async () => {
    const rig = await make();
    const { hashes, state } = await threeGenerations(rig);
    const bad = (await readJson(rig.store, 'main')).slice(0, 2000);
    await rig.store.set(slotKey('main'), bad);
    advance(state, 360);
    const outcome = await saveGame(rig.store, state, WALL + 9000);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.quarantined).toHaveLength(1);
    expect(outcome.quarantined[0]?.created).toBe(true);
    expect(await rig.store.get(outcome.quarantined[0]?.key ?? '')).toBe(bad);
    expect(await slotHashes(rig.store)).toEqual([hashState(state), hashes[1], hashes[0], null]);
  });

  it('主存档没有了（被删了），备份还在：用备份一，不算损坏，也不留副本', async () => {
    const rig = await make();
    const { hashes } = await threeGenerations(rig);
    await rig.store.remove(slotKey('main'));
    const loaded = await loadGame(rig.store, WALL);
    expect(loaded.status).toBe('restored');
    expect(loaded.source).toBe('backup1');
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[1]);
    expect(loaded.failures).toEqual([{ slot: 'main', kind: 'missing' }]);
    expect(loaded.damaged).toBe(false);
    expect(loaded.quarantined).toEqual([]);
  });

  it('主存档和备份一都坏了：继续往下试，用备份二，两份坏的都留副本', async () => {
    const rig = await make();
    const { hashes } = await threeGenerations(rig);
    await rig.store.set(slotKey('main'), 'garbage');
    await rig.store.set(slotKey('backup1'), (await readJson(rig.store, 'backup1')).slice(0, 100));
    const loaded = await loadGame(rig.store, WALL);
    expect(loaded.status).toBe('restored');
    expect(loaded.source).toBe('backup2');
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[0]);
    expect(loaded.failures.map((f) => `${f.slot}:${f.kind}`)).toEqual(['main:invalid', 'backup1:invalid']);
    expect(loaded.quarantined.map((q) => q.slot)).toEqual(['main', 'backup1']);
    expect(await listQuarantine(rig.store)).toHaveLength(2);
  });

  it('备份三也能用：前三份都坏了', async () => {
    const rig = await make();
    const state = runState(BUSY, 0);
    const hashes = await saveSeries(rig.store, state, 4);
    for (const slot of ['main', 'backup1', 'backup2'] as const) await rig.store.set(slotKey(slot), `broken ${slot}`);
    const loaded = await loadGame(rig.store, WALL);
    expect(loaded.source).toBe('backup3');
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[0]);
    expect(loaded.failures).toHaveLength(3);
  });

  it('四份都坏了：corrupt，没有状态，每一份都留了副本，原件都还在', async () => {
    const rig = await make();
    const state = runState(BUSY, 0);
    await saveSeries(rig.store, state, 4);
    for (const slot of SLOTS) await rig.store.set(slotKey(slot), `broken ${slot}`);
    const loaded = await loadGame(rig.store, WALL);
    expect(loaded.status).toBe('corrupt');
    expect(loaded.state).toBeNull();
    expect(loaded.source).toBeNull();
    expect(loaded.damaged).toBe(true);
    expect(loaded.failures.every((f) => f.kind === 'invalid')).toBe(true);
    expect(loaded.quarantined).toHaveLength(4);
    for (const slot of SLOTS) expect(await rig.store.get(slotKey(slot))).toBe(`broken ${slot}`);
    const copies = await Promise.all((await listQuarantine(rig.store)).map((key) => rig.store.get(key)));
    expect(copies.sort()).toEqual(SLOTS.map((slot) => `broken ${slot}`).sort());
  });

  it('保存之后马上读，主存档是好的，所以备份里的坏档不会被碰到', async () => {
    const rig = await make();
    const state = runState(BUSY, 0);
    await saveSeries(rig.store, state, 3);
    await rig.store.set(slotKey('backup2'), 'broken');
    const loaded = await loadGame(rig.store, WALL);
    expect(loaded.status).toBe('ok');
    expect(loaded.damaged).toBe(false);
    expect(await listQuarantine(rig.store)).toEqual([]);
  });
});

describe.each(RIGS)('关闭再打开：%s', (_name, make) => {
  it('连续保存 10 次，再模拟关闭和打开 10 次：没有丢档，没有坏档', async () => {
    const rig = await make();
    const state = runState(BUSY, 0);
    const hashes: string[] = [];
    const checkSlots = async (store: KeyValueStore, label: string): Promise<void> => {
      const k = hashes.length - 1;
      expect(await slotHashes(store), label).toEqual([0, 1, 2, 3].map((i) => hashes[k - i] ?? null));
    };

    for (let i = 0; i < 10; i++) {
      advance(state, 360 + i * 7);
      const outcome = await saveGame(rig.store, state, WALL + i * 1000);
      expect(outcome.ok && outcome.warnings).toEqual([]);
      hashes.push(hashState(state));
      await checkSlots(rig.store, `第 ${i + 1} 次保存`);
    }

    for (let round = 0; round < 10; round++) {
      const store = (await rig.reopen());
      const loaded = await loadGame(store, WALL + 100_000 + round);
      const label = `第 ${round + 1} 次打开`;
      expect(loaded.status, label).toBe('ok');
      expect(loaded.source, label).toBe('main');
      expect(loaded.failures, label).toEqual([]);
      expect(loaded.quarantined, label).toEqual([]);
      expect(loaded.state && hashState(loaded.state), label).toBe(hashes[hashes.length - 1]);
      // 玩一小段，关闭时再存一次
      const played = loaded.state as SimState;
      advance(played, 150 + round);
      const saved = await saveGame(store, played, WALL + 200_000 + round * 1000);
      expect(saved.ok && saved.warnings, label).toEqual([]);
      hashes.push(hashState(played));
      await checkSlots(store, `第 ${round + 1} 次关闭`);
    }

    expect(await listQuarantine(rig.store)).toEqual([]);
    // 最后四份都是好的，而且是最近的四代
    const finalHashes = await slotHashes(rig.store);
    expect(finalHashes.every((h) => h !== null)).toBe(true);
    expect(new Set(finalHashes).size).toBe(4);
  });
});

// ---- 写到一半出错：不丢存档 ----
describe('存储出错时不丢存档', () => {
  /** 备好三代存档，返回包着的存储和各代的哈希。 */
  async function setup(): Promise<{ faulty: FaultyStore; hashes: string[]; state: SimState }> {
    const inner = new MemoryStore();
    const faulty = new FaultyStore(inner);
    const state = runState(BUSY, 0);
    const hashes = await saveSeries(faulty, state, 4);
    return { faulty, hashes, state };
  }

  const MODES: FaultMode[] = ['throw', 'torn'];
  // 满的四份存档保存一次，要写 4 次：备份三、备份二、备份一、主存档
  const WRITES = ['备份三', '备份二', '备份一', '主存档'];

  it.each(MODES.flatMap((mode) => WRITES.map((what, at): [FaultMode, string, number] => [mode, what, at])))(
    '出错方式 %s，写%s时出错：读档仍然得到好的存档，下一次保存恢复正常',
    async (mode, _what, at) => {
      const { faulty, hashes, state } = await setup();
      advance(state, 360);
      const fresh = hashState(state);
      faulty.mutations = 0;
      faulty.failAt = at;
      faulty.mode = mode;
      const outcome = await saveGame(faulty, state, WALL + 99_000);
      faulty.failAt = null;

      const loaded = await loadGame(faulty, WALL + 100_000);
      expect(['ok', 'restored']).toContain(loaded.status);
      const got = loaded.state && hashState(loaded.state);
      if (at < 3) {
        // 挪备份时出错：照样写了新的主存档，只是备份少了一代
        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.warnings).toEqual(['rotation-failed']);
        expect(loaded.status).toBe('ok');
        expect(got).toBe(fresh);
      } else {
        // 写主存档时出错：这次保存失败，读到的是上一代
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.error).toBe('store');
        expect(got).toBe(hashes[3]);
        expect(loaded.status).toBe(mode === 'throw' ? 'ok' : 'restored');
        if (mode === 'torn') {
          expect(loaded.source).toBe('backup1');
          expect(loaded.damaged).toBe(true);
          expect(loaded.quarantined).toHaveLength(1);
        }
      }
      // 出错之后下一次保存正常，存储恢复到一致的状态
      advance(state, 360);
      const again = await saveGame(faulty, state, WALL + 101_000);
      expect(again.ok).toBe(true);
      const last = await loadGame(faulty, WALL + 102_000);
      expect(last.status).toBe('ok');
      expect(last.state && hashState(last.state)).toBe(hashState(state));
    },
  );

  it('没有故障的对照：满的四份存档保存一次，确实是 4 次写', async () => {
    const { faulty, state } = await setup();
    faulty.mutations = 0;
    advance(state, 360);
    await saveGame(faulty, state, WALL + 99_000);
    expect(faulty.mutations).toBe(WRITES.length);
  });

  it('坏的主存档没能留下副本（副本写不进去）：仍然写新的主存档，并给出警告', async () => {
    const inner = new MemoryStore();
    const faulty = new FaultyStore(inner);
    const state = runState(BUSY, 0);
    await saveSeries(faulty, state, 2);
    await inner.set(slotKey('main'), 'broken');
    faulty.mutations = 0;
    faulty.failAt = 0; // 第一次写是副本
    advance(state, 360);
    const outcome = await saveGame(faulty, state, WALL + 99_000);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.warnings).toContain('quarantine-failed');
    expect((await loadGame(faulty, WALL + 100_000)).status).toBe('ok');
  });

  it('读档时副本写不进去：照样读到好的备份，并给出警告', async () => {
    const inner = new MemoryStore();
    const faulty = new FaultyStore(inner);
    const state = runState(BUSY, 0);
    const hashes = await saveSeries(faulty, state, 2);
    await inner.set(slotKey('main'), 'broken');
    faulty.mutations = 0;
    faulty.failAt = 0;
    const loaded = await loadGame(faulty, WALL);
    expect(loaded.status).toBe('restored');
    expect(loaded.state && hashState(loaded.state)).toBe(hashes[0]);
    expect(loaded.warnings).toEqual(['quarantine-failed']);
    expect(loaded.quarantined).toEqual([]);
    expect(await inner.get(slotKey('main'))).toBe('broken');
  });
});

// ---- localStorage 的出错处理 ----
describe('LocalStorageStore 的出错处理', () => {
  it('空间不够：抛出 kind 为 quota 的 StoreError，原值不变', async () => {
    const fake = new FakeStorage(30);
    const store = new LocalStorageStore(fake);
    await store.set('a', 'x'.repeat(10));
    const error = await store.set('a', 'y'.repeat(100)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).kind).toBe('quota');
    expect(await store.get('a')).toBe('x'.repeat(10));
  });

  it('认得各浏览器的容量错误写法', async () => {
    const make = (name: string, code?: number): LocalStorageStore => {
      const storage = new FakeStorage();
      storage.setItem = () => {
        throw Object.assign(new Error('full'), { name, code });
      };
      return new LocalStorageStore(storage);
    };
    for (const store of [make('QuotaExceededError'), make('NS_ERROR_DOM_QUOTA_REACHED'), make('Error', 22), make('Error', 1014)]) {
      await expect(store.set('a', 'b')).rejects.toMatchObject({ kind: 'quota' });
    }
    await expect(make('SecurityError').set('a', 'b')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('读取出错（例如浏览器禁用了本地存储）：StoreError，读档返回 unavailable 而不是抛出', async () => {
    const storage = new FakeStorage();
    storage.getItem = () => {
      throw Object.assign(new Error('denied'), { name: 'SecurityError' });
    };
    const store = new LocalStorageStore(storage);
    await expect(store.get('a')).rejects.toBeInstanceOf(StoreError);
    const loaded = await loadGame(store, WALL);
    expect(loaded.status).toBe('unavailable');
    expect(loaded.state).toBeNull();
    expect(loaded.error).toContain('denied');
  });

  // 这两个用例要的是「存档比空间大」。压缩之后存档小得多，所以关掉压缩，按 JSON 原文的大小定空间
  it('主存档都放不下：保存失败，原因是 quota，已有的存档原样保留', async () => {
    const state = runState(BUSY, 600);
    const serialized = serializeSave(state, WALL);
    if (!serialized.ok) throw new Error('serialize');
    const fake = new FakeStorage(serialized.text.length - 100);
    const store = new LocalStorageStore(fake);
    const outcome = await saveGame(store, state, WALL, { compress: false });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('store');
      expect(outcome.storeKind).toBe('quota');
    }
    expect(await store.keys()).toEqual([]);
  });

  it('空间只够放两份：挪备份放不下，警告 rotation-failed，新的主存档照样写进去', async () => {
    const state = runState(BUSY, 600);
    const serialized = serializeSave(state, WALL);
    if (!serialized.ok) throw new Error('serialize');
    const size = serialized.text.length;
    const fake = new FakeStorage(2 * size + 200); // 两份加键名
    const store = new LocalStorageStore(fake);

    const first = await saveGame(store, state, WALL + 1, { compress: false });
    const second = await saveGame(store, state, WALL + 2, { compress: false }); // main 挪成 backup1，放得下
    const third = await saveGame(store, state, WALL + 3, { compress: false }); // backup1 要挪成 backup2，放不下
    expect(first.ok && first.warnings).toEqual([]);
    expect(second.ok && second.warnings).toEqual([]);
    expect(third.ok && third.warnings).toEqual(['rotation-failed']);
    const loaded = await loadGame(store, WALL + 4);
    expect(loaded.status).toBe('ok');
    expect(loaded.save?.savedAt).toBe(WALL + 3);
    expect(await store.keys()).toEqual([slotKey('backup1'), slotKey('main')].sort());
  });

  it('不压缩时写进去的存档是 JSON 原文，带的格式标识就是 SAVE_FORMAT', async () => {
    const fake = new FakeStorage();
    await saveGame(new LocalStorageStore(fake), runState(BUSY, 10), WALL, { compress: false });
    expect(fake.getItem(slotKey('main'))?.startsWith(`{"format":"${SAVE_FORMAT}"`)).toBe(true);
  });

  it('默认压缩：同样的空间，压缩之后四份存档都放得下，不压缩时放不下', async () => {
    const state = runState(BUSY, 600);
    const serialized = serializeSave(state, WALL);
    if (!serialized.ok) throw new Error('serialize');
    const packedSize = (await encodeSaveText(serialized.text)).length;
    expect(packedSize).toBeLessThan(serialized.text.length * 0.8);
    // 空间正好够四份压缩之后的存档，加上键名
    const quota = 4 * packedSize + 200;
    const compressed = new LocalStorageStore(new FakeStorage(quota));
    for (let i = 0; i < 4; i++) {
      const outcome = await saveGame(compressed, state, WALL + i);
      expect(outcome.ok && outcome.warnings).toEqual([]);
    }
    expect(await compressed.keys()).toEqual(SLOTS.map((slot) => slotKey(slot)).sort());
    const plain = new LocalStorageStore(new FakeStorage(quota));
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await saveGame(plain, state, WALL + i, { compress: false }));
    expect(results.some((outcome) => !outcome.ok || outcome.warnings.length > 0)).toBe(true);
  });
});

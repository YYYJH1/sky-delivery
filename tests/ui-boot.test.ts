// 打开页面：读档（没有存档、读到备份、全坏了）、同一个浏览器两个页面的运行权、调试参数。
import { describe, expect, it } from 'vitest';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { DAY_STEPS, DroneState, advance, hashState } from '../src/core/index.ts';
import { LocalStorageStore, MemoryStore, SLOTS, loadGame, quarantinePrefix, saveGame, slotKey } from '../src/save/index.ts';
import { boot, formatSavedAt, newCampaign, randomSeed } from '../src/ui/boot.ts';
import { DEBUG_NAMESPACE, applyDebug, fastForward, forceHolding, parseGameParams } from '../src/ui/debug-params.ts';
import { RUN_LOCK_NAME, acquireRunLock } from '../src/ui/lock.ts';
import type { LockManagerLike } from '../src/ui/lock.ts';
import { WALL, readJson } from './save-helpers.ts';

/** 走了一段的经营模式状态，里面有订单、余额和买过的东西。 */
function playedState(seed = 7) {
  const state = newCampaign(seed);
  fastForward(state, 120);
  return state;
}

describe('新开局', () => {
  it('经营模式，订单种子由调用方给，只有老街开通，一座站两架飞机', () => {
    const state = newCampaign(123);
    expect(state.config.mode).toBe('campaign');
    expect(state.config.seed).toBe(123);
    expect(state.stations).toHaveLength(1);
    expect(state.drones).toHaveLength(2);
    expect(state.campaign?.districts.map((d) => d.open)).toEqual([true, false, false]);
    expect(state.step).toBe(0);
  });

  it('同一个种子开出同样的局', () => {
    const a = newCampaign(9);
    const b = newCampaign(9);
    expect(hashState(a)).toBe(hashState(b));
  });

  it('随机种子是整数，落在 0 到 2^31 - 1 之间', () => {
    expect(randomSeed(() => 0)).toBe(0);
    expect(randomSeed(() => 0.5)).toBe(1_073_741_823);
    expect(randomSeed(() => 0.999999999)).toBeLessThan(2_147_483_647);
    expect(Number.isInteger(randomSeed(() => 0.123456789))).toBe(true);
  });
});

describe('打开页面时读档', () => {
  it('没有存档：开新的经营模式，没有提示，没存过', async () => {
    const result = await boot(new MemoryStore(), WALL, { seed: 5 });
    expect(result.status).toBe('empty');
    expect(result.notice).toBeNull();
    expect(result.savedStep).toBeNull();
    expect(result.state.config.seed).toBe(5);
    expect(result.state.step).toBe(0);
  });

  it('有存档：接着玩，状态和存的时候完全相同，记下已存过的步，没有提示', async () => {
    const store = new MemoryStore();
    const state = playedState();
    expect((await saveGame(store, state, WALL)).ok).toBe(true);
    const result = await boot(store, WALL + 1000, { seed: 999 });
    expect(result.status).toBe('ok');
    expect(result.notice).toBeNull();
    expect(result.savedStep).toBe(state.step);
    expect(hashState(result.state)).toBe(hashState(state));
    expect(result.state.config.seed).toBe(7);
  });

  it('主存档坏了：换成最新的备份，提示里带备份的保存时间，坏档留着不删', async () => {
    const store = new MemoryStore();
    const first = playedState();
    await saveGame(store, first, WALL);
    advance(first, 600);
    await saveGame(store, first, WALL + 60_000); // 第二次保存：第一份挪成备份一
    const mainKey = slotKey('main');
    const good = await readJson(store, 'main');
    await store.set(mainKey, good.replace('"money"', '"money":NaN,"x"'));

    const result = await boot(store, WALL + 120_000, { seed: 1 });
    expect(result.status).toBe('restored');
    expect(result.notice).toEqual({ kind: 'restored', savedAt: WALL });
    expect(result.savedStep).toBe(1200);
    expect(result.state.campaign).not.toBeNull();
    // 坏的主存档没有被删或覆盖，另存了一份副本
    expect(await store.get(mainKey)).not.toBeNull();
    expect((await store.keys(quarantinePrefix())).length).toBeGreaterThan(0);
  });

  it('四份存档全坏：开新游戏，给出提示，坏档不删', async () => {
    const store = new MemoryStore();
    for (const slot of SLOTS) await store.set(slotKey(slot), 'not a save');
    const result = await boot(store, WALL, { seed: 11 });
    expect(result.status).toBe('corrupt');
    expect(result.notice).toEqual({ kind: 'allBad' });
    expect(result.savedStep).toBeNull();
    expect(result.state.config.seed).toBe(11);
    expect(result.state.step).toBe(0);
    for (const slot of SLOTS) expect(await store.get(slotKey(slot))).toBe('not a save');
    expect((await store.keys(quarantinePrefix())).length).toBeGreaterThan(0);
  });

  it('把存档里的一个数值改成 NaN：回退到上一份备份', async () => {
    const store = new MemoryStore();
    const state = playedState();
    await saveGame(store, state, WALL);
    advance(state, 300);
    await saveGame(store, state, WALL + 1);
    const mainKey = slotKey('main');
    const text = await readJson(store, 'main');
    const broken = text.replace(/"money":[-\d.e]+/, '"money":NaN');
    expect(broken).not.toBe(text);
    await store.set(mainKey, broken);
    const result = await boot(store, WALL + 5, { seed: 1 });
    expect(result.status).toBe('restored');
    expect(result.savedStep).toBe(1200);
    expect(result.notice?.kind).toBe('restored');
  });

  it('存储用不了：开新游戏，不报错也不提示，之后保存失败时再提示', async () => {
    // 浏览器禁用了本地存储：读也会抛错
    const denied = (): never => {
      throw new Error('SecurityError: access is denied');
    };
    const store = new LocalStorageStore({ length: 0, key: () => null, getItem: denied, setItem: denied, removeItem: denied });
    const result = await boot(store, WALL, { seed: 3 });
    expect(result.status).toBe('unavailable');
    expect(result.notice).toBeNull();
    expect(result.savedStep).toBeNull();
    expect(result.state.step).toBe(0);
  });

  it('存档里是别的模式的状态：当作读不出来，开新游戏并提示', async () => {
    const store = new MemoryStore();
    const sandbox = playedState();
    sandbox.campaign = null;
    sandbox.config = { ...sandbox.config, mode: 'sandbox' };
    expect((await saveGame(store, sandbox, WALL)).ok).toBe(true);
    const result = await boot(store, WALL, { seed: 2 });
    expect(result.state.campaign).not.toBeNull();
    expect(result.notice).toEqual({ kind: 'allBad' });
  });

  it('调试开局用单独的存档位置，不读也不写正常的存档', async () => {
    const store = new MemoryStore();
    await saveGame(store, playedState(), WALL);
    const debug = await boot(store, WALL, { seed: 4, save: { namespace: DEBUG_NAMESPACE } });
    expect(debug.status).toBe('empty');
    await saveGame(store, newCampaign(4), WALL, { namespace: DEBUG_NAMESPACE });
    expect((await loadGame(store, WALL)).state?.config.seed).toBe(7);
    expect((await loadGame(store, WALL, { namespace: DEBUG_NAMESPACE })).state?.config.seed).toBe(4);
  });
});

describe('提示里的时间', () => {
  it('备份的保存时间写成本地时间 年-月-日 时:分，补零', () => {
    expect(formatSavedAt(new Date(2026, 10, 12, 21, 30).getTime())).toBe('2026-11-12 21:30');
    expect(formatSavedAt(new Date(2027, 0, 5, 7, 4).getTime())).toBe('2027-01-05 07:04');
  });

  it('填进词表的「存档已损坏，已恢复为 {时间} 的备份。」', () => {
    const text = fmt(STR.system.saveCorrupt, { savedAt: formatSavedAt(new Date(2026, 10, 12, 21, 30).getTime()) });
    expect(text).toBe(fmt(STR.system.saveCorrupt, { savedAt: '2026-11-12 21:30' }));
  });
});

describe('同一个浏览器开两个页面：运行权', () => {
  /** 一个假的锁管理器：同一个名字只有一个持有者，持有者的回调返回的承诺不结束就一直持有。 */
  function fakeLocks(): LockManagerLike & { held: Set<string>; requests: string[] } {
    const held = new Set<string>();
    const requests: string[] = [];
    return {
      held,
      requests,
      request(name, options, callback) {
        requests.push(name);
        expect(options).toEqual({ ifAvailable: true });
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve(callback({}));
      },
    };
  }

  it('第一个页面拿到，第二个页面没拿到', async () => {
    const locks = fakeLocks();
    expect(await acquireRunLock(locks)).toBe('granted');
    expect(await acquireRunLock(locks)).toBe('taken');
    expect(locks.requests).toEqual([RUN_LOCK_NAME, RUN_LOCK_NAME]);
  });

  it('拿到之后一直持有，不会因为回调结束而放掉', async () => {
    const locks = fakeLocks();
    expect(await acquireRunLock(locks)).toBe('granted');
    expect(locks.held.has(RUN_LOCK_NAME)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(await acquireRunLock(locks)).toBe('taken');
  });

  it('浏览器没有 Web Locks：没有办法限制，按不支持处理，页面照常运行', async () => {
    expect(await acquireRunLock(undefined)).toBe('unsupported');
  });

  it('申请时出错：按不支持处理，不让页面卡住', async () => {
    const throwing: LockManagerLike = {
      request() {
        throw new Error('SecurityError');
      },
    };
    const rejecting: LockManagerLike = { request: () => Promise.reject(new Error('NotSupportedError')) };
    expect(await acquireRunLock(throwing)).toBe('unsupported');
    expect(await acquireRunLock(rejecting)).toBe('unsupported');
  });

  it('提示文字取自词表', () => {
    expect(STR.system.otherPage).toBe('游戏已在其他页面打开。');
  });
});

/** 解锁、开通、星级、连续未达到的次数、已读便签、补飞机和画面状态这几个调试参数没给时的样子。 */
const NO_EXTRA = { unlock: [], open: [], stars: [], misses: [], readTips: false, drones: 0, look: null };

describe('调试参数', () => {
  it('不给参数：不是调试开局，没有错误', () => {
    expect(parseGameParams('')).toEqual({ seed: null, ff: 0, money: null, pause: false, ...NO_EXTRA, debug: false, errors: [] });
  });

  it('seed、ff、money、pause 都能读出来，给了前三个中的任何一个就是调试开局', () => {
    const p = parseGameParams('?seed=42&ff=100&money=500&pause=1');
    expect(p).toEqual({ seed: 42, ff: 100, money: 500, pause: true, ...NO_EXTRA, debug: true, errors: [] });
    expect(parseGameParams('?pause=1').debug).toBe(false);
    expect(parseGameParams('?ff=30').debug).toBe(true);
    expect(parseGameParams('?money=0')).toMatchObject({ money: 0, debug: true });
  });

  it('写错的参数按没给处理，并记下错误', () => {
    const p = parseGameParams('?seed=1.5&ff=abc&money=-3&x=1');
    expect(p).toMatchObject({ seed: null, ff: 0, money: null, debug: false });
    expect(p.errors).toHaveLength(4);
  });

  it('unlock 参数：all 是全部开放项（午晚两套策略除外），也可以逐个写名字；写错的名字整个参数不生效', () => {
    const all = parseGameParams('?unlock=all');
    expect(all.unlock).toContain('priceTags');
    expect(all.unlock).toContain('showCampus');
    expect(all.unlock).not.toContain('ruleSets');
    expect(all.debug).toBe(true);
    expect(parseGameParams('?unlock=priceTags,doubleBox').unlock).toEqual(['priceTags', 'doubleBox']);
    const bad = parseGameParams('?unlock=priceTags,nope');
    expect(bad.unlock).toEqual([]);
    expect(bad.errors).toHaveLength(1);
    expect(parseGameParams('?unlock=ruleSets').errors).toHaveLength(1);
  });

  it('open、stars、misses 是逗号隔开的整数，stars 在 1 到 5 之间，open 是片区编号', () => {
    const p = parseGameParams('?open=1,2&stars=3,2,1&misses=1,0,0&readtips=1');
    expect(p).toMatchObject({ open: [1, 2], stars: [3, 2, 1], misses: [1, 0, 0], readTips: true, debug: true, errors: [] });
    expect(parseGameParams('?stars=0').errors).toHaveLength(1);
    expect(parseGameParams('?stars=6').stars).toEqual([]);
    expect(parseGameParams('?open=3').open).toEqual([]);
    expect(parseGameParams('?open=1,,2').errors).toHaveLength(1);
    expect(parseGameParams('?misses=x').misses).toEqual([]);
  });

  it('只给 readtips 也是调试开局；readtips 不是 1 时不生效', () => {
    expect(parseGameParams('?readtips=1').debug).toBe(true);
    expect(parseGameParams('?readtips=0').debug).toBe(false);
  });

  it('applyDebug：先开通片区，再改星级，再打开开放项，再改日结次数，标已读，最后改余额', () => {
    const state = newCampaign(42);
    applyDebug(state, parseGameParams('?ff=100&open=1&stars=3,2&unlock=selectColumn,priceTags&misses=1&readtips=1&money=250'));
    const campaign = state.campaign!;
    expect(campaign.districts.map((d) => [d.open, d.star])).toEqual([[true, 3], [true, 2], [false, 1]]);
    expect(campaign.unlocks.selectColumn).toBeGreaterThanOrEqual(0);
    expect(campaign.unlocks.priceTags).toBeGreaterThanOrEqual(0);
    expect(campaign.unlocks.ruleSets).toBeGreaterThanOrEqual(0); // 开通写字楼区时分成午晚两套
    expect(campaign.ruleSets).not.toBeNull();
    expect(campaign.rating[0]!.misses).toBe(1);
    expect(campaign.tips.length).toBeGreaterThan(0);
    expect(campaign.tips.every((t) => t.read)).toBe(true);
    expect(campaign.money).toBe(250);
    // 开通之后写字楼区开张星级够的店
    expect(campaign.shopOpen.some((open, i) => open && state.world.merchants[i]!.district === 1)).toBe(true);
  });

  it('没带调试参数时 applyDebug 什么也不改', () => {
    const state = newCampaign(42);
    const before = hashState(state);
    applyDebug(state, parseGameParams(''));
    expect(hashState(state)).toBe(before);
  });

  it('快进到指定的秒，替玩家点完开局的五张订单，自动派单随后打开', () => {
    const state = newCampaign(42);
    fastForward(state, 100);
    expect(state.step).toBe(1000);
    const campaign = state.campaign!;
    expect(campaign.opening.orders).toHaveLength(5);
    expect(campaign.opening.done).toBe(true);
    expect(state.orders.slice(0, 5).every((o) => o.manualAt >= 0)).toBe(true);
    expect(state.orders.length).toBeGreaterThan(5); // 随机订单开始产生
  });

  it('快进是确定的：同一个种子，同样的参数，状态的哈希相同', () => {
    const a = newCampaign(42);
    const b = newCampaign(42);
    fastForward(a, 150);
    fastForward(b, 150);
    expect(hashState(a)).toBe(hashState(b));
  });

  it('已经走过的步不再快进，也不会倒退', () => {
    const state = newCampaign(42);
    fastForward(state, 30);
    const step = state.step;
    fastForward(state, 10);
    expect(state.step).toBe(step);
  });

  it('applyDebug：先快进，再改余额', () => {
    const state = newCampaign(42);
    applyDebug(state, parseGameParams('?ff=60&money=777'));
    expect(state.step).toBe(600);
    expect(state.campaign?.money).toBe(777);
  });

  it('调试开局的存档位置和正常的不同', () => {
    expect(DEBUG_NAMESPACE).not.toBe('sky-delivery.');
    expect(DAY_STEPS).toBe(3600);
  });
});

describe('调试用：让飞机回到站点上空等降落', () => {
  it('把站上停着的飞机改成排队等降落，起降口的队列里有它们，占用数少了对应的数', () => {
    const state = newCampaign(42);
    advance(state, 100);
    const station = state.stations[0]!;
    const occupied = station.occupied;
    expect(forceHolding(state, 2)).toBe(2);
    expect(state.drones.filter((d) => d.state === DroneState.LandQueue)).toHaveLength(2);
    expect(station.queue).toHaveLength(2);
    expect(station.occupied).toBe(occupied - 2);
    for (const d of state.drones) {
      expect(d.returning).toBe(true);
      expect(d.target).toBe(0);
      expect(d.queuedAt).toBeLessThan(state.step);
    }
  });

  it('停着的飞机不够时只改能改的，返回实际的架数；没有站时返回 0', () => {
    const state = newCampaign(42);
    expect(forceHolding(state, 9)).toBe(2);
    expect(forceHolding(state, 1)).toBe(0); // 已经没有停着的了
    const other = newCampaign(1);
    other.stations[0]!.removed = true;
    expect(forceHolding(other, 2)).toBe(0);
  });

  it('改过的状态是自洽的：能存档读档，接着走会一架一架降落回停机位，占用数回到原来的数', async () => {
    const state = newCampaign(42);
    advance(state, 100);
    forceHolding(state, 2);
    const store = new MemoryStore();
    expect((await saveGame(store, state, WALL)).ok).toBe(true);
    const loaded = await boot(store, WALL, { seed: 1 });
    expect(loaded.status).toBe('ok');
    expect(hashState(loaded.state)).toBe(hashState(state));
    advance(state, 200);
    expect(state.drones.every((d) => d.state === DroneState.Dock)).toBe(true);
    expect(state.stations[0]!.occupied).toBe(2);
    expect(state.stations[0]!.queue).toHaveLength(0);
  });
});

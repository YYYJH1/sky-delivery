// 关闭再打开窗口 10 次，没有丢档和坏档。把存档里的一个数值改成 NaN 后，回退到上一份备份并给出提示。
// 走打开页面的正式路径：openGameStore 选存储，boot 读档，createSession 运行和自动保存，关闭时保存。
// 三种存储各做一遍：内存存储，假的 localStorage，假的 IndexedDB。
// 另外：离开期间的进账在打开页面时结算，导入存档。
import { describe, expect, it } from 'vitest';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { awaySecondsSince, createSession } from '../src/app/index.ts';
import type { Session } from '../src/app/index.ts';
import { AWAY_CAP_SECONDS, DAY_STEPS, advance, hashState, step } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import {
  MemoryStore,
  SLOTS,
  encodeSaveCode,
  encodeSaveText,
  listQuarantine,
  loadGame,
  openGameStore,
  saveGame,
  slotKey,
} from '../src/save/index.ts';
import type { KeyValueStore } from '../src/save/index.ts';
import { boot, formatSavedAt, newCampaign, readImport } from '../src/ui/boot.ts';
import type { BootResult } from '../src/ui/boot.ts';
import { campaignOf } from './campaign-helpers.ts';
import { FakeIdbFactory } from './fake-idb.ts';
import { FakeStorage, WALL, campaignScript, hashOfSlot, readJson, readStored, richCampaign, slotHashes } from './save-helpers.ts';

// ---- 三种存储，关闭再打开 ----
interface Backend {
  /** 打开页面时拿到的存储。第一次是新的，之后每次都是「关闭再打开」：数据还在，存储对象是新的。 */
  open(): Promise<KeyValueStore>;
}

function memoryBackend(): Backend {
  let current = new MemoryStore();
  return {
    open() {
      // 数据还在，存储对象是新的
      current = new MemoryStore(current.snapshot());
      return Promise.resolve(current);
    },
  };
}

function localStorageBackend(): Backend {
  const storage = new FakeStorage();
  return {
    async open() {
      // 没有 IndexedDB 的浏览器：退回 localStorage
      const opened = await openGameStore({ indexedDb: undefined, storage, nowMs: WALL });
      expect(opened.kind).toBe('localstorage');
      return opened.store;
    },
  };
}

function indexedDbBackend(): Backend {
  const factory = new FakeIdbFactory();
  const storage = new FakeStorage();
  return {
    async open() {
      const opened = await openGameStore({ indexedDb: factory, storage, nowMs: WALL });
      expect(opened.kind).toBe('indexeddb');
      return opened.store;
    },
  };
}

const BACKENDS: [string, () => Backend][] = [
  ['内存存储', memoryBackend],
  ['localStorage', localStorageBackend],
  ['IndexedDB', indexedDbBackend],
];

/** 打开页面：读档，接上会话。返回读到的东西和会话。 */
async function openPage(store: KeyValueStore, wallMs: number, seed = 7): Promise<{ booted: BootResult; session: Session; game: SimState }> {
  const booted = await boot(store, wallMs, { seed });
  const game = booted.state;
  const session = createSession({
    store,
    savedStep: booted.savedStep,
    host: {
      state: () => game,
      advance(steps) {
        for (let i = 0; i < steps; i++) {
          campaignScript(game);
          step(game);
        }
      },
    },
  });
  if (booted.away !== null) session.noteChange();
  return { booted, session, game };
}

/** 玩一阵：1 倍速，每帧 50 毫秒，一直到状态走到第 untilStep 步。返回最后一帧的墙上时间。 */
function play(session: Session, game: SimState, untilStep: number, fromWall: number): number {
  let wall = fromWall;
  let now = 0;
  session.frame(now, wall);
  while (game.step < untilStep) {
    now += 50;
    wall += 50;
    session.frame(now, wall);
  }
  return wall;
}

describe.each(BACKENDS)('关闭再打开 10 次：%s', (_name, make) => {
  it('每次打开都读到上次关闭时的存档，没有丢档，没有坏档，备份是最近的四代', async () => {
    const backend = make();
    let wall = WALL;
    const closing: string[] = [];

    // 第一次打开：没有存档，开新的一局
    {
      const store = await backend.open();
      const { booted, session, game } = await openPage(store, wall);
      expect(booted.status).toBe('empty');
      expect(booted.notice).toBeNull();
      expect(booted.away).toBeNull();
      wall = play(session, game, 700, wall);
      session.close(wall);
      await session.flush();
      closing.push(hashState(game));
    }

    for (let round = 1; round <= 10; round++) {
      const store = await backend.open();
      const label = `第 ${round} 次重新打开`;
      // 重新打开发生在关闭的同一刻：离开了 0 秒，读到的状态和关闭时完全相同
      const { booted, session, game } = await openPage(store, wall);
      expect(booted.status, label).toBe('ok');
      expect(booted.notice, label).toBeNull();
      expect(booted.away, label).toBeNull();
      expect(booted.savedStep, label).toBe(game.step);
      expect(hashState(game), label).toBe(closing[closing.length - 1]);
      expect(await listQuarantine(store), label).toEqual([]);
      // 接着玩一阵再关闭
      wall = play(session, game, game.step + 400 + round * 37, wall);
      session.close(wall);
      await session.flush();
      closing.push(hashState(game));
    }

    // 最后：四份存档都是好的，各不相同（间隔保存和关闭时保存的最近四代），主存档是最后一次关闭时的，没有坏档的副本
    const store = await backend.open();
    const hashes = await slotHashes(store);
    expect(hashes.every((h) => h !== null)).toBe(true);
    expect(new Set(hashes).size).toBe(4);
    expect(hashes[0]).toBe(closing[closing.length - 1]);
    expect(await listQuarantine(store)).toEqual([]);
    const loaded = await loadGame(store, wall);
    expect(loaded.status).toBe('ok');
    expect(loaded.failures).toEqual([]);
  });

  it('把存档里的一个数值改成 NaN：回退到上一份备份，提示里带备份的保存时间，坏档不删', async () => {
    const backend = make();
    const store = await backend.open();
    // 三次保存，三代存档，保存时间各不相同
    const state = richCampaign(7, 500);
    const stamps: number[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      advance(state, 300);
      const savedAt = WALL + i * 60_000;
      expect((await saveGame(store, state, savedAt)).ok).toBe(true);
      stamps.push(savedAt);
      hashes.push(hashState(state));
    }
    // 现在：main 是第三代，backup1 是第二代
    const mainKey = slotKey('main');
    const good = await readJson(store, 'main');
    expect(good.includes('"money":')).toBe(true);
    const nan = good.replace(/"money":[-0-9.e]+/, '"money":NaN');
    expect(nan).not.toBe(good);
    await store.set(mainKey, nan); // 写成没压缩的，写法本身就读不出来

    const reopened = await backend.open();
    const result = await boot(reopened, WALL + 1_000_000, { seed: 1 });
    expect(result.status).toBe('restored');
    expect(result.notice).toEqual({ kind: 'restored', savedAt: stamps[1] });
    expect(result.savedStep).toBe(result.state.step);
    // 离开期间的进账从备份的保存时间算起，比 30 分钟短，所以这里只看状态：余额之外都是备份的
    const away = result.away;
    const restored = structuredClone(result.state);
    if (away !== null) {
      campaignOf(restored).money -= away.amount;
      campaignOf(restored).away = [];
    }
    expect(hashState(restored)).toBe(hashes[1]);
    // 提示文字：词表里的「存档读不出来，已换成 {时间} 的备份。」填上备份的保存时间
    const text = fmt(STR.system.saveCorrupt, { savedAt: formatSavedAt(stamps[1] as number) });
    expect(text).toMatch(/^存档读不出来，已换成 \d{4}-\d\d-\d\d \d\d:\d\d 的备份。$/);
    // 坏的存档原样留着，另存了一份带时间的副本
    expect(await reopened.get(mainKey)).toBe(nan);
    const copies = await listQuarantine(reopened);
    expect(copies).toHaveLength(1);
    expect(await reopened.get(copies[0] as string)).toBe(nan);
  });

  it('改的是压缩的存档（校验和对得上，里面的数值是 NaN）：同样回退到上一份备份', async () => {
    const backend = make();
    const store = await backend.open();
    const state = richCampaign(7, 500);
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      advance(state, 300);
      hashes.push(hashState(state));
      expect((await saveGame(store, state, WALL + i * 1000)).ok).toBe(true);
    }
    const good = await readJson(store, 'main');
    const nan = good.replace(/"money":[-0-9.e]+/, '"money":NaN');
    // 改完再压缩：压缩的写法本身完好，解开之后的 JSON 里有 NaN，读不出来
    await store.set(slotKey('main'), await encodeSaveText(nan));
    const reopened = await backend.open();
    const result = await boot(reopened, WALL + 1000 + 1, { seed: 1 }); // 离开 0.001 秒，没有进账
    expect(result.status).toBe('restored');
    expect(result.notice?.kind).toBe('restored');
    expect(hashState(result.state)).toBe(hashes[1]);
    expect(await listQuarantine(reopened)).toHaveLength(1);
  });

  it('回退之后接着玩、再保存：坏档不会被挪进备份，下一次打开是好的主存档', async () => {
    const backend = make();
    const store = await backend.open();
    const state = richCampaign(7, 500);
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      advance(state, 300);
      hashes.push(hashState(state));
      await saveGame(store, state, WALL + i * 1000);
    }
    await store.set(slotKey('main'), (await readStored(store, 'main')).slice(0, 5000));
    const reopened = await backend.open();
    const first = await boot(reopened, WALL + 1000, { seed: 1 }); // 备份一是 WALL + 1000 存的，离开 0 秒
    expect(first.status).toBe('restored');
    expect(first.away).toBeNull();
    const state2 = first.state;
    advance(state2, 300);
    expect((await saveGame(reopened, state2, WALL + 51_000)).ok).toBe(true);
    // 新的主存档，原来的备份一和备份二原样保留
    expect(await slotHashes(reopened)).toEqual([hashState(state2), hashes[1], hashes[0], null]);
    const second = await boot(await backend.open(), WALL + 51_000, { seed: 1 }); // 离开 0 秒
    expect(second.status).toBe('ok');
    expect(second.notice).toBeNull();
    expect(hashState(second.state)).toBe(hashState(state2));
  });

  it('四份都坏：开新的一局，给出提示，坏档一份不删', async () => {
    const backend = make();
    const store = await backend.open();
    for (const slot of SLOTS) await store.set(slotKey(slot), `broken ${slot}`);
    const result = await boot(await backend.open(), WALL, { seed: 5 });
    expect(result.status).toBe('corrupt');
    expect(result.notice).toEqual({ kind: 'allBad' });
    expect(result.state.step).toBe(0);
    for (const slot of SLOTS) expect(await (await backend.open()).get(slotKey(slot))).toBe(`broken ${slot}`);
  });
});

// ---- 离开期间的进账：打开页面时结算 ----
describe('打开页面时结算离开期间的进账', () => {
  /** 存档里有两个完整的游戏日，每天都有进账。 */
  async function savedGame(): Promise<{ store: MemoryStore; state: SimState; income: number }> {
    const state = richCampaign(7, 2000);
    for (let i = 0; i < 2 * DAY_STEPS + 500; i++) {
      campaignScript(state);
      step(state);
    }
    const c = campaignOf(state);
    const completed = Math.floor(state.step / DAY_STEPS);
    const income = (c.income[completed - 1] ?? 0) + (c.income[completed - 2] ?? 0);
    expect(income).toBeGreaterThan(100);
    const store = new MemoryStore();
    expect((await saveGame(store, state, WALL)).ok).toBe(true);
    return { store, state, income };
  }

  /** 离开结算的公式，直接写出来：每秒进账 × 秒数 × 30%，进账是最近两个完整游戏日的合计除以 720 秒。 */
  const expected = (income: number, seconds: number): number => Math.floor(((income / 720) * Math.min(seconds, AWAY_CAP_SECONDS) * 0.3) + 1e-9);

  it('离开 10 分钟：进账加进余额，记一条记录，状态的其余部分不变，提示用的金额是整数', async () => {
    const { store, state, income } = await savedGame();
    const moneyBefore = campaignOf(state).money;
    const booted = await boot(store, WALL + 600_000, { seed: 1 });
    expect(booted.status).toBe('ok');
    const amount = expected(income, 600);
    expect(amount).toBeGreaterThan(10);
    expect(booted.away).toEqual({ step: state.step, seconds: 600, amount });
    expect(Number.isInteger(booted.away?.amount)).toBe(true);
    expect(campaignOf(booted.state).money).toBe(moneyBefore + amount);
    expect(campaignOf(booted.state).away).toEqual([booted.away]);
    expect(booted.state.step).toBe(state.step);
    expect(booted.state.orders).toEqual(state.orders);
    // 词表里的「你不在的时候进账 ¥{金额}。」
    expect(fmt(STR.system.awayIncome, { amount: booted.away?.amount ?? 0 })).toBe(`你不在的时候进账 ¥${amount}。`);
    // 存档里的状态没有被改：结算只发生在读出来的状态上，要等保存才写回去
    expect(campaignOf((await loadGame(store, WALL)).state!).money).toBe(moneyBefore);
  });

  it('离开超过 30 分钟：超出的部分不计', async () => {
    const { store, income } = await savedGame();
    const booted = await boot(store, WALL + 5 * 3600_000, { seed: 1 });
    expect(booted.away?.amount).toBe(expected(income, AWAY_CAP_SECONDS));
    expect(booted.away?.seconds).toBe(5 * 3600);
  });

  it('系统时间被调回过去：不发放，不报错，状态和存档里的完全相同', async () => {
    const { store, state } = await savedGame();
    for (const wall of [WALL - 1, WALL - 3600_000, WALL - 86_400_000 * 400]) {
      const booted = await boot(store, wall, { seed: 1 });
      expect(booted.status).toBe('ok');
      expect(booted.away).toBeNull();
      expect(hashState(booted.state)).toBe(hashState(state));
    }
    // 现在的时间不是有限数字
    const odd = await boot(store, Number.NaN, { seed: 1 });
    expect(odd.away).toBeNull();
    expect(hashState(odd.state)).toBe(hashState(state));
  });

  it('零秒：不发放。第一个游戏日还没结束：也不发放，不论离开多久', async () => {
    const { store, state } = await savedGame();
    expect((await boot(store, WALL, { seed: 1 })).away).toBeNull();
    // 第一天还没结束的存档
    const young = newCampaign(7);
    advance(young, 1500);
    const youngStore = new MemoryStore();
    await saveGame(youngStore, young, WALL);
    const booted = await boot(youngStore, WALL + 3600_000, { seed: 1 });
    expect(booted.status).toBe('ok');
    expect(booted.away).toBeNull();
    expect(hashState(booted.state)).toBe(hashState(young));
    expect(state.step).toBeGreaterThan(2 * DAY_STEPS);
  });

  it('新开的局、存档读不出来的局：没有离开期间的进账', async () => {
    const empty = await boot(new MemoryStore(), WALL + 99_999_999, { seed: 3 });
    expect(empty.away).toBeNull();
    const bad = new MemoryStore();
    for (const slot of SLOTS) await bad.set(slotKey(slot), 'garbage');
    expect((await boot(bad, WALL + 99_999_999, { seed: 3 })).away).toBeNull();
  });

  it('读到的是备份：离开的时间从备份的保存时间算起', async () => {
    const { state, income } = await savedGame();
    const store = new MemoryStore();
    await saveGame(store, state, WALL); // 备份一的保存时间
    await saveGame(store, state, WALL + 120_000); // 主存档，比备份晚两分钟
    await store.set(slotKey('main'), 'broken');
    const booted = await boot(store, WALL + 600_000, { seed: 1 });
    expect(booted.status).toBe('restored');
    expect(booted.away?.seconds).toBe(600); // 从 WALL 算起，不是从主存档的 WALL + 120 秒
    expect(booted.away?.amount).toBe(expected(income, 600));
  });

  it('开关 10 次：每次的离开各结算一次，进账不重复算，记录一条一条累加', async () => {
    const { store: first, state, income } = await savedGame();
    let data = first.snapshot();
    let wall = WALL;
    let money = campaignOf(state).money;
    const gaps = [90, 200, 15, 600, 61, 1000, 5, 2400, 300, 45];
    const records: { seconds: number; amount: number }[] = [];
    for (const [i, gap] of gaps.entries()) {
      wall += gap * 1000;
      const store = new MemoryStore(data);
      const { booted, session, game } = await openPage(store, wall);
      const amount = expected(income, gap);
      if (amount >= 1) {
        expect(booted.away, `第 ${i + 1} 次`).toEqual({ step: game.step, seconds: gap, amount });
        money += amount;
        records.push({ seconds: gap, amount });
      } else {
        expect(booted.away, `第 ${i + 1} 次`).toBeNull();
      }
      expect(campaignOf(game).money, `第 ${i + 1} 次`).toBe(money);
      // 结算改了状态，关闭时保存，保存时间是关闭的这一刻，下一次从这里算起
      session.close(wall);
      await session.flush();
      data = store.snapshot();
    }
    expect(records.length).toBeGreaterThanOrEqual(8);
    const final = await loadGame(new MemoryStore(data), wall);
    expect(campaignOf(final.state!).away.map((r) => [r.seconds, r.amount])).toEqual(records.map((r) => [r.seconds, r.amount]));
    expect(campaignOf(final.state!).money).toBe(money);
  });

  it('读档时的结算也要写回存档：不保存就关掉再打开，会从原来的保存时间重新算，不会多发', async () => {
    const { store, income } = await savedGame();
    const a = await boot(store, WALL + 600_000, { seed: 1 });
    const b = await boot(store, WALL + 900_000, { seed: 1 }); // 没有保存，又打开了一次，这时离原来的存档已经 15 分钟
    expect(a.away?.amount).toBe(expected(income, 600));
    expect(b.away?.amount).toBe(expected(income, 900));
    // 发的是 15 分钟的钱，不是 10 分钟加 15 分钟
    expect(campaignOf(b.state).away).toHaveLength(1);
    expect(awaySecondsSince(WALL, WALL + 900_000)).toBe(900);
  });
});

// ---- 导入存档 ----
describe('导入存档', () => {
  it('现在导出的导出码能导入，状态和导出时相同', async () => {
    const state = richCampaign(7, 2000);
    advance(state, 1500);
    const code = await encodeSaveCode(state, WALL);
    if (!code.ok) throw new Error('export failed');
    const imported = await readImport(code.code);
    expect(imported.ok).toBe(true);
    expect(imported.ok && hashState(imported.state)).toBe(hashState(state));
    // 复制时被折了行、加了空格，也能导入
    expect((await readImport(`  ${code.code.replace(/(.{60})/g, '$1\n')}\n`)).ok).toBe(true);
  });

  it('改动之前的版本导出的导出码（里面是版本 1 的存档）也能导入', async () => {
    const { readFileSync } = await import('node:fs');
    const { gunzipSync } = await import('node:zlib');
    const text = gunzipSync(readFileSync(new URL('./fixtures/save-v1-campaign.json.gz', import.meta.url))).toString('utf8');
    const imported = await readImport(await encodeSaveText(text));
    expect(imported.ok).toBe(true);
    expect(imported.ok && imported.state.step).toBe(18_001);
    expect(imported.ok && campaignOf(imported.state).away).toEqual([]);
  });

  it('读不出来的和不是经营模式的：拒绝，说明原因，不碰存档', async () => {
    const store = new MemoryStore();
    const mine = richCampaign(7, 500);
    await saveGame(store, mine, WALL);
    const before = store.snapshot();
    const code = await encodeSaveCode(mine, WALL);
    if (!code.ok) throw new Error('export failed');
    const dot = code.code.indexOf('.');
    for (const bad of ['', 'hello', code.code.slice(0, 200), `${code.code.slice(0, dot + 30)}x${code.code.slice(dot + 31)}`, '{"format":"sky-delivery-save"}']) {
      const result = await readImport(bad);
      expect(result.ok, bad.slice(0, 20)).toBe(false);
      expect(!result.ok && result.reason, bad.slice(0, 20)).toBe('code');
    }
    // 沙盒模式的存档，导出码是对的，但玩不了
    const { runState, BUSY } = await import('./save-helpers.ts');
    const sandbox = await encodeSaveCode(runState(BUSY, 100), WALL);
    if (!sandbox.ok) throw new Error('export failed');
    const refused = await readImport(sandbox.code);
    expect(!refused.ok && refused.reason).toBe('mode');
    expect(store.snapshot()).toEqual(before);
  });

  it('导入之后装进存档：成为主存档，原来的主存档挪进备份一，保存时间取现在，所以导入一份很早以前导出的存档没有离开期间的进账', async () => {
    const store = new MemoryStore();
    const mine = richCampaign(7, 500);
    advance(mine, 400);
    await saveGame(store, mine, WALL);
    // 别人（或者很早以前的自己）导出的存档，里面有两个完整的游戏日
    const theirs = richCampaign(99, 2000);
    for (let i = 0; i < 2 * DAY_STEPS; i++) {
      campaignScript(theirs);
      step(theirs);
    }
    const code = await encodeSaveCode(theirs, WALL - 86_400_000); // 一天前导出的
    if (!code.ok) throw new Error('export failed');
    const imported = await readImport(code.code);
    if (!imported.ok) throw new Error('import failed');
    const now = WALL + 5000;
    expect((await saveGame(store, imported.state, now)).ok).toBe(true);
    expect(await hashOfSlot(store, 'main')).toBe(hashState(theirs));
    expect(await hashOfSlot(store, 'backup1')).toBe(hashState(mine));
    // 页面重新载入：读到导入的存档，离开 0 秒
    const booted = await boot(store, now, { seed: 1 });
    expect(booted.status).toBe('ok');
    expect(booted.away).toBeNull();
    expect(hashState(booted.state)).toBe(hashState(theirs));
  });
});

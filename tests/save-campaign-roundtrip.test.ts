// 经营模式下，任意时刻存档再读档，之后 600 步的状态哈希与不存档时相同。随机选 200 个时刻各测一次。
// 玩家的命令穿插在运行里（买飞机、建站、开通片区、换卡、退回、点订单、离开结算），参照的那一局和恢复出来的那一局做同样的操作。
// 存档走正式的路径：压缩之后写进存储，再读出来解压、校验。三种存储轮流用：内存，假的 localStorage，假的 IndexedDB。
// 另外每隔几个时刻改走导出码。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, DroneState, OrderStatus, createRng, createState, hashState, nextInt, settleAway, step, summaryStep } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { IndexedDbStore, LocalStorageStore, MemoryStore, decodeSaveCode, encodeSaveCode, loadGame, saveGame } from '../src/save/index.ts';
import type { KeyValueStore } from '../src/save/index.ts';
import { FakeIdbFactory } from './fake-idb.ts';
import { FakeStorage, WALL, campaignScript, richCampaign } from './save-helpers.ts';

/** 脚本之外再加一种玩家操作：隔一段时间离开一会儿再回来，结算离开期间的进账。 */
function playerTurn(state: SimState): void {
  campaignScript(state);
  if (state.step % 2000 === 1000) settleAway(state, 700 + (state.step % 13));
}

function stepWithScript(state: SimState): void {
  playerTurn(state);
  step(state);
}

interface Plan {
  /** 开局的状态。有的开局已经快进过一段，状态所在的步不是 0。 */
  start: () => SimState;
  /** 参照的那一局从开局的状态起一共走多少步。 */
  total: number;
  moments: number;
  /** 每个时刻读档之后再走多少步，逐步比较。 */
  horizon: number;
  seed: number;
  /** 每隔几个时刻，读档改走导出码。 */
  codeEvery: number;
  /** 一定要测的时刻（状态所在的绝对的步），和随机选的并在一起。早于开局状态的忽略。 */
  extra?: number[];
}

interface Report {
  moments: number[];
  stepsCompared: number;
  mismatches: string[];
  droneStates: Set<number>;
  orderStatuses: Set<number>;
  seen: {
    stations: number;
    drones: number;
    removedDrones: boolean;
    ruleSets: boolean;
    doubleBox: boolean;
    nearest: boolean;
    manual: boolean;
    awayRecords: number;
    dayRecords: number;
    peakRecords: number;
    openingNotDone: boolean;
    purchasedToday: boolean;
  };
  stores: Record<string, number>;
  maxStoredBytes: number;
  maxRawBytes: number;
}

/** 在 [0, limit] 里不重复地随机选 count 个整数，再加上 extra 里的，从小到大排好。 */
function pickMoments(count: number, limit: number, seed: number, extra: number[] = []): number[] {
  const rng = createRng(seed);
  const picked = new Set<number>(extra);
  while (picked.size < count + extra.length) picked.add(nextInt(rng, limit + 1));
  return [...picked].sort((a, b) => a - b);
}

/**
 * 三局对照：
 *   甲：不存档，逐步记下状态哈希。
 *   乙：同样的操作，但在选中的时刻存档再读档，每一步的哈希必须与甲相同（存档不改变状态）。
 *   丙：从每个时刻读回来的状态，用同样的操作再走 horizon 步，每一步的哈希必须与甲相同。
 */
async function verify(plan: Plan): Promise<Report> {
  const reference = plan.start();
  const begin = reference.step;
  const expected: string[] = [hashState(reference)];
  for (let i = 0; i < plan.total; i++) {
    stepWithScript(reference);
    expected.push(hashState(reference));
  }

  // 下面的 k 都是从开局状态起走了多少步，状态所在的步是 begin + k
  const extra = (plan.extra ?? []).map((at) => at - begin).filter((k) => k >= 0 && k <= plan.total - plan.horizon);
  const moments = pickMoments(plan.moments, plan.total - plan.horizon, plan.seed, extra);
  const wanted = new Set(moments);
  const report: Report = {
    moments,
    stepsCompared: 0,
    mismatches: [],
    droneStates: new Set(),
    orderStatuses: new Set(),
    seen: {
      stations: 0,
      drones: 0,
      removedDrones: false,
      ruleSets: false,
      doubleBox: false,
      nearest: false,
      manual: false,
      awayRecords: 0,
      dayRecords: 0,
      peakRecords: 0,
      openingNotDone: false,
      purchasedToday: false,
    },
    stores: { memory: 0, localStorage: 0, indexedDb: 0 },
    maxStoredBytes: 0,
    maxRawBytes: 0,
  };

  const memory = new MemoryStore();
  const local = new LocalStorageStore(new FakeStorage());
  const idb = await IndexedDbStore.open(new FakeIdbFactory());
  const rotation: [string, KeyValueStore][] = [
    ['memory', memory],
    ['localStorage', local],
    ['memory', memory],
    ['indexedDb', idb],
    ['localStorage', local],
  ];

  const live = plan.start();
  let seen = 0;
  for (let k = 0; k <= plan.total; k++) {
    if (live.step !== begin + k) throw new Error('the live state fell out of step');
    if (hashState(live) !== expected[k]) {
      report.mismatches.push(`saving changed the live run before step ${k}`);
      break;
    }
    if (wanted.has(k)) {
      seen += 1;
      const [storeName, store] = rotation[seen % rotation.length] as [string, KeyValueStore];
      report.stores[storeName] = (report.stores[storeName] ?? 0) + 1;
      const outcome = await saveGame(store, live, WALL + begin + k);
      if (!outcome.ok) throw new Error(`save failed at step ${k}: ${outcome.message}`);
      report.maxStoredBytes = Math.max(report.maxStoredBytes, outcome.bytes);
      report.maxRawBytes = Math.max(report.maxRawBytes, outcome.rawBytes);
      if (!outcome.packed) report.mismatches.push(`the save at step ${k} was not compressed`);
      const loaded = await loadGame(store, WALL + begin + k);
      if (loaded.status !== 'ok' || loaded.state === null) throw new Error(`load failed at step ${k}: ${loaded.status}`);
      let restored = loaded.state;
      if (seen % plan.codeEvery === 0) {
        const code = await encodeSaveCode(live, WALL + begin + k);
        if (!code.ok) throw new Error(`export failed at step ${k}`);
        const imported = await decodeSaveCode(code.code);
        if (!imported.ok) throw new Error(`import failed at step ${k}: ${imported.reason.message}`);
        restored = imported.state;
      }
      if (hashState(restored) !== expected[k]) report.mismatches.push(`hash differs right after loading at step ${k}`);
      if (JSON.stringify(restored) !== JSON.stringify(live)) report.mismatches.push(`state differs right after loading at step ${k}`);

      for (const d of live.drones) report.droneStates.add(d.state);
      for (const o of live.orders) report.orderStatuses.add(o.status);
      const c = live.campaign;
      if (c !== null) {
        const s = report.seen;
        s.stations = Math.max(s.stations, live.stations.filter((x) => !x.removed).length);
        s.drones = Math.max(s.drones, live.drones.filter((x) => !x.removed).length);
        s.removedDrones ||= live.drones.some((x) => x.removed);
        s.ruleSets ||= c.ruleSets !== null;
        s.doubleBox ||= live.capacity > 1;
        s.nearest ||= live.returnRule === 'nearest';
        s.manual ||= live.orders.some((o) => o.manualAt >= 0);
        s.awayRecords = Math.max(s.awayRecords, c.away.length);
        s.dayRecords = Math.max(s.dayRecords, c.days.length);
        s.peakRecords = Math.max(s.peakRecords, c.peaks.length);
        s.openingNotDone ||= !c.opening.done;
        s.purchasedToday ||= c.drones.some((p) => p.day === Math.floor(live.step / DAY_STEPS));
      }

      for (let j = 1; j <= plan.horizon; j++) {
        stepWithScript(restored);
        report.stepsCompared += 1;
        if (hashState(restored) !== expected[k + j]) {
          report.mismatches.push(`restored run from step ${k} diverges ${j} steps later`);
          break;
        }
      }
    }
    if (k < plan.total) stepWithScript(live);
  }
  expect(seen).toBe(moments.length);
  return report;
}

describe('经营模式的存档往返', () => {
  it('从中局开始运行两个游戏日，随机选 200 个时刻存档再读档，之后 600 步的状态哈希与不存档时逐步相同', { timeout: 300_000 }, async () => {
    const total = 2 * DAY_STEPS;
    const report = await verify({
      start: () => richCampaign(7, 16000),
      total,
      moments: 200,
      horizon: 600,
      seed: 20261113,
      codeEvery: 20,
      // 一定要测的时刻：开局，每场高峰小结的前后，日结的前后。这个开局是快进到第 1000 步的
      extra: [1000, 1001, summaryStep(0, 'noon') - 1, summaryStep(0, 'noon'), summaryStep(0, 'evening') - 1, summaryStep(0, 'evening'), DAY_STEPS - 1, DAY_STEPS, DAY_STEPS + 1, DAY_STEPS + 2],
    });
    expect(report.moments).toHaveLength(210);
    expect(new Set(report.moments).size).toBe(210);
    // 选出来的 200 个随机时刻之外，加上了 10 个固定的时刻，每个时刻都比较了 600 步
    expect(report.stepsCompared).toBe(210 * 600);
    expect(report.mismatches).toEqual([]);

    // 这些时刻覆盖了各种局面：飞机的九种状态、订单的四种状态都出现过（退单要运力不够才有，见下一个用例），三种存储都用到了
    expect([...report.droneStates].sort()).toEqual(Object.values(DroneState).sort());
    expect([...report.orderStatuses].sort()).toEqual([OrderStatus.Pending, OrderStatus.Assigned, OrderStatus.Picked, OrderStatus.Delivered].sort());
    expect(Object.values(report.stores).every((n) => n > 20)).toBe(true);
    // 状态里有经营模式的各种东西：多座站、很多飞机、退回过的飞机、两套策略、双层货箱、就近降落、日结和小结的记录、离开结算的记录
    expect(report.seen.stations).toBeGreaterThanOrEqual(3);
    expect(report.seen.drones).toBeGreaterThanOrEqual(20);
    expect(report.seen).toMatchObject({
      removedDrones: true,
      ruleSets: true,
      doubleBox: true,
      nearest: true,
      manual: true,
      purchasedToday: true,
    });
    expect(report.seen.awayRecords).toBeGreaterThanOrEqual(1);
    expect(report.seen.dayRecords).toBeGreaterThanOrEqual(1);
    expect(report.seen.peakRecords).toBeGreaterThanOrEqual(3);
    // 压缩真的起了作用，存下来的比 JSON 原文小
    expect(report.maxStoredBytes).toBeLessThan(report.maxRawBytes);
  });

  it('从真正的开局开始（价签没开放、开局的五张订单），运行 4500 步，随机选 40 个时刻，之后 600 步逐步相同', { timeout: 300_000 }, async () => {
    const report = await verify({
      start: () => createState({ mode: 'campaign', seed: 31 }),
      total: 4500,
      moments: 40,
      horizon: 600,
      seed: 99,
      codeEvery: 5,
      extra: [0, 2, 10, 11, 50, 51, 100],
    });
    expect(report.mismatches).toEqual([]);
    expect(report.stepsCompared).toBe(47 * 600);
    expect(report.seen.openingNotDone).toBe(true);
  });

  it('运力不够、退单很多（没有钱，写字楼区开通，订单远多于飞机）：24 个时刻，之后 400 步', { timeout: 300_000 }, async () => {
    const report = await verify({ start: () => richCampaign(21, 0), total: DAY_STEPS, moments: 24, horizon: 400, seed: 5, codeEvery: 6 });
    expect(report.mismatches).toEqual([]);
    expect(report.stepsCompared).toBe(24 * 400);
    // 订单的五种状态这里都出现过，包括退单
    expect([...report.orderStatuses].sort()).toEqual(Object.values(OrderStatus).sort());
  });

  it('另一个订单种子、另一笔钱：12 个时刻，之后 300 步', { timeout: 300_000 }, async () => {
    const report = await verify({ start: () => richCampaign(42, 3000), total: DAY_STEPS + 900, moments: 12, horizon: 300, seed: 7, codeEvery: 4 });
    expect(report.mismatches).toEqual([]);
    expect(report.stepsCompared).toBe(12 * 300);
  });
});

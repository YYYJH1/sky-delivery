// 存档往返：任意时刻存档再读档，之后的进程与不存档时逐步相同。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, DroneState, OrderStatus, createRng, createState, hashState, nextInt, step } from '../src/core/index.ts';
import type { ConfigOverrides, SimState } from '../src/core/index.ts';
import { MemoryStore, decodeSaveCode, encodeSaveCode, loadGame, saveGame, validateSaveData } from '../src/save/index.ts';
import type { SaveData } from '../src/save/index.ts';
import { CITY, OPENING } from './helpers.ts';
import { BUSY, WALL, applyScript } from './save-helpers.ts';

interface RoundTripPlan {
  config: ConfigOverrides;
  /** 参照的那一局一共走多少步。 */
  total: number;
  /** 随机选多少个存档时刻。 */
  moments: number;
  /** 每个时刻读档之后再走多少步，逐步比较。 */
  horizon: number;
  seed: number;
  /** 每隔几个时刻，读档改走导出码。 */
  codeEvery: number;
}

interface RoundTripReport {
  moments: number[];
  stepsCompared: number;
  mismatches: string[];
  droneStates: Set<number>;
  orderStatuses: Set<number>;
  /** 在存档的那些时刻里，状态里出现过的各种情形。 */
  seen: { manual: boolean; shared: boolean; early: boolean; multiStop: boolean; queued: boolean; ruleChanges: number };
  maxBytes: number;
}

/** 在 [0, limit] 里不重复地随机选 count 个整数，从小到大排好。 */
function pickMoments(count: number, limit: number, seed: number): number[] {
  const rng = createRng(seed);
  const picked = new Set<number>();
  while (picked.size < count) picked.add(nextInt(rng, limit + 1));
  return [...picked].sort((a, b) => a - b);
}

function stepWithScript(state: SimState): void {
  applyScript(state);
  step(state);
}

/**
 * 三局对照：
 *   甲：不存档，逐步记下状态哈希。
 *   乙：同样的操作，但在选中的时刻存档再读档，每一步的哈希必须与甲相同（存档不改变状态）。
 *   丙：从每个时刻读回来的状态，用同样的操作再走 horizon 步，每一步的哈希必须与甲相同。
 */
async function verifyRoundTrips(plan: RoundTripPlan): Promise<RoundTripReport> {
  const reference = createState(plan.config);
  const expected: string[] = [hashState(reference)];
  for (let i = 0; i < plan.total; i++) {
    stepWithScript(reference);
    expected.push(hashState(reference));
  }

  const moments = pickMoments(plan.moments, plan.total - plan.horizon, plan.seed);
  const wanted = new Set(moments);
  const report: RoundTripReport = {
    moments,
    stepsCompared: 0,
    mismatches: [],
    droneStates: new Set(),
    orderStatuses: new Set(),
    seen: { manual: false, shared: false, early: false, multiStop: false, queued: false, ruleChanges: 0 },
    maxBytes: 0,
  };

  const live = createState(plan.config);
  const store = new MemoryStore();
  let seen = 0;
  for (let k = 0; k <= plan.total; k++) {
    if (live.step !== k) throw new Error('the live state fell out of step');
    if (hashState(live) !== expected[k]) {
      report.mismatches.push(`saving changed the live run before step ${k}`);
      break;
    }
    if (wanted.has(k)) {
      seen += 1;
      const outcome = await saveGame(store, live, WALL + k);
      if (!outcome.ok) throw new Error(`save failed at step ${k}: ${outcome.message}`);
      report.maxBytes = Math.max(report.maxBytes, outcome.bytes);
      const loaded = await loadGame(store, WALL + k);
      if (loaded.status !== 'ok' || loaded.state === null) throw new Error(`load failed at step ${k}: ${loaded.status}`);
      let restored = loaded.state;
      if (seen % plan.codeEvery === 0) {
        const code = await encodeSaveCode(live, WALL + k);
        if (!code.ok) throw new Error(`export failed at step ${k}`);
        const imported = await decodeSaveCode(code.code);
        if (!imported.ok) throw new Error(`import failed at step ${k}: ${imported.reason.message}`);
        restored = imported.state;
      }
      // 读回来的状态与存档那一刻完全相同
      if (hashState(restored) !== expected[k]) report.mismatches.push(`hash differs right after loading at step ${k}`);
      if (JSON.stringify(restored) !== JSON.stringify(live)) report.mismatches.push(`state differs right after loading at step ${k}`);
      for (const d of live.drones) report.droneStates.add(d.state);
      for (const o of live.orders) report.orderStatuses.add(o.status);
      report.seen.manual ||= live.orders.some((o) => o.manualAt >= 0);
      report.seen.shared ||= live.orders.some((o) => o.shared);
      report.seen.early ||= live.stats.early.length > 0 && live.orders.some((o) => o.early);
      report.seen.multiStop ||= live.drones.some((d) => d.route.length >= 4);
      report.seen.queued ||= live.stations.some((s) => s.queue.length > 0);
      report.seen.ruleChanges = Math.max(report.seen.ruleChanges, live.stats.ruleChanges.length);
      // 之后 horizon 步，每一步都与不存档时相同
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
  expect(seen).toBe(plan.moments);
  return report;
}

const OTHER: [string, ConfigOverrides][] = [
  ['老街开局', OPENING],
  ['老街四架飞机，顺路合并，载量 2', { ...OPENING, drones: 4, peakRate: 24, capacity: 2, rules: { pool: 'any' } }],
  ['三片区，三座站', { ...CITY, layout: 'three', capacity: 3 }],
  ['三片区，两座站向外移，载量 3', { ...CITY, layout: 'edge', peakRate: 82, capacity: 3 }],
  ['三片区，一座大站，起降间隔 0.4 秒', { ...CITY, layout: 'single', gateInterval: 0.4, capacity: 2 }],
  ['写字楼区只有两家店', { scenario: 'sparseOffice', drones: 12, peakRate: 60, gateInterval: 0.8, capacity: 2 }],
];

describe('存档往返', () => {
  it('沙盒模式运行 4500 步（一天多），随机选 200 个时刻存档再读档，之后 600 步的状态哈希与不存档时逐步相同', { timeout: 120_000 }, async () => {
    const report = await verifyRoundTrips({
      config: BUSY,
      total: 4500,
      moments: 200,
      horizon: 600,
      seed: 20261112,
      codeEvery: 20,
    });
    expect(report.moments).toHaveLength(200);
    expect(new Set(report.moments).size).toBe(200);
    expect(report.stepsCompared).toBe(200 * 600);
    expect(report.mismatches).toEqual([]);

    // 这 200 个时刻覆盖了各种局面：飞机的九种状态、订单的五种结局都出现过
    expect([...report.droneStates].sort()).toEqual(Object.values(DroneState).sort());
    expect([...report.orderStatuses].sort()).toEqual(Object.values(OrderStatus).sort());
    // 中途换过策略卡、点击过订单插队，状态里这些字段都有值：换卡记录、插队、同乘、提前派出、多个停靠点、起降口排队
    expect(report.seen).toEqual({ manual: true, shared: true, early: true, multiStop: true, queued: true, ruleChanges: report.seen.ruleChanges });
    expect(report.seen.ruleChanges).toBeGreaterThanOrEqual(8);
  });

  it.each(OTHER)('别的配置也一样：%s，12 个时刻，之后 300 步', { timeout: 60_000 }, async (_name, config) => {
    const report = await verifyRoundTrips({ config, total: DAY_STEPS, moments: 12, horizon: 300, seed: 99, codeEvery: 4 });
    expect(report.mismatches).toEqual([]);
    expect(report.stepsCompared).toBe(12 * 300);
  });

  it('特殊的时刻：开局的第 0 步，和第一天结束的那一步', async () => {
    for (const k of [0, 1, DAY_STEPS - 1, DAY_STEPS, DAY_STEPS + 1]) {
      const live = createState(BUSY);
      for (let i = 0; i < k; i++) stepWithScript(live);
      const store = new MemoryStore();
      expect((await saveGame(store, live, WALL)).ok).toBe(true);
      const loaded = await loadGame(store, WALL);
      expect(loaded.state).toEqual(live);
      const restored = loaded.state as SimState;
      for (let j = 0; j < 300; j++) {
        stepWithScript(live);
        stepWithScript(restored);
      }
      expect(hashState(restored)).toBe(hashState(live));
    }
  });
});

describe('状态里没有非有限的数字', () => {
  // 存档校验里放行表是空的，依据就在这里：各种配置、各种局面下，状态的每一个数字都是有限的
  const CONFIGS: [string, ConfigOverrides][] = [['忙碌的三片区', BUSY], ...OTHER];

  it.each(CONFIGS)('%s：运行 3 个游戏日，每隔一段扫描一次，没有 NaN 和无穷', (_name, config) => {
    const state = createState(config);
    for (let i = 0; i < 3 * DAY_STEPS; i++) {
      stepWithScript(state);
      if (i % 400 === 0 || i === 3 * DAY_STEPS - 1) {
        const save = { format: 'x', version: 1, contentVersion: 'x', savedAt: 0, state } as unknown as SaveData;
        const nonFinite = validateSaveData(save).filter((issue) => issue.kind === 'non-finite');
        expect(nonFinite, `第 ${i} 步`).toEqual([]);
      }
    }
  });
});

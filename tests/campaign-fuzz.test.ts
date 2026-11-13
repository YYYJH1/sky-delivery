// 经营模式的随机命令：把有效的和无效的命令随机插进运行里，每隔一小段检查不变量，并检查同样的命令序列得到同样的结果。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { DAY_STEPS, DroneState, OrderStatus, TIP_IDS, applyCommand, createRng, fleetOf, hashState, nextInt, ruleSetInForce, step } from '../src/core/index.ts';
import type { Command, PeakName, SimState } from '../src/core/index.ts';
import { campaignOf, campaignState, clickOpening, unlockAll } from './campaign-helpers.ts';

function randomCommand(rng: ReturnType<typeof createRng>, state: SimState): Command {
  const pick = <T>(items: readonly T[]): T => items[nextInt(rng, items.length)] as T;
  const station = (): number => nextInt(rng, state.stations.length + 1) - (nextInt(rng, 6) === 0 ? 1 : 0); // 偶尔给一个不存在的编号
  const drone = (): number => nextInt(rng, state.drones.length + 1);
  switch (nextInt(rng, 14)) {
    case 0:
      return { type: 'buildStation', roof: nextInt(rng, MAP_V1.roofs.length) };
    case 1:
    case 2:
      return { type: 'buyDrone', station: station() };
    case 3:
    case 4:
      return { type: 'buyBay', station: station() };
    case 5:
      return { type: 'upgradeGate', station: station() };
    case 6:
      return pick<Command>([{ type: 'buyDoubleBox' }, { type: 'buyNearestLanding' }]);
    case 7:
      return { type: 'openDistrict', district: nextInt(rng, 3) };
    case 8:
      return { type: 'refundDrone', drone: drone() };
    case 9:
      return { type: 'refundBay', station: station() };
    case 10:
      return { type: 'refundStation', station: station() };
    case 12:
      // 单独换一栏，常常指定改午高峰还是晚高峰的一套（还没分成两套时会失败）
      return {
        type: 'setRules',
        rules: pick([{ select: pick(['fifo', 'deadline', 'roundtrip', 'prioCampus']) }, { zone: pick(['global', 'hybrid', 'strict']) }, { pool: pick(['single', 'same', 'any']) }]),
        peak: pick<PeakName | undefined>([undefined, 'noon', 'evening']),
      };
    case 13:
      return { type: 'readTip', tip: pick(TIP_IDS) };
    default:
      return pick<Command>([
        { type: 'setRules', rules: { select: pick(['fifo', 'deadline', 'roundtrip', 'prioOffice']), zone: pick(['global', 'hybrid', 'strict']), pool: pick(['single', 'any', 'same']) } },
        { type: 'prioritizeOrder', order: nextInt(rng, Math.max(1, state.orders.length)) },
      ]);
  }
}

/** 检查不变量，返回违反的条目。 */
function violations(state: SimState): string[] {
  const bad: string[] = [];
  const campaign = campaignOf(state);
  if (!(campaign.money >= 0)) bad.push(`money ${campaign.money}`);
  if (campaign.stations.length !== state.stations.length) bad.push('campaign.stations length');
  if (campaign.drones.length !== state.drones.length) bad.push('campaign.drones length');
  if (state.capacity < 1) bad.push('capacity');
  const live = state.stations.filter((s) => !s.removed);
  if (live.length < 1 || live.length > ECONOMY_V1.maxStations) bad.push(`station count ${live.length}`);
  const roofs = new Set<number>();
  for (const s of state.stations) {
    const info = campaign.stations[s.id];
    if (info === undefined) {
      bad.push(`station ${s.id} has no campaign record`);
      continue;
    }
    if (s.removed) {
      if (s.bays !== 0 || s.occupied !== 0 || s.queue.length !== 0) bad.push(`removed station ${s.id} is not empty`);
      if (campaign.roofStation[info.roof] === s.id) bad.push(`removed station ${s.id} still owns roof ${info.roof}`);
      continue;
    }
    if (roofs.has(info.roof)) bad.push(`roof ${info.roof} used twice`);
    roofs.add(info.roof);
    if (campaign.roofStation[info.roof] !== s.id) bad.push(`roof ${info.roof} does not point to station ${s.id}`);
    const roof = MAP_V1.roofs[info.roof] as { size: 'small' | 'medium' | 'large' };
    if (s.bays < ECONOMY_V1.baysAtBuild || s.bays > ECONOMY_V1.bayCap[roof.size]) bad.push(`station ${s.id} has ${s.bays} bays`);
    // 占用数等于停在机位上、排队起飞、起飞中、降落中的飞机数
    const holding = state.drones.filter(
      (d) =>
        !d.removed &&
        d.station === s.id &&
        (d.state === DroneState.Dock || d.state === DroneState.TakeoffQueue || d.state === DroneState.Takeoff || d.state === DroneState.Land),
    ).length;
    if (s.occupied !== holding) bad.push(`station ${s.id} occupied ${s.occupied} but ${holding} drones hold a bay`);
    if (s.occupied > s.bays) bad.push(`station ${s.id} occupied ${s.occupied} > bays ${s.bays}`);
    if (state.returnRule === 'home' && fleetOf(state, s.id) > s.bays) bad.push(`station ${s.id} has more drones than bays`);
    if (info.gateLevel < 1 || info.gateLevel > 3) bad.push(`station ${s.id} gate level ${info.gateLevel}`);
    const interval = Math.round((ECONOMY_V1.gateSeconds[info.gateLevel - 1] as number) * 10);
    if (s.gateInterval !== interval) bad.push(`station ${s.id} gate interval ${s.gateInterval}`);
  }
  for (const d of state.drones) {
    if (!d.removed) continue;
    if (d.station !== -1 || d.route.length > 0 || d.state !== DroneState.Dock) bad.push(`removed drone ${d.id} is not parked out`);
    if (state.stations.some((s) => s.queue.includes(d.id))) bad.push(`removed drone ${d.id} is in a queue`);
  }
  for (const d of state.drones) {
    if (d.removed) continue;
    if (d.home < 0 || (state.stations[d.home] as { removed: boolean }).removed) bad.push(`drone ${d.id} belongs to a removed station`);
    if (d.target >= 0 && (state.stations[d.target] as { removed: boolean }).removed) bad.push(`drone ${d.id} flies to a removed station`);
  }
  for (const id of state.pending) {
    const order = state.orders[id];
    if (order === undefined || order.status !== OrderStatus.Pending) bad.push(`pending order ${id}`);
    else if ((state.stations[order.home] as { removed: boolean }).removed) bad.push(`pending order ${id} belongs to a removed station`);
  }
  // 规矩、开放项、便签、日结记录和送达计数的不变量
  if (campaign.ruleSets !== null) {
    const inForce = campaign.ruleSets[ruleSetInForce(state)];
    if (JSON.stringify(inForce) !== JSON.stringify(state.rules)) bad.push(`state.rules ${JSON.stringify(state.rules)} is not the set in force ${JSON.stringify(inForce)}`);
  }
  for (const [key, at] of Object.entries(campaign.unlocks)) {
    if (!Number.isInteger(at) || at < -1 || at > state.step) bad.push(`unlock ${key} at ${at}`);
  }
  if (new Set(campaign.tips.map((t) => t.id)).size !== campaign.tips.length) bad.push('a tip appears twice');
  campaign.days.forEach((d, i) => {
    if (d.day !== i) bad.push(`day record ${i} says day ${d.day}`);
  });
  if (campaign.delivered !== state.orders.filter((o) => o.status === OrderStatus.Delivered).length) bad.push('delivered counter');
  const nonFinite: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) nonFinite.push(path);
    } else if (value === undefined) {
      nonFinite.push(`${path} is undefined`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    }
  };
  walk(campaign, 'campaign');
  if (nonFinite.length > 0) bad.push(`not JSON safe: ${nonFinite.slice(0, 3).join(', ')}`);
  return bad;
}

function run(seed: number, steps: number, open = false): { state: SimState; hashes: string[]; succeeded: Record<string, number> } {
  const state = campaignState({ seed });
  if (open) unlockAll(state); // 各项开放全部打开，随机命令从一开始就能成功
  const rng = createRng(seed + 777);
  const hashes: string[] = [];
  const succeeded: Record<string, number> = {};
  for (let i = 0; i < steps; i++) {
    clickOpening(state);
    // 每隔几步给点钱，让购买有机会成功
    if (i % 400 === 0) campaignOf(state).money += 300;
    if (nextInt(rng, 25) === 0) {
      const command = randomCommand(rng, state);
      const result = applyCommand(state, command);
      if (result.ok) succeeded[command.type] = (succeeded[command.type] ?? 0) + 1;
    }
    step(state);
    if (i % 50 === 0) {
      const bad = violations(state);
      if (bad.length > 0) throw new Error(`step ${state.step}: ${bad.slice(0, 5).join('; ')}`);
    }
    if (i % 10 === 0) hashes.push(hashState(state));
  }
  return { state, hashes, succeeded };
}

describe('经营模式：随机命令', () => {
  it.each([1, 2, 3, 4])('种子 %i：随机的有效和无效命令穿插在运行里，不变量始终成立，余额等于进账减购买加退回', (seed) => {
    const { state, succeeded } = run(seed, 3 * DAY_STEPS);
    expect(violations(state)).toEqual([]);
    const campaign = campaignOf(state);
    const earned = state.orders.filter((o) => o.status === OrderStatus.Delivered).reduce((sum, o) => sum + o.rev, 0);
    expect(campaign.money).toBeCloseTo(earned + 300 * Math.ceil((3 * DAY_STEPS) / 400) - campaign.spent + campaign.refunded, 6);
    // 各种命令确实有成功的，随机序列不是空转
    expect(Object.keys(succeeded).length).toBeGreaterThanOrEqual(6);
    expect(campaign.spent).toBeGreaterThan(300);
  });

  it('同样的种子和命令序列，每一步的状态哈希相同', () => {
    const a = run(5, 2 * DAY_STEPS);
    const b = run(5, 2 * DAY_STEPS);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.succeeded).toEqual(b.succeeded);
  });

  it('命令序列经过存档式的复制（JSON 往返）之后继续运行，结果不变', () => {
    const state = run(6, DAY_STEPS).state;
    const restored = JSON.parse(JSON.stringify(state)) as SimState;
    expect(restored).toEqual(state);
    for (let i = 0; i < 1200; i++) {
      step(state);
      step(restored);
    }
    expect(hashState(restored)).toBe(hashState(state));
  });
});

describe('经营模式：各项开放全部打开时的随机命令', () => {
  it.each([11, 12, 13])('种子 %i：四个游戏日里随机的命令穿插在运行里，包括指定改哪一套规矩、标记便签，不变量始终成立', (seed) => {
    const { state, succeeded } = run(seed, 4 * DAY_STEPS, true);
    expect(violations(state)).toEqual([]);
    // 各种新命令确实成功过：改规矩（含指定一套）、标记便签
    expect(succeeded.setRules ?? 0).toBeGreaterThan(5);
    expect(succeeded.readTip ?? 0).toBeGreaterThan(0);
    expect(Object.keys(succeeded).length).toBeGreaterThanOrEqual(7);
  });

  it('同样的种子和命令序列，每一步的状态哈希相同', () => {
    const a = run(14, 3 * DAY_STEPS, true);
    const b = run(14, 3 * DAY_STEPS, true);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.succeeded).toEqual(b.succeeded);
  });
});

// 经营模式的随机命令：把有效的和无效的命令随机插进运行里，每隔一小段检查不变量，并检查同样的命令序列得到同样的结果。
// 每个命令先问价再执行，两者的结论必须一致。机队的两条不变量每一步都查：无人机总数不超过停机位总数，没有无人机在上空连续等降落超过 600 步。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { FORECAST_V1 } from '../src/content/forecast_v1.ts';
import { DAY_STEPS, DroneState, OrderStatus, TIP_IDS, applyCommand, createRng, fleetOf, hashState, nextInt, quoteCommand, ruleSetInForce, step } from '../src/core/index.ts';
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
    // 从没买过就近降落时飞机的归属站不变，飞机数不会超过停机位数。买过之后归属站跟着降落的站走：一座站自己的飞机在外面时，
    // 别的站的飞机落进了它的停机位，它归属的飞机就可以多于停机位，所以买过之后不查这一条。关掉开关之后这些飞机回来，
    // 归属站没有空位就改落有空位的站，数目随后回到不超过停机位，这一点由 campaign-landing.test.ts 的局面检查
    if (!campaign.nearestOwned && fleetOf(state, s.id) > s.bays) bad.push(`station ${s.id} has more drones than bays`);
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
    // 停在站里的飞机（停着、排队起飞、起飞中）归属这座站：落在哪座站，归属站就改成哪座。
    // 关掉就近降落时已经飞往别的站的飞机也一样，以前它落下之后归属站还是原来的站，停在这座站里却算在原来的站名下
    const parked = d.state === DroneState.Dock || d.state === DroneState.TakeoffQueue || d.state === DroneState.Takeoff;
    if (parked && d.station >= 0 && d.home !== d.station) bad.push(`drone ${d.id} is parked at station ${d.station} but belongs to station ${d.home}`);
    // 从没买过就近降落时飞机只飞回自己的站：归属站没有空位才改落别的站的分支不会触发
    if (!campaign.nearestOwned && d.returning && d.target !== d.home) bad.push(`drone ${d.id} returns to station ${d.target} but belongs to station ${d.home}`);
  }
  for (const id of state.pending) {
    const order = state.orders[id];
    if (order === undefined || order.status !== OrderStatus.Pending) bad.push(`pending order ${id}`);
    else if ((state.stations[order.home] as { removed: boolean }).removed) bad.push(`pending order ${id} belongs to a removed station`);
  }
  // 策略、开放项、便签、日结记录和送达计数的不变量
  if (campaign.ruleSets !== null) {
    const inForce = campaign.ruleSets[ruleSetInForce(state)];
    if (JSON.stringify(inForce) !== JSON.stringify(state.rules)) bad.push(`state.rules ${JSON.stringify(state.rules)} is not the set in force ${JSON.stringify(inForce)}`);
  }
  for (const [key, at] of Object.entries(campaign.unlocks)) {
    if (!Number.isInteger(at) || at < -1 || at > state.step) bad.push(`unlock ${key} at ${at}`);
  }
  if (new Set(campaign.tips.map((t) => t.id)).size !== campaign.tips.length) bad.push('a tip appears twice');
  // 推演次数和效果记录：次数在 0 到上限之间，跟踪还剩 1 到内容表的天数次日结，副本记下的数是有限的数，日结里的效果行三个数都是有限的数，后一场晚于前一场
  if (!Number.isInteger(campaign.forecast.charges) || campaign.forecast.charges < 0 || campaign.forecast.charges > FORECAST_V1.maxCharges) bad.push(`forecast charges ${campaign.forecast.charges}`);
  for (const watch of campaign.effectWatches) {
    if (!Number.isInteger(watch.left) || watch.left < 1 || watch.left > FORECAST_V1.effectDays) bad.push(`effect watch left ${watch.left}`);
    if (watch.step > state.step) bad.push(`effect watch from the future ${watch.step}`);
    // 副本记下的数：与跟踪同类的高峰，晚于购买前的那一场，每一场最多记一次，数是有限的
    const seen = new Set<string>();
    for (const t of watch.twins) {
      const key = `${t.day}${t.peak}`;
      if (t.peak !== watch.peak || t.day <= (watch.beforeDay ?? Infinity) || seen.has(key) || !Number.isFinite(t.value)) bad.push(`effect watch twin ${JSON.stringify(t)}`);
      seen.add(key);
    }
  }
  for (const d of campaign.days) {
    for (const line of d.effects) {
      if (!Number.isFinite(line.before) || !Number.isFinite(line.after) || !Number.isFinite(line.twin) || !(line.afterDay > line.beforeDay)) bad.push(`effect line ${JSON.stringify(line)}`);
    }
  }
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

/** 一架无人机连续在上空等降落（LandQueue）的步数上限。起降口 1 级时每 12 步放行一架，一座站最多 12 个停机位，正常排队远用不到这么久。 */
const HOVER_LIMIT = 600;

/**
 * 机队的两条不变量，每一步都查，都只数没有退回的。
 * 第 1 条：无人机总数不超过站的停机位总数。开着就近降落时，无人机降落在哪座站就归属哪座站，一座站归属的无人机可以多于它的停机位，
 * 所以每座站各自的数目不能当上限，只有总数是。
 */
function overCapacity(state: SimState): string | null {
  const drones = state.drones.filter((d) => !d.removed).length;
  const bays = state.stations.reduce((sum, s) => (s.removed ? sum : sum + s.bays), 0);
  return drones > bays ? `${drones} drones but ${bays} bays` : null;
}

/**
 * 第 2 条：没有无人机连续处在 LandQueue 超过 HOVER_LIMIT 步。第 1 条被破坏之后，回站的无人机选不到有空位的站，只能在上空盘旋，
 * 多出来的无人机要等很久才会有一架等够这么多步，所以第 2 条要比第 1 条晚很多步才失败。
 */
function overHover(state: SimState): string | null {
  for (const d of state.drones) {
    if (d.removed || d.state !== DroneState.LandQueue) continue;
    const hovered = state.step - d.queuedAt;
    if (hovered > HOVER_LIMIT) return `drone ${d.id} has hovered ${hovered} steps above station ${d.station}`;
  }
  return null;
}

function run(seed: number, steps: number, open = false): { state: SimState; hashes: string[]; succeeded: Record<string, number> } {
  const state = campaignState({ seed });
  if (open) unlockAll(state); // 各项开放全部打开，随机命令从一开始就能成功
  const rng = createRng(seed + 777);
  // 就近降落的开关用单独的随机数流：不改变上面那条流产生的命令序列
  const toggles = createRng(seed + 888);
  // 推演同样用单独的流：它只扣推演次数，不改变别的任何状态
  const forecasts = createRng(seed + 999);
  const hashes: string[] = [];
  const succeeded: Record<string, number> = {};
  // 机队的两条不变量各自第一次被破坏的那一步，跑完之后一起报：两条是否都查得到，看这一行
  let capacityBad: string | null = null;
  let hoverBad: string | null = null;
  for (let i = 0; i < steps; i++) {
    clickOpening(state);
    // 每隔几步给点钱，让购买有机会成功
    if (i % 400 === 0) campaignOf(state).money += 300;
    if (nextInt(rng, 25) === 0) {
      const command = randomCommand(rng, state);
      const quote = quoteCommand(state, command);
      const result = applyCommand(state, command);
      // 问价和执行的结论一致：能不能执行相同，不能时原因也相同
      if (quote.ok !== result.ok || (!result.ok && quote.reason !== result.reason)) {
        throw new Error(`step ${state.step}: quote of ${JSON.stringify(command)} says ${quote.ok ? 'ok' : quote.reason} but the command gives ${result.ok ? 'ok' : result.reason}`);
      }
      if (result.ok) succeeded[command.type] = (succeeded[command.type] ?? 0) + 1;
    }
    if (nextInt(toggles, 40) === 0) {
      const command: Command = { type: 'setNearestLanding', on: nextInt(toggles, 2) === 0 };
      if (applyCommand(state, command).ok) succeeded[command.type] = (succeeded[command.type] ?? 0) + 1;
    }
    if (nextInt(forecasts, 60) === 0) {
      const command: Command = { type: 'useForecast' };
      const quote = quoteCommand(state, command);
      const result = applyCommand(state, command);
      if (quote.ok !== result.ok || (!result.ok && quote.reason !== result.reason)) {
        throw new Error(`step ${state.step}: quote of useForecast says ${quote.ok ? 'ok' : quote.reason} but the command gives ${result.ok ? 'ok' : result.reason}`);
      }
      if (result.ok) succeeded.useForecast = (succeeded.useForecast ?? 0) + 1;
    }
    step(state);
    const over = overCapacity(state);
    if (over !== null && capacityBad === null) capacityBad = `step ${state.step}: ${over}`;
    const hovering = overHover(state);
    if (hovering !== null && hoverBad === null) hoverBad = `step ${state.step}: ${hovering}`;
    if (i % 50 === 0) {
      const bad = violations(state);
      if (bad.length > 0) throw new Error(`step ${state.step}: ${bad.slice(0, 5).join('; ')}`);
    }
    if (i % 10 === 0) hashes.push(hashState(state));
  }
  if (capacityBad !== null || hoverBad !== null) {
    throw new Error(`fleet invariants broken. Drones above bays: ${capacityBad ?? 'never'}. Hover above ${HOVER_LIMIT} steps: ${hoverBad ?? 'never'}`);
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
    expect(Object.keys(succeeded).filter((type) => type !== 'useForecast').length).toBeGreaterThanOrEqual(6); // 推演是另加的，不算在原来的命令种类里
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
  it.each([11, 12, 13])('种子 %i：四个游戏日里随机的命令穿插在运行里，包括指定改哪一套策略、标记便签，不变量始终成立', (seed) => {
    const { state, succeeded } = run(seed, 4 * DAY_STEPS, true);
    expect(violations(state)).toEqual([]);
    // 各种新命令确实成功过：改策略（含指定一套）、标记便签
    expect(succeeded.setRules ?? 0).toBeGreaterThan(5);
    expect(succeeded.readTip ?? 0).toBeGreaterThan(0);
    expect(succeeded.useForecast ?? 0).toBeGreaterThan(0);
    expect(Object.keys(succeeded).filter((type) => type !== 'useForecast').length).toBeGreaterThanOrEqual(7);
  });

  it('同样的种子和命令序列，每一步的状态哈希相同', () => {
    const a = run(14, 3 * DAY_STEPS, true);
    const b = run(14, 3 * DAY_STEPS, true);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.succeeded).toEqual(b.succeeded);
  });
});

describe('经营模式：无人机总数和停机位总数', () => {
  // 上面所有的随机命令测试都在每一步查机队的两条不变量。买飞机、退停机位、退站点只看一座站（没有全城的总数检查）时，
  // 种子 11 到 14 只违反第 1 条：总数超过停机位数之后，多出来的飞机要再等很久才有一架在上空等够 600 步，运行短了查不到第 2 条。
  // 同样没有总数检查时，下面三个运行两条都会失败，保证随机命令覆盖得到第 2 条：种子 140 在第 6435 步总数超过停机位数，
  // 第 7232 步有飞机等够 600 步，种子 138 是第 6449 步和第 7221 步，种子 1 是第 19230 步和第 21991 步。
  // 种子 1 跑十二个游戏日，看长时间之后也守得住
  it.each([
    { seed: 140, days: 3, open: false },
    { seed: 138, days: 4, open: true },
    { seed: 1, days: 12, open: true },
  ])('种子 $seed（$days 个游戏日）：无人机总数始终不超过停机位总数，没有无人机在上空连续等降落超过 600 步', ({ seed, days, open }) => {
    const { state } = run(seed, days * DAY_STEPS, open);
    expect(violations(state)).toEqual([]);
  });
});

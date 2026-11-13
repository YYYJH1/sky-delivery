// 创建状态，以及玩家对状态的两类操作：换规矩卡、点击订单插队。
// 经营模式里玩家的其他操作（建站、购买、退回等）是命令，见 campaign/commands.ts。
import { createCampaignState } from './campaign/create.ts';
import { ruleSetInForce } from './campaign/rulesets.ts';
import { makeConfig } from './config.ts';
import type { ConfigOverrides } from './config.ts';
import { OrderStatus } from './constants.ts';
import { createDrones } from './systems/drones.ts';
import { hasRule } from './dispatch/registry.ts';
import { createRng } from './rng.ts';
import type { PeakName } from './systems/schedule.ts';
import { createStations } from './systems/stations.ts';
import type { RuleColumn, RuleSet, SimState, World } from './types.ts';
import { buildWorld, planStations } from './world.ts';

const COLUMNS: readonly RuleColumn[] = ['select', 'zone', 'pool'];

/**
 * 按配置创建开局状态：地图、站点、满电停在停机位上的飞机，没有订单。
 * 沙盒模式的地图默认由场景和地图种子生成，也可以传入现成的地图（测试用）。
 * 经营模式的地图是内容表里的地图 v1，开局状态见 campaign/create.ts，传入的地图不起作用。
 */
export function createState(overrides: ConfigOverrides = {}, prebuiltWorld?: World): SimState {
  const config = makeConfig(overrides);
  for (const column of COLUMNS) {
    if (!hasRule(column, config.rules[column])) {
      throw new RangeError(`unknown rule "${config.rules[column]}" in column ${column}`);
    }
  }
  if (config.mode === 'campaign') return createCampaignState(config);
  const world = prebuiltWorld ?? buildWorld(config.scenario, config.mapSeed);
  const plans = planStations(world, config);
  const stations = createStations(plans, config);
  return {
    config,
    world,
    step: 0,
    // 订单用独立的随机数流，换规则时订单完全相同
    rng: { orders: createRng(config.seed), dispatch: createRng(config.seed + 100000) },
    rules: { ...config.rules },
    capacity: config.capacity,
    returnRule: config.returnRule,
    stations,
    drones: createDrones(plans),
    orders: [],
    pending: [],
    openQueue: [],
    stats: {
      stranded: 0,
      landWait: stations.map(() => []),
      bayEmpty: stations.map(() => []),
      bayTotal: stations.map(() => []),
      early: [],
      ruleChanges: [],
      flightTotal: [],
      flightLoaded: [],
    },
    campaign: null,
  };
}

/**
 * 换规矩卡，立即生效，并记下换卡的时刻。取值不合法时整体不生效。
 * 经营模式开通写字楼区之后分成午晚两套（campaign.ruleSets 不是 null），state.rules 是现在生效的那一套。
 * peak 指定改哪一套，不指定就改现在生效的那一套：
 * - 改现在生效的那一套：立即生效，照常记换卡，同时记进这一套的保存。
 * - 改另一套：只保存，到切换的那一步才生效，不记换卡。
 * 还没有分成两套时不能指定 peak，会抛 RangeError。
 */
export function setRules(state: SimState, patch: Partial<RuleSet>, peak?: PeakName): void {
  for (const column of COLUMNS) {
    const to = patch[column];
    if (to !== undefined && !hasRule(column, to)) {
      throw new RangeError(`unknown rule "${to}" in column ${column}`);
    }
  }
  const sets = state.campaign?.ruleSets ?? null;
  if (peak !== undefined) {
    if (peak !== 'noon' && peak !== 'evening') throw new RangeError(`unknown rule set "${String(peak)}"`);
    if (sets === null) throw new RangeError('the rules are not split into two sets yet');
  }
  const inForce = sets === null ? null : ruleSetInForce(state);
  if (sets !== null && peak !== undefined && peak !== inForce) {
    for (const column of COLUMNS) {
      const to = patch[column];
      if (to !== undefined) sets[peak][column] = to;
    }
    return;
  }
  for (const column of COLUMNS) {
    const to = patch[column];
    if (to === undefined || to === state.rules[column]) continue;
    state.stats.ruleChanges.push({ step: state.step, column, from: state.rules[column], to });
    state.rules[column] = to;
  }
  if (sets !== null && inForce !== null) sets[inForce] = { ...state.rules };
}

/** 玩家点击一张等待中的订单：排到最前，下一架可用的飞机优先去送。已经派出的订单不能插队。 */
export function prioritizeOrder(state: SimState, orderId: number): boolean {
  const order = state.orders[orderId];
  if (!order || order.status !== OrderStatus.Pending || order.manualAt >= 0) return false;
  order.manualAt = state.step;
  return true;
}

// 经营模式测试共用的小工具。
import { expect } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import type { MapRoofV1 } from '../src/content/table_types.ts';
import { OrderStatus, UNLOCK_KEYS, addOrder, applyCommand, createState, hashState, quoteCommand, refreshShops } from '../src/core/index.ts';
import type { CampaignState, Command, CommandFailure, ConfigOverrides, Order, SimState } from '../src/core/index.ts';

/** 经营模式的开局状态。 */
export function campaignState(overrides: ConfigOverrides = {}): SimState {
  return createState({ mode: 'campaign', ...overrides });
}

export function campaignOf(state: SimState): CampaignState {
  if (state.campaign === null) throw new Error('not a campaign state');
  return state.campaign;
}

/**
 * 把各项开放全部打开：价签、调度台的栏和卡、片区的显示。午晚两套规矩不在其内，它随开通写字楼区自动出现。
 * 给不关心开放条件的命令测试用，开放条件本身的测试用没打开的状态。
 */
export function unlockAll(state: SimState): SimState {
  const campaign = campaignOf(state);
  for (const key of UNLOCK_KEYS) {
    if (key !== 'ruleSets' && campaign.unlocks[key] < 0) campaign.unlocks[key] = state.step;
  }
  return state;
}

/**
 * 安静的经营模式状态：不产生任何订单（开局订单和随机订单都没有），自动派单是开着的，
 * 测试自己用 addOrder 放订单。给命令的测试用。各项开放默认全部打开（unlocked 为 false 时保持开局的锁定状态）。
 */
export function quietState(overrides: ConfigOverrides = {}, unlocked = true): SimState {
  const state = campaignState({ orderEndStep: 0, ...overrides });
  campaignOf(state).opening.done = true;
  if (unlocked) unlockAll(state);
  return state;
}

/** 给余额，缺省给很多。 */
export function withMoney(state: SimState, money = 1_000_000): SimState {
  campaignOf(state).money = money;
  return state;
}

/** 执行命令，必须成功，返回新建的站或飞机的编号。 */
export function must(state: SimState, command: Command): number {
  const result = applyCommand(state, command);
  if (!result.ok) throw new Error(`command ${JSON.stringify(command)} failed: ${result.reason}`);
  return result.id;
}

/** 命令必须失败，原因代码是 reason，状态一点不变（哈希和完整内容都相同），只读的价签也给出同样的原因且不改状态。 */
export function expectRejected(state: SimState, command: Command, reason: CommandFailure): void {
  const hashBefore = hashState(state);
  const jsonBefore = JSON.stringify(state);
  const quote = quoteCommand(state, command);
  expect(quote.ok, `quote of ${JSON.stringify(command)}`).toBe(false);
  expect(quote.reason, `quote of ${JSON.stringify(command)}`).toBe(reason);
  const result = applyCommand(state, command);
  expect(result, `result of ${JSON.stringify(command)}`).toEqual({ ok: false, reason });
  expect(hashState(state), `hash after ${JSON.stringify(command)}`).toBe(hashBefore);
  expect(JSON.stringify(state), `state after ${JSON.stringify(command)}`).toBe(jsonBefore);
}

/** 活着的飞机：没有退回的。 */
export function liveDrones(state: SimState): SimState['drones'] {
  return state.drones.filter((d) => !d.removed);
}

/** 地图 v1 里第一块满足条件的屋顶的下标。 */
export function roofWhere(pick: (roof: MapRoofV1, index: number) => boolean): number {
  const index = MAP_V1.roofs.findIndex(pick);
  if (index < 0) throw new Error('no roof matches');
  return index;
}

/** 点击还没点击过的开局订单，像玩家一样。开局结束之后什么也不做。 */
export function clickOpening(state: SimState): void {
  const campaign = campaignOf(state);
  if (campaign.opening.done) return;
  for (const id of campaign.opening.orders) {
    const order = state.orders[id];
    if (order !== undefined && order.manualAt < 0 && order.status === OrderStatus.Pending) must(state, { type: 'prioritizeOrder', order: id });
  }
}

/**
 * 经营模式的状态，直接进入随机订单：开局的五张固定订单当作已经出现，自动派单是开着的。
 * stars 是各片区的星级，open 是各片区是否开通。
 */
export function runningState(seed: number, stars: readonly number[] = [1, 1, 1], open: readonly boolean[] = [true, false, false]): SimState {
  const state = campaignState({ seed });
  const campaign = campaignOf(state);
  campaign.opening.orders = [0, 1, 2, 3, 4];
  campaign.opening.done = true;
  campaign.districts.forEach((d, k) => {
    d.open = open[k] as boolean;
    d.star = stars[k] as number;
  });
  refreshShops(state);
  return state;
}

/**
 * 手工构造的订单：下单的步、送往的片区，以及结果。给了 delivered 就是那一步送达，给了 cancelled 就是那一步退单，都不给就是还没有结果。
 * 另有几个可选项，用来造出高峰小结里四段时间和配送站的各种情形：
 * assignDelay 下单到派单的步数（等飞机，缺省 10），gateWait 派单到起飞开始的步数（等起降，缺省 0），
 * prepWait 飞机到店到取餐开始的步数（等出餐，缺省 10），departed 接单的飞机从哪座站起飞（离店最近的站是 0 号站，缺省 0）。
 */
export interface OutcomeSpec {
  district: number;
  tOrder: number;
  delivered?: number;
  cancelled?: number;
  rev?: number;
  assignDelay?: number;
  gateWait?: number;
  prepWait?: number;
  departed?: number;
}

/**
 * 放一张手工构造的订单。有结果的订单直接设好结局，并且从待派队列和退单检查队列里拿掉，所以推进状态时不会被再次处理。
 * 没有结果的订单留在待派队列里。订单要按下单的步从小到大放，编号才与下单的先后一致。
 */
export function outcomeOrder(state: SimState, spec: OutcomeSpec): Order {
  const buildings = state.world.buildingsByDistrict[spec.district] as number[];
  const order = addOrder(state, { merchant: 0, building: buildings[0] as number, portion: 1, prepSteps: 10, tOrder: spec.tOrder });
  if (spec.delivered === undefined && spec.cancelled === undefined) return order;
  state.pending.splice(state.pending.indexOf(order.id), 1);
  state.openQueue.splice(state.openQueue.indexOf(order.id), 1);
  if (spec.delivered !== undefined) {
    order.status = OrderStatus.Delivered;
    order.tAssign = spec.tOrder + (spec.assignDelay ?? 10);
    order.gateWait = spec.gateWait ?? 0;
    order.tArrive = order.tAssign + order.gateWait + 40;
    order.tPick = order.tArrive + (spec.prepWait ?? 10);
    order.tDeliver = spec.delivered;
    order.departed = spec.departed ?? 0;
    order.rev = spec.rev ?? 5;
  } else {
    order.status = OrderStatus.Cancelled;
    order.tCancel = spec.cancelled as number;
  }
  return order;
}

/** 送往一个片区的一批订单：onTime 张准时送达（用时 200 步），late 张超时送达（用时 400 步），cancelled 张退单，都在 day 这一天里下单、出结果。 */
export function batchOrders(state: SimState, district: number, day: number, counts: { onTime?: number; late?: number; cancelled?: number }): void {
  const base = day * 3600 + 1000;
  let k = 0;
  for (let i = 0; i < (counts.onTime ?? 0); i++) outcomeOrder(state, { district, tOrder: base + k++, delivered: base + k + 200 });
  for (let i = 0; i < (counts.late ?? 0); i++) outcomeOrder(state, { district, tOrder: base + k++, delivered: base + k + 400 });
  for (let i = 0; i < (counts.cancelled ?? 0); i++) outcomeOrder(state, { district, tOrder: base + k++, cancelled: base + k + 900 });
}

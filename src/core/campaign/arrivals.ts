// 经营模式的订单：开局的五张固定订单，以及开局结束之后每个开通的片区各自产生的随机订单。
import { DISTRICT_RATES_V1, STAR_MULTIPLIER_V1 } from '../../content/districts_v1.ts';
import { OPENING_ORDERS_V1 } from '../../content/opening_v1.ts';
import {
  BIG_ORDER_SHARE,
  DAY_STEPS,
  DT,
  OrderStatus,
  PREP_MAX_SECONDS,
  PREP_MIN_SECONDS,
  STEPS_PER_SECOND,
} from '../constants.ts';
import { nextFloat, nextRange, poisson } from '../rng.ts';
import { curveSteps } from '../systems/curve.ts';
import { addOrder, searchCumulative } from '../systems/orders.ts';
import type { CampaignState, Order, SimState } from '../types.ts';
import { currentOpeningMultiplier } from './opening.ts';

/** 各片区一天里每一步的相对来单率，由内容表的控制点算出。 */
const DISTRICT_CURVES: readonly (readonly number[])[] = DISTRICT_RATES_V1.map((d) => curveSteps(d.curveSeconds, d.curveRate));

/**
 * 一个片区在某一步的来单率（每步的期望来单数）：基础来单率 / 60 × 曲线 × 星级倍数 × 开业期倍数 × 每步秒数。
 * 开业期倍数见 opening.ts，不在开业期里是 1，缺省也是 1。
 */
export function districtLambda(district: number, tickOfDay: number, star: number, opening = 1): number {
  const rate = (DISTRICT_RATES_V1[district] as { baseRate: number }).baseRate;
  const curve = (DISTRICT_CURVES[district] as readonly number[])[tickOfDay] as number;
  const multiplier = STAR_MULTIPLIER_V1[Math.min(Math.max(star, 1), STAR_MULTIPLIER_V1.length) - 1] as number;
  return ((rate / 60) * curve * multiplier * opening) * DT;
}

/** 五张开局订单都已出现，并且都有了结果（送达或退单）。 */
function openingResolved(state: SimState, campaign: CampaignState): boolean {
  const { orders } = campaign.opening;
  if (orders.length < OPENING_ORDERS_V1.length) return false;
  return orders.every((id) => {
    const status = (state.orders[id] as Order).status;
    return status === OrderStatus.Delivered || status === OrderStatus.Cancelled;
  });
}

/** 在开通的片区里抽一张随机订单：楼在片区里等概率，店在全部已开张的店里按权重抽。 */
function generateOrder(state: SimState, campaign: CampaignState, district: number): void {
  const rng = state.rng.orders;
  const uBuilding = nextFloat(rng);
  const uMerchant = nextFloat(rng);
  const prepSeconds = nextRange(rng, PREP_MIN_SECONDS, PREP_MAX_SECONDS);
  const uPortion = nextFloat(rng);
  const candidates = state.world.buildingsByDistrict[district] as number[];
  const building = candidates[Math.min(Math.floor(uBuilding * candidates.length), candidates.length - 1)] as number;
  const cum = campaign.cumWeights[building] as number[];
  const merchant = searchCumulative(cum, uMerchant * (cum[cum.length - 1] as number));
  addOrder(state, {
    merchant,
    building,
    portion: uPortion < BIG_ORDER_SHARE ? 2 : 1,
    prepSteps: Math.round(prepSeconds * STEPS_PER_SECOND),
  });
}

/**
 * 经营模式的产生订单阶段。
 * 开局时只有内容表里写定的五张订单，按各自的步出现，不产生随机订单，自动派单关着。
 * 五张都有了结果之后，自动派单打开，同时开始产生随机订单：每个开通的片区按片区编号的顺序，
 * 各抽一个泊松数，来单率由 districtLambda 给出，新开通的片区在开业期里来单打折。只用订单随机数流。
 */
export function campaignArrivals(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null) return;
  const { config, step } = state;
  if (config.orderEndStep !== null && step >= config.orderEndStep) return;
  const day = Math.floor(step / DAY_STEPS);
  while (campaign.income.length <= day) campaign.income.push(0);

  const opening = campaign.opening;
  while (opening.orders.length < OPENING_ORDERS_V1.length && (OPENING_ORDERS_V1[opening.orders.length] as { step: number }).step <= step) {
    const o = OPENING_ORDERS_V1[opening.orders.length] as (typeof OPENING_ORDERS_V1)[number];
    const order = addOrder(state, { merchant: o.merchant, building: o.building, portion: o.portion, prepSteps: o.prepSteps });
    opening.orders.push(order.id);
  }
  if (!opening.done) {
    if (!openingResolved(state, campaign)) return;
    opening.done = true;
  }

  const tickOfDay = step % DAY_STEPS;
  campaign.districts.forEach((district, k) => {
    if (!district.open) return;
    const n = poisson(state.rng.orders, districtLambda(k, tickOfDay, district.star, currentOpeningMultiplier(state, k)));
    for (let i = 0; i < n; i++) generateOrder(state, campaign, k);
  });
}

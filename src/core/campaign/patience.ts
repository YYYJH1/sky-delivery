// 顾客的耐心：订单下单后等多久没有被取走就退单。经营模式里按订单送往的片区现在的星级取，星级越高越没有耐心，
// 各星的秒数在内容表 stars_v1.ts 的 patienceSeconds 里。沙盒模式的所有订单都是固定的 90 秒。
// 订单上不记时限，只记送往的片区，所以升星或掉星之后，还在等的订单也按新的星级判断。
import { STARS_V1 } from '../../content/stars_v1.ts';
import { CANCEL_STEPS, STEPS_PER_SECOND } from '../constants.ts';
import type { Order, SimState } from '../types.ts';

/** 星级对应的退单时限，单位是步。星级超出一星到最高星的范围时取最近的一档。 */
export function patienceSteps(star: number): number {
  const table = STARS_V1.patienceSeconds;
  const i = Math.min(Math.max(star, 1), table.length) - 1;
  return Math.round((table[i] as number) * STEPS_PER_SECOND);
}

/** 各星里最短的退单时限，单位是步。 */
export function shortestPatienceSteps(): number {
  let best = Infinity;
  for (const seconds of STARS_V1.patienceSeconds) best = Math.min(best, Math.round(seconds * STEPS_PER_SECOND));
  return best;
}

/** 一张订单现在的退单时限，单位是步。沙盒模式固定为 CANCEL_STEPS。 */
export function orderPatienceSteps(state: SimState, order: Order): number {
  const info = state.campaign?.districts[order.district];
  return info === undefined ? CANCEL_STEPS : patienceSteps(info.star);
}

/** 送往某个片区的订单现在的退单时限，单位是秒。沙盒模式和没有这个片区时是沙盒的 90 秒。 */
export function districtPatienceSeconds(state: SimState, district: number): number {
  const info = state.campaign?.districts[district];
  return (info === undefined ? CANCEL_STEPS : patienceSteps(info.star)) / STEPS_PER_SECOND;
}

// 「提前派出」的统计：规则让哪些订单比按下单顺序更早派出。
import { DAY_STEPS } from '../constants.ts';
import { peakAt } from '../systems/schedule.ts';
import type { Order, SimState } from '../types.ts';

/**
 * 一轮派单结束后调用。
 * - roster 是这一轮按下单顺序会派出的订单编号：用同一批可用的飞机、同样的派单条件（站点分工、电量、一起送的限制）
 *   和同样的选飞机办法，把等待中的订单按下单时间再排一遍算出的名单（见 run.ts 的 planRound）。
 *   交给空闲飞机的订单和插进别的飞机路线的订单都在名单里。
 * - 实际派出的订单里不在这份名单里的，各记一次。同一张订单只记一次。
 * - 玩家点击插队的订单不计入。
 * - 每次计数记下当时生效的「先送哪张单」和订单所属的高峰。
 * 返回这一轮新记的订单编号。
 */
export function recordEarlyDispatches(
  state: SimState,
  roster: readonly number[],
  dispatched: readonly number[],
): number[] {
  const inRoster = new Set(roster);
  const counted: number[] = [];
  for (const id of dispatched) {
    const o = state.orders[id] as Order;
    if (o.manualAt >= 0 || inRoster.has(id) || o.early) continue;
    o.early = true;
    counted.push(id);
    state.stats.early.push({
      step: state.step,
      order: id,
      rule: state.rules.select,
      day: Math.floor(o.tOrder / DAY_STEPS),
      peak: peakAt(o.tOrder),
    });
  }
  return counted;
}

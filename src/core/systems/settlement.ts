// 结算：订单送达时的进账和打赏。
import { DAY_STEPS, LATE_SLOPE, OrderStatus, PAY_FLOOR, PAY_FLOOR_AT, PROMISE_STEPS, TIP_SHARE, TIP_WITHIN } from '../constants.ts';
import type { Order, SimState } from '../types.ts';

/** 按送达用时（步）算进账和打赏。承诺时间内全额，六成以内另加打赏，之后线性下降，两倍时降到三成。 */
export function settlement(amount: number, elapsedSteps: number): { pay: number; tip: number } {
  const x = elapsedSteps / PROMISE_STEPS;
  if (x <= 1) {
    return { pay: amount, tip: x <= TIP_WITHIN ? TIP_SHARE * amount : 0 };
  }
  if (x <= PAY_FLOOR_AT) return { pay: amount * (1 - LATE_SLOPE * (x - 1)), tip: 0 };
  return { pay: PAY_FLOOR * amount, tip: 0 };
}

/** 订单送达：记录时刻并结算。 */
export function deliverOrder(order: Order, now: number): void {
  order.tDeliver = now;
  order.status = OrderStatus.Delivered;
  const { pay, tip } = settlement(order.amount, now - order.tOrder);
  order.rev = pay + tip;
  order.tip = tip;
}

/** 经营模式：订单送达后，进账加进余额，并记到送达那一天，送达的订单总数加一。沙盒模式没有余额，什么也不做。 */
export function creditOrder(state: SimState, order: Order): void {
  const campaign = state.campaign;
  if (campaign === null) return;
  campaign.money += order.rev;
  campaign.delivered += 1;
  const day = Math.floor(order.tDeliver / DAY_STEPS);
  while (campaign.income.length <= day) campaign.income.push(0);
  campaign.income[day] = (campaign.income[day] as number) + order.rev;
}

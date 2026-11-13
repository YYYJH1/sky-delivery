// 退单：下单后等满 90 秒仍没有被取走的订单，顾客退单。已经取走的订单一定送到。
import { CANCEL_STEPS, OrderStatus } from '../constants.ts';
import { dropFromRoute } from './drones.ts';
import type { Drone, Order, SimState } from '../types.ts';

export function cancelOrder(state: SimState, order: Order, now: number): void {
  if (order.status === OrderStatus.Pending) {
    state.pending.splice(state.pending.indexOf(order.id), 1);
  } else {
    dropFromRoute(state, state.drones[order.drone] as Drone, order.id, now);
  }
  order.status = OrderStatus.Cancelled;
  order.tCancel = now;
}

/** 退单阶段。退单检查队列按下单时间排序，只需要看队首。 */
export function expireOrders(state: SimState): void {
  const queue = state.openQueue;
  const now = state.step;
  while (queue.length > 0) {
    const order = state.orders[queue[0] as number] as Order;
    if (order.status >= OrderStatus.Picked) {
      queue.shift();
    } else if (now - order.tOrder >= CANCEL_STEPS) {
      queue.shift();
      cancelOrder(state, order, now);
    } else {
      break;
    }
  }
}

// 退单：下单后等满一段时间仍没有被取走的订单，顾客退单。已经取走的订单一定送到。
// 沙盒模式的时限固定为 CANCEL_STEPS。经营模式里时限随订单送往的片区的星级变短（见 campaign/patience.ts）。
import { orderPatienceSteps, shortestPatienceSteps } from '../campaign/patience.ts';
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

/** 时限固定时的退单阶段。退单检查队列按下单时间排序，只需要看队首。 */
function expireByFixedLimit(state: SimState): void {
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

/**
 * 时限随星级变化时的退单阶段。队列仍按下单时间排序，但先下单的订单不一定先到时限，所以不能只看队首。
 * 下单时间离现在不到最短时限的订单一定还没到时限，队列按下单时间排，遇到第一张这样的订单就可以停。
 * 之前的订单逐张比较：已经取走的移出队列，到了时限的退单，其余留着。同一步里退单的先后仍按队列的顺序。
 */
function expireByStar(state: SimState): void {
  const queue = state.openQueue;
  const now = state.step;
  const shortest = shortestPatienceSteps();
  let i = 0;
  while (i < queue.length) {
    const order = state.orders[queue[i] as number] as Order;
    if (order.status >= OrderStatus.Picked) {
      queue.splice(i, 1);
    } else if (now - order.tOrder < shortest) {
      break;
    } else if (now - order.tOrder >= orderPatienceSteps(state, order)) {
      queue.splice(i, 1);
      cancelOrder(state, order, now);
    } else {
      i += 1;
    }
  }
}

/** 退单阶段。 */
export function expireOrders(state: SimState): void {
  if (state.campaign === null) expireByFixedLimit(state);
  else expireByStar(state);
}

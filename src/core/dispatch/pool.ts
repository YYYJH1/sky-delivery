// 「一趟送几单」栏。载量是改装（配置里的 capacity），这一栏的卡只决定哪些订单可以一起送。
// 一起送的做法：新订单插进另一架已有任务的飞机的路线，且新订单在机上的这一段里同时有别的订单（同乘）。
// 插入的计算在 insert.ts。
import { PUSH_STEPS } from '../constants.ts';
import type { Order } from '../types.ts';
import type { PoolRule } from './types.ts';

/** 一趟送一单：每张订单单独配送，任何载量下都不插入。 */
export const singleRule: PoolRule = {
  id: 'single',
  usesBusyDrones: false,
  pushLimit: 0,
  accepts: () => false,
};

/** 同一家店的一起送：路线上的订单都和这张订单取自同一家店时才一起送。 */
export const sameRule: PoolRule = {
  id: 'same',
  usesBusyDrones: true,
  pushLimit: PUSH_STEPS,
  accepts: (state, route, order) => route.every((stop) => (state.orders[stop.order] as Order).merchant === order.merchant),
};

/** 顺路的一起送：不限店，原有订单的预计送达最多被推迟 6 秒。 */
export const anyRule: PoolRule = {
  id: 'any',
  usesBusyDrones: true,
  pushLimit: PUSH_STEPS,
  accepts: () => true,
};

export const POOL_RULES: Readonly<Record<string, PoolRule>> = {
  [singleRule.id]: singleRule,
  [sameRule.id]: sameRule,
  [anyRule.id]: anyRule,
};

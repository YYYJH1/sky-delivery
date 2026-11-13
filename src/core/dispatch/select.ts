// 「先送哪张单」栏。
import { DROP_SECONDS, DT, PICK_SECONDS, PROMISE_SECONDS, SPEED } from '../constants.ts';
import type { Order } from '../types.ts';
import { DISTRICT_CAMPUS, DISTRICT_OFFICE, DISTRICT_OLD } from '../world.ts';
import type { DispatchContext, SelectRule } from './types.ts';

function ordersOf(ctx: DispatchContext): Order[] {
  return ctx.pendingIds.map((id) => ctx.state.orders[id] as Order);
}

function indices(n: number): number[] {
  return Array.from({ length: n }, (_, k) => k);
}

/** 先下单的先送：按下单时间排序。 */
export const fifoRule: SelectRule = {
  id: 'fifo',
  rank(ctx) {
    const orders = ordersOf(ctx);
    return indices(orders.length).sort((p, q) => {
      const a = orders[p] as Order;
      const b = orders[q] as Order;
      return a.tOrder - b.tOrder || a.id - b.id;
    });
  },
};

/**
 * 赶不赶得上承诺时间：group 0 是赶得上的，剩余时间在 slack 里，1 是已经赶不上的，2 是没有可用飞机能接的。
 * 取餐时刻是飞到店和出餐完成里较晚的一个。
 */
function deadlineKeys(ctx: DispatchContext, orders: readonly Order[]): { group: number[]; slack: number[] } {
  const nowSeconds = ctx.now * DT;
  const group: number[] = [];
  const slack: number[] = [];
  orders.forEach((o, k) => {
    const fly = ctx.flyTime[k] as number;
    if (fly < Infinity) {
      const pickStart = Math.max(nowSeconds + fly, o.prepDone * DT);
      const s = o.tOrder * DT + PROMISE_SECONDS - (pickStart + PICK_SECONDS + o.dMB / SPEED + DROP_SECONDS);
      group.push(s >= 0 ? 0 : 1);
      slack.push(s >= 0 ? s : 0);
    } else {
      group.push(2);
      slack.push(0);
    }
  });
  return { group, slack };
}

/**
 * 快超时的先送：在还赶得上承诺时间的订单里，先送剩余时间最少的。
 * 已经赶不上的排在赶得上的后面，没有可用飞机的排在最后。
 */
export const deadlineRule: SelectRule = {
  id: 'deadline',
  rank(ctx) {
    const orders = ordersOf(ctx);
    const { group, slack } = deadlineKeys(ctx, orders);
    return indices(orders.length).sort((p, q) => {
      const a = orders[p] as Order;
      const b = orders[q] as Order;
      return (
        (group[p] as number) - (group[q] as number) ||
        (slack[p] as number) - (slack[q] as number) ||
        a.tOrder - b.tOrder ||
        a.id - b.id
      );
    });
  },
};

/**
 * 来回快的先送：先送整趟用时最短的订单。整趟是站到店、店到楼、楼回站，取各架可用飞机里最短的。
 * 没有可用飞机能接的订单排在最后，它们之间按店到楼的用时从短到长。用时相同时按下单时间，再按编号。
 */
export const roundtripRule: SelectRule = {
  id: 'roundtrip',
  rank(ctx) {
    const orders = ordersOf(ctx);
    const trip = ctx.tripTime();
    const open = (k: number): boolean => (trip[k] as number) < Infinity;
    return indices(orders.length).sort((p, q) => {
      const a = orders[p] as Order;
      const b = orders[q] as Order;
      const lead = (open(p) ? 0 : 1) - (open(q) ? 0 : 1);
      if (lead !== 0) return lead;
      const timeP = open(p) ? (trip[p] as number) : a.dMB / SPEED;
      const timeQ = open(q) ? (trip[q] as number) : b.dMB / SPEED;
      return timeP - timeQ || a.tOrder - b.tOrder || a.id - b.id;
    });
  },
};

/**
 * 某一片的先送：送到指定片区的订单排在最前，各自内部按「快超时的先送」排。
 * 核心里每个片区登记一张卡，界面把它们合成一张带参数的卡。
 */
function prioDistrictRule(id: string, district: number): SelectRule {
  return {
    id,
    rank(ctx) {
      const orders = ordersOf(ctx);
      const { group, slack } = deadlineKeys(ctx, orders);
      return indices(orders.length).sort((p, q) => {
        const a = orders[p] as Order;
        const b = orders[q] as Order;
        return (
          (a.district === district ? 0 : 1) - (b.district === district ? 0 : 1) ||
          (group[p] as number) - (group[q] as number) ||
          (slack[p] as number) - (slack[q] as number) ||
          a.tOrder - b.tOrder ||
          a.id - b.id
        );
      });
    },
  };
}

export const prioOldRule = prioDistrictRule('prioOld', DISTRICT_OLD);
export const prioOfficeRule = prioDistrictRule('prioOffice', DISTRICT_OFFICE);
export const prioCampusRule = prioDistrictRule('prioCampus', DISTRICT_CAMPUS);

export const SELECT_RULES: Readonly<Record<string, SelectRule>> = {
  [fifoRule.id]: fifoRule,
  [deadlineRule.id]: deadlineRule,
  [roundtripRule.id]: roundtripRule,
  [prioOldRule.id]: prioOldRule,
  [prioOfficeRule.id]: prioOfficeRule,
  [prioCampusRule.id]: prioCampusRule,
};

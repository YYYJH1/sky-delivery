// 派单规则的接口。调度台的每一栏对应一个注册表，栏里的每张卡是表里的一项。
import type { Drone, Order, RouteStop, SimState } from '../types.ts';

/** 一轮派单的上下文：本轮待派的订单，以及每张订单被允许的可用飞机里飞到店最快的用时。 */
export interface DispatchContext {
  state: SimState;
  now: number;
  /** 本轮待派订单的编号，按下单顺序 */
  pendingIds: readonly number[];
  /** 每张待派订单的最短飞到店用时（秒）。没有被允许且电量够的可用飞机时为 Infinity */
  flyTime: readonly number[];
  /** 每张待派订单的整趟最短用时（秒）：站到店、店到楼、楼回站。没有可行飞机时为 Infinity */
  tripTime(): readonly number[];
}

/** 先送哪张单。 */
export interface SelectRule {
  id: string;
  /** 返回 ctx.pendingIds 的下标，从最先送的排到最后送的。必须包含全部下标 */
  rank(ctx: DispatchContext): number[];
}

/** 别的站帮不帮。 */
export interface ZoneRule {
  id: string;
  /**
   * 从 drone.station 号站出发的飞机，能不能接这张单。
   * 停在停机位上的飞机传它自己。订单插进别的飞机的路线时，传一个只带这一趟出发站的对象。
   */
  allows(state: SimState, now: number, drone: Pick<Drone, 'station'>, order: Order): boolean;
}

/** 一趟送几单。 */
export interface PoolRule {
  id: string;
  /**
   * 为真时，载量不小于 2 的局面里订单可以插进别的飞机的路线，
   * 没有可用飞机的轮次也要走派单流程，因为订单可以插进已有任务的飞机。
   */
  usesBusyDrones: boolean;
  /** 已有订单的预计送达时刻最多被推迟的步数 */
  pushLimit: number;
  /** 一架飞机路线上已有的订单（路线非空），能不能和这张订单一起送。载量、电量、分工由插入的计算另行检查 */
  accepts(state: SimState, route: readonly RouteStop[], order: Order): boolean;
}

// 「别的站帮不帮」栏。每张订单的「本站」是离它的店最近的站。
import { ZONE_WAIT_STEPS } from '../constants.ts';
import type { ZoneRule } from './types.ts';

/** 哪座站都能送：不区分站点，由用时最短的可用飞机去送。 */
export const globalRule: ZoneRule = {
  id: 'global',
  allows: () => true,
};

/** 等 10 秒再帮：订单下单后的前 10 秒只有本站的飞机能接，之后其他站的飞机也能接。 */
export const hybridRule: ZoneRule = {
  id: 'hybrid',
  allows: (_state, now, drone, order) => drone.station === order.home || now - order.tOrder >= ZONE_WAIT_STEPS,
};

/** 只由最近的站送：只有停在本站的飞机能接。 */
export const strictRule: ZoneRule = {
  id: 'strict',
  allows: (_state, _now, drone, order) => drone.station === order.home,
};

export const ZONE_RULES: Readonly<Record<string, ZoneRule>> = {
  [globalRule.id]: globalRule,
  [hybridRule.id]: hybridRule,
  [strictRule.id]: strictRule,
};

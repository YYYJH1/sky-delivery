// 新片区的开业期：片区开通的那一天和之后的几天，来单打折。每一天的倍数在内容表 districts_v1.ts 的 opening 里。
// 开通的那一天不另外存。片区开通之后，每次日结都在记录里给它写一行，第一行所在的游戏日就是开通那天。
// 开通当天还没有日结，这时开通的那天就是今天。老街开局就开通，也没有开业期。
import { DISTRICT_RATES_V1 } from '../../content/districts_v1.ts';
import { dayOf } from '../systems/schedule.ts';
import type { SimState } from '../types.ts';

/** 一个片区现在处在开业期的第几天，以及这一天的来单倍数。 */
export interface OpeningPhase {
  day: number; // 开业第几天，从 1 数起，1 是开通的那一天
  multiplier: number; // 这一天的来单倍数
}

/** 开业期第 day 天（从 1 数起）的来单倍数。没有开业期的片区和开业期之后的天数都是 1。 */
export function openingMultiplier(district: number, day: number): number {
  const table = DISTRICT_RATES_V1[district]?.opening ?? [];
  return table[day - 1] ?? 1;
}

/**
 * 片区开通的那一个游戏日（从 0 数起）。没有这个片区或还没开通为 null。
 * 日结记录里有这个片区的第一条记录所在的日子就是开通那天。片区一旦开通就不会关，所以有这个片区的记录在日结记录里是连续的一段，
 * 用二分法找第一条。还没有任何一次日结写到它时，它是今天开通的。
 */
export function districtOpenDay(state: SimState, district: number): number | null {
  const campaign = state.campaign;
  const info = campaign?.districts[district];
  if (campaign === null || info === undefined || !info.open) return null;
  const days = campaign.days;
  const has = (i: number): boolean => (days[i]?.districts ?? []).some((line) => line.district === district);
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (has(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo < days.length ? lo : dayOf(state.step);
}

/**
 * 某个片区现在的开业期。没有开通、没有开业期（老街）或开业期已经过去时为 null。
 * 开业期的天数按游戏日算：开通的那天是第 1 天，不管它是从几点开始的。
 */
export function openingPhase(state: SimState, district: number): OpeningPhase | null {
  const table = DISTRICT_RATES_V1[district]?.opening ?? [];
  if (table.length === 0) return null;
  const openDay = districtOpenDay(state, district);
  if (openDay === null) return null;
  const day = dayOf(state.step) - openDay + 1;
  const multiplier = table[day - 1];
  return multiplier === undefined ? null : { day, multiplier };
}

/** 某个片区现在的开业期倍数，不在开业期里是 1。产生订单时用它。 */
export function currentOpeningMultiplier(state: SimState, district: number): number {
  return openingPhase(state, district)?.multiplier ?? 1;
}

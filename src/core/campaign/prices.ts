// 价格：按内容表里的参数算。飞机和停机位按每座站各自已有的数量计价，
// 每一档都从基础价直接算出后取整，不在上一档取整后的价格上累乘。
// 幂用整数次连乘算，不用 Math.pow，因为它的末位在不同的引擎之间可能不同。
import { ECONOMY_V1 } from '../../content/economy_v1.ts';
import { MAP_V1 } from '../../content/map_v1.ts';
import type { RoofSize } from '../../content/table_types.ts';

/** base 的 n 次方，n 是非负整数，连乘。 */
function powInt(base: number, n: number): number {
  let result = 1;
  for (let i = 0; i < n; i++) result *= base;
  return result;
}

/** 一座站的第 n 架飞机的价格（n 从 1 数起）：第 1、2 架是基础价，第 n 架（n 不小于 3）是 round(基础价 × 1.14^(n-3))。 */
export function dronePrice(n: number): number {
  const e = ECONOMY_V1;
  if (n <= 2) return e.droneBase;
  return Math.round(e.droneBase * powInt(e.droneGrowth, n - 3));
}

/** 一座站的第 n 个停机位的价格（n 从 1 数起，新站自带前两个）：第 n 个（n 不小于 3）是 round(基础价 × 1.17^(n-3))。 */
export function bayPrice(n: number): number {
  const e = ECONOMY_V1;
  const first = e.baysAtBuild + 1; // 新站自带之后的第一个，价格就是基础价
  if (n <= first) return e.bayBase;
  return Math.round(e.bayBase * powInt(e.bayGrowth, n - first));
}

/** 建第 count + 1 座站的基准价，count 是现有的站数。建站价还要乘屋顶的价格系数。 */
export function stationBasePrice(count: number): number {
  const table = ECONOMY_V1.stationBase;
  const index = Math.min(Math.max(count - 1, 0), table.length - 1);
  return table[index] as number;
}

/** 在一块屋顶上建站的价格：基准价乘屋顶的价格系数，取整。 */
export function stationPrice(count: number, roof: number): number {
  const coef = (MAP_V1.roofs[roof] as { priceCoef: number }).priceCoef;
  return Math.round(stationBasePrice(count) * coef);
}

/** 起降口升到 level 级（2 或 3）的价格。 */
export function gatePrice(level: number): number {
  return ECONOMY_V1.gatePrice[level - 1] as number;
}

/** 起降口从 1 级升到 level 级一共花的钱：2 级到 level 级的升级价之和。1 级以下为 0。 */
export function gateUpgradesTotal(level: number): number {
  let total = 0;
  for (let l = 2; l <= level; l++) total += gatePrice(l);
  return total;
}

/** 屋顶大小对应的停机位上限。 */
export function bayCap(size: RoofSize): number {
  return ECONOMY_V1.bayCap[size];
}

// 口碑 v1。只放数据，判断的函数在核心里。
// 统计范围是最近两个游戏日里有结果的、送往这个片区的订单，两天合并算，第一天只有当天。
// 升星：日结时达到上一档的条件升一星，一次最多一星。
// 掉星：三星及以上，日结时没有达到当前星级下面一档的升星条件，连续两次日结都如此，掉一星。二星不会掉回一星。
// 最少样本：最近两天有结果的订单少于 minSample 张时，这次日结星级不变，连续未达到的计数也不变，与没有订单同样处理。
// 刚开通的片区头一两天订单很少，一张准时的订单就是 100%，没有这个下限会直接升星。
import type { StarsV1 } from './table_types.ts';

export const STARS_V1: StarsV1 = {
  maxStar: 5,
  windowDays: 2,
  minSample: 10,
  rules: [
    { star: 2, onTimeMin: 55, cancelBelow: null }, // 老街第一天只有两架飞机，二星线和老街来单率都取初值（60 和 12）时，只有 68% 的种子能在第一天日结时升二星，见 districts_v1.ts 老街一项
    { star: 3, onTimeMin: 75, cancelBelow: 8 },
    { star: 4, onTimeMin: 85, cancelBelow: 4 },
    { star: 5, onTimeMin: 92, cancelBelow: 2 },
  ],
  dropFromStar: 3,
  dropAfterMisses: 2,
  endingStar: 4,
};

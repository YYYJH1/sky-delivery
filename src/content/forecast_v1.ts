// 推演和效果记录用到的数 v1。
// 只放数据，累计推演次数、写效果记录的函数在核心里（campaign/summary.ts、campaign/effects.ts），推演本身在应用层算。
import type { ForecastV1 } from './table_types.ts';

export const FORECAST_V1: ForecastV1 = {
  maxCharges: 4, // 推演次数最多累积到这么多次。已累积的次数不会过期
  chargesPerPeak: 1, // 每场高峰的小结生成时加几次
  sequences: 16, // 一次推演用几套订单序列分别运行带选项和不带选项的两种情况，由应用层读取
  effectDays: 3, // 购买改装之后，在接下来的几次日结里各写一行这项改装的效果
};

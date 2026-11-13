// 每场高峰的目标线、过线标记和小结对照用到的数 v1。
// 只放数据，计算的函数在核心里。目标线的公式用到的星级线、订单的下限取自口碑表 stars_v1.ts。
import type { GoalsV1 } from './table_types.ts';

export const GOALS_V1: GoalsV1 = {
  minJudgedOrders: 8,
  minLiveOrders: 3,
  lowLoadWaitSeconds: 5,
};

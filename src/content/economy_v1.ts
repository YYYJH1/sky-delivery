// 价格表 v1。只放数据，算价格的函数在核心里。
// 飞机和停机位的价格按每座站各自已有的数量计，每一档都从基础价直接算出后取整。
//
// 下面三处按自动购买脚本的节奏表校准过，括号里是校准之前的初值，其余的数没有校准。
// - 飞机基础价 100（初值 50），停机位基础价 140（初值 70），增长率 1.14 和 1.17 不变。初值下，均衡玩法在第 6 个游戏日结束（36 分钟）
//   就做到写字楼区三星，目标是 45 到 60 分钟，全程不换卡的玩法只晚一天（42 分钟）。校准之后均衡玩法是 54 分钟，全程不换卡的玩法明显更慢（66 分钟）。
// - 第 2 座站的基准价 330（初值 500），开通写字楼区 200（初值 400）。老街三星之后要先攒开通价，再攒建站价，
//   飞机和停机位涨价之后第二座站要到第 23 分钟，目标是 15 到 20 分钟。
// - 第 4 座站的基准价 2800（初值 3600）。按 3600 算，均衡玩法攒这笔钱最长要 2.2 个游戏日，超过两个游戏日的目标。
import type { EconomyV1 } from './table_types.ts';

export const ECONOMY_V1: EconomyV1 = {
  startMoney: 0,
  droneBase: 100,
  droneGrowth: 1.14,
  bayBase: 140,
  bayGrowth: 1.17,
  baysAtBuild: 2,
  stationBase: [330, 1400, 2800],
  maxStations: 4,
  gateSeconds: [1.2, 0.8, 0.4],
  gatePrice: [0, 240, 900],
  bayCap: { small: 6, medium: 9, large: 12 },
  doubleBoxPrice: 180,
  doubleBoxCapacity: 2,
  nearestLandingPrice: 300,
  nearestLandingMinStations: 2,
  districtOpenPrice: [0, 200, 1600],
  districtOpenStars: 3,
  openingDrones: 2,
};

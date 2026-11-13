// 价格表 v1。只放数据，算价格的函数在核心里。
// 飞机和停机位的价格按每座站各自已有的数量计，每一档都从基础价直接算出后取整：第 n 架飞机 round(droneBase × droneGrowth^(n-3))，第 n 个停机位同理。
//
// 基础价低、增长率高：一座站的头几架飞机和头几个停机位比原来便宜，开局和前期不比原来慢，越往后越贵。
// 满配一座站（12 个停机位、12 架飞机）要 9,843，原来的价格表是 5,068。后期的钱不再几天就花不出去，建满四座站的时间往后推。
// 开通大学城和建第 3、第 4 座站是后期的大笔支出，价格取到每一次攒钱都不超过两个游戏日。
import type { EconomyV1 } from './table_types.ts';

export const ECONOMY_V1: EconomyV1 = {
  startMoney: 0,
  droneBase: 75,
  droneGrowth: 1.3,
  bayBase: 105,
  bayGrowth: 1.38,
  baysAtBuild: 2,
  stationBase: [330, 1900, 2800],
  maxStations: 4,
  gateSeconds: [1.2, 0.8, 0.4],
  gatePrice: [0, 240, 900],
  bayCap: { small: 6, medium: 9, large: 12 },
  doubleBoxPrice: 180,
  doubleBoxCapacity: 2,
  nearestLandingPrice: 300,
  nearestLandingMinStations: 2,
  districtOpenPrice: [0, 200, 2600],
  districtOpenStars: 3,
  openingDrones: 2,
};

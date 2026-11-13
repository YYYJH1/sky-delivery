// 解锁条件 v1。只放数据，判断的函数在核心里。
// 片区和星级都用核心里的编号：0 老街，1 写字楼区，2 大学城。
// 双层货箱和就近降落的条件（停机位到屋顶上限、两座以上的站）在价格表和核心里，不在这里。
import type { UnlocksV1 } from './table_types.ts';

export const UNLOCKS_V1: UnlocksV1 = {
  zoneStations: 2,
  ruleSetsDistrict: 1,
  priceTagsBalance: 140, // 余额够买第一个东西（停机位，140）时价签开放。初值 120 是停机位 70 加飞机 50，飞机和停机位涨价之后改成了停机位的价格
  selectLateAbove: 15, // 初值是 30。老街来单降到 11 以后，第一场午高峰超时超过三成的种子少了。取一成半，第一场午高峰小结就开放这一栏的种子回到八成左右
  selectLatestDay: 1,
  prioDistrict: 1,
  prioNoUpgrade: 2,
  prioGapPoints: 20,
  roundtripDistrict: 1,
  roundtripStar: 3,
  show: [
    { district: 1, after: 0, star: 3 },
    { district: 2, after: 1, star: 3 },
  ],
};

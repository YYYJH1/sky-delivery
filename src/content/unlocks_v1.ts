// 解锁条件 v1。只放数据，判断的函数在核心里。
// 片区和星级都用核心里的编号：0 老街，1 写字楼区，2 大学城。
// 双层货箱和就近降落的条件（停机位到屋顶上限、两座以上的站）在价格表和核心里，不在这里。
import type { UnlocksV1 } from './table_types.ts';

export const UNLOCKS_V1: UnlocksV1 = {
  zoneStations: 2,
  ruleSetsDistrict: 1,
  priceTagsBalance: 105, // 余额够买第一个东西（停机位，105）时价签开放
  selectLateAbove: 15, // 初值是 30。老街来单降到 11 以后，第一场午高峰超时超过三成的种子少了。取一成半，第一场午高峰小结就开放这一栏的种子回到八成左右
  selectLatestDay: 1,
  prioDistrict: 1,
  prioOpensWith: 1, // 随写字楼区开通一起开放，第一个有取舍的选择在开通写字楼区时就出现。取 null 时回到日结时按下面两项判断：连续两次日结没有升星，并且准时率低 20 个百分点以上
  prioNoUpgrade: 2,
  prioGapPoints: 20,
  roundtripDistrict: 1,
  roundtripStar: 3,
  // 大学城在写字楼区到四星之后才显示，所以要先把写字楼区做到四星，再去开通大学城。开通要的星级是三星（economy_v1 的 districtOpenStars），四星已经满足
  show: [
    { district: 1, after: 0, star: 3 },
    { district: 2, after: 1, star: 4 },
  ],
};

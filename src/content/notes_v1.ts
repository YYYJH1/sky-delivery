// 高峰小结的说明句、便签和新店位置用到的数 v1。
// 只放数据，选句子和判断时机的函数在核心里。百分数都是整数的百分点。
import type { NotesV1 } from './table_types.ts';

export const NOTES_V1: NotesV1 = {
  onTimeHigh: 90,
  takeoffWaitPct: 15, // 附加句：某座站至少有 1 架无人机等待起飞的时间占这一场的 15% 以上。单位是百分点。
  landQueueMin: 1,
  bayIdleShare: 50,
  emptyFlightPct: 35, // 附加句：全部无人机空载飞行的时间占机队时间的 35% 以上。单位是百分点。模拟里高峰期间空载飞行占 33% 到 42%。
  notNearestShare: 30,
  districtLowGap: 20,
  gateBusyPct: 10, // 便签：某座站至少有 1 架无人机排队（等待起飞或等待降落）的时间占这一场的比例大于 10%。单位是百分点。
  redOrderSeconds: 22,
  middleRadius: 0.4,
};

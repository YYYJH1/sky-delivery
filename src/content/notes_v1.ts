// 高峰小结的说明句、便签和新店位置用到的数 v1。
// 只放数据，选句子和判断时机的函数在核心里。百分数都是整数的百分点。
import type { NotesV1 } from './table_types.ts';

export const NOTES_V1: NotesV1 = {
  onTimeHigh: 90,
  landQueueMin: 1,
  bayIdleShare: 50,
  notNearestShare: 30,
  districtLowGap: 20,
  redOrderSeconds: 22,
  middleRadius: 0.4,
};

// 开局的五张订单 v1。店和楼是地图 v1 里的下标，步是游戏开始后的步（一步 0.1 秒）。
// 第一张在开局时来自老街最热的店（nameIndex 为 0），之后在第 10 到 36 秒之间依次出现四张。
// 第三、四张只差 0.6 秒，这时一架飞机还在送上一张订单，只有一架空着，玩家要决定先送哪一张。
// 都是普通单，楼取离店较近的老街住宅。五张订单都有了结果之后，自动派单打开，随机订单开始产生。
import type { OpeningOrderV1 } from './table_types.ts';

export const OPENING_ORDERS_V1: OpeningOrderV1[] = [
  { step: 0, merchant: 0, building: 10, portion: 1, prepSteps: 60 },
  { step: 100, merchant: 6, building: 6, portion: 1, prepSteps: 50 },
  { step: 180, merchant: 4, building: 2, portion: 1, prepSteps: 70 },
  { step: 186, merchant: 3, building: 7, portion: 1, prepSteps: 60 },
  { step: 360, merchant: 10, building: 3, portion: 1, prepSteps: 50 },
];

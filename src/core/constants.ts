// 模拟核心的常量。时间一律用整数步，一步 100 毫秒。

// ---- 时间 ----
export const STEP_MS = 100;
export const DT = 0.1; // 每步的秒数
export const STEPS_PER_SECOND = 10;
export const DAY_STEPS = 3600; // 一个游戏日 360 秒
export const DRAIN_STEPS = 2400; // 最后一天之后不再来单、继续运行的步数，让每张订单都有结局

// 每 0.5 秒派一次单
export const DECIDE_EVERY = 5;

// ---- 飞行与电量 ----
export const SPEED = 110; // 单位/秒
export const STEP_DIST = SPEED * DT; // 每步飞行距离
export const RANGE = 7000; // 满电航程
export const HOVER_COST = 30 * DT; // 悬停（等出餐、等降落）每步耗电
export const HOVER_MARGIN = 150; // 派单前电量检查的悬停余量
export const RESERVE = 0.1 * RANGE; // 派单前电量检查保留的电量
export const LOW_BATTERY = 0.15; // 电量低于此比例的降落排到队首
export const EMPTY_SPEED_FACTOR = 0.2; // 电量耗尽后的速度比例

// ---- 动作时长（步）----
export const TAKEOFF_STEPS = 8;
export const LAND_STEPS = 8;
export const PICK_STEPS = 12;
export const DROP_STEPS = 12;

// ---- 订单 ----
export const PROMISE_STEPS = 300; // 承诺 30 秒
export const CANCEL_STEPS = 900; // 等满 90 秒仍没有被取走就退单
export const PICK_SECONDS = 1.2; // 估算送达时间用的取餐和送达动作时长
export const DROP_SECONDS = 1.2;
export const PROMISE_SECONDS = 30;
export const PREP_MIN_SECONDS = 4; // 出餐时间 4 到 10 秒
export const PREP_MAX_SECONDS = 10;
export const BIG_ORDER_SHARE = 0.15; // 大单占比
export const BIG_ORDER_MULTIPLIER = 1.8; // 大单金额倍数
export const AMOUNT_BASE = 5; // 订单金额：5 元起，另按距离计
export const AMOUNT_PER_DISTANCE = 0.004;

// ---- 派单规则 ----
export const ZONE_WAIT_STEPS = 100; // 「延迟支援」：订单下单后只有最近的站能接，满 10 秒其他站也能接
export const PUSH_STEPS = 60; // 「一起送」：已有订单的预计送达最多被推迟 6 秒

// ---- 结算 ----
export const TIP_SHARE = 0.1; // 在承诺时间的六成以内送达，另加一成打赏
export const TIP_WITHIN = 0.6;
export const LATE_SLOPE = 0.7; // 超时后金额线性下降，到承诺时间的两倍降到三成
export const PAY_FLOOR = 0.3;
export const PAY_FLOOR_AT = 2;

// ---- 起降口 ----
export const DEFAULT_GATE_INTERVAL = 1.2; // 秒，两次动作开始之间的最小间隔
export const DEFAULT_CHARGE_TIME = 14; // 秒，从空电充满

// ---- 运力占用：全天按时刻分段 ----
export const BUSY_SEGMENTS = 24; // 一天分 24 段
export const BUSY_SEGMENT_STEPS = DAY_STEPS / BUSY_SEGMENTS; // 每段 150 步，即 15 秒。第 i 段是天内的第 150i 到 150i + 149 步

// ---- 日程：高峰窗口与小结时刻（天内的步）----
export const NOON_WINDOW = { start: 600, end: 1500 } as const; // 第 60 到 150 秒
export const EVENING_WINDOW = { start: 2150, end: 3100 } as const; // 第 215 到 310 秒
export const SUMMARY_DELAY = 300; // 小结在高峰结束 30 秒后生成

// ---- 状态编号 ----
export const OrderStatus = { Pending: 0, Assigned: 1, Picked: 2, Delivered: 3, Cancelled: 4 } as const;

export const DroneState = {
  Dock: 0, // 停在机位上，可以接单
  TakeoffQueue: 1, // 已接单，在起降口排队等起飞
  Takeoff: 2, // 起飞动作中
  Fly: 3, // 飞往取餐点、送餐点或回站
  Prep: 4, // 到了店里，悬停等出餐
  Pick: 5, // 取餐动作
  Drop: 6, // 送达动作
  LandQueue: 7, // 回到站点上空，盘旋等待降落
  Land: 8, // 降落动作中
} as const;

export const StopKind = { Pickup: 0, Drop: 1 } as const;

export const PeakId = { Noon: 0, Evening: 1 } as const;

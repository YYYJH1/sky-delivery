// 离开期间的进账。玩家关闭游戏，或网页不可见超过一分钟，回来时按最近的进账速度结算一笔钱。
//
// 公式：每秒进账 × 离开的秒数 × 30%。
//   每秒进账等于最近两个完整游戏日的订单进账合计除以 720 秒，不扣除购买支出。
//   完整的游戏日不足两个时，用已完成的那一个，除以 360 秒。第一个游戏日还没结束时不结算。
//   离开时间超过 30 分钟的部分不计，上限相当于 1.5 个游戏日的进账。
//   进账取向下的整数，和界面显示的数一致。
//
// 只做三件事：余额加上这笔钱，记一条记录，返回这条记录。不改游戏内时间、口碑、订单和别的任何状态，
// 游戏内时间在离开期间不前进。系统时间被调回过去的情形由调用方处理：离开的秒数算成 0，这里就不结算。
// 纯函数，同样的状态和离开的秒数得到同样的结果。离开的秒数由调用方用墙上时间算出，核心不读时钟。
import { DAY_STEPS, STEPS_PER_SECOND } from '../constants.ts';
import type { AwayRecord, SimState } from '../types.ts';

/** 离开期间按进账速度的这个百分数结算。 */
export const AWAY_PERCENT = 30;

/** 离开时间超过这个秒数的部分不计。 */
export const AWAY_CAP_SECONDS = 1800;

/** 一个游戏日有多少秒。 */
export const AWAY_DAY_SECONDS = DAY_STEPS / STEPS_PER_SECOND;

/** 参与计算的完整游戏日最多取几个。 */
export const AWAY_MAX_DAYS = 2;

/** 记录最多留几条，再多就丢掉最早的。 */
export const AWAY_LOG_LIMIT = 100;

/** 浮点误差的余量。进账本来是整数时，不让 119.99999999999999 被取成 119。和界面的 wholeMoney 同一个办法。 */
const EPSILON = 1e-9;

export interface AwayQuote {
  /** 参与计算的完整游戏日数：0 表示不结算，其余是 1 或 2。 */
  days: number;
  /** 每秒进账。没有可依据的游戏日时为 0。 */
  rate: number;
  /** 计入的秒数，已经按上限截断。 */
  counted: number;
  /** 应得的钱，向下取整的整数。 */
  amount: number;
}

const NOTHING: AwayQuote = { days: 0, rate: 0, counted: 0, amount: 0 };

/**
 * 离开 seconds 秒，现在结算会给多少钱。只算，不改状态。
 * 沙盒模式没有余额，离开的秒数不是正的有限数，或者第一个游戏日还没结束时，什么也不给。
 */
export function quoteAway(state: SimState, seconds: number): AwayQuote {
  const campaign = state.campaign;
  if (campaign === null) return NOTHING;
  if (!Number.isFinite(seconds) || !(seconds > 0)) return NOTHING;
  // 已经完整结束的游戏日数：第 d 天在第 (d + 1) × 3600 步结束
  const completed = Math.floor(state.step / DAY_STEPS);
  if (completed < 1) return NOTHING;
  const days = Math.min(AWAY_MAX_DAYS, completed);
  let income = 0;
  for (let k = 1; k <= days; k++) income += campaign.income[completed - k] ?? 0;
  if (!(income > 0)) return { ...NOTHING, days };
  const windowSeconds = days * AWAY_DAY_SECONDS;
  const counted = Math.min(seconds, AWAY_CAP_SECONDS);
  const amount = Math.floor((income * counted * AWAY_PERCENT) / (windowSeconds * 100) + EPSILON);
  return { days, rate: income / windowSeconds, counted, amount };
}

/**
 * 结算离开期间的进账：把钱加进余额，记一条记录并返回它。
 * 不足一元，或者不该给的情形（见 quoteAway），什么也不做，返回 null，也不记录。
 */
export function settleAway(state: SimState, seconds: number): AwayRecord | null {
  const campaign = state.campaign;
  if (campaign === null) return null;
  const quote = quoteAway(state, seconds);
  if (!(quote.amount >= 1)) return null;
  campaign.money += quote.amount;
  const record: AwayRecord = { step: state.step, seconds, amount: quote.amount };
  campaign.away.push(record);
  if (campaign.away.length > AWAY_LOG_LIMIT) campaign.away.splice(0, campaign.away.length - AWAY_LOG_LIMIT);
  return { ...record };
}

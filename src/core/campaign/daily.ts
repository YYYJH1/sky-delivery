// 日程阶段：每步最先做。沙盒模式下什么也不做。
// 经营模式里按步数决定要不要做这几件事，顺序固定：
// 1 日结：第 d 天的日结在第 (d + 1) × 3600 步开始时做，在产生订单之前，新一天的订单量因此用新的星级
// 2 午晚两套策略的切换：天内第 0 步换成午高峰的一套，第 2150 步换成晚高峰的一套
// 3 高峰开始：天内第 600 步和第 2150 步，给各个开通的片区算这一场要达到的准时率
// 4 高峰小结：小结时刻（高峰结束 30 秒后，天内第 1800 步和第 3400 步）生成这一场的记录
// 5 检查靠状态判断的开放项
import { DAY_STEPS } from '../constants.ts';
import { dayOf, peakStartingAt, summaryStep } from '../systems/schedule.ts';
import type { SimState } from '../types.ts';
import { recordPeakGoals } from './goals.ts';
import { switchRuleSet } from './rulesets.ts';
import { settleDay } from './settle.ts';
import { recordPeakSummary } from './summary.ts';
import { refreshUnlocks } from './unlocks.ts';

export function dailyPhase(state: SimState): void {
  if (state.campaign === null) return;
  const step = state.step;
  const day = dayOf(step);
  if (step > 0 && step % DAY_STEPS === 0) settleDay(state, day - 1);
  switchRuleSet(state);
  const starting = peakStartingAt(step);
  if (starting !== null) recordPeakGoals(state, day, starting);
  if (step === summaryStep(day, 'noon')) recordPeakSummary(state, day, 'noon');
  if (step === summaryStep(day, 'evening')) recordPeakSummary(state, day, 'evening');
  refreshUnlocks(state);
}

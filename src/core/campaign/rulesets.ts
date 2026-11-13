// 午晚两套策略。开通写字楼区之前只有一套，就是 state.rules。开通时分成两套，都以当时的策略为初值。
// 从一天开始（天内第 0 步）到晚高峰开始（天内第 2150 步）用午高峰的一套，从第 2150 步到一天结束用晚高峰的一套。
// 切换由每步开始时的日程阶段做，写进 state.rules，不记入 stats.ruleChanges，所以小结里「这一场中途换过策略」的判断不受影响。
// 分开之后 campaign.ruleSets 里两套始终是最新的，state.rules 等于现在生效的那一套。
import { DAY_STEPS, EVENING_WINDOW } from '../constants.ts';
import type { PeakName } from '../systems/schedule.ts';
import type { RuleSet, SimState } from '../types.ts';

/** 天内第 tick 步用哪一套。 */
export function ruleSetAt(tick: number): PeakName {
  return tick >= EVENING_WINDOW.start ? 'evening' : 'noon';
}

/**
 * 现在 state.rules 是哪一套：最近一次执行过的那一步所处的时段。
 * 切换在每步开始时做，所以第 2150 步还没执行时，state.rules 仍是午高峰的一套。
 */
export function ruleSetInForce(state: SimState): PeakName {
  return state.step === 0 ? 'noon' : ruleSetAt((state.step - 1) % DAY_STEPS);
}

/** 分成两套，都以现在的策略为初值。已经分开时什么也不做。 */
export function splitRuleSets(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null || campaign.ruleSets !== null) return;
  campaign.ruleSets = { noon: { ...state.rules }, evening: { ...state.rules } };
}

/** 把一套策略的内容拷进 state.rules，保持 state.rules 是同一个对象。 */
function copyInto(target: RuleSet, source: RuleSet): void {
  target.select = source.select;
  target.zone = source.zone;
  target.pool = source.pool;
}

/** 日程阶段调用：天内第 0 步和第 2150 步，把应当生效的一套写进 state.rules。没有分开时什么也不做。 */
export function switchRuleSet(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null || campaign.ruleSets === null) return;
  const tick = state.step % DAY_STEPS;
  if (tick !== 0 && tick !== EVENING_WINDOW.start) return;
  copyInto(state.rules, campaign.ruleSets[ruleSetAt(tick)]);
}

/**
 * 买了双层货箱之后，「合单策略」一栏开放，这一栏自动从「单独配送」换成「顺路合并」。
 * 这次自动换卡不算玩家换卡，不记入 stats.ruleChanges。分成两套之后两套都换。
 */
export function autoPoolAfterDoubleBox(state: SimState): void {
  const sets: RuleSet[] = [state.rules];
  const campaign = state.campaign;
  if (campaign !== null && campaign.ruleSets !== null) sets.push(campaign.ruleSets.noon, campaign.ruleSets.evening);
  for (const set of sets) {
    if (set.pool === 'single') set.pool = 'any';
  }
}

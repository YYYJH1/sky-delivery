export { buildRound, canPool, dispatchRound, dispatchable, planRound, roundSequence } from './run.ts';
export type { Assignment, DispatchResult, Insertion, PlanItem, Round } from './run.ts';
export { recordEarlyDispatches } from './early.ts';
export { previewDispatch } from './ranking.ts';
export type { DispatchPreview } from './ranking.ts';
export { RULE_REGISTRY, getPoolRule, getSelectRule, getZoneRule, hasRule, ruleIds } from './registry.ts';
export type { DispatchContext, PoolRule, SelectRule, ZoneRule } from './types.ts';

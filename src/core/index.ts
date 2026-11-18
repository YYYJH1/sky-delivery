// 模拟核心的公开接口。画面、界面和脚本只从这里引用核心。
export * from './constants.ts';
export { DEFAULT_CONFIG, LAYOUTS, MODES, RETURN_RULES, SCENARIOS, makeConfig } from './config.ts';
export type { ConfigOverrides } from './config.ts';
export { createState, prioritizeOrder, setRules } from './state.ts';
export { LIGHT_STEP_PHASES, STEP_PHASES, advance, step, stepLight } from './step.ts';
export type { StepObserver, StepPhase } from './step.ts';
export { hashState } from './hash.ts';
export { addOrder } from './systems/orders.ts';
export { creditOrder, deliverOrder, settlement } from './systems/settlement.ts';
export { createRng, nextFloat, nextInt, nextRange, poisson } from './rng.ts';
export type { RngState } from './rng.ts';
export { buildWorld, planStations } from './world.ts';
export { buildRound, canPool, dispatchRound, dispatchable, planRound, previewDispatch, recordEarlyDispatches, roundSequence, ruleIds } from './dispatch/index.ts';
export type {
  Assignment,
  DispatchContext,
  DispatchPreview,
  DispatchResult,
  Insertion,
  PlanItem,
  PoolRule,
  Round,
  SelectRule,
  ZoneRule,
} from './dispatch/index.ts';
export { dayOf, peakAt, peakInProgress, peakStartingAt, peakWindow, summaryStep } from './systems/schedule.ts';
export type { PeakName } from './systems/schedule.ts';
export { averageMetrics, dayMetrics, meanFromDay2, peakSummary, stationStats, windowStats } from './metrics.ts';
export type {
  DayMetrics,
  DistrictStats,
  MeanMetrics,
  PeakSummary,
  ScopeMetrics,
  ScopeName,
  Segments,
  StationStats,
  WindowStats,
} from './metrics.ts';
export { runDays, runMetrics } from './run.ts';
export type { RunMetrics } from './run.ts';
// ---- 经营模式 ----
export { CONTENT_VERSION } from '../content/version.ts';
// 应用层只能经这个入口读到内容表里的数：推演的订单序列数、推演次数的上限
export { FORECAST_V1 } from '../content/forecast_v1.ts';
export { buildCampaignWorld, refreshShops } from './campaign/map.ts';
export { campaignArrivals, districtLambda } from './campaign/arrivals.ts';
export { currentOpeningMultiplier, districtOpenDay, openingMultiplier, openingPhase } from './campaign/opening.ts';
export type { OpeningPhase } from './campaign/opening.ts';
export { districtPatienceSeconds, orderPatienceSteps, patienceSteps, shortestPatienceSteps } from './campaign/patience.ts';
export { applyCommand, quoteCommand } from './campaign/commands.ts';
export type { Command, CommandFailure, CommandQuote, CommandResult, CommandType, PriceKind } from './campaign/commands.ts';
export { bayCap, bayPrice, dronePrice, gatePrice, stationBasePrice, stationPrice } from './campaign/prices.ts';
export { fleetOf, inboundTo, nearestFreeStation, stationCount } from './systems/stations.ts';
export { DISTRICT_NAMES, RULE_NAMES } from './strings.ts';
// ---- 经营模式：日结、口碑、解锁、两套策略、高峰小结、便签 ----
export { settleDay } from './campaign/settle.ts';
export { dailyPhase } from './campaign/daily.ts';
export { decideStar, districtNote, keepRule, meetsRule, pct, pickNoteKind, resultStep, starRule, tallyResults, windowOfDay } from './campaign/rating.ts';
export type { DistrictNote, NoteKind, ResultCounts, StarDecision } from './campaign/rating.ts';
export { UNLOCK_KEYS, isUnlocked, lockedUnlocks, refreshUnlocks, ruleLock, ruleOffered, ruleOpen, showKeyOf, unlock } from './campaign/unlocks.ts';
export { autoPoolAfterDoubleBox, ruleSetAt, ruleSetInForce, splitRuleSets, switchRuleSet } from './campaign/rulesets.ts';
export { lastPeakTicket, peakRecord, pickExtra, pickMain, pickSentences, recordPeakSummary, sharesOf100 } from './campaign/summary.ts';
export { districtGoal, goalOf, goalRule, judgeable, liveRows, peakGoals, reachesLine, recordPeakGoals } from './campaign/goals.ts';
export type { LiveRow, LiveView } from './campaign/goals.ts';
export { attachBaseline, finishShadow, forwardToShadow, isForwarded, openShadow, replayOnCopy } from './campaign/shadow.ts';
export type { BaselineDraft, Shadow } from './campaign/shadow.ts';
export { FLEET_CLASSES, FleetClass, busySegmentOf, emptyTally, fleetClassOf, isBackFlight, recordFleet, recordSortie, resetPeakTally, takeDayBusy } from './campaign/fleet.ts';
export { gainTotal, incomeStanding, peakGain, peakStanding } from './campaign/records.ts';
export { effectValue, recordTwin, settleEffects, watchPurchase } from './campaign/effects.ts';
export type { PeakStanding, Standing } from './campaign/records.ts';
export type { PeakTicket, SentenceInput, Sentences } from './campaign/summary.ts';
export { TIP_IDS, hasTip, markTipRead, pushTip, tipsPhase, unreadTips } from './campaign/tips.ts';
export { newShopAt, placeDirection } from './campaign/places.ts';
export type { PlaceRect } from './campaign/places.ts';
// ---- 经营模式：离开期间的进账 ----
export { AWAY_CAP_SECONDS, AWAY_DAY_SECONDS, AWAY_LOG_LIMIT, AWAY_MAX_DAYS, AWAY_PERCENT, quoteAway, settleAway } from './campaign/away.ts';
export type { AwayQuote } from './campaign/away.ts';
export type * from './types.ts';

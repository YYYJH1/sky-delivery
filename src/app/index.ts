// 运行循环的公开接口。界面层只从这里引用。
export { AUTOSAVE_INTERVAL_STEPS, CHANGE_SAVE_DELAY_MS, autosaveReason, milestonesBetween } from './autosave.ts';
export type { AutosaveInput, AutosaveReason, Milestones } from './autosave.ts';
export { attachBrowser, browserEnv } from './browser.ts';
export type { Attached, BrowserEnv } from './browser.ts';
export { AWAY_AFTER_MS, CATCH_UP_STEPS_PER_FRAME, MAX_STEPS_PER_FRAME, SPEEDS, awaySecondsSince, createLoop } from './loop.ts';
export type { FrameResult, Loop, LoopOptions, ResumeOutcome, Speed } from './loop.ts';
export { createPlay } from './play.ts';
export type { Play, PlayOptions } from './play.ts';
export { MAX_TWINS, createTwins, twinCommand } from './twins.ts';
export type { TwinCopy, TwinSet } from './twins.ts';
export {
  DEFAULT_SEQUENCES,
  HORIZON_PEAKS,
  advanceTo,
  applyOption,
  copyFull,
  copyShared,
  emptyTiming,
  forecast,
  forecastBatch,
  forecastEndStep,
  forecastPartRuns,
  forecastRuns,
  mergeForecast,
  openCopy,
  sequenceSeed,
  signTestThreshold,
  summarizeForecast,
  verdictOf,
} from './forecast.ts';
export type { ForecastDone, ForecastParams, ForecastPart, ForecastResult, ForecastTiming, ForecastUnavailable, ForecastVerdict, StateCopier } from './forecast.ts';
export { ForecastCancelled, MAX_FORECAST_WORKERS, createForecastClient, defaultWorkerCount, disposeForecast, requestForecast, splitRange, workerCountFor } from './forecast-client.ts';
export type { ForecastClient, ForecastClientOptions, ForecastHandle, WorkerLike } from './forecast-client.ts';
// 后台线程的文件（forecast-worker.ts）不从这里导出：它在线程里才有入口，界面和测试需要它的类型时直接引用那个文件
export { createSession } from './session.ts';
export type { SaveReport, Session, SessionHost, SessionOptions } from './session.ts';

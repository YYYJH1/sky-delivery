// 运行循环的公开接口。界面层只从这里引用。
export { AUTOSAVE_INTERVAL_STEPS, CHANGE_SAVE_DELAY_MS, autosaveReason, milestonesBetween } from './autosave.ts';
export type { AutosaveInput, AutosaveReason, Milestones } from './autosave.ts';
export { attachBrowser, browserEnv } from './browser.ts';
export type { Attached, BrowserEnv } from './browser.ts';
export { AWAY_AFTER_MS, CATCH_UP_STEPS_PER_FRAME, MAX_STEPS_PER_FRAME, SPEEDS, awaySecondsSince, createLoop } from './loop.ts';
export type { FrameResult, Loop, LoopOptions, ResumeOutcome, Speed } from './loop.ts';
export { createSession } from './session.ts';
export type { SaveReport, Session, SessionHost, SessionOptions } from './session.ts';

// 无头运行：从开局运行指定的游戏日数，再多跑一段不再来单的时间，让每张订单都有结局。
import type { ConfigOverrides } from './config.ts';
import { DAY_STEPS, DRAIN_STEPS } from './constants.ts';
import { dayMetrics, meanFromDay2 } from './metrics.ts';
import type { DayMetrics, MeanMetrics } from './metrics.ts';
import { createState } from './state.ts';
import { advance } from './step.ts';
import type { SimState } from './types.ts';

export function runDays(overrides: ConfigOverrides, days: number): SimState {
  if (!Number.isInteger(days) || days < 1) throw new RangeError('days must be a positive integer');
  const state = createState({ ...overrides, orderEndStep: days * DAY_STEPS });
  advance(state, days * DAY_STEPS + DRAIN_STEPS);
  return state;
}

export interface RunMetrics {
  daily: DayMetrics[];
  mean: MeanMetrics; // 第 2 天起的平均
}

export function runMetrics(state: SimState, days: number): RunMetrics {
  const daily = Array.from({ length: days }, (_, day) => dayMetrics(state, day));
  return { daily, mean: meanFromDay2(daily) };
}

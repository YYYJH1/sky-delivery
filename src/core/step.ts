// 一步的执行顺序：日程（经营模式的日结、两套策略的切换、高峰小结）、产生订单、退单、派单（每 5 步一次）、起降口、飞机状态机、统计、便签。
// 每个阶段是一个读写同一个状态对象的函数。测试可以按这张表逐阶段推进。
// 日程和便签两个阶段只在经营模式里做事，沙盒模式下什么也不做。
import { campaignArrivals } from './campaign/arrivals.ts';
import { dailyPhase } from './campaign/daily.ts';
import { tipsPhase } from './campaign/tips.ts';
import { DECIDE_EVERY } from './constants.ts';
import { dispatchRound } from './dispatch/run.ts';
import { tickDrones } from './systems/drones.ts';
import { expireOrders } from './systems/expiry.ts';
import { generateArrivals } from './systems/orders.ts';
import { recordStats } from './systems/stats.ts';
import { runGates } from './systems/stations.ts';
import type { SimState } from './types.ts';

export interface StepPhase {
  name: string;
  run(state: SimState): void;
}

function dispatchPhase(state: SimState): void {
  if (state.step % DECIDE_EVERY === 0) dispatchRound(state);
}

/** 产生订单：经营模式按内容表的片区规律和开局订单，沙盒模式按场景的到达曲线。 */
function arrivalsPhase(state: SimState): void {
  if (state.campaign !== null) campaignArrivals(state);
  else generateArrivals(state);
}

export const STEP_PHASES: readonly StepPhase[] = [
  { name: 'daily', run: dailyPhase },
  { name: 'arrivals', run: arrivalsPhase },
  { name: 'expire', run: expireOrders },
  { name: 'dispatch', run: dispatchPhase },
  { name: 'gates', run: runGates },
  { name: 'drones', run: tickDrones },
  { name: 'stats', run: recordStats },
  { name: 'tips', run: tipsPhase },
];

/** 观察者：在每个阶段前后各调用一次，给测试和调试工具用。不得修改状态。 */
export interface StepObserver {
  before?(phase: string, state: SimState): void;
  after?(phase: string, state: SimState): void;
}

/** 推进一步（100 毫秒）。 */
export function step(state: SimState, observer?: StepObserver): void {
  for (const phase of STEP_PHASES) {
    observer?.before?.(phase.name, state);
    phase.run(state);
    observer?.after?.(phase.name, state);
  }
  state.step += 1;
}

/** 连续推进若干步。 */
export function advance(state: SimState, steps: number): void {
  if (!Number.isInteger(steps) || steps < 0) throw new RangeError('steps must be a non-negative integer');
  for (let i = 0; i < steps; i++) step(state);
}

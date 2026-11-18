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

/** 轻量派单阶段：只给副本用，见 dispatchRound 的 light 参数。 */
function dispatchPhaseLight(state: SimState): void {
  if (state.step % DECIDE_EVERY === 0) dispatchRound(state, true);
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

/** 轻量副本用的阶段表：派单阶段换成轻量的，其余阶段与 STEP_PHASES 是同一批函数。 */
export const LIGHT_STEP_PHASES: readonly StepPhase[] = STEP_PHASES.map((phase) => (phase.name === 'dispatch' ? { name: phase.name, run: dispatchPhaseLight } : phase));

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

/**
 * 轻量副本推进一步。与 step 的差别只有派单阶段不算「提前派出」：不算按下单顺序的比较名单，order.early、stats.early 和小结记录里的
 * early 不再更新。其余的计算与 step 完全相同，订单交给哪架飞机、插进哪条路线、起降、电量、小结里的准时数和收入都与 step 逐位相同。
 * 提前派出的记录只进统计和小结的文字，不影响派单、星级和收入，所以只读这些结果的副本可以用它省下一半的派单计算。
 * 只能给不进存档、也不看「提前派出」统计的副本用（推演、小结的开局策略对照、效果记录里不购买的副本），主状态永远用 step。
 * 副本是否轻量不写进 SimState：它不参与哈希和存档，由推进它的代码选 step 还是 stepLight。
 */
export function stepLight(state: SimState): void {
  for (const phase of LIGHT_STEP_PHASES) phase.run(state);
  state.step += 1;
}

/** 连续推进若干步。 */
export function advance(state: SimState, steps: number): void {
  if (!Number.isInteger(steps) || steps < 0) throw new RangeError('steps must be a non-negative integer');
  for (let i = 0; i < steps; i++) step(state);
}

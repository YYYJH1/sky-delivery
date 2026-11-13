// 只读的派单预览：按当前生效的三张卡，给出等待订单在这一刻的派单先后。
// 画面用它在订单旁边标名次。预览和实际派单走同一套代码（buildRound、roundSequence、planRound），
// 不另写一份派单逻辑，也不修改状态：这两个函数和规则的 rank 都只读状态。
import type { SimState } from '../types.ts';
import { getSelectRule } from './registry.ts';
import { buildRound, planRound, roundSequence } from './run.ts';

export interface DispatchPreview {
  /**
   * 等待派单的订单编号，按派单的先后排。这一轮会派出的订单在前，按派出的顺序。
   * 其余的订单按当前「先送哪张单」的排序，玩家点击插队的订单在最前。
   * 只包含现在可以派的订单：经营模式开局阶段自动派单关着，没有被点击的订单不在里面。
   */
  ids: number[];
  /** ids 的前几张是这一轮会派出的。没有空闲飞机，或者订单都没有飞机能接时为 0 */
  dispatching: number;
}

/**
 * 如果这一刻做一轮派单，订单会按什么先后派出。只读。
 * 在派单的那一步之前调用，ids 的前 dispatching 张与随后 dispatchRound 实际派出的订单相同，顺序也相同。
 * 状态里没有等待派单的订单时返回空名单。
 */
export function previewDispatch(state: SimState): DispatchPreview {
  if (state.pending.length === 0) return { ids: [], dispatching: 0 };
  const round = buildRound(state);
  const { ctx } = round;
  if (ctx.pendingIds.length === 0) return { ids: [], dispatching: 0 };
  const sequence = roundSequence(round, getSelectRule(state.rules.select));
  const plan = planRound(round, sequence);
  const first = plan.map((item) => ctx.pendingIds[item.k] as number);
  const taken = new Set(first);
  const rest = sequence.map((k) => ctx.pendingIds[k] as number).filter((id) => !taken.has(id));
  return { ids: [...first, ...rest], dispatching: first.length };
}

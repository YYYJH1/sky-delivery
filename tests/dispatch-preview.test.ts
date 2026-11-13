// 只读的派单预览（previewDispatch）：不改状态，和实际派单一致，换卡之后名次跟着变。
import { describe, expect, it } from 'vitest';
import {
  DECIDE_EVERY,
  OrderStatus,
  STEP_PHASES,
  addOrder,
  advance,
  createState,
  dispatchRound,
  hashState,
  previewDispatch,
  prioritizeOrder,
  setRules,
  step,
} from '../src/core/index.ts';
import type { DispatchPreview, RuleSet, SimState } from '../src/core/index.ts';
import { CITY, OPENING } from './helpers.ts';
import { campaignOf, clickOpening, quietState, runningState } from './campaign-helpers.ts';

/** 与 step() 相同的一步，只是在派单阶段之前调用预览，并留下实际派出的订单。 */
function stepWithPreview(state: SimState): { preview: DispatchPreview | null; dispatched: number[] | null } {
  let preview: DispatchPreview | null = null;
  let dispatched: number[] | null = null;
  for (const phase of STEP_PHASES) {
    if (phase.name === 'dispatch') {
      if (state.step % DECIDE_EVERY === 0) {
        preview = previewDispatch(state);
        dispatched = dispatchRound(state).dispatched;
      }
    } else {
      phase.run(state);
    }
  }
  state.step += 1;
  return { preview, dispatched };
}

/** 把一个状态往前推进 steps 步，每个派单的步都核对预览。返回核对过的、有订单派出的轮数。 */
function checkAgainstDispatch(state: SimState, steps: number): number {
  let rounds = 0;
  for (let i = 0; i < steps; i++) {
    const { preview, dispatched } = stepWithPreview(state);
    if (preview === null || dispatched === null) continue;
    expect(preview.ids.slice(0, preview.dispatching), `第 ${state.step - 1} 步`).toEqual(dispatched);
    expect(preview.dispatching).toBe(dispatched.length);
    if (dispatched.length > 0) rounds += 1;
  }
  return rounds;
}

describe('previewDispatch：只读', () => {
  it('调用前后状态的哈希和完整内容都相同，在运行中的多个时刻都是', () => {
    const state = runningState(42, [5, 1, 1]); // 老街五星，订单多，飞机不够用
    for (let i = 0; i < 60; i++) {
      advance(state, 50);
      const hashBefore = hashState(state);
      const jsonBefore = JSON.stringify(state);
      previewDispatch(state);
      previewDispatch(state);
      expect(hashState(state)).toBe(hashBefore);
      expect(JSON.stringify(state)).toBe(jsonBefore);
    }
    expect(state.orders.length).toBeGreaterThan(40);
  });

  it('沙盒模式的状态也一样', () => {
    const state = createState(OPENING);
    advance(state, 900);
    const hashBefore = hashState(state);
    const jsonBefore = JSON.stringify(state);
    const preview = previewDispatch(state);
    expect(preview.ids.length).toBe(state.pending.length);
    expect(hashState(state)).toBe(hashBefore);
    expect(JSON.stringify(state)).toBe(jsonBefore);
  });

  it('没有等待的订单时返回空名单', () => {
    expect(previewDispatch(quietState())).toEqual({ ids: [], dispatching: 0 });
  });
});

describe('previewDispatch：与实际派单一致', () => {
  it('经营模式，换着三栏的卡跑，每一轮派单之前的预览与实际派出的订单相同，顺序也相同', () => {
    let rounds = 0;
    const combos: Partial<RuleSet>[] = [
      { select: 'fifo' },
      { select: 'deadline' },
      { select: 'roundtrip' },
      { select: 'prioOld', zone: 'hybrid' },
      { select: 'deadline', zone: 'strict' },
    ];
    for (const [k, rules] of combos.entries()) {
      // 老街五星，开局只有一座站、两架飞机，订单会积压，名单里才有没派出的订单
      const state = runningState(40 + k, [5, 1, 1]);
      setRules(state, rules);
      rounds += checkAgainstDispatch(state, 2400);
    }
    expect(rounds).toBeGreaterThan(100);
  });

  it('一趟可以送两单时，插进别的飞机路线的订单也在名单里，与实际一致', () => {
    let rounds = 0;
    for (const pool of ['same', 'any']) {
      const state = createState({ ...CITY, rules: { select: 'deadline', zone: 'global', pool }, capacity: 2, seed: 7 });
      rounds += checkAgainstDispatch(state, 1500);
    }
    expect(rounds).toBeGreaterThan(80);
  });

  it('飞机不够时，名单后面有没派出的订单，前面有派出的订单', () => {
    const state = createState({ ...OPENING, seed: 11, peakRate: 40 });
    advance(state, 1000);
    const preview = previewDispatch(state);
    expect(state.pending.length).toBeGreaterThanOrEqual(4);
    expect(preview.ids.length).toBe(state.pending.length);
    expect(preview.dispatching).toBeLessThan(preview.ids.length);
    for (const id of preview.ids) expect(state.orders[id]?.status).toBe(OrderStatus.Pending);
    expect([...preview.ids].sort((a, b) => a - b)).toEqual([...state.pending].sort((a, b) => a - b));
  });
});

describe('previewDispatch：名次由当前生效的卡决定', () => {
  /** 一个安静的状态，没有飞机可用，三张订单：编号 0 的店离楼最远，1 其次，2 最近，下单越晚越近。 */
  function threeOrders(): SimState {
    const state = quietState();
    for (const d of state.drones) d.removed = true; // 没有可用飞机，名单只由卡的排序决定
    const merchants = [0, 4, 6]; // 地图 v1 里开局就开张的三家老街的店
    const building = 3;
    merchants.forEach((merchant, i) => addOrder(state, { merchant, building, portion: 1, prepSteps: 50, tOrder: i * 10 }));
    return state;
  }

  it('先到先送：按下单的先后，换成短程优先之后名次变了', () => {
    const state = threeOrders();
    expect(previewDispatch(state)).toEqual({ ids: [0, 1, 2], dispatching: 0 });
    setRules(state, { select: 'roundtrip' });
    const trips = state.orders.map((o) => o.dMB);
    const expected = [0, 1, 2].sort((a, b) => (trips[a] as number) - (trips[b] as number));
    expect(expected).not.toEqual([0, 1, 2]);
    expect(previewDispatch(state)).toEqual({ ids: expected, dispatching: 0 });
    setRules(state, { select: 'fifo' });
    expect(previewDispatch(state).ids).toEqual([0, 1, 2]);
  });

  it('玩家点击插队的订单排在最前，点了之后名次跟着变', () => {
    const state = threeOrders();
    expect(prioritizeOrder(state, 2)).toBe(true);
    expect(previewDispatch(state).ids).toEqual([2, 0, 1]);
  });

  it('有一架空闲飞机时，这一轮会派出的订单在前，名次与实际派出的相同', () => {
    const state = threeOrders();
    const drone = state.drones[0];
    if (drone === undefined) throw new Error('no drone');
    drone.removed = false;
    setRules(state, { select: 'roundtrip' });
    const preview = previewDispatch(state);
    expect(preview.dispatching).toBe(1);
    const sent = dispatchRound(state).dispatched;
    expect(sent).toEqual(preview.ids.slice(0, 1));
  });

  it('经营模式开局阶段自动派单关着：没有被点击的订单不在名单里，点击之后才在', () => {
    const state = quietState({ seed: 42 }, false);
    campaignOf(state).opening.done = false;
    addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 60 });
    addOrder(state, { merchant: 6, building: 6, portion: 1, prepSteps: 50 });
    expect(previewDispatch(state).ids).toEqual([]);
    clickOpening(state); // 开局订单的编号在 campaign.opening.orders 里，这里手工放的订单不在其中
    expect(previewDispatch(state).ids).toEqual([]);
    expect(prioritizeOrder(state, 1)).toBe(true);
    expect(previewDispatch(state).ids).toEqual([1]);
    expect(previewDispatch(state).dispatching).toBe(1);
    step(state);
  });
});

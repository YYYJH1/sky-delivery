// 轻量一步（stepLight）和轻量派单（dispatchRound 的 light 参数）：与 step 只差「提前派出」的记录。
// 提前派出的记录有三处：order.early、state.stats.early、小结记录里的 early。除了这三处，轻量的一步推进出的状态与 step 逐位相同。
// 推演、小结的开局策略对照和效果记录里不购买的副本都用轻量的一步，它们读的数（准时、超时、取消、收入、起降排队、每趟单数、回站飞行）不受影响。
import { describe, expect, it } from 'vitest';
import { createPlay } from '../src/app/index.ts';
import { DAY_STEPS, LIGHT_STEP_PHASES, STEP_PHASES, createState, dispatchRound, hashState, step, stepLight } from '../src/core/index.ts';
import type { Command, ConfigOverrides, SimState } from '../src/core/index.ts';
import { playGame } from '../tools/autoplay-lib.ts';
import { campaignOf, roofWhere, runningState, unlockAll } from './campaign-helpers.ts';
import { CITY } from './helpers.ts';

/**
 * 去掉「提前派出」的三处记录之后的状态哈希：order.early 记为 false，stats.early 记为空，小结记录里的 early 记为没有提前派出时的值
 * （这一场中途换过「调度策略」是 null，否则是 0）。就地改，哈希算完立刻改回去。
 */
function hashWithoutEarly(state: SimState): string {
  const flagged = state.orders.filter((o) => o.early);
  const events = state.stats.early;
  const peaks = state.campaign?.peaks ?? [];
  const counts = peaks.map((p) => p.early);
  for (const o of flagged) o.early = false;
  state.stats.early = [];
  for (const p of peaks) p.early = p.changedMidPeak ? null : 0;
  try {
    return hashState(state);
  } finally {
    for (const o of flagged) o.early = true;
    state.stats.early = events;
    peaks.forEach((p, i) => {
      p.early = counts[i] as number | null;
    });
  }
}

/** 沙盒：三个片区、载量 2、顺路合并、调度策略「时限优先」。与下单顺序不同的排序会让一部分订单被记为提前派出。 */
const POOLING: ConfigOverrides = { ...CITY, capacity: 2, rules: { select: 'deadline', zone: 'global', pool: 'any' } };

describe('轻量的一步', () => {
  it('阶段表与 STEP_PHASES 的名字和顺序相同，只有派单阶段不是同一个函数', () => {
    expect(LIGHT_STEP_PHASES.map((p) => p.name)).toEqual(STEP_PHASES.map((p) => p.name));
    STEP_PHASES.forEach((phase, i) => {
      const light = LIGHT_STEP_PHASES[i];
      if (phase.name === 'dispatch') expect(light?.run).not.toBe(phase.run);
      else expect(light?.run).toBe(phase.run);
    });
  });

  it('沙盒：逐步推进，轻量的状态与去掉提前派出记录的完整状态哈希相同，轻量的一边一条提前派出的记录都没有', () => {
    const full = createState(POOLING);
    const light = createState(POOLING);
    let compared = 0;
    for (let i = 0; i < DAY_STEPS; i++) {
      step(full);
      stepLight(light);
      if (i % 10 === 0) {
        expect(hashWithoutEarly(full), `第 ${full.step} 步`).toBe(hashState(light));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(300);
    expect(full.stats.early.length, '完整的一边确实记了提前派出，对比才有意义').toBeGreaterThan(0);
    expect(light.stats.early).toEqual([]);
    expect(light.orders.some((o) => o.early)).toBe(false);
    expect(hashWithoutEarly(full)).toBe(hashState(light));
    expect(JSON.stringify(light.orders.map((o) => ({ ...o, early: false })))).toBe(JSON.stringify(full.orders.map((o) => ({ ...o, early: false }))));
  });

  it('沙盒：每一轮派单，轻量派单派出的订单和顺序与完整派单相同，early 为空，状态只差提前派出的记录', () => {
    const probe = createState(POOLING);
    let rounds = 0;
    let withEarly = 0;
    for (let i = 0; i < 4000; i++) {
      if (probe.step % 5 === 0 && probe.pending.length > 0) {
        const full = structuredClone(probe);
        const light = structuredClone(probe);
        const a = dispatchRound(full);
        const b = dispatchRound(light, true);
        expect(b.dispatched, `第 ${probe.step} 步`).toEqual(a.dispatched);
        expect(b.early).toEqual([]);
        expect(light.stats.early).toHaveLength(probe.stats.early.length);
        expect(hashWithoutEarly(full), `第 ${probe.step} 步`).toBe(hashWithoutEarly(light));
        rounds += 1;
        if (a.early.length > 0) withEarly += 1;
      }
      step(probe);
    }
    expect(rounds).toBeGreaterThan(100);
    expect(withEarly).toBeGreaterThan(0);
  });

  it('经营模式：均衡玩法第 8 天起推进一天，轻量与完整的状态每 100 步只差提前派出，小结记录里读的数逐个相同', () => {
    const start = playGame('balanced', 42, { days: 8 }).state;
    const full = structuredClone(start);
    const light = structuredClone(start);
    const peaksBefore = campaignOf(start).peaks.length;
    for (let i = 0; i < DAY_STEPS; i++) {
      step(full);
      stepLight(light);
      if (i % 100 === 0) expect(hashWithoutEarly(full), `第 ${full.step} 步`).toBe(hashWithoutEarly(light));
    }
    expect(hashWithoutEarly(full)).toBe(hashWithoutEarly(light));
    expect(full.stats.early.length).toBeGreaterThan(start.stats.early.length);
    expect(light.stats.early).toHaveLength(start.stats.early.length);
    const read = (state: SimState): unknown[] =>
      campaignOf(state).peaks.slice(peaksBefore).map((p) => ({
        onTime: p.onTime,
        late: p.late,
        lateOpen: p.lateOpen,
        cancelled: p.cancelled,
        revenue: p.revenue,
        districts: p.districts,
        stations: p.stations,
        fleet: p.fleet,
        fleetBack: p.fleetBack,
      }));
    expect(read(light).length).toBe(2);
    expect(read(light)).toEqual(read(full));
  });
});

describe('副本用轻量的一步：会话层持有的两种副本读到的数不变', () => {
  const OLD_SMALL = roofWhere((r) => r.district === 0 && r.size === 'small');
  /** 三种改装、换卡、建站、买飞机和点击插队穿插在五天里。命令按步给出，两局用同一张表。 */
  const SCHEDULE = new Map<number, ((s: SimState) => Command | null)[]>([
    [2000, [() => ({ type: 'upgradeGate', station: 0 })]],
    [2100, [() => ({ type: 'buyBay', station: 0 }), () => ({ type: 'buyDrone', station: 0 })]],
    [2500, [() => ({ type: 'buildStation', roof: OLD_SMALL })]],
    [2600, [() => ({ type: 'buyDrone', station: 1 })]],
    [3000, [() => ({ type: 'buyDoubleBox' })]],
    [3100, [() => ({ type: 'setRules', rules: { pool: 'same' } })]],
    [3200, [() => ({ type: 'setRules', rules: { select: 'deadline' } })]],
    [4000, [() => ({ type: 'buyNearestLanding' })]],
    [4100, [() => ({ type: 'setNearestLanding', on: false })]],
    [4600, [() => ({ type: 'setNearestLanding', on: true })]],
    [5000, [() => ({ type: 'upgradeGate', station: 1 })]],
    [9000, [() => ({ type: 'upgradeGate', station: 1 })]],
  ]);

  function run(light: boolean): SimState {
    const state = unlockAll(runningState(9));
    campaignOf(state).money = 50_000;
    campaignOf(state).districts[0]!.star = 2;
    const play = createPlay(state, { light });
    for (let i = 0; i < 5 * DAY_STEPS; i++) {
      const commands = [...(SCHEDULE.get(state.step) ?? [])];
      if (state.step % 700 === 0) commands.push((s) => (s.pending[0] === undefined ? null : { type: 'prioritizeOrder', order: s.pending[0] }));
      for (const make of commands) {
        const command = make(state);
        if (command !== null) play.command(command);
      }
      play.step();
    }
    return state;
  }

  it('同一局用轻量副本和用完整副本：主状态逐位相同，包括小结里补进的对照和日结里写的效果行', () => {
    const light = run(true);
    const full = run(false);
    const peaks = campaignOf(light).peaks;
    expect(peaks.filter((p) => p.baseline !== null).length, '小结的对照确实补进了记录').toBeGreaterThan(2);
    const lines = campaignOf(light).days.flatMap((d) => d.effects);
    expect(lines.length, '效果行确实写出了').toBeGreaterThan(0);
    expect(new Set(lines.map((l) => l.kind)).size, '三种改装的效果行都写出了').toBe(3);
    expect(campaignOf(light).peaks.map((p) => p.baseline)).toEqual(campaignOf(full).peaks.map((p) => p.baseline));
    expect(campaignOf(light).days.map((d) => d.effects)).toEqual(campaignOf(full).days.map((d) => d.effects));
    expect(hashState(light)).toBe(hashState(full));
    expect(JSON.stringify(light)).toBe(JSON.stringify(full));
  });
});

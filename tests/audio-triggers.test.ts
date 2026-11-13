// 声音的触发：从游戏状态抄快照，比较上一次和这一次得出要播的声音，只读状态。
// 先用手工造的快照检查各种情形，再用真实的核心推进一段游戏，检查触发的条件和频率。
import { describe, expect, it } from 'vitest';
import { SOUND_IDS } from '../src/audio/catalog.ts';
import type { SoundId } from '../src/audio/catalog.ts';
import { MAX_GAP_STEPS, NIGHT_FROM_TICK, RECENT_STEPS, isNight, soundsBetween, takeSnapshot } from '../src/audio/triggers.ts';
import type { AudioSnapshot } from '../src/audio/triggers.ts';
import {
  DAY_STEPS,
  DroneState,
  PROMISE_STEPS,
  TAKEOFF_STEPS,
  addOrder,
  createState,
  hashState,
  markTipRead,
  pushTip,
  recordPeakSummary,
  setRules,
  splitRuleSets,
  step,
} from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { campaignOf, outcomeOrder, quietState, runningState } from './campaign-helpers.ts';

/** 手工造的快照，只写要变的项。 */
function snap(part: Partial<AudioSnapshot> = {}): AudioSnapshot {
  return {
    step: 1000,
    night: false,
    peak: -1,
    takeoffStep: -1,
    results: [],
    ruleChanges: 0,
    ruleSets: null,
    ruleSetInForce: -1,
    peaks: 0,
    stars: [1, 1, 1],
    tipsRead: 0,
    ...part,
  };
}

/** 从 prev 到 cur：cur 的步比 prev 大 gap。 */
function between(prev: Partial<AudioSnapshot>, cur: Partial<AudioSnapshot>, gap = 5): SoundId[] {
  const before = snap(prev);
  return soundsBetween(before, snap({ step: before.step + gap, ...cur }));
}

describe('夜间的分界', () => {
  it('一天里第 2850 步（19:00）起是夜间，新的一天开始又是白天', () => {
    expect(NIGHT_FROM_TICK).toBe(2850);
    expect(isNight(0)).toBe(false);
    expect(isNight(2849)).toBe(false);
    expect(isNight(2850)).toBe(true);
    expect(isNight(DAY_STEPS - 1)).toBe(true);
    expect(isNight(DAY_STEPS)).toBe(false);
    expect(isNight(DAY_STEPS * 3 + 2900)).toBe(true);
  });
});

describe('soundsBetween：手工造的快照', () => {
  it('没有上一次快照，或者什么都没变，没有声音', () => {
    expect(soundsBetween(null, snap())).toEqual([]);
    expect(between({}, {})).toEqual([]);
    expect(between({}, {}, 0)).toEqual([]);
  });

  it('起飞：正在起飞的飞机里有一架是上次观察之后才开始的', () => {
    expect(between({}, { takeoffStep: 1002 })).toEqual(['takeoff']);
    expect(between({}, { takeoffStep: 1000 })).toEqual(['takeoff']);
    expect(between({}, { takeoffStep: 999 })).toEqual([]);
    expect(between({ takeoffStep: 995 }, { takeoffStep: 995 })).toEqual([]);
  });

  it('送达和退单：只看结果产生在两次观察之间的订单，每种声音出现一次', () => {
    const at = (kind: 'onTime' | 'late' | 'cancel', big = false, stepAt = 1002) => [{ step: stepAt, kind, big }];
    expect(between({}, { results: at('onTime') })).toEqual(['onTime']);
    expect(between({}, { results: at('late') })).toEqual([]);
    expect(between({}, { results: at('cancel') })).toEqual(['cancel']);
    expect(between({}, { results: at('onTime', true) })).toEqual(['bigOrder']);
    // 大单超时送达也有硬币声：钱进账了
    expect(between({}, { results: at('late', true) })).toEqual(['bigOrder']);
    // 大单退单是退单
    expect(between({}, { results: at('cancel', true) })).toEqual(['cancel']);
    // 两次观察之外的结果不算：早于上一次，或者不早于这一次
    expect(between({}, { results: at('onTime', false, 999) })).toEqual([]);
    expect(between({}, { results: at('onTime', false, 1005) })).toEqual([]);
    expect(between({}, { results: at('onTime', false, 1000) })).toEqual(['onTime']);
    expect(between({}, { results: at('onTime', false, 1004) })).toEqual(['onTime']);
    // 一次送来一大批，也只出每种声音一次
    const many = Array.from({ length: 40 }, (_, i) => ({ step: 1000 + (i % 5), kind: 'onTime' as const, big: i % 7 === 0 }));
    expect(between({}, { results: many })).toEqual(['bigOrder', 'onTime']);
  });

  it('高峰开始：从高峰外进入高峰，或者从午高峰换到晚高峰。在高峰里面不重复，离开高峰没有声音', () => {
    expect(between({ peak: -1 }, { peak: 0 })).toEqual(['peakStart']);
    expect(between({ peak: 0 }, { peak: 1 })).toEqual(['peakStart']);
    expect(between({ peak: 0 }, { peak: 0 })).toEqual([]);
    expect(between({ peak: 0 }, { peak: -1 })).toEqual([]);
  });

  it('高峰小结：小结的数量增加', () => {
    expect(between({ peaks: 3 }, { peaks: 4 })).toEqual(['summary']);
    expect(between({ peaks: 3 }, { peaks: 3 })).toEqual([]);
    expect(between({ peaks: 3 }, { peaks: 2 })).toEqual([]);
  });

  it('升星：有片区的星级升高。掉星、不变、片区数对不上都没有声音，一升一降算升星', () => {
    expect(between({ stars: [1, 1, 1] }, { stars: [2, 1, 1] })).toEqual(['starUp']);
    expect(between({ stars: [3, 2, 1] }, { stars: [2, 2, 1] })).toEqual([]);
    expect(between({ stars: [3, 2, 1] }, { stars: [3, 2, 1] })).toEqual([]);
    expect(between({ stars: [3, 2, 1] }, { stars: [2, 3, 1] })).toEqual(['starUp']);
    expect(between({ stars: [1, 1] }, { stars: [2, 2, 2] })).toEqual([]);
  });

  it('换策略卡：玩家换卡的次数增加。还没生效的那一套被改也算，午晚切换、两套刚分开、现在生效的那一套被改（已经计入次数）不另算', () => {
    expect(between({ ruleChanges: 2 }, { ruleChanges: 3 })).toEqual(['rule']);
    const sets = (noon: string, evening: string): readonly [string, string] => [noon, evening];
    // 午高峰生效，改了晚高峰那一套
    expect(between({ ruleSets: sets('a|b|c', 'a|b|c'), ruleSetInForce: 0 }, { ruleSets: sets('a|b|c', 'd|b|c'), ruleSetInForce: 0 })).toEqual(['rule']);
    // 晚高峰生效，改了午高峰那一套
    expect(between({ ruleSets: sets('a|b|c', 'a|b|c'), ruleSetInForce: 1 }, { ruleSets: sets('d|b|c', 'a|b|c'), ruleSetInForce: 1 })).toEqual(['rule']);
    // 改的是现在生效的那一套：次数没变就没有声音，次数变了才有
    expect(between({ ruleSets: sets('a|b|c', 'a|b|c'), ruleSetInForce: 0 }, { ruleSets: sets('d|b|c', 'a|b|c'), ruleSetInForce: 0 })).toEqual([]);
    expect(between({ ruleSets: sets('a|b|c', 'a|b|c'), ruleSetInForce: 0 }, { ruleSets: sets('d|b|c', 'a|b|c'), ruleSetInForce: 0, ruleChanges: 1 })).toEqual(['rule']);
    // 午晚切换：两套内容都没变
    expect(between({ ruleSets: sets('a|b|c', 'd|b|c'), ruleSetInForce: 0 }, { ruleSets: sets('a|b|c', 'd|b|c'), ruleSetInForce: 1 })).toEqual([]);
    // 切换的同时那一套被改：两次快照里它都不是生效的那一套才算，这里午高峰在切换前是生效的，不算
    expect(between({ ruleSets: sets('a|b|c', 'a|b|c'), ruleSetInForce: 0 }, { ruleSets: sets('d|b|c', 'a|b|c'), ruleSetInForce: 1 })).toEqual([]);
    // 两套刚分开
    expect(between({ ruleSets: null, ruleSetInForce: -1 }, { ruleSets: sets('a|b|c', 'a|b|c'), ruleSetInForce: 0 })).toEqual([]);
  });

  it('便签读过收起：已读的便签数增加', () => {
    expect(between({ tipsRead: 1 }, { tipsRead: 2 })).toEqual(['noteRead']);
    expect(between({ tipsRead: 1 }, { tipsRead: 1 })).toEqual([]);
  });

  it('同时发生几件事：每种声音一次，按优先级排', () => {
    const everything = between(
      { peak: -1, peaks: 0, stars: [1, 1, 1] },
      {
        takeoffStep: 1003,
        results: [
          { step: 1001, kind: 'onTime', big: false },
          { step: 1002, kind: 'onTime', big: true },
          { step: 1003, kind: 'cancel', big: false },
        ],
        peak: 0,
        peaks: 1,
        stars: [2, 1, 1],
        ruleChanges: 1,
        tipsRead: 1,
      },
    );
    expect(everything).toEqual(['starUp', 'summary', 'peakStart', 'bigOrder', 'cancel', 'onTime', 'takeoff', 'rule', 'noteRead']);
    expect([...everything].sort()).toEqual([...SOUND_IDS].sort());
  });

  it('游戏暂停（步没有前进）时不出新的世界声音，只有玩家自己操作带来的两种', () => {
    const changed = {
      takeoffStep: 1000,
      results: [{ step: 1000, kind: 'onTime' as const, big: true }],
      peak: 0,
      peaks: 1,
      stars: [2, 1, 1],
      ruleChanges: 1,
      tipsRead: 1,
    };
    expect(between({}, changed, 0)).toEqual(['rule', 'noteRead']);
    expect(between({}, { ...changed, ruleChanges: 0, tipsRead: 0 }, 0)).toEqual([]);
  });

  it('步退回去，或者两次观察隔得太远，说明状态被换掉了（读档、导入），什么也不出', () => {
    const jumped = { ruleChanges: 5, peaks: 9, tipsRead: 3, stars: [5, 5, 5], takeoffStep: 2000, peak: 1 };
    expect(between({}, jumped, -1)).toEqual([]);
    expect(between({}, jumped, -500)).toEqual([]);
    expect(between({}, jumped, MAX_GAP_STEPS + 1)).toEqual([]);
    expect(between({}, { peaks: 1 }, MAX_GAP_STEPS)).toEqual(['summary']);
    expect(MAX_GAP_STEPS).toBeLessThanOrEqual(RECENT_STEPS);
  });

  it('不修改传入的快照', () => {
    const before = snap({ results: [{ step: 1001, kind: 'onTime', big: false }], stars: [1, 2, 3] });
    const after = snap({ step: 1005, results: [{ step: 1002, kind: 'cancel', big: false }], stars: [2, 2, 3] });
    const frozen = JSON.stringify([before, after]);
    soundsBetween(before, after);
    expect(JSON.stringify([before, after])).toBe(frozen);
  });
});

describe('takeSnapshot：从真实的状态抄快照', () => {
  it('沙盒模式：没有经营模式的字段，对应的项是 0、空或 null', () => {
    const state = createState({ scenario: 'threeDistricts', drones: 4 });
    expect(takeSnapshot(state)).toEqual({
      step: 0,
      night: false,
      peak: -1,
      takeoffStep: -1,
      results: [],
      ruleChanges: 0,
      ruleSets: null,
      ruleSetInForce: -1,
      peaks: 0,
      stars: [],
      tipsRead: 0,
    });
  });

  it('经营模式的开局：三个片区都是一星，没有小结，没有便签', () => {
    const snapshot = takeSnapshot(quietState());
    expect(snapshot.stars).toEqual([1, 1, 1]);
    expect(snapshot.peaks).toBe(0);
    expect(snapshot.tipsRead).toBe(0);
    expect(snapshot.ruleSets).toBeNull();
  });

  it('只读：抄快照不改状态，状态之后怎么变也不影响快照', () => {
    const state = quietState();
    outcomeOrder(state, { district: 0, tOrder: 5, delivered: 200 });
    state.step = 210;
    const hash = hashState(state);
    const json = JSON.stringify(state);
    const snapshot = takeSnapshot(state);
    expect(hashState(state)).toBe(hash);
    expect(JSON.stringify(state)).toBe(json);
    const frozen = JSON.stringify(snapshot);
    campaignOf(state).districts[0].star = 4;
    state.orders.length = 0;
    state.step = 9999;
    expect(JSON.stringify(snapshot)).toBe(frozen);
  });

  it('订单结果：送达的按承诺时间分准时和超时，退单单列，大单有标记，没有结果的和太早的不算', () => {
    const state = quietState();
    outcomeOrder(state, { district: 0, tOrder: 0, delivered: 100 }); // 结果太早
    const justOnTime = outcomeOrder(state, { district: 0, tOrder: 800, delivered: 800 + PROMISE_STEPS }); // 刚好准时
    const big = outcomeOrder(state, { district: 1, tOrder: 820, delivered: 820 + PROMISE_STEPS });
    big.portion = 2;
    outcomeOrder(state, { district: 0, tOrder: 830, delivered: 830 + PROMISE_STEPS + 1 }); // 超时一步
    outcomeOrder(state, { district: 2, tOrder: 900, cancelled: 1150 });
    outcomeOrder(state, { district: 0, tOrder: 1000 }); // 还没有结果
    state.step = 1200;
    expect(justOnTime.tDeliver - justOnTime.tOrder).toBe(PROMISE_STEPS);
    expect(takeSnapshot(state).results).toEqual([
      { step: 1100, kind: 'onTime', big: false },
      { step: 1120, kind: 'onTime', big: true },
      { step: 1131, kind: 'late', big: false },
      { step: 1150, kind: 'cancel', big: false },
    ]);
    // 往后走，旧的结果不再保留
    state.step = 1150 + RECENT_STEPS;
    expect(takeSnapshot(state).results).toEqual([{ step: 1150, kind: 'cancel', big: false }]);
    state.step = 1151 + RECENT_STEPS;
    expect(takeSnapshot(state).results).toEqual([]);
  });

  it('起飞：取正在起飞的飞机里最近一次起飞开始的步', () => {
    const state = quietState();
    expect(takeSnapshot(state).takeoffStep).toBe(-1);
    const [a, b] = state.drones;
    a.state = DroneState.Takeoff;
    a.tEnd = 505 + TAKEOFF_STEPS;
    b.state = DroneState.Takeoff;
    b.tEnd = 503 + TAKEOFF_STEPS;
    expect(takeSnapshot(state).takeoffStep).toBe(505);
    a.removed = true;
    expect(takeSnapshot(state).takeoffStep).toBe(503);
    b.state = DroneState.Fly;
    expect(takeSnapshot(state).takeoffStep).toBe(-1);
  });

  it('高峰和夜间：按这一步的位置', () => {
    const state = quietState();
    state.step = 599;
    expect(takeSnapshot(state)).toMatchObject({ peak: -1, night: false });
    state.step = 600;
    expect(takeSnapshot(state)).toMatchObject({ peak: 0, night: false });
    state.step = 2150;
    expect(takeSnapshot(state)).toMatchObject({ peak: 1, night: false });
    state.step = DAY_STEPS + 2900;
    expect(takeSnapshot(state)).toMatchObject({ peak: 1, night: true });
    state.step = DAY_STEPS + 3100;
    expect(takeSnapshot(state)).toMatchObject({ peak: -1, night: true });
  });

  it('策略、小结、便签：玩家换卡进次数，小结和已读便签各自计数，两套策略有内容', () => {
    const state = quietState();
    setRules(state, { select: 'deadline' });
    expect(takeSnapshot(state).ruleChanges).toBe(1);
    recordPeakSummary(state, 0, 'noon');
    expect(takeSnapshot(state).peaks).toBe(1);
    pushTip(state, 'firstOrder');
    pushTip(state, 'boardReady');
    expect(takeSnapshot(state).tipsRead).toBe(0);
    markTipRead(state, 'firstOrder');
    expect(takeSnapshot(state).tipsRead).toBe(1);
    splitRuleSets(state);
    const sets = takeSnapshot(state);
    expect(sets.ruleSets).toEqual([`deadline|${state.rules.zone}|${state.rules.pool}`, `deadline|${state.rules.zone}|${state.rules.pool}`]);
    expect(sets.ruleSetInForce).toBe(0);
  });
});

describe('用真实的核心检查触发', () => {
  /** 每次推进 chunk 步就比较一次，收集这一路上出现的声音。 */
  function observe(state: SimState, steps: number, chunk: number): SoundId[][] {
    const out: SoundId[][] = [];
    let previous = takeSnapshot(state);
    for (let done = 0; done < steps; done += chunk) {
      for (let i = 0; i < chunk; i++) step(state);
      const current = takeSnapshot(state);
      out.push(soundsBetween(previous, current));
      previous = current;
    }
    return out;
  }

  it('飞机起飞的那一次观察里出起飞声，之后不再重复', () => {
    const state = quietState();
    const building = (state.world.buildingsByDistrict[0] as number[])[0] as number;
    addOrder(state, { merchant: 0, building, portion: 1, prepSteps: 10, tOrder: 0 });
    let heard = 0;
    let previous = takeSnapshot(state);
    for (let i = 0; i < 60; i++) {
      step(state);
      const current = takeSnapshot(state);
      if (soundsBetween(previous, current).includes('takeoff')) heard += 1;
      previous = current;
    }
    // 一张订单派给一架飞机，一架飞机起飞一次
    expect(heard).toBe(1);
    expect(state.drones.filter((d) => d.departed >= 0).length).toBe(1);
  });

  it('一次推进几步到十几步，起飞也不会漏：起飞动作持续 8 步', () => {
    for (const chunk of [1, 3, 6, 8]) {
      const state = quietState();
      const building = (state.world.buildingsByDistrict[0] as number[])[0] as number;
      for (let i = 0; i < 2; i++) addOrder(state, { merchant: 0, building, portion: 1, prepSteps: 10, tOrder: 0 });
      const heard = observe(state, 240, chunk).flat().filter((id) => id === 'takeoff').length;
      expect(heard, `每次推进 ${chunk} 步`).toBeGreaterThanOrEqual(1);
    }
  });

  it('两天的游戏：每个高峰开始一次，每场小结一次，各种送达声都有，观察是只读的', () => {
    const watched = runningState(11);
    const control = runningState(11);
    const days = 2;
    const heard = observe(watched, DAY_STEPS * days, 4).flat();
    for (let i = 0; i < DAY_STEPS * days; i++) step(control);
    // 观察不改状态：看过的和没看过的走出同一个状态
    expect(hashState(watched)).toBe(hashState(control));
    expect(heard.filter((id) => id === 'peakStart')).toHaveLength(2 * days);
    expect(heard.filter((id) => id === 'summary')).toHaveLength(2 * days);
    expect(heard.filter((id) => id === 'takeoff').length).toBeGreaterThan(10);
    expect(heard.filter((id) => id === 'onTime').length).toBeGreaterThan(10);
    // 世界里的声音都和订单、飞机的变化一一对应：每个声音出现的次数不会比事件多
    const delivered = watched.orders.filter((o) => o.tDeliver >= 0).length;
    expect(heard.filter((id) => id === 'onTime' || id === 'bigOrder').length).toBeLessThanOrEqual(delivered);
    expect(heard.filter((id) => id === 'cancel').length).toBeLessThanOrEqual(watched.orders.filter((o) => o.tCancel >= 0).length);
  });

  it('升星：日结把片区升星的那一次观察里出升星声', () => {
    const state = runningState(3);
    state.step = DAY_STEPS - 1;
    const before = takeSnapshot(state);
    campaignOf(state).districts[0].star = 2;
    state.step = DAY_STEPS;
    expect(soundsBetween(before, takeSnapshot(state))).toEqual(['starUp']);
  });

  it('玩家换策略卡、读便签：暂停时（步不前进）也有声音', () => {
    const state = quietState();
    pushTip(state, 'firstOrder');
    const before = takeSnapshot(state);
    setRules(state, { select: 'deadline' });
    expect(soundsBetween(before, takeSnapshot(state))).toEqual(['rule']);
    const mid = takeSnapshot(state);
    markTipRead(state, 'firstOrder');
    expect(soundsBetween(mid, takeSnapshot(state))).toEqual(['noteRead']);
  });

  it('换了一份状态（读档）：快照的步退回去，什么也不出', () => {
    const state = runningState(5);
    for (let i = 0; i < 1500; i++) step(state);
    const before = takeSnapshot(state);
    const loaded = runningState(6);
    recordPeakSummary(loaded, 0, 'noon');
    expect(soundsBetween(before, takeSnapshot(loaded))).toEqual([]);
  });
});

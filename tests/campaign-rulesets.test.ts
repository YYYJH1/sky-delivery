// 午晚两套策略：开通写字楼区时分成两套，天内第 0 步和第 2150 步自动切换，改另一套只保存，自动切换不记换卡。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, EVENING_WINDOW, NOON_WINDOW, advance, createRng, createState, isUnlocked, nextInt, peakSummary, ruleSetAt, ruleSetInForce, setRules, splitRuleSets, step } from '../src/core/index.ts';
import type { PeakName, RuleSet, SimState, StepObserver } from '../src/core/index.ts';
import { campaignOf, expectRejected, must, quietState, withMoney } from './campaign-helpers.ts';
import { OPENING } from './helpers.ts';

const EVENING_START = EVENING_WINDOW.start; // 天内第 2150 步
const NOON_START = NOON_WINDOW.start; // 天内第 600 步

// 经营模式的调度台里没有「单独配送」（内容表 rules_v1），换卡的命令只认表里的卡，所以午高峰策略的「合单策略」用 same
const NOON_SET: RuleSet = { select: 'deadline', zone: 'hybrid', pool: 'same' };
const EVENING_SET: RuleSet = { select: 'roundtrip', zone: 'strict', pool: 'any' };

/** 老街三星，开通写字楼区，两套策略都是开局的 fifo、global、single。 */
function splitState(): SimState {
  const state = withMoney(quietState());
  campaignOf(state).districts[0]!.star = 3;
  must(state, { type: 'openDistrict', district: 1 });
  return state;
}

/** 分开之后，午高峰一套换成 NOON_SET，晚高峰一套换成 EVENING_SET。 */
function configured(): SimState {
  const state = splitState();
  must(state, { type: 'setRules', rules: NOON_SET, peak: 'noon' });
  must(state, { type: 'setRules', rules: EVENING_SET, peak: 'evening' });
  return state;
}

function sets(state: SimState): { noon: RuleSet; evening: RuleSet } {
  const rs = campaignOf(state).ruleSets;
  if (rs === null) throw new Error('rules are not split');
  return rs;
}

describe('时段和现在生效的是哪一套', () => {
  it('从天内第 0 步到第 2150 步用午高峰的一套，之后到一天结束用晚高峰的一套', () => {
    expect(EVENING_START).toBe(2150);
    expect([0, 1, 600, 2149].map(ruleSetAt)).toEqual(['noon', 'noon', 'noon', 'noon']);
    expect([2150, 2151, 3100, 3599].map(ruleSetAt)).toEqual(['evening', 'evening', 'evening', 'evening']);
  });

  it('现在 state.rules 是哪一套看最近执行过的那一步：第 2150 步执行之前仍是午高峰的一套，执行之后才是晚高峰的一套', () => {
    const state = quietState();
    const inForce = (at: number): PeakName => {
      state.step = at;
      return ruleSetInForce(state);
    };
    expect([0, 1, 2149, 2150].map(inForce)).toEqual(['noon', 'noon', 'noon', 'noon']);
    expect([2151, 3000, 3600].map(inForce)).toEqual(['evening', 'evening', 'evening']);
    expect([3601, 3602, DAY_STEPS + 2150].map(inForce)).toEqual(['noon', 'noon', 'noon']);
    expect(inForce(DAY_STEPS + 2151)).toBe('evening');
  });
});

describe('开通写字楼区之前只有一套', () => {
  it('不能指定改哪一套：命令 noRuleSets，状态不变；直接调用 setRules 报错', () => {
    const state = quietState();
    expect(campaignOf(state).ruleSets).toBeNull();
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline' }, peak: 'noon' }, 'noRuleSets');
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline' }, peak: 'evening' }, 'noRuleSets');
    expect(() => setRules(state, { select: 'deadline' }, 'evening')).toThrow(RangeError);
    // 不指定时和以前一样：立即生效并记下换卡
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    expect(state.rules.select).toBe('deadline');
    expect(state.stats.ruleChanges.length).toBe(1);
    expect(campaignOf(state).ruleSets).toBeNull();
  });

  it('沙盒模式里 setRules 的行为不变，指定 peak 报错', () => {
    const sandbox = createState({ ...OPENING });
    setRules(sandbox, { select: 'deadline' });
    expect(sandbox.rules.select).toBe('deadline');
    expect(sandbox.stats.ruleChanges.length).toBe(1);
    expect(() => setRules(sandbox, { select: 'fifo' }, 'noon')).toThrow(RangeError);
  });
});

describe('开通写字楼区时分成两套，都以当时的策略为初值', () => {
  it('开通的那一刻，两套都等于当时的 state.rules，并开放午晚两套', () => {
    const state = withMoney(quietState());
    campaignOf(state).districts[0]!.star = 3;
    advance(state, 700); // 午高峰中途
    must(state, { type: 'setRules', rules: { select: 'deadline', zone: 'hybrid' } });
    expect(isUnlocked(state, 'ruleSets')).toBe(false);
    must(state, { type: 'openDistrict', district: 1 });
    expect(sets(state)).toEqual({ noon: { select: 'deadline', zone: 'hybrid', pool: 'single' }, evening: { select: 'deadline', zone: 'hybrid', pool: 'single' } });
    expect(campaignOf(state).unlocks.ruleSets).toBe(700);
    expect(state.rules).toEqual(sets(state).noon);
    // 分开之后两套是各自的对象，改一套不影响另一套
    expect(sets(state).noon).not.toBe(sets(state).evening);
    expect(sets(state).noon).not.toBe(state.rules);
  });

  it('晚高峰中途开通也一样：两套都以当时生效的策略为初值', () => {
    const state = withMoney(quietState());
    campaignOf(state).districts[0]!.star = 3;
    advance(state, 2400);
    must(state, { type: 'setRules', rules: { pool: 'any' } });
    must(state, { type: 'openDistrict', district: 1 });
    expect(sets(state).noon).toEqual(state.rules);
    expect(sets(state).evening).toEqual(state.rules);
    expect(ruleSetInForce(state)).toBe('evening');
  });

  it('开通之前不分，开通之后只分一次：再调用分开的函数什么也不改', () => {
    const state = configured();
    const before = JSON.stringify(sets(state));
    splitRuleSets(state);
    expect(JSON.stringify(sets(state))).toBe(before);
  });

  it('不经命令直接把写字楼区设成已开通，下一步开始时也会分开', () => {
    const state = quietState();
    campaignOf(state).districts[1]!.open = true;
    expect(campaignOf(state).ruleSets).toBeNull();
    step(state);
    expect(campaignOf(state).ruleSets).not.toBeNull();
  });
});

describe('切换：天内第 0 步换成午高峰的一套，第 2150 步换成晚高峰的一套', () => {
  it('第 2150 步执行时换成晚高峰的一套，这一步的派单已经用它；第 3600 步执行时换回午高峰的一套', () => {
    const state = configured();
    expect(state.rules).toEqual(NOON_SET);
    advance(state, EVENING_START - 1);
    expect(state.rules).toEqual(NOON_SET);
    step(state); // 执行第 2149 步
    expect(state.step).toBe(EVENING_START);
    expect(state.rules).toEqual(NOON_SET); // 第 2150 步还没有执行，切换在这一步开始时做
    const seen: string[] = [];
    const observer: StepObserver = {
      before(phase, s) {
        if (phase === 'daily') seen.push(`daily ${s.rules.select}`);
        if (phase === 'dispatch') seen.push(`dispatch ${s.rules.select}`);
      },
    };
    step(state, observer);
    expect(seen).toEqual([`daily ${NOON_SET.select}`, `dispatch ${EVENING_SET.select}`]);
    expect(state.rules).toEqual(EVENING_SET);
    expect(ruleSetInForce(state)).toBe('evening');
    advance(state, DAY_STEPS - EVENING_START - 1);
    expect(state.step).toBe(DAY_STEPS);
    expect(state.rules).toEqual(EVENING_SET);
    const next: string[] = [];
    step(state, { before: (phase, s) => (phase === 'dispatch' ? next.push(s.rules.select) : undefined) });
    expect(next).toEqual([NOON_SET.select]);
    expect(state.rules).toEqual(NOON_SET);
    expect(ruleSetInForce(state)).toBe('noon');
  });

  it('连着几天按时切换：每一步生效的都是所处时段的那一套', () => {
    const state = configured();
    for (let i = 0; i < 3 * DAY_STEPS; i++) {
      step(state);
      const expected = sets(state)[ruleSetAt(i % DAY_STEPS)];
      expect(state.rules, `after step ${i}`).toEqual(expected);
    }
  });

  it('自动切换不记入换卡记录：换卡记录里只有玩家换的，小结里「这一场中途换过策略」的判断不受影响', () => {
    const state = configured();
    // configured 里指定了另一套（晚高峰一套）和现在生效的一套（午高峰一套）：午高峰那套是立即生效的，记了换卡，
    // 开局的「合单策略」是 single，午高峰那套换成 same 也是一次换卡
    const mine = state.stats.ruleChanges.map((c) => [c.column, c.to]);
    expect(mine).toEqual([['select', 'deadline'], ['zone', 'hybrid'], ['pool', 'same']]);
    advance(state, 2 * DAY_STEPS);
    expect(state.stats.ruleChanges.map((c) => [c.column, c.to])).toEqual(mine);
    for (const day of [0, 1]) {
      for (const peak of ['noon', 'evening'] as const) {
        // 第 0 天的午高峰这一场里开通后改过现在这套，但在高峰开始之前，所以不算中途
        expect(peakSummary(state, day, peak).early.changedMidPeak, `day ${day} ${peak}`).toBe(false);
      }
    }
  });
});

describe('改哪一套：指定的正好是现在生效的那一套，立即生效并记换卡；改另一套只保存，到切换时才生效，不记换卡', () => {
  it('午高峰时段改晚高峰的一套：state.rules 不变，没有换卡记录，只保存在晚高峰的一套里，到切换时生效', () => {
    const state = splitState();
    advance(state, 100);
    const before = structuredClone(state.rules);
    const changes = state.stats.ruleChanges.length;
    must(state, { type: 'setRules', rules: { select: 'roundtrip', pool: 'any' }, peak: 'evening' });
    expect(state.rules).toEqual(before);
    expect(state.stats.ruleChanges.length).toBe(changes);
    expect(sets(state).evening).toEqual({ select: 'roundtrip', zone: 'global', pool: 'any' });
    expect(sets(state).noon).toEqual(before);
    advance(state, EVENING_START - 100 + 1);
    expect(state.rules).toEqual({ select: 'roundtrip', zone: 'global', pool: 'any' });
    expect(state.stats.ruleChanges.length).toBe(changes);
  });

  it('午高峰时段改午高峰的一套：立即生效，照常记换卡，也记进午高峰的一套', () => {
    const state = splitState();
    advance(state, 100);
    must(state, { type: 'setRules', rules: { select: 'deadline' }, peak: 'noon' });
    expect(state.rules.select).toBe('deadline');
    expect(sets(state).noon.select).toBe('deadline');
    expect(sets(state).evening.select).toBe('fifo');
    expect(state.stats.ruleChanges.map((c) => [c.step, c.column, c.from, c.to])).toEqual([[100, 'select', 'fifo', 'deadline']]);
  });

  it('不指定改哪一套：改现在生效的那一套，晚高峰时段改的就是晚高峰的一套', () => {
    const state = splitState();
    advance(state, 2400);
    must(state, { type: 'setRules', rules: { zone: 'strict' } });
    expect(sets(state).evening.zone).toBe('strict');
    expect(sets(state).noon.zone).toBe('global');
    expect(state.stats.ruleChanges.map((c) => [c.step, c.column, c.to])).toEqual([[2400, 'zone', 'strict']]);
    // 晚高峰时段改午高峰的一套：只保存
    must(state, { type: 'setRules', rules: { zone: 'hybrid' }, peak: 'noon' });
    expect(state.rules.zone).toBe('strict');
    expect(sets(state).noon.zone).toBe('hybrid');
    expect(state.stats.ruleChanges.length).toBe(1);
    advance(state, DAY_STEPS - 2400 + 1);
    expect(state.rules.zone).toBe('hybrid'); // 第二天一开始换成午高峰的一套
  });

  it('同一套改回原值：不记换卡，也不变', () => {
    const state = configured();
    const changes = state.stats.ruleChanges.length;
    must(state, { type: 'setRules', rules: { select: NOON_SET.select }, peak: 'noon' });
    expect(state.stats.ruleChanges.length).toBe(changes);
  });

  it('指定的一套不存在：unknownTarget；策略卡不存在：unknownRule；没开放的卡：ruleLocked，状态都不变', () => {
    const state = splitState();
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline' }, peak: 'night' as never }, 'unknownTarget');
    expectRejected(state, { type: 'setRules', rules: { select: 'nope' }, peak: 'noon' }, 'unknownRule');
    const locked = withMoney(quietState({}, false));
    campaignOf(locked).districts[0]!.star = 3;
    campaignOf(locked).unlocks.showOffice = 0;
    must(locked, { type: 'openDistrict', district: 1 });
    expectRejected(locked, { type: 'setRules', rules: { select: 'deadline' }, peak: 'evening' }, 'ruleLocked');
  });
});

describe('第 2150 步和第 600 步的边界：换卡的步严格大于高峰开始的那一步才算中途', () => {
  /** 在状态推进到第 at 步时执行命令，再跑到小结之后，返回两场小结的「中途换过策略」。 */
  function midPeak(at: number, command: Parameters<typeof must>[1]): { noon: boolean; evening: boolean } {
    const state = configured();
    state.stats.ruleChanges.length = 0;
    advance(state, at);
    must(state, command);
    advance(state, DAY_STEPS - at);
    return { noon: peakSummary(state, 0, 'noon').early.changedMidPeak, evening: peakSummary(state, 0, 'evening').early.changedMidPeak };
  }

  it('午高峰开始的那一步（第 600 步）换午高峰的一套：整场都用新的，不算中途；晚一步算', () => {
    expect(midPeak(NOON_START, { type: 'setRules', rules: { select: 'fifo' } })).toEqual({ noon: false, evening: false });
    expect(midPeak(NOON_START + 1, { type: 'setRules', rules: { select: 'fifo' } })).toEqual({ noon: true, evening: false });
  });

  it('晚高峰开始的那一步（第 2150 步）：现在生效的还是午高峰的一套，改它不影响晚高峰，不算中途，晚一步改晚高峰的一套才算', () => {
    expect(midPeak(EVENING_START, { type: 'setRules', rules: { select: 'fifo' } })).toEqual({ noon: false, evening: false });
    expect(midPeak(EVENING_START, { type: 'setRules', rules: { select: 'fifo' }, peak: 'noon' })).toEqual({ noon: false, evening: false });
    expect(midPeak(EVENING_START + 1, { type: 'setRules', rules: { select: 'fifo' } })).toEqual({ noon: false, evening: true });
  });

  it('第 2150 步改晚高峰的一套：只保存，没有换卡记录，这一场整场都用它，不算中途', () => {
    const state = configured();
    state.stats.ruleChanges.length = 0;
    advance(state, EVENING_START);
    must(state, { type: 'setRules', rules: { select: 'fifo' }, peak: 'evening' });
    expect(state.stats.ruleChanges).toEqual([]);
    const seen: string[] = [];
    step(state, { before: (phase, s) => (phase === 'dispatch' ? seen.push(s.rules.select) : undefined) });
    expect(seen).toEqual(['fifo']);
    advance(state, DAY_STEPS - EVENING_START - 1);
    expect(peakSummary(state, 0, 'evening').early.changedMidPeak).toBe(false);
  });

  it('改另一套，不论什么时候都不算中途：午高峰中途改晚高峰的一套，晚高峰中途改午高峰的一套', () => {
    expect(midPeak(900, { type: 'setRules', rules: { select: 'fifo' }, peak: 'evening' })).toEqual({ noon: false, evening: false });
    expect(midPeak(2500, { type: 'setRules', rules: { select: 'fifo' }, peak: 'noon' })).toEqual({ noon: false, evening: false });
  });

  it('生成的小结记录里的标记与 peakSummary 一致', () => {
    const state = configured();
    advance(state, 900);
    must(state, { type: 'setRules', rules: { select: 'fifo' } });
    advance(state, 2800);
    const [noon, evening] = campaignOf(state).peaks;
    expect([noon?.changedMidPeak, evening?.changedMidPeak]).toEqual([true, false]);
    expect(noon?.early).toBeNull();
  });
});

describe('买双层货箱时两套都换', () => {
  it('两套里「单独配送」都换成「顺路合并」，不记换卡；已经不是「单独配送」的一套不动', () => {
    const state = splitState();
    must(state, { type: 'setRules', rules: { pool: 'same' }, peak: 'noon' });
    state.stats.ruleChanges.length = 0;
    expect(sets(state)).toEqual({ noon: { select: 'fifo', zone: 'global', pool: 'same' }, evening: { select: 'fifo', zone: 'global', pool: 'single' } });
    must(state, { type: 'buyDoubleBox' });
    expect(sets(state)).toEqual({ noon: { select: 'fifo', zone: 'global', pool: 'same' }, evening: { select: 'fifo', zone: 'global', pool: 'any' } });
    expect(state.stats.ruleChanges).toEqual([]);
    expect(state.rules.pool).toBe('same');
    advance(state, EVENING_START + 1);
    expect(state.rules.pool).toBe('any');
  });
});

describe('不变量：分开之后 state.rules 始终等于现在生效的那一套', () => {
  it('跑三个游戏日，随机地改两套策略，每一步之后 state.rules 都等于所处时段的那一套，换卡记录与玩家改现在这套的次数相符', () => {
    const state = configured();
    const rng = createRng(17);
    const pick = <T>(items: readonly T[]): T => items[nextInt(rng, items.length)] as T;
    let expectedChanges = state.stats.ruleChanges.length;
    for (let i = 0; i < 3 * DAY_STEPS; i++) {
      if (nextInt(rng, 40) === 0) {
        const patch: Partial<RuleSet> = {};
        if (nextInt(rng, 2) === 0) patch.select = pick(['fifo', 'deadline', 'roundtrip', 'prioOld']);
        if (nextInt(rng, 2) === 0) patch.zone = pick(['global', 'hybrid', 'strict']);
        if (nextInt(rng, 2) === 0) patch.pool = pick(['same', 'any']);
        const peak: PeakName | undefined = pick([undefined, 'noon', 'evening'] as const);
        const inForce = ruleSetInForce(state);
        const target = peak ?? inForce;
        if (target === inForce) {
          for (const column of ['select', 'zone', 'pool'] as const) {
            const to = patch[column];
            if (to !== undefined && to !== state.rules[column]) expectedChanges += 1;
          }
        }
        must(state, { type: 'setRules', rules: patch, peak });
        expect(state.rules).toEqual(sets(state)[inForce]);
      }
      step(state);
      expect(state.rules, `after step ${i}`).toEqual(sets(state)[ruleSetInForce(state)]);
    }
    expect(state.stats.ruleChanges.length).toBe(expectedChanges);
  });
});

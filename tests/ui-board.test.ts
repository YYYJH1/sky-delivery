// 调度台的数据：栏和卡的状态（选中，没开放），收起时的几行字，两套策略的页签，选片区，白板底部的小票条，
// 以及点一张卡发的命令只带这一栏。经营模式的调度台只列内容表 rules_v1 里的卡，没有「单独配送」。
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_RULES_V1 } from '../src/content/rules_v1.ts';
import { UNLOCKS_V1 } from '../src/content/unlocks_v1.ts';
import { STR, districtName, fmt, ruleCard, ruleName } from '../src/content/strings.zh.ts';
import type { DistrictIndex } from '../src/content/strings.zh.ts';
import { DAY_STEPS, EVENING_WINDOW, advance, applyCommand, hashState, ruleIds, unlock } from '../src/core/index.ts';
import type { PeakRecord, SimState } from '../src/core/index.ts';
import { PRIO_KEY, PRIO_RULES, WIDE_LOCK_CHARS, computeBoard, isRuleId, layoutCards, offeredRules, pickerChoices, ruleCommand, ticketLine } from '../src/ui/board.ts';
import type { BoardCard, BoardView } from '../src/ui/board.ts';
import { campaignOf, campaignState, expectRejected, must, quietState, unlockAll, withMoney } from './campaign-helpers.ts';

function board(state: SimState, peak: 'noon' | 'evening' | null = null): BoardView {
  const view = computeBoard(state, peak);
  if (view === null) throw new Error('no board');
  return view;
}

function cardOf(view: BoardView, key: string): BoardCard {
  for (const column of view.columns) {
    const card = column.cards.find((c) => c.key === key);
    if (card !== undefined) return card;
  }
  throw new Error(`no card ${key}`);
}

/** 开通写字楼区：核心在开通时把策略分成午晚两套。 */
function splitState(): SimState {
  const state = unlockAll(campaignState());
  campaignOf(state).districts[1]!.open = true;
  advance(state, 1); // 每步开始时检查开放项，分成两套
  expect(campaignOf(state).ruleSets).not.toBeNull();
  return state;
}

/** 手工放一条高峰小结的记录。 */
function pushPeak(state: SimState, patch: Partial<PeakRecord>): void {
  campaignOf(state).peaks.push({
    day: 0,
    peak: 'noon',
    step: 1800,
    orders: 20,
    onTime: 15,
    late: 4,
    lateOpen: 1,
    cancelled: 1,
    revenue: 143.6,
    districts: [],
    segments: null,
    select: 'fifo',
    early: 0,
    changedMidPeak: false,
    main: { id: 'noOrders' },
    extra: null,
    cleared: null,
    baseline: null,
    fleet: null,
    fleetBack: null,
    stations: [],
    ...patch,
  });
}

describe('调度台什么时候有', () => {
  it('「调度策略」一栏开放之前没有白板', () => {
    expect(computeBoard(campaignState(), null)).toBeNull();
  });

  it('开放之后有白板：标题、全天策略', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    expect(board(state)).toMatchObject({ title: STR.board.title, sub: STR.board.collapsed.all, tabs: null, shownPeak: null });
  });
});

describe('三栏的卡', () => {
  it('只开了第一栏：先到先送选中，时限优先可选，短程优先和{片区}优先没开放', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    const select = board(state).columns[0]!;
    expect(select).toMatchObject({ key: 'select', title: STR.board.columns.select, locked: false });
    expect(select.cards.map((c) => [c.key, c.selected, c.locked])).toEqual([
      ['fifo', true, false],
      ['deadline', false, false],
      ['roundtrip', false, true],
      [PRIO_KEY, false, true],
    ]);
    expect(cardOf(board(state), 'fifo')).toMatchObject({ ...ruleCard('fifo'), rule: 'fifo', lockText: null });
  });

  it('没开放的卡写出开放的条件，点了不换卡', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    const roundtrip = cardOf(board(state), 'roundtrip');
    expect(roundtrip).toMatchObject({ locked: true, lockText: STR.board.locked.roundtrip, rule: null, pick: false, selected: false });
    const prio = cardOf(board(state), PRIO_KEY);
    expect(prio).toMatchObject({ locked: true, lockText: STR.board.locked.prioDistrict, rule: null, pick: false });
  });

  it('「{片区}优先」的解锁说明写的是内容表里随之开放的片区', () => {
    expect(UNLOCKS_V1.prioOpensWith).not.toBeNull();
    expect(STR.board.locked.prioDistrict).toBe(`开通${districtName(UNLOCKS_V1.prioOpensWith as DistrictIndex)}后解锁`);
  });

  it('「合单策略」和「协同策略」没开放时整栏只写条件，不列卡', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    const [, pool, zone] = board(state).columns;
    expect(pool).toMatchObject({ key: 'pool', title: STR.board.columns.pool, locked: true, lockText: STR.board.locked.pool, cards: [] });
    expect(zone).toMatchObject({ key: 'zone', title: STR.board.columns.zone, locked: true, lockText: STR.board.locked.zone, cards: [] });
  });

  it('栏开放之后列出这一栏的卡，当前选中的突出：「合单策略」一栏只有两张卡，没有「单独配送」', () => {
    const state = unlockAll(campaignState());
    state.rules.pool = 'any';
    state.rules.zone = 'strict';
    const [, pool, zone] = board(state).columns;
    expect(pool!.cards.map((c) => [c.name, c.selected])).toEqual([[ruleName('same'), false], [ruleName('any'), true]]);
    expect(zone!.cards.map((c) => [c.name, c.selected])).toEqual([[ruleName('global'), false], [ruleName('hybrid'), false], [ruleName('strict'), true]]);
    expect(pool!.cards.every((c) => !c.locked)).toBe(true);
  });

  it('「{片区}优先」的三个编号合成一张，没有「单独配送」，一共九张', () => {
    const view = board(unlockAll(campaignState()));
    const keys = view.columns.flatMap((c) => c.cards.map((card) => card.key));
    expect(keys).toEqual(['fifo', 'deadline', 'roundtrip', PRIO_KEY, 'same', 'any', 'global', 'hybrid', 'strict']);
    expect(keys).toHaveLength(9);
    expect(keys).not.toContain('single');
  });

  it('每一栏列哪些卡取自内容表 rules_v1，顺序也一样；核心注册表里别的卡（单独配送）调度台不列', () => {
    expect(offeredRules('select')).toEqual(CAMPAIGN_RULES_V1.select);
    expect(offeredRules('pool')).toEqual(CAMPAIGN_RULES_V1.pool);
    expect(offeredRules('zone')).toEqual(CAMPAIGN_RULES_V1.zone);
    const view = board(unlockAll(campaignState()));
    const shown = view.columns.flatMap((c) => c.cards.map((card) => card.rule ?? card.key)).filter((key) => key !== PRIO_KEY);
    const registered = (['select', 'pool', 'zone'] as const).flatMap((column) => ruleIds(column)).filter((id) => !PRIO_RULES.includes(id as never));
    expect(registered.filter((id) => !shown.includes(id))).toEqual(['single']);
  });

  it('买下双层货箱之前这一栏整栏没开放，不列任何卡；买下之后自动选「顺路合并」，只有两张卡', () => {
    const state = withMoney(quietState());
    campaignOf(state).unlocks.poolColumn = -1;
    expect(state.rules.pool).toBe('single'); // 没有货箱时核心内部按单独配送运行
    const before = board(state).columns[1]!;
    expect(before).toMatchObject({ key: 'pool', locked: true, lockText: STR.board.locked.pool, cards: [] });
    expect(board(state).picked).toEqual([ruleName('fifo'), ruleName('global')]); // 这一栏没开放，收起时不写「单独配送」
    must(state, { type: 'buyDoubleBox' });
    const after = board(state).columns[1]!;
    expect(after.locked).toBe(false);
    expect(after.cards.map((c) => [c.name, c.selected])).toEqual([[ruleName('same'), false], [ruleName('any'), true]]);
    expect(board(state).picked).toEqual([ruleName('fifo'), ruleName('any'), ruleName('global')]);
  });

  it('这一栏开放了，策略却仍是「单独配送」（调试开局、手工构造的状态）：两张卡都不选中，收起时也不写它', () => {
    const state = unlockAll(campaignState());
    expect(state.rules.pool).toBe('single');
    const pool = board(state).columns[1]!;
    expect(pool.cards.map((c) => [c.name, c.selected])).toEqual([[ruleName('same'), false], [ruleName('any'), false]]);
    expect(board(state).picked).toEqual([ruleName('fifo'), ruleName('global')]);
  });

  it('白板上任何地方都不出现「单独配送」：展开的卡、收起时的卡名、两套策略的页签', () => {
    const texts = (view: BoardView): string[] => [...view.picked, ...view.columns.flatMap((c) => [c.title, c.lockText ?? '', ...c.cards.flatMap((card) => [card.name, card.desc, card.cost, card.lockText ?? ''])])];
    for (const state of [campaignState(), unlockAll(campaignState()), splitState()]) {
      unlock(state, 'selectColumn');
      for (const peak of [null, 'noon', 'evening'] as const) expect(texts(board(state, peak)).join('|')).not.toContain(ruleName('single'));
    }
  });

  it('开放项逐个打开：短程优先和{片区}优先各有各的条件', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    unlock(state, 'roundtrip');
    expect(cardOf(board(state), 'roundtrip').locked).toBe(false);
    expect(cardOf(board(state), PRIO_KEY).locked).toBe(true);
    unlock(state, 'prioDistrict');
    expect(cardOf(board(state), PRIO_KEY)).toMatchObject({ locked: false, pick: true, rule: null });
  });
});

describe('{片区}优先', () => {
  it('没选中时卡名写写字楼区优先，说明和代价取自词表', () => {
    const view = board(unlockAll(campaignState()));
    expect(cardOf(view, PRIO_KEY)).toMatchObject({ ...ruleCard('prioOffice'), selected: false });
  });

  it('选中其中一个片区时，卡名换成那个片区，卡是选中的', () => {
    const state = unlockAll(campaignState());
    state.rules.select = 'prioCampus';
    expect(cardOf(board(state), PRIO_KEY)).toMatchObject({ name: ruleName('prioCampus'), selected: true });
    state.rules.select = 'prioOld';
    expect(cardOf(board(state), PRIO_KEY)).toMatchObject({ name: ruleName('prioOld'), selected: true });
  });

  it('选的时候只列已开通的片区，选中的标出来', () => {
    const state = unlockAll(campaignState());
    expect(pickerChoices(state, 'fifo')).toEqual([{ district: 0, name: '老街', rule: 'prioOld', selected: false }]);
    campaignOf(state).districts[1]!.open = true;
    state.rules.select = 'prioOffice';
    expect(pickerChoices(state, state.rules.select)).toEqual([
      { district: 0, name: '老街', rule: 'prioOld', selected: false },
      { district: 1, name: '写字楼区', rule: 'prioOffice', selected: true },
    ]);
    expect(board(state).pickPrompt).toBe(STR.board.pickDistrict);
    expect(board(state).picker.map((p) => p.district)).toEqual([0, 1]);
  });

  it('三个编号对应三个片区', () => {
    expect([...PRIO_RULES]).toEqual(['prioOld', 'prioOffice', 'prioCampus']);
    for (const id of PRIO_RULES) expect(isRuleId(id)).toBe(true);
    expect(isRuleId('nope')).toBe(false);
  });
});

describe('磁贴排成两列', () => {
  const card = (key: string, lockText: string | null): BoardCard => ({
    key,
    column: 'select',
    name: key,
    desc: '',
    cost: '',
    selected: false,
    locked: lockText !== null,
    lockText,
    pick: false,
    rule: null,
    wide: false,
    col: 0,
    forecast: null,
  });

  it('一行两张，先左后右', () => {
    expect(layoutCards([card('a', null), card('b', null), card('c', null)]).map((c) => [c.col, c.wide])).toEqual([[0, false], [1, false], [0, false]]);
  });

  it('条件很长的卡占满一行，下一张从新的一行起', () => {
    const long = '写'.repeat(WIDE_LOCK_CHARS + 1);
    expect(layoutCards([card('a', null), card('b', long), card('c', null), card('d', null)]).map((c) => [c.col, c.wide])).toEqual([[0, false], [0, true], [0, false], [1, false]]);
  });

  it('条件正好是上限的字数不算长', () => {
    expect(layoutCards([card('a', '写'.repeat(WIDE_LOCK_CHARS))])[0]).toMatchObject({ wide: false });
  });

  it('白板上：锁着的短程优先和{片区}优先条件都短，四张卡排成两行两列', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    const view = board(state);
    expect(cardOf(view, 'fifo')).toMatchObject({ col: 0, wide: false });
    expect(cardOf(view, 'deadline')).toMatchObject({ col: 1, wide: false });
    expect(cardOf(view, 'roundtrip')).toMatchObject({ col: 0, wide: false });
    expect(cardOf(view, PRIO_KEY)).toMatchObject({ col: 1, wide: false });
  });

  it('开放之后{片区}优先是普通的一张，排在短程优先右边', () => {
    const view = board(unlockAll(campaignState()));
    expect(cardOf(view, 'roundtrip').col).toBe(0);
    expect(cardOf(view, PRIO_KEY)).toMatchObject({ col: 1, wide: false });
  });
});

describe('收起时的几行字', () => {
  it('只列已经开放的栏里选中的卡名', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    expect(board(state).picked).toEqual([ruleName('fifo')]);
    unlock(state, 'poolColumn');
    state.rules.pool = 'any'; // 买下双层货箱时核心把这一栏从「单独配送」换成「顺路合并」
    expect(board(state).picked).toEqual([ruleName('fifo'), ruleName('any')]);
    unlock(state, 'zoneColumn');
    expect(board(state).picked).toEqual([ruleName('fifo'), ruleName('any'), ruleName('global')]);
  });

  it('选了{片区}优先，写那个片区的名称', () => {
    const state = unlockAll(campaignState());
    state.rules.select = 'prioOffice';
    expect(board(state).picked[0]).toBe(ruleName('prioOffice'));
  });
});

describe('两套策略的页签', () => {
  it('开通写字楼区之前没有页签；分成两套之后有「午高峰」「晚高峰」，默认是现在生效的那一套', () => {
    expect(board(unlockAll(campaignState())).tabs).toBeNull();
    const state = splitState();
    const view = board(state);
    expect(view.tabs).toEqual([
      { peak: 'noon', name: '午高峰', on: true },
      { peak: 'evening', name: '晚高峰', on: false },
    ]);
    expect(view).toMatchObject({ shownPeak: 'noon', sub: STR.board.collapsed.noon });
  });

  it('晚高峰开始之后现在生效的是晚高峰策略：默认页签和收起时的小字跟着变', () => {
    const state = splitState();
    advance(state, EVENING_WINDOW.start + 5 - state.step);
    expect(board(state)).toMatchObject({ shownPeak: 'evening', sub: STR.board.collapsed.evening });
    expect(board(state).tabs?.map((t) => t.on)).toEqual([false, true]);
  });

  it('点页签看另一套：卡的选中和白板底部的小票条按那一套，收起时的字仍然是现在生效的那一套', () => {
    const state = splitState();
    const sets = campaignOf(state).ruleSets!;
    sets.evening.select = 'deadline';
    sets.evening.zone = 'strict';
    const noon = board(state, 'noon');
    const evening = board(state, 'evening');
    expect(cardOf(noon, 'fifo').selected).toBe(true);
    expect(cardOf(noon, 'deadline').selected).toBe(false);
    expect(cardOf(evening, 'deadline').selected).toBe(true);
    expect(cardOf(evening, 'strict').selected).toBe(true);
    expect(evening.shownPeak).toBe('evening');
    expect(evening.picked).toEqual(noon.picked);
    expect(evening.sub).toBe(STR.board.collapsed.noon);
  });

  it('没分成两套时不管传什么页签，都是 state.rules，没有 shownPeak', () => {
    const state = unlockAll(campaignState());
    expect(board(state, 'evening')).toMatchObject({ shownPeak: null, tabs: null });
  });
});

describe('白板底部的小票条', () => {
  /** 昨日这场高峰的小票条，文字取自词表。 */
  const lastPeak = (peak: string, onTime: number, cancelled: number, revenue: number): string => fmt(STR.board.lastPeak, { peak, onTime, cancelled, revenue });

  it('没有前一天这场高峰的记录：暂无昨日同场高峰记录', () => {
    const state = unlockAll(campaignState());
    expect(ticketLine(state, 'noon')).toBe(STR.board.lastPeakNone);
    expect(board(state).ticket).toBe(STR.board.lastPeakNone);
  });

  it('第一天的记录要到第二天才是「昨日」', () => {
    const state = unlockAll(campaignState());
    pushPeak(state, {});
    expect(ticketLine(state, 'noon')).toBe(STR.board.lastPeakNone);
    state.step = DAY_STEPS + 10;
    expect(ticketLine(state, 'noon')).toBe(lastPeak('午高峰', 75, 1, 143));
  });

  it('只看同一场高峰：午高峰的记录不出现在晚高峰的小票条上', () => {
    const state = unlockAll(campaignState());
    pushPeak(state, {});
    state.step = DAY_STEPS + 10;
    expect(ticketLine(state, 'evening')).toBe(STR.board.lastPeakNone);
    pushPeak(state, { peak: 'evening', step: 3400, onTime: 8, orders: 10, cancelled: 0, revenue: 90 });
    expect(ticketLine(state, 'evening')).toBe(lastPeak('晚高峰', 80, 0, 90));
  });

  it('没有分成两套时，小票条看现在生效的那一场；分成两套之后看页签那一场', () => {
    const state = unlockAll(campaignState());
    pushPeak(state, {});
    pushPeak(state, { peak: 'evening', step: 3400, onTime: 5, orders: 10, cancelled: 2, revenue: 40 });
    state.step = DAY_STEPS + 10;
    expect(board(state).ticket).toBe(lastPeak('午高峰', 75, 1, 143));
    campaignOf(state).districts[1]!.open = true;
    advance(state, 1);
    expect(board(state, 'evening').ticket).toBe(lastPeak('晚高峰', 50, 2, 40));
    expect(board(state, 'noon').ticket).toBe(lastPeak('午高峰', 75, 1, 143));
  });

  it('这一场没有订单时准时率写 0，收入取整', () => {
    const state = unlockAll(campaignState());
    pushPeak(state, { orders: 0, onTime: 0, cancelled: 0, revenue: 0.9 });
    state.step = DAY_STEPS + 10;
    expect(ticketLine(state, 'noon')).toBe(lastPeak('午高峰', 0, 0, 0));
  });
});

describe('点一张卡发的命令只带这一栏', () => {
  it('没分成两套：命令里只有这一栏，没有 peak', () => {
    expect(ruleCommand('select', 'deadline', null)).toEqual({ type: 'setRules', rules: { select: 'deadline' } });
    expect(ruleCommand('zone', 'strict', null)).toEqual({ type: 'setRules', rules: { zone: 'strict' } });
    expect(Object.keys((ruleCommand('pool', 'any', null) as { rules: object }).rules)).toEqual(['pool']);
  });

  it('分成两套之后带 peak', () => {
    expect(ruleCommand('select', 'deadline', 'evening')).toEqual({ type: 'setRules', rules: { select: 'deadline' }, peak: 'evening' });
  });

  it('只有第一栏开放时，只换这一栏能成功：三栏整套发回去，没开放的一栏会让整条命令失败', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline', pool: 'single', zone: 'global' } }, 'ruleLocked');
    expect(applyCommand(state, ruleCommand('select', 'deadline', null)).ok).toBe(true);
    expect(state.rules).toEqual({ select: 'deadline', pool: 'single', zone: 'global' });
  });

  it('换一栏不动另外两栏：别的栏原来是什么还是什么', () => {
    const state = unlockAll(campaignState());
    state.rules.pool = 'any';
    state.rules.zone = 'hybrid';
    expect(applyCommand(state, ruleCommand('select', 'roundtrip', null)).ok).toBe(true);
    expect(state.rules).toEqual({ select: 'roundtrip', pool: 'any', zone: 'hybrid' });
  });

  it('换另一套：只改那一套，现在生效的和另一套都不变', () => {
    const state = splitState();
    const result = applyCommand(state, ruleCommand('zone', 'strict', 'evening'));
    expect(result.ok).toBe(true);
    const sets = campaignOf(state).ruleSets!;
    expect(sets.evening.zone).toBe('strict');
    expect(sets.noon.zone).toBe('global');
    expect(state.rules.zone).toBe('global');
  });

  it('改现在生效的那一套：立即生效，两套里对应的一套同步', () => {
    const state = splitState();
    expect(applyCommand(state, ruleCommand('select', 'deadline', 'noon')).ok).toBe(true);
    expect(state.rules.select).toBe('deadline');
    expect(campaignOf(state).ruleSets!.noon.select).toBe('deadline');
    expect(campaignOf(state).ruleSets!.evening.select).toBe('fifo');
  });

  it('没分成两套时带 peak，核心拒绝', () => {
    const state = unlockAll(campaignState());
    expectRejected(state, ruleCommand('select', 'deadline', 'evening'), 'noRuleSets');
  });

  it('选「{片区}优先」：发的是那个片区的规则编号', () => {
    const state = unlockAll(campaignState());
    campaignOf(state).districts[1]!.open = true;
    const choice = pickerChoices(state, state.rules.select).find((c) => c.district === 1)!;
    expect(applyCommand(state, ruleCommand('select', choice.rule, null)).ok).toBe(true);
    expect(state.rules.select).toBe('prioOffice');
  });

  it('没开放的卡：核心拒绝，状态不变', () => {
    const state = campaignState();
    unlock(state, 'selectColumn');
    const before = hashState(state);
    expectRejected(state, ruleCommand('select', 'roundtrip', null), 'ruleLocked');
    expect(hashState(state)).toBe(before);
  });
});

describe('只读', () => {
  it('算调度台不改状态', () => {
    const state = splitState();
    pushPeak(state, {});
    const before = hashState(state);
    const json = JSON.stringify(state);
    board(state, null);
    board(state, 'evening');
    expect(hashState(state)).toBe(before);
    expect(JSON.stringify(state)).toBe(json);
  });

  it('同一个状态算两次结果相同', () => {
    const state = splitState();
    expect(JSON.stringify(board(state, 'evening'))).toBe(JSON.stringify(board(state, 'evening')));
  });
});

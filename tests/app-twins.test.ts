// 效果记录里「不购买时」的副本（src/app/twins.ts，由 createPlay 持有）：
// 购买起降口升级、双层货箱、就近降落之前复制一份尚未购买的状态，之后与主状态逐步同推，玩家的其他命令也做给它，
// 小结生成之后把副本这一场的指标记进效果跟踪，日结时写成效果行里「不购买时」的数。
// 核心的验收：副本记下的数与另一份独立复制、独立推进的不购买状态在同一场的指标完全相同。
import { describe, expect, it } from 'vitest';
import { MAX_TWINS, createPlay, twinCommand } from '../src/app/index.ts';
import type { Play } from '../src/app/index.ts';
import { FORECAST_V1 } from '../src/content/forecast_v1.ts';
import { DAY_STEPS, addOrder, applyCommand, createState, effectValue, hashState, peakRecord, quoteCommand, step } from '../src/core/index.ts';
import type { Command, CommandType, EffectKind, EffectLine, EffectWatch, PeakRecord, SimState } from '../src/core/index.ts';
import { parseSave, serializeSave } from '../src/save/index.ts';
import { campaignOf, quietState, roofWhere, runningState, unlockAll, withMoney } from './campaign-helpers.ts';
import { WALL } from './save-helpers.ts';

const OLD_SMALL = roofWhere((r) => r.district === 0 && r.size === 'small');

/** 经营模式，各项开放全开，钱很多，订单取随机订单。 */
function makeRunning(seed: number): SimState {
  const state = unlockAll(runningState(seed));
  campaignOf(state).money = 50_000;
  return state;
}

/** 一局里写出的全部效果行。 */
function allLines(state: SimState): EffectLine[] {
  return campaignOf(state).days.flatMap((d) => d.effects);
}

/** 命令必须成功。 */
function ok(play: Play, command: Command): void {
  const result = play.command(command);
  expect(result.ok, JSON.stringify({ command, result })).toBe(true);
}

/**
 * 在一份独立的不购买状态上做玩家的命令，作为副本应当收到什么的对照：余额不够时补到刚好够，与副本的做法相同，但这里是测试自己写的。
 * 点击订单插队在这份状态里失败了不算：副本也是这样处理的。
 */
function mirror(copy: SimState, command: Command): void {
  const quote = quoteCommand(copy, command);
  if (!quote.ok && quote.reason === 'notEnoughMoney') campaignOf(copy).money = quote.price;
  const result = applyCommand(copy, command);
  if (command.type !== 'prioritizeOrder') expect(result.ok, JSON.stringify({ command, result })).toBe(true);
}

/** 副本记下的每一个数，和独立的不购买状态在同一场的指标逐个相等。返回核对了几个。 */
function expectTwinsMatch(watch: EffectWatch, independent: SimState): number {
  for (const t of watch.twins) {
    const own = peakRecord(independent, t.day, t.peak) as PeakRecord;
    expect(own, `${watch.kind} ${t.day} ${t.peak}`).not.toBeNull();
    expect(t.value, `${watch.kind} ${t.day} ${t.peak}`).toBe(effectValue(watch.kind, watch.station, own));
  }
  return watch.twins.length;
}

/** 效果行里不购买时的数，和独立的不购买状态在同一场的指标逐个相等。返回核对了几行。 */
function expectLinesMatch(lines: readonly EffectLine[], independent: SimState): number {
  for (const line of lines) {
    const own = peakRecord(independent, line.afterDay, line.peak) as PeakRecord;
    expect(own, `${line.kind} ${line.afterDay} ${line.peak}`).not.toBeNull();
    expect(line.twin, `${line.kind} 第 ${line.afterDay} 天 ${line.peak}`).toBe(effectValue(line.kind, line.station, own));
  }
  return lines.length;
}

/** 主状态经过 play 推进，独立的状态用核心的 step 推进，到主状态走到 endStep。 */
function runBoth(play: Play, state: SimState, independents: readonly SimState[], endStep: number): void {
  while (state.step < endStep) {
    play.step();
    for (const copy of independents) step(copy);
  }
}

describe('副本的数与独立的不购买模拟完全相同', () => {
  /** 三种改装各一个购买：起降口升级和双层货箱在一座站时就能买，就近降落要有两座站。 */
  const CASES: { name: string; kind: EffectKind; build: boolean; command: Command }[] = [
    { name: '起降口升级', kind: 'gate', build: false, command: { type: 'upgradeGate', station: 0 } },
    { name: '双层货箱', kind: 'doubleBox', build: false, command: { type: 'buyDoubleBox' } },
    { name: '就近降落', kind: 'nearest', build: true, command: { type: 'buyNearestLanding' } },
  ];

  for (const { name, kind, build, command } of CASES) {
    for (const seed of [3, 11]) {
      it(`${name}，种子 ${seed}：购买之后跑到第 6 天，核对期间没有别的命令，效果行里的 twin 和副本记下的每个数，都与独立推进的不购买状态同一场的指标完全相同`, () => {
        const state = makeRunning(seed);
        const play = createPlay(state);
        if (build) ok(play, { type: 'buildStation', roof: OLD_SMALL });
        for (let i = 0; i < 2000; i++) play.step(); // 第 0 天午高峰的小结（第 1800 步）之后
        const independent = structuredClone(state); // 尚未购买的一份
        ok(play, command);
        expect(play.twinWatches()).toHaveLength(1);
        const watch = campaignOf(state).effectWatches[0] as EffectWatch;
        expect(play.twinWatches()[0]).toBe(watch); // 副本对应的就是主状态里的这条跟踪
        runBoth(play, state, [independent], 6 * DAY_STEPS + 1);
        const lines = allLines(state);
        expect(lines.length, '写出的效果行').toBeGreaterThanOrEqual(FORECAST_V1.effectDays);
        expect(lines.every((l) => l.kind === kind)).toBe(true);
        expect(expectLinesMatch(lines, independent)).toBe(lines.length);
        expect(expectTwinsMatch(watch, independent)).toBeGreaterThanOrEqual(lines.length);
        // 买了与不买是两个世界：至少有一行里现在的数和不购买时的数不同
        expect(lines.some((l) => l.twin !== l.after)).toBe(true);
        // 写满行数之后跟踪删掉，副本也丢掉
        expect(campaignOf(state).effectWatches).toEqual([]);
        expect(play.twinWatches()).toEqual([]);
      });
    }
  }

  it('副本记下的数就是核心写进效果行的 twin：行与跟踪里同一场的数逐个相同；副本只记与跟踪同类、晚于购买前那一场的高峰', () => {
    const state = makeRunning(5);
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step();
    ok(play, { type: 'buyDoubleBox' });
    const watch = campaignOf(state).effectWatches[0] as EffectWatch;
    while (state.step < 5 * DAY_STEPS) play.step();
    expect(allLines(state).length).toBeGreaterThan(0);
    for (const line of allLines(state)) {
      expect(watch.twins.find((t) => t.day === line.afterDay && t.peak === line.peak)?.value).toBe(line.twin);
    }
    expect(watch.twins.every((t) => t.peak === watch.peak && t.day > (watch.beforeDay as number))).toBe(true);
  });
});

describe('玩家之后的命令也做给副本', () => {
  /** 购买之后的命令：做命令的步，和按当时的状态给出命令的函数，给出 null 表示这一步不做（例如没有等待派单的订单可点）。 */
  type Step = [number, (state: SimState) => Command | null];

  /**
   * 主状态经过 play 做这些命令，独立的不购买状态（只有 mirror 里同样的命令）做同样的命令，两边每一步同推。
   * 副本里的数应当与独立状态同一场的指标完全相同：副本要是漏掉了哪条命令，两边的世界就不同。
   * 返回主状态、独立状态、这条跟踪、会话和真正做了几条命令。
   */
  function forwarding(command: Command, schedule: readonly Step[], build = false): { state: SimState; independent: SimState; watch: EffectWatch; play: Play; issued: number } {
    const state = makeRunning(7);
    const play = createPlay(state);
    if (build) ok(play, { type: 'buildStation', roof: OLD_SMALL });
    for (let i = 0; i < 2000; i++) play.step();
    const independent = structuredClone(state);
    ok(play, command);
    const watch = campaignOf(state).effectWatches[0] as EffectWatch;
    const plan = new Map<number, Step[]>();
    for (const item of schedule) plan.set(item[0], [...(plan.get(item[0]) ?? []), item]);
    let issued = 0;
    while (state.step < 6 * DAY_STEPS + 1) {
      for (const [, make] of plan.get(state.step) ?? []) {
        const next = make(state);
        if (next === null) continue;
        ok(play, next);
        mirror(independent, next);
        issued += 1;
      }
      play.step();
      step(independent);
    }
    return { state, independent, watch, play, issued };
  }

  /** 点一张等待派单的订单，没有就不点。 */
  const click = (at: number): Step => [at, (s) => (s.pending[0] === undefined ? null : { type: 'prioritizeOrder', order: s.pending[0] })];
  /** 买一架飞机，同一步马上原价退回：命令要在同一步，飞机才还停在停机位上。 */
  const buyAndRefund = (at: number, station: number): Step[] => [
    [at, () => ({ type: 'buyDrone', station })],
    [at, (s) => ({ type: 'refundDrone', drone: s.drones.length - 1 })],
  ];

  /** 一座站的局面里，之后几天陆续做的命令：加停机位、买飞机、建第二座站和它的飞机、换卡、点订单、买了就退。 */
  const LATER_ONE: Step[] = [
    [2200, () => ({ type: 'buyBay', station: 0 })],
    [2300, () => ({ type: 'buyDrone', station: 0 })],
    click(2400),
    click(2600),
    click(2800),
    [4000, () => ({ type: 'buildStation', roof: OLD_SMALL })],
    [4100, () => ({ type: 'buyDrone', station: 1 })],
    [4300, () => ({ type: 'setRules', rules: { select: 'deadline' } })],
    ...buyAndRefund(4400, 1),
    [8000, () => ({ type: 'buyBay', station: 1 })],
  ];
  /** 两座站的局面（就近降落要有两座站）。 */
  const LATER_TWO: Step[] = [
    [2200, () => ({ type: 'buyBay', station: 0 })],
    [2300, () => ({ type: 'buyDrone', station: 0 })],
    click(2400),
    click(2600),
    [2900, () => ({ type: 'buyBay', station: 1 })],
    [3000, () => ({ type: 'buyDrone', station: 1 })],
    [4300, () => ({ type: 'setRules', rules: { select: 'deadline' } })],
    ...buyAndRefund(4400, 1),
  ];

  for (const [name, command, build] of [
    ['起降口升级', { type: 'upgradeGate', station: 0 }, false],
    ['双层货箱', { type: 'buyDoubleBox' }, false],
    ['就近降落', { type: 'buyNearestLanding' }, true],
  ] as const) {
    it(`${name}：之后建站、加停机位、买飞机、换卡、点订单、退回，都做给副本，副本的数与同样命令下独立的不购买状态完全相同`, () => {
      const { state, independent, watch, play, issued } = forwarding(command, build ? LATER_TWO : LATER_ONE, build);
      expect(issued).toBeGreaterThanOrEqual(7);
      const lines = allLines(state);
      expect(lines.length).toBeGreaterThanOrEqual(FORECAST_V1.effectDays);
      expect(expectLinesMatch(lines, independent)).toBe(lines.length);
      expect(expectTwinsMatch(watch, independent)).toBeGreaterThanOrEqual(lines.length);
      expect(play.twinWatches()).toEqual([]); // 写满之后丢掉，没有中途作废
    });
  }

  it('就近降落买下之后随意开关：开关不做给就近降落自己的副本（副本里没有这项改装），副本不作废，数与从不买也从不开关的独立状态相同', () => {
    const toggles: [number, boolean][] = [
      [3000, false],
      [3700, true],
      [7300, false],
    ];
    const state = makeRunning(7);
    const play = createPlay(state);
    ok(play, { type: 'buildStation', roof: OLD_SMALL });
    for (let i = 0; i < 2000; i++) play.step();
    const independent = structuredClone(state);
    ok(play, { type: 'buyNearestLanding' });
    const watch = campaignOf(state).effectWatches[0] as EffectWatch;
    while (state.step < 6 * DAY_STEPS + 1) {
      for (const [at, on] of toggles) if (at === state.step) ok(play, { type: 'setNearestLanding', on }); // 只做给主状态，独立状态没有这项改装，什么也不做
      play.step();
      step(independent);
      if (state.step === 7400) expect(play.twinWatches()).toEqual([watch]); // 开关了三次，副本还在
    }
    const lines = allLines(state);
    expect(lines.length).toBeGreaterThanOrEqual(FORECAST_V1.effectDays);
    expect(expectLinesMatch(lines, independent)).toBe(lines.length);
    expect(expectTwinsMatch(watch, independent)).toBeGreaterThanOrEqual(lines.length);
  });

  it('双层货箱买下之后改合单策略：这一栏随双层货箱开放，副本里没有，不做给双层货箱的副本，副本不作废；同一条命令里别的栏照常做给它', () => {
    const state = makeRunning(7);
    campaignOf(state).unlocks.poolColumn = -1; // 合单策略一栏随双层货箱开放，不用调试开放
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step();
    const independent = structuredClone(state);
    expect(quoteCommand(independent, { type: 'setRules', rules: { pool: 'same' } })).toMatchObject({ ok: false, reason: 'ruleLocked' }); // 没有双层货箱的世界里换不了这一栏
    ok(play, { type: 'buyDoubleBox' });
    const watch = campaignOf(state).effectWatches[0] as EffectWatch;
    // 买下的同时合单策略一栏开放，自动换成顺路合并。之后换成同店合并，不做给副本
    expect(state.rules.pool).toBe('any');
    ok(play, { type: 'setRules', rules: { pool: 'same' } });
    expect(state.rules.pool).toBe('same');
    expect(play.twinWatches()).toEqual([watch]);
    // 同一条命令里还换了调度策略：这一栏做给副本
    ok(play, { type: 'setRules', rules: { pool: 'any', select: 'deadline' } });
    mirror(independent, { type: 'setRules', rules: { select: 'deadline' } });
    expect(play.twinWatches()).toEqual([watch]);
    runBoth(play, state, [independent], 6 * DAY_STEPS + 1);
    const lines = allLines(state);
    expect(lines.length).toBeGreaterThanOrEqual(FORECAST_V1.effectDays);
    expect(expectLinesMatch(lines, independent)).toBe(lines.length);
  });

  it('同一座站连升两级：低一级的副本收不到后一级的升级（没有低一级就升不到高一级），各自与对应的独立状态相同', () => {
    const state = makeRunning(7);
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step();
    const none = structuredClone(state); // 一级也没有买
    ok(play, { type: 'upgradeGate', station: 0 });
    const second = structuredClone(state); // 已经买了 2 级，3 级还没有买
    const first = campaignOf(state).effectWatches[0] as EffectWatch;
    for (let i = 0; i < 1000; i++) {
      play.step();
      step(none);
      step(second);
    }
    ok(play, { type: 'upgradeGate', station: 0 });
    const next = campaignOf(state).effectWatches[1] as EffectWatch;
    expect([first.level, next.level]).toEqual([2, 3]);
    expect(play.twinWatches()).toEqual([first, next]);
    runBoth(play, state, [none, second], 6 * DAY_STEPS + 1);
    const byLevel = (level: number): EffectLine[] => allLines(state).filter((l) => l.level === level);
    expect(byLevel(2).length).toBeGreaterThan(0);
    expect(byLevel(3).length).toBeGreaterThan(0);
    expect(expectLinesMatch(byLevel(2), none)).toBe(byLevel(2).length); // 2 级的对照是一级也没升的世界
    expect(expectLinesMatch(byLevel(3), second)).toBe(byLevel(3).length); // 3 级的对照是只升了 2 级的世界
    expect(expectTwinsMatch(first, none)).toBeGreaterThan(0);
    expect(expectTwinsMatch(next, second)).toBeGreaterThan(0);
  });
});

describe('命令做不做给副本：twinCommand', () => {
  /** 每种命令一条，类型表保证核心以后加了新的命令，这里要补上。 */
  const SAMPLES: Record<CommandType, Command> = {
    buildStation: { type: 'buildStation', roof: 3 },
    buyDrone: { type: 'buyDrone', station: 0 },
    buyBay: { type: 'buyBay', station: 0 },
    upgradeGate: { type: 'upgradeGate', station: 0 },
    buyDoubleBox: { type: 'buyDoubleBox' },
    buyNearestLanding: { type: 'buyNearestLanding' },
    setNearestLanding: { type: 'setNearestLanding', on: false },
    openDistrict: { type: 'openDistrict', district: 1 },
    setRules: { type: 'setRules', rules: { select: 'deadline' } },
    prioritizeOrder: { type: 'prioritizeOrder', order: 4 },
    readTip: { type: 'readTip', tip: 'firstOrder' },
    useForecast: { type: 'useForecast' },
    refundDrone: { type: 'refundDrone', drone: 0 },
    refundBay: { type: 'refundBay', station: 0 },
    refundStation: { type: 'refundStation', station: 1 },
  };
  const WATCHES: Pick<EffectWatch, 'kind' | 'station'>[] = [
    { kind: 'gate', station: 0 },
    { kind: 'doubleBox', station: null },
    { kind: 'nearest', station: null },
  ];

  it('便签标记已读和使用推演不做给任何副本，其余的命令都原样做给副本（除了下面几条没有这项改装就下不出来的）', () => {
    for (const watch of WATCHES) {
      for (const [type, command] of Object.entries(SAMPLES) as [CommandType, Command][]) {
        const forwarded = twinCommand(watch, command);
        if (type === 'readTip' || type === 'useForecast') expect(forwarded, `${watch.kind} ${type}`).toBeNull();
        else if (type === 'upgradeGate' && watch.kind === 'gate') expect(forwarded, `${watch.kind} ${type}`).toBeNull();
        else if (type === 'setNearestLanding' && watch.kind === 'nearest') expect(forwarded, `${watch.kind} ${type}`).toBeNull();
        else expect(forwarded, `${watch.kind} ${type}`).toBe(command); // 原样做给副本
      }
    }
  });

  it('同一座站更高一级的起降口升级不做给低一级的副本，别的站照常做', () => {
    const gate = { kind: 'gate', station: 1 } as const;
    expect(twinCommand(gate, { type: 'upgradeGate', station: 1 })).toBeNull();
    expect(twinCommand(gate, { type: 'upgradeGate', station: 0 })).toEqual({ type: 'upgradeGate', station: 0 });
    expect(twinCommand({ kind: 'doubleBox', station: null }, { type: 'upgradeGate', station: 1 })).toEqual({ type: 'upgradeGate', station: 1 });
  });

  it('合单策略一栏的换卡不做给双层货箱的副本，同一条命令里别的栏照常做，不改原来的命令', () => {
    const box = { kind: 'doubleBox', station: null } as const;
    expect(twinCommand(box, { type: 'setRules', rules: { pool: 'same' } })).toBeNull();
    const mixed: Command = { type: 'setRules', rules: { select: 'deadline', pool: 'same' }, peak: 'evening' };
    expect(twinCommand(box, mixed)).toEqual({ type: 'setRules', rules: { select: 'deadline' }, peak: 'evening' });
    expect(mixed).toEqual({ type: 'setRules', rules: { select: 'deadline', pool: 'same' }, peak: 'evening' });
    expect(twinCommand(box, { type: 'setRules', rules: { zone: 'strict' } })).toEqual({ type: 'setRules', rules: { zone: 'strict' } });
    // 别的改装的副本里这一栏有，照常做
    expect(twinCommand({ kind: 'gate', station: 0 }, { type: 'setRules', rules: { pool: 'same' } })).toEqual({ type: 'setRules', rules: { pool: 'same' } });
    expect(twinCommand({ kind: 'nearest', station: null }, { type: 'setRules', rules: { pool: 'same' } })).toEqual({ type: 'setRules', rules: { pool: 'same' } });
  });
});

describe('命令在副本里失败：作废', () => {
  /** 午高峰小结之后买了起降口升级。 */
  function bought(): { state: SimState; play: Play; watch: EffectWatch } {
    const state = makeRunning(7);
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step();
    ok(play, { type: 'upgradeGate', station: 0 });
    return { state, play, watch: campaignOf(state).effectWatches[0] as EffectWatch };
  }

  it('转发的命令在副本里失败，这个副本作废：已经记下的数留在跟踪里，之后不再记，也就不再写效果行', () => {
    const { state, play, watch } = bought();
    while (state.step < DAY_STEPS + 2000) play.step(); // 第 1 天午高峰的小结（第 5400 步）之后，副本记下了这一场的数
    expect(watch.twins.map((t) => [t.day, t.peak])).toEqual([[1, 'noon']]);
    expect(play.twinWatches()).toEqual([watch]);
    // 只改主状态：片区 0 到了三星，主状态里开通得了片区 1，副本里星级没变，开通不了
    campaignOf(state).districts[0]!.star = 3;
    ok(play, { type: 'openDistrict', district: 1 });
    expect(campaignOf(state).districts[1]!.open).toBe(true);
    expect(play.twinWatches()).toEqual([]);
    expect(watch.twins.map((t) => [t.day, t.peak])).toEqual([[1, 'noon']]); // 作废之前记下的还在
    while (state.step < 7 * DAY_STEPS) play.step();
    expect(watch.twins.map((t) => [t.day, t.peak])).toEqual([[1, 'noon']]); // 之后没有再记
    // 第 1 天的日结用的是作废之前记下的第 1 天午高峰的数，写了一行，之后几天副本没有数，不写
    expect(allLines(state).map((l) => l.afterDay)).toEqual([1]);
    expect(campaignOf(state).effectWatches).toEqual([]); // 五次日结之后跟踪照样删掉
  });

  it('点击订单插队在副本里失败不算作废：这张订单副本里没有或已经派出', () => {
    const { state, play, watch } = bought();
    const building = state.world.buildingsByDistrict[0]![0] as number;
    // 只往主状态里放一张订单，副本里没有它
    const order = addOrder(state, { merchant: 0, building, portion: 1, prepSteps: 10, tOrder: state.step });
    ok(play, { type: 'prioritizeOrder', order: order.id });
    expect(play.twinWatches()).toEqual([watch]);
  });

  it('命令在主状态里失败：不做给副本，副本不受影响', () => {
    const { state, play, watch } = bought();
    campaignOf(state).money = 0;
    expect(play.command({ type: 'buyBay', station: 0 })).toEqual({ ok: false, reason: 'notEnoughMoney' });
    expect(play.twinWatches()).toEqual([watch]);
  });

  it('副本里的余额与主状态不同：主状态里买得起，副本里余额不够时补到刚好够，不算失败', () => {
    const { state, play, watch } = bought();
    campaignOf(state).money = 500; // 只改主状态
    ok(play, { type: 'buyBay', station: 0 }); // 这座站开局的停机位满了，先加一个
    ok(play, { type: 'buyDrone', station: 0 });
    expect(play.twinWatches()).toEqual([watch]);
  });

  it('主状态被会话层之外的代码推进过（副本与主状态不在同一步）：下一步就丢掉副本', () => {
    const { state, play } = bought();
    play.step();
    expect(play.twinWatches()).toHaveLength(1);
    step(state); // 绕过 play
    expect(play.twinWatches()).toHaveLength(1);
    play.step();
    expect(play.twinWatches()).toEqual([]);
  });
});

describe('读档之后不写', () => {
  it('存档里没有副本：读档之后接着玩，这些跟踪不再记副本的数，之后的日结不写这一行；读档之前已经写出的行留着', () => {
    const state = makeRunning(7);
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step();
    ok(play, { type: 'buyDoubleBox' });
    while (state.step < 2 * DAY_STEPS + 100) play.step(); // 第 1 天的日结已经写过一行
    const before = allLines(state);
    expect(before.length).toBeGreaterThan(0);
    const watchBefore = campaignOf(state).effectWatches[0] as EffectWatch;
    expect(watchBefore.twins.length).toBeGreaterThan(0);
    // 存成文本再读回来，用新的 play 接着玩
    const saved = serializeSave(state, WALL);
    if (!saved.ok) throw new Error(saved.reason.message);
    const loaded = parseSave(saved.text);
    if (!loaded.ok) throw new Error(loaded.reason.message);
    const next = loaded.state;
    expect(hashState(next)).toBe(hashState(state)); // 副本不进存档，状态原样读回
    const resumed = createPlay(next);
    expect(resumed.twinWatches()).toEqual([]);
    const watchAfter = campaignOf(next).effectWatches[0] as EffectWatch;
    expect(watchAfter.twins).toEqual(watchBefore.twins); // 记下的数随存档保存
    while (next.step < 8 * DAY_STEPS) resumed.step();
    expect(allLines(next)).toEqual(before); // 读档之后没有新的一行
    expect(watchAfter.twins).toEqual(watchBefore.twins); // 也没有新的数
    expect(campaignOf(next).effectWatches).toEqual([]); // 跟踪写不出行，购买之后五次日结还是删掉
  });

  it('读档之后再买：新的购买有新的副本，已经读进来的旧跟踪没有', () => {
    const state = makeRunning(7);
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step();
    ok(play, { type: 'upgradeGate', station: 0 });
    const saved = serializeSave(state, WALL);
    if (!saved.ok) throw new Error(saved.reason.message);
    const loaded = parseSave(saved.text);
    if (!loaded.ok) throw new Error(loaded.reason.message);
    const resumed = createPlay(loaded.state);
    ok(resumed, { type: 'buyDoubleBox' });
    const watches = campaignOf(loaded.state).effectWatches;
    expect(watches.map((w) => w.kind)).toEqual(['gate', 'doubleBox']);
    expect(resumed.twinWatches()).toEqual([watches[1]]);
  });
});

describe('副本的数量', () => {
  /** 两座站，第 0 天午高峰小结之后。主状态最近一场小结里每座站都补上起降排队的数，这样购买前的数一定有。 */
  function ready(): { state: SimState; play: Play } {
    const state = makeRunning(3);
    const play = createPlay(state);
    ok(play, { type: 'buildStation', roof: OLD_SMALL });
    for (let i = 0; i < 2000; i++) play.step();
    for (const row of campaignOf(state).peaks[0]!.stations) row.gateWait ??= 1;
    return { state, play };
  }
  const FIVE: Command[] = [
    { type: 'buyDoubleBox' },
    { type: 'upgradeGate', station: 0 },
    { type: 'upgradeGate', station: 1 },
    { type: 'buyNearestLanding' },
    { type: 'upgradeGate', station: 0 },
  ];

  it(`同时存在的副本最多 ${MAX_TWINS} 个：第五笔购买丢掉最早的那一个，它之后的效果行不再写，其余照常`, () => {
    expect(MAX_TWINS).toBe(4);
    const { state, play } = ready();
    for (const [i, command] of FIVE.entries()) {
      ok(play, command);
      expect(play.twinWatches(), `第 ${i + 1} 笔`).toHaveLength(Math.min(i + 1, MAX_TWINS));
    }
    const watches = campaignOf(state).effectWatches;
    expect(watches).toHaveLength(5);
    expect(play.twinWatches()).toEqual(watches.slice(1)); // 最早的双层货箱被挤掉，按购买的先后排
    while (state.step < 6 * DAY_STEPS) play.step();
    expect(watches[0]!.twins).toEqual([]); // 被挤掉的没有记过数
    expect(allLines(state).filter((l) => l.kind === 'doubleBox')).toEqual([]);
    expect(watches.slice(1).some((w) => w.twins.length > 0)).toBe(true);
    expect(allLines(state).length).toBeGreaterThan(0);
    expect(play.twinWatches()).toEqual([]); // 跟踪都删掉之后，副本也都丢掉
  });

  it('一个副本被丢掉（作废或跟踪删掉）之后腾出名额，新的购买照常开副本', () => {
    const { state, play } = ready();
    for (const command of FIVE.slice(0, 4)) ok(play, command);
    expect(play.twinWatches()).toHaveLength(4);
    campaignOf(state).effectWatches = campaignOf(state).effectWatches.slice(1); // 最早的一笔被删
    play.step();
    expect(play.twinWatches()).toHaveLength(3);
    ok(play, FIVE[4] as Command);
    expect(play.twinWatches()).toHaveLength(4);
    expect(play.twinWatches()[3]).toBe(campaignOf(state).effectWatches[3]);
  });

  it('drop：丢掉全部副本，已经记下的数留在跟踪里，之后不再记', () => {
    const { state, play } = ready();
    for (const command of FIVE.slice(0, 3)) ok(play, command);
    while (state.step < DAY_STEPS + 2000) play.step();
    const recorded = campaignOf(state).effectWatches.map((w) => w.twins.length);
    expect(recorded.some((n) => n > 0)).toBe(true);
    play.drop();
    expect(play.twinWatches()).toEqual([]);
    expect(play.shadowActive()).toBe(false);
    while (state.step < 4 * DAY_STEPS) play.step();
    expect(campaignOf(state).effectWatches.map((w) => w.twins.length)).toEqual(recorded);
  });
});

describe('哪些购买开副本', () => {
  it('不记效果跟踪的购买和命令不开副本：建站、买飞机、加停机位、换卡', () => {
    const state = makeRunning(3);
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step();
    for (const command of [
      { type: 'buildStation', roof: OLD_SMALL },
      { type: 'buyBay', station: 0 },
      { type: 'buyDrone', station: 0 },
      { type: 'setRules', rules: { select: 'deadline' } },
    ] as const) {
      ok(play, command);
      expect(play.twinWatches(), command.type).toEqual([]);
    }
    expect(campaignOf(state).effectWatches).toEqual([]);
  });

  it('购买失败不开副本：资金不够、起降口已是最高级', () => {
    const state = makeRunning(3);
    const play = createPlay(state);
    for (let i = 0; i < 2000; i++) play.step();
    campaignOf(state).money = 1;
    expect(play.command({ type: 'buyDoubleBox' }).ok).toBe(false);
    campaignOf(state).money = 50_000;
    ok(play, { type: 'upgradeGate', station: 0 });
    ok(play, { type: 'upgradeGate', station: 0 });
    expect(play.command({ type: 'upgradeGate', station: 0 })).toEqual({ ok: false, reason: 'gateMax' });
    expect(play.twinWatches()).toHaveLength(2);
    expect(campaignOf(state).effectWatches).toHaveLength(2);
  });

  it('购买前没有数的跟踪不开副本：它的第一次日结就会删掉，写不出一行（购买时还没有小结记录，或者这座站在最近一场里没有已送达的订单）', () => {
    const state = withMoney(quietState());
    const play = createPlay(state);
    ok(play, { type: 'buyDoubleBox' }); // 没有小结记录
    expect(campaignOf(state).effectWatches[0]).toMatchObject({ before: null, peak: null });
    expect(play.twinWatches()).toEqual([]);
    for (let i = 0; i < 2000; i++) play.step();
    expect(campaignOf(state).peaks).toHaveLength(1);
    ok(play, { type: 'upgradeGate', station: 0 }); // 没有订单，这座站这一场没有起降排队的数
    expect(campaignOf(state).effectWatches[1]).toMatchObject({ kind: 'gate', before: null, peak: 'noon' });
    expect(play.twinWatches()).toEqual([]);
  });

  it('沙盒模式没有副本：购买不成功，照常推进', () => {
    const state = createState({ mode: 'sandbox' });
    const play = createPlay(state);
    expect(play.command({ type: 'buyDoubleBox' })).toEqual({ ok: false, reason: 'notCampaign' });
    for (let i = 0; i < 100; i++) play.step();
    expect(state.step).toBe(100);
    expect(play.twinWatches()).toEqual([]);
  });

  it('关掉副本（twins: false）：购买照常记跟踪，没有副本，没有副本的数，写不出效果行；其余与开着时的主状态相同', () => {
    const run = (twins: boolean): SimState => {
      const state = makeRunning(5);
      const play = createPlay(state, { twins });
      for (let i = 0; i < 2000; i++) play.step();
      ok(play, { type: 'buyDoubleBox' });
      expect(play.twinWatches().length).toBe(twins ? 1 : 0);
      while (state.step < 6 * DAY_STEPS) play.step();
      return state;
    };
    const off = run(false);
    const on = run(true);
    expect(allLines(off)).toEqual([]);
    expect(allLines(on).length).toBeGreaterThan(0);
    for (const state of [off, on]) {
      const c = campaignOf(state);
      c.effectWatches = [];
      for (const d of c.days) d.effects = [];
    }
    expect(hashState(off)).toBe(hashState(on));
  });
});

describe('副本不影响主状态', () => {
  it('同一局，经过会话层（有副本）和直接用核心推进，同样的命令在同样的步：每条命令的结果相同，每一步的决定相关状态相同（不含效果跟踪、效果行和小结对照）', () => {
    // 三种改装之后做一批别的命令，覆盖转发的各类命令
    const schedule = new Map<number, ((s: SimState) => Command | null)[]>([
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
      [5000, [() => ({ type: 'upgradeGate', station: 1 }), () => ({ type: 'upgradeGate', station: 0 })]],
      [6000, [() => ({ type: 'buyDrone', station: 1 }), (s) => ({ type: 'refundDrone', drone: s.drones.length - 1 })]],
      [7300, [() => ({ type: 'buyBay', station: 1 })]],
      [9000, [() => ({ type: 'upgradeGate', station: 1 })]],
    ]);
    const make = (): SimState => {
      const s = makeRunning(9);
      campaignOf(s).districts[0]!.star = 2;
      return s;
    };
    const withTwins = make();
    const plain = make();
    const play = createPlay(withTwins);
    const strip = (s: SimState): SimState => {
      const copy = structuredClone(s);
      const c = campaignOf(copy);
      c.effectWatches = [];
      for (const d of c.days) d.effects = [];
      for (const p of c.peaks) p.baseline = null; // 小结对照也是会话层补进记录的，与副本无关
      return copy;
    };
    let issued = 0;
    let mostTwins = 0;
    let compared = 0;
    for (let i = 0; i < 5 * DAY_STEPS; i++) {
      const at = withTwins.step;
      const commands = [...(schedule.get(at) ?? [])];
      if (at % 700 === 0) commands.push((s) => (s.pending[0] === undefined ? null : { type: 'prioritizeOrder', order: s.pending[0] }));
      for (const make of commands) {
        const command = make(withTwins);
        if (command === null) continue;
        expect(play.command(command), JSON.stringify(command)).toEqual(applyCommand(plain, command));
        issued += 1;
      }
      mostTwins = Math.max(mostTwins, play.twinWatches().length);
      play.step();
      step(plain);
      if (withTwins.step % 300 === 1) {
        expect(hashState(strip(withTwins)), `第 ${withTwins.step} 步`).toBe(hashState(strip(plain)));
        compared += 1;
      }
    }
    expect(issued).toBeGreaterThan(20);
    expect(mostTwins).toBeGreaterThanOrEqual(3); // 三种改装的副本同时在
    expect(compared).toBeGreaterThan(50);
    expect(allLines(withTwins).length).toBeGreaterThan(0); // 副本确实在工作
    expect(allLines(plain)).toEqual([]);
    expect(JSON.stringify(strip(withTwins))).toBe(JSON.stringify(strip(plain)));
  });
});

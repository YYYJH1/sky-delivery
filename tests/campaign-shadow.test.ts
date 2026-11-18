// 小结的对照：副本从高峰开始时复制，主状态走一步它走一步，玩家的购买命令在同一步做给它，小结时刻算出按开局的卡的结果。
// 不变式：整场用的都是开局的卡时，副本的结果与主状态的结果逐项相同。用了别的卡时，副本的结果确实不同。
import { describe, expect, it } from 'vitest';
import { createPlay } from '../src/app/index.ts';
import type { Play } from '../src/app/index.ts';
import { GOALS_V1 } from '../src/content/goals_v1.ts';
import {
  DAY_STEPS,
  applyCommand,
  attachBaseline,
  createState,
  finishShadow,
  forwardToShadow,
  hashState,
  isForwarded,
  openShadow,
  peakInProgress,
  peakRecord,
  quoteCommand,
  step,
  summaryStep,
} from '../src/core/index.ts';
import type { BaselineDraft, Command, PeakName, PeakRecord, SimState } from '../src/core/index.ts';
import { POLICIES, ruleCommands, shoppingList } from '../tools/autoplay-lib.ts';
import type { PolicyId } from '../tools/autoplay-lib.ts';
import { campaignOf, must, outcomeOrder, quietState, roofWhere, runningState } from './campaign-helpers.ts';

interface Played {
  state: SimState;
  play: Play;
  drafts: { day: number; peak: PeakName; draft: BaselineDraft | null }[];
  /** 玩家在高峰里下的、做给副本的命令有几条 */
  forwardedInPeak: number;
}

/**
 * 像玩家一样玩 days 个游戏日：开局的订单点一下，每秒按自动购买脚本的玩法决定一次，买东西、换卡都经过 play。
 * withShadow 为 false 时直接用 step 和 applyCommand，不经过 play，用来核对副本不改变游戏。
 */
function playDays(policy: PolicyId, seed: number, days: number, withShadow = true): Played {
  const state = createState({ mode: 'campaign', seed });
  const drafts: Played['drafts'] = [];
  const play = createPlay(state, { onDraft: (day, peak, draft) => drafts.push({ day, peak, draft }) });
  const spec = POLICIES[policy];
  let forwardedInPeak = 0;
  const run = (command: Command): void => {
    const inPeak = peakInProgress(state.step) !== null;
    const result = withShadow ? play.command(command) : applyCommand(state, command);
    if (result.ok && inPeak && isForwarded(command)) forwardedInPeak += 1;
  };
  const campaign = campaignOf(state);
  for (let i = 0; i < days * DAY_STEPS + 1; i++) {
    if (!campaign.opening.done) {
      for (const id of campaign.opening.orders) {
        const order = state.orders[id];
        if (order !== undefined && order.manualAt < 0 && state.step >= order.tOrder + 10) run({ type: 'prioritizeOrder', order: id });
      }
    }
    if (state.step % 10 === 0) {
      for (const command of ruleCommands(state, spec)) run(command);
      for (let n = 0; n < 12; n++) {
        const command = shoppingList(state, spec).find((c) => quoteCommand(state, c).ok);
        if (command === undefined) break;
        run(command);
      }
    }
    if (withShadow) play.step();
    else step(state);
  }
  return { state, play, drafts, forwardedInPeak };
}

interface Figures {
  orders: number;
  onTime: number;
  late: number;
  lateOpen: number;
  cancelled: number;
  revenue: number;
  districts: { district: number; n: number; onTime: number; pct: number | null }[];
}

/** 草稿和记录里同名的各项，用来逐项比较。 */
function figures(source: Figures): Figures {
  const { orders, onTime, late, lateOpen, cancelled, revenue } = source;
  return { orders, onTime, late, lateOpen, cancelled, revenue, districts: source.districts.map((d) => ({ district: d.district, n: d.n, onTime: d.onTime, pct: d.pct })) };
}

describe('不变式：整场用的都是开局的卡，副本的结果与主状态逐项相同', () => {
  it.each([7, 42, 51])('全程不换卡，种子 %i：打 5 个游戏日，每一场副本算出的结果与小结的记录逐项相同，记录里没有对照', (seed) => {
    const { state, drafts } = playDays('noCards', seed, 5);
    const campaign = campaignOf(state);
    expect(drafts.length).toBe(campaign.peaks.length);
    expect(campaign.peaks.length).toBeGreaterThanOrEqual(10);
    // 第一天开局的订单是玩家点的，点击不做给副本，第一天的午高峰不比
    const checked = drafts.filter((d) => d.day >= 1);
    expect(checked.length).toBeGreaterThanOrEqual(8);
    for (const { day, peak, draft } of checked) {
      const record = peakRecord(state, day, peak) as PeakRecord;
      expect(draft, `${day}${peak}`).not.toBeNull();
      expect(figures(draft as BaselineDraft), `${day}${peak}`).toEqual(figures(record));
    }
    // 整场用的是开局的卡：没有什么可比的，记录里没有对照
    expect(campaign.peaks.every((p) => p.baseline === null)).toBe(true);
  });

  it('玩的过程中有购买发生在高峰里，做给副本之后结果仍然逐项相同', () => {
    let inPeak = 0;
    for (const seed of [3, 7, 42, 51]) {
      const { state, drafts, forwardedInPeak } = playDays('noCards', seed, 5);
      inPeak += forwardedInPeak;
      for (const { day, peak, draft } of drafts.filter((d) => d.day >= 1)) {
        expect(figures(draft as BaselineDraft), `${seed} ${day}${peak}`).toEqual(figures(peakRecord(state, day, peak) as PeakRecord));
      }
    }
    expect(inPeak).toBeGreaterThan(0);
  });
});

describe('用了别的卡：副本的结果确实不同，对照补进了记录', () => {
  it('均衡玩法换成时限优先，种子 42：对照补进记录，订单数相同，准时数有的场次不同', () => {
    const { state, drafts } = playDays('balanced', 42, 6);
    const campaign = campaignOf(state);
    const withBaseline = campaign.peaks.filter((p) => p.baseline !== null);
    expect(withBaseline.length).toBeGreaterThanOrEqual(6);
    let different = 0;
    for (const record of withBaseline) {
      const baseline = record.baseline as NonNullable<PeakRecord['baseline']>;
      expect(baseline.orders, `${record.day}${record.peak}`).toBe(record.orders);
      expect(baseline.onTime + baseline.late + baseline.cancelled).toBe(baseline.orders);
      expect(baseline.districts.map((d) => d.district)).toEqual(record.districts.map((d) => d.district));
      expect(baseline.districts.reduce((sum, d) => sum + d.n, 0)).toBe(baseline.orders);
      if (baseline.onTime !== record.onTime || baseline.cancelled !== record.cancelled || baseline.late !== record.late) different += 1;
    }
    expect(different).toBeGreaterThanOrEqual(3);
    // 草稿里的结果就是补进记录里的
    for (const { day, peak, draft } of drafts) {
      const record = peakRecord(state, day, peak) as PeakRecord;
      if (record.baseline === null) continue;
      expect(figures(draft as BaselineDraft)).toEqual(figures(record.baseline));
    }
  });

  it('副本只换策略：两局一模一样，一局在高峰第一步换了卡，它的副本结果与另一局的主状态结果逐项相同，它自己的结果不同', () => {
    const make = (swap: boolean): { state: SimState; drafts: Played['drafts'] } => {
      const state = runningState(9);
      const drafts: Played['drafts'] = [];
      const play = createPlay(state, { onDraft: (day, peak, draft) => drafts.push({ day, peak, draft }) });
      campaignOf(state).unlocks.selectColumn = 0;
      // 午高峰的第一步之前换卡，这一刻两局的状态只差这一张卡
      const at = 2 * DAY_STEPS + 600;
      for (let i = 0; i < 3 * DAY_STEPS; i++) {
        if (swap && state.step === at) expect(play.command({ type: 'setRules', rules: { select: 'deadline' } }).ok).toBe(true);
        play.step();
      }
      return { state, drafts };
    };
    const plain = make(false);
    const swapped = make(true);
    const plainRecord = peakRecord(plain.state, 2, 'noon') as PeakRecord;
    const swappedRecord = peakRecord(swapped.state, 2, 'noon') as PeakRecord;
    const draft = swapped.drafts.find((d) => d.day === 2 && d.peak === 'noon')?.draft as BaselineDraft;
    expect(draft).not.toBeNull();
    expect(figures(draft)).toEqual(figures(plainRecord));
    expect(swappedRecord.baseline).toEqual(expect.objectContaining(figures(plainRecord)));
    // 换卡的一局自己的结果与另一局不同
    expect(swappedRecord.orders).toBe(plainRecord.orders);
    expect([swappedRecord.onTime, swappedRecord.late, swappedRecord.cancelled]).not.toEqual([plainRecord.onTime, plainRecord.late, plainRecord.cancelled]);
  });
});

describe('副本不改变游戏', () => {
  it('同一局，经过副本和不经过副本，主状态逐位相同：全程不换卡时哈希相同', () => {
    for (const seed of [3, 42]) {
      const a = playDays('noCards', seed, 3, true);
      const b = playDays('noCards', seed, 3, false);
      expect(hashState(a.state), `${seed}`).toBe(hashState(b.state));
    }
  });

  it('换卡的玩法：把小结记录里补进的对照拿掉，状态与不经过副本的一局逐字段相同', () => {
    for (const seed of [3, 42]) {
      const a = playDays('balanced', seed, 3, true);
      const b = playDays('balanced', seed, 3, false);
      expect(campaignOf(a.state).peaks.some((p) => p.baseline !== null)).toBe(true);
      expect(hashState(a.state)).not.toBe(hashState(b.state)); // 对照在记录里，哈希里有它
      for (const peak of campaignOf(a.state).peaks) peak.baseline = null;
      expect(hashState(a.state), `${seed}`).toBe(hashState(b.state));
      expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    }
  });
});

describe('副本的生命周期', () => {
  it('高峰第一步之前复制，小结生成的那一步之后没有；晚高峰同样；天内别的时候没有', () => {
    const state = runningState(5);
    const play = createPlay(state);
    const seen = new Map<number, boolean>();
    const watch = [100, 599, 600, 601, 1500, 1799, 1800, 1801, 2149, 2150, 2151, 3399, 3400, 3401, DAY_STEPS + 1];
    for (let i = 0; i < DAY_STEPS + 100; i++) {
      play.step();
      if (watch.includes(state.step)) seen.set(state.step, play.shadowActive());
    }
    // 这里的步数是刚走完一步之后状态所在的步：第 600 步之前复制，走完第 600 步，状态在 601
    expect([...seen]).toEqual([
      [100, false],
      [599, false],
      [600, false],
      [601, true],
      [1500, true],
      [1799, true],
      [1800, true],
      [1801, false],
      [2149, false],
      [2150, false],
      [2151, true],
      [3399, true],
      [3400, true],
      [3401, false],
      [DAY_STEPS + 1, false],
    ]);
  });

  it('读档之后接着玩：副本不在，这一场没有对照；下一场照常有', () => {
    const state = runningState(11);
    const first = createPlay(state);
    for (let i = 0; i < 900; i++) first.step();
    expect(first.shadowActive()).toBe(true);
    const drafts: { day: number; peak: PeakName; draft: BaselineDraft | null }[] = [];
    // 换一个新的 play 接着走，像读档之后重新开始：新的没有副本
    const second = createPlay(state, { onDraft: (day, peak, draft) => drafts.push({ day, peak, draft }) });
    expect(second.shadowActive()).toBe(false);
    for (let i = 0; i < 1300; i++) second.step();
    expect(peakRecord(state, 0, 'noon')?.baseline).toBeNull();
    expect(drafts).toEqual([]); // 午高峰的小结时刻没有副本，没有对照，也不交付
    expect(second.shadowActive()).toBe(true); // 晚高峰的第一步已经复制过了
  });

  it('drop：主状态被外部改过之后丢掉副本，这一场没有对照', () => {
    const state = runningState(11);
    const drafts: { draft: BaselineDraft | null }[] = [];
    const play = createPlay(state, { onDraft: (_day, _peak, draft) => drafts.push({ draft }) });
    for (let i = 0; i < 700; i++) play.step();
    expect(play.shadowActive()).toBe(true);
    play.drop();
    expect(play.shadowActive()).toBe(false);
    for (let i = 0; i < 1200; i++) play.step();
    expect(peakRecord(state, 0, 'noon')?.baseline).toBeNull();
    expect(drafts).toEqual([]);
  });

  it('沙盒模式：照常推进，没有副本', () => {
    const state = createState({ mode: 'sandbox' });
    const play = createPlay(state);
    for (let i = 0; i < 700; i++) play.step();
    expect(play.shadowActive()).toBe(false);
    expect(state.step).toBe(700);
  });

  it('命令在主状态里失败，结果原样返回，副本不受影响', () => {
    const state = quietState();
    const play = createPlay(state);
    state.step = 600;
    play.step();
    expect(play.shadowActive()).toBe(true);
    const result = play.command({ type: 'buyBay', station: 0 }); // 没有钱
    expect(result).toEqual({ ok: false, reason: 'notEnoughMoney' });
    expect(play.shadowActive()).toBe(true);
  });
});

describe('做给副本的命令', () => {
  it('名单：建站、买飞机、加停机位、升级起降口、双层货箱、就近降落及其开关、开通片区、三种退回。换卡、点单插队、便签已读不在名单里', () => {
    const forwarded: Command[] = [
      { type: 'buildStation', roof: 0 },
      { type: 'buyDrone', station: 0 },
      { type: 'buyBay', station: 0 },
      { type: 'upgradeGate', station: 0 },
      { type: 'buyDoubleBox' },
      { type: 'buyNearestLanding' },
      { type: 'setNearestLanding', on: false },
      { type: 'openDistrict', district: 1 },
      { type: 'refundDrone', drone: 0 },
      { type: 'refundBay', station: 0 },
      { type: 'refundStation', station: 0 },
    ];
    for (const c of forwarded) expect(isForwarded(c), c.type).toBe(true);
    const others: Command[] = [{ type: 'setRules', rules: { select: 'deadline' } }, { type: 'prioritizeOrder', order: 0 }, { type: 'readTip', tip: 'firstOrder' }];
    for (const c of others) expect(isForwarded(c), c.type).toBe(false);
  });

  /** 高峰开始时复制出的副本，主状态有 money 这么多钱。 */
  function pair(money: number): { main: SimState; shadow: ReturnType<typeof openShadow> } {
    const main = quietState();
    main.step = 600;
    campaignOf(main).money = money;
    return { main, shadow: openShadow(structuredClone(main), 0, 'noon') };
  }

  it('主状态里买成了，副本里余额不够时补到刚好够，照样买成，副本不算对不上', () => {
    const { main, shadow } = pair(1000);
    campaignOf(shadow.state).money = 0;
    const command: Command = { type: 'buyBay', station: 0 };
    expect(applyCommand(main, command).ok).toBe(true);
    forwardToShadow(shadow, main, command);
    expect(shadow.diverged).toBe(false);
    expect(shadow.state.stations[0]?.bays).toBe(main.stations[0]?.bays);
    expect(campaignOf(shadow.state).money).toBe(0); // 补的钱花掉了
  });

  it('价签在主状态里开放了，副本里还没开放：副本也开放，买得成', () => {
    const main = quietState({}, false);
    main.step = 600;
    campaignOf(main).money = 1000;
    campaignOf(main).unlocks.priceTags = 590;
    const shadow = openShadow(structuredClone(main), 0, 'noon');
    campaignOf(shadow.state).unlocks.priceTags = -1;
    const command: Command = { type: 'buyBay', station: 0 };
    expect(applyCommand(main, command).ok).toBe(true);
    forwardToShadow(shadow, main, command);
    expect(shadow.diverged).toBe(false);
    expect(campaignOf(shadow.state).unlocks.priceTags).toBe(590);
  });

  it('价签和双层货箱在主状态里一起开放了，副本里都还没开放：双层货箱做给副本时副本也开放，买得成', () => {
    const main = quietState({}, false);
    main.step = 600;
    campaignOf(main).money = 1000;
    campaignOf(main).unlocks.priceTags = 590;
    campaignOf(main).unlocks.doubleBox = 590;
    const shadow = openShadow(structuredClone(main), 0, 'noon');
    campaignOf(shadow.state).unlocks.priceTags = -1;
    campaignOf(shadow.state).unlocks.doubleBox = -1;
    const command: Command = { type: 'buyDoubleBox' };
    expect(applyCommand(main, command).ok).toBe(true);
    forwardToShadow(shadow, main, command);
    expect(shadow.diverged).toBe(false);
    expect(shadow.state.capacity).toBe(2);
    expect(campaignOf(shadow.state).unlocks.priceTags).toBe(590);
    expect(campaignOf(shadow.state).unlocks.doubleBox).toBe(590);
  });

  it('命令在副本里因为别的原因失败，副本就对不上了，不再有结果', () => {
    const { main, shadow } = pair(1000);
    // 主状态里把一块空屋顶建了站，副本里同一块屋顶已经被占了
    const roof = campaignOf(main).roofStation.findIndex((s) => s === -1);
    const command: Command = { type: 'buildStation', roof };
    expect(applyCommand(main, command).ok).toBe(true);
    campaignOf(shadow.state).roofStation[roof] = 7;
    forwardToShadow(shadow, main, command);
    expect(shadow.diverged).toBe(true);
    // 副本推进到小结时刻也没有结果
    shadow.state.step = summaryStep(0, 'noon');
    expect(finishShadow(shadow)).toBeNull();
  });

  it('就近降落的买下和开关都做给副本：副本里同步切换，不算对不上，小结的对照只比策略卡', () => {
    const main = quietState();
    main.step = 600;
    campaignOf(main).money = 100_000;
    must(main, { type: 'buildStation', roof: roofWhere((r) => r.district === 0 && !r.opening) });
    const shadow = openShadow(structuredClone(main), 0, 'noon');
    const commands: Command[] = [
      { type: 'buyNearestLanding' },
      { type: 'setNearestLanding', on: false },
      { type: 'setNearestLanding', on: true },
      { type: 'setNearestLanding', on: false },
    ];
    for (const command of commands) {
      expect(applyCommand(main, command).ok).toBe(true);
      forwardToShadow(shadow, main, command);
      expect(shadow.diverged).toBe(false);
      expect(shadow.state.returnRule).toBe(main.returnRule);
      expect(campaignOf(shadow.state).nearestOwned).toBe(campaignOf(main).nearestOwned);
    }
    expect(main.returnRule).toBe('home');
    expect(shadow.state.returnRule).toBe('home');
  });

  it('不在名单里的命令什么也不做', () => {
    const { main, shadow } = pair(1000);
    const before = JSON.stringify(shadow.state);
    forwardToShadow(shadow, main, { type: 'setRules', rules: { select: 'deadline' } });
    forwardToShadow(shadow, main, { type: 'prioritizeOrder', order: 0 });
    expect(JSON.stringify(shadow.state)).toBe(before);
    expect(shadow.diverged).toBe(false);
  });

  it('副本的卡：调度策略和协同策略是开局的卡，合单策略跟着主状态。分成两套时两套都是开局的卡，主状态不变', () => {
    const main = quietState();
    main.rules.select = 'deadline';
    main.rules.zone = 'hybrid';
    main.rules.pool = 'any';
    const shadow = openShadow(structuredClone(main), 0, 'noon');
    expect(shadow.state.rules).toEqual({ select: 'fifo', zone: 'global', pool: 'any' });
    expect(main.rules).toEqual({ select: 'deadline', zone: 'hybrid', pool: 'any' });
    const split = quietState();
    campaignOf(split).ruleSets = { noon: { select: 'deadline', zone: 'hybrid', pool: 'any' }, evening: { select: 'prioOffice', zone: 'strict', pool: 'same' } };
    const shadow2 = openShadow(structuredClone(split), 0, 'evening');
    expect(campaignOf(shadow2.state).ruleSets).toEqual({ noon: { select: 'fifo', zone: 'global', pool: 'any' }, evening: { select: 'fifo', zone: 'global', pool: 'same' } });
    expect(campaignOf(split).ruleSets?.evening.select).toBe('prioOffice');
  });
});

describe('补进记录', () => {
  /** 午高峰的小结已经生成的状态：10 张送达的订单，主状态现在用的调度策略是 select。记录里还没有对照。 */
  function recorded(select: string): SimState {
    const state = quietState();
    state.rules.select = select;
    for (let i = 0; i < 10; i++) outcomeOrder(state, { district: 0, tOrder: 700 + i, delivered: 700 + i + 200 });
    state.step = summaryStep(0, 'noon');
    step(state); // 日程阶段在这一步生成小结
    return state;
  }

  const draft = (patch: Partial<BaselineDraft> = {}): BaselineDraft => ({
    day: 0,
    peak: 'noon',
    orders: 10,
    onTime: 6,
    late: 3,
    lateOpen: 1,
    cancelled: 1,
    revenue: 52.5,
    districts: [{ district: 0, n: 10, onTime: 6, pct: 60 }],
    waitDroneSeconds: 12,
    ...patch,
  });

  it('用了别的卡：补进对照，各项取草稿里的；记录里已经有对照的不再补', () => {
    const state = recorded('deadline');
    const record = campaignOf(state).peaks[0] as PeakRecord;
    expect(record.orders).toBe(10);
    expect(record.baseline).toBeNull();
    expect(attachBaseline(state, draft())).toBe(true);
    expect(record.baseline).toEqual({ orders: 10, onTime: 6, late: 3, lateOpen: 1, cancelled: 1, revenue: 52.5, districts: [{ district: 0, n: 10, onTime: 6, pct: 60 }], lowLoad: false });
    expect(attachBaseline(state, draft({ onTime: 1 }))).toBe(false);
    expect(record.baseline?.onTime).toBe(6);
  });

  it('整场用的是开局的卡：不补。这一场里换过调度策略或协同策略，哪怕换回来：补。合单策略换卡不算', () => {
    const same = recorded('fifo');
    expect(attachBaseline(same, draft())).toBe(false);
    expect(campaignOf(same).peaks[0]?.baseline).toBeNull();
    const changed = recorded('fifo');
    changed.stats.ruleChanges.push({ step: 900, column: 'select', from: 'deadline', to: 'fifo' });
    expect(attachBaseline(changed, draft())).toBe(true);
    const zoneChanged = recorded('fifo');
    zoneChanged.stats.ruleChanges.push({ step: 900, column: 'zone', from: 'hybrid', to: 'global' });
    expect(attachBaseline(zoneChanged, draft())).toBe(true);
    const zoneNow = recorded('fifo');
    zoneNow.rules.zone = 'hybrid';
    expect(attachBaseline(zoneNow, draft())).toBe(true);
    const pool = recorded('fifo');
    pool.stats.ruleChanges.push({ step: 900, column: 'pool', from: 'single', to: 'any' });
    expect(attachBaseline(pool, draft())).toBe(false);
  });

  it('换卡发生在高峰的第一步或小结生成的那一步，不算这一场中途换的', () => {
    const atStart = recorded('fifo');
    atStart.stats.ruleChanges.push({ step: 600, column: 'select', from: 'deadline', to: 'fifo' });
    expect(attachBaseline(atStart, draft())).toBe(false);
    const atEnd = recorded('fifo');
    atEnd.stats.ruleChanges.push({ step: summaryStep(0, 'noon'), column: 'select', from: 'deadline', to: 'fifo' });
    expect(attachBaseline(atEnd, draft())).toBe(false);
  });

  it('两份状态里的订单数对不上，或者这一场没有记录、草稿是别的一场的：不补', () => {
    const state = recorded('deadline');
    expect(attachBaseline(state, draft({ orders: 9 }))).toBe(false);
    expect(attachBaseline(state, draft({ peak: 'evening' }))).toBe(false);
    expect(attachBaseline(state, draft({ day: 1 }))).toBe(false);
    expect(campaignOf(state).peaks[0]?.baseline).toBeNull();
  });

  it('订单不多于运力：两种策略下订单平均等飞机的时间都低于内容表里的数', () => {
    // 主状态里的订单是手工造的，等飞机 1 秒
    const fast = recorded('deadline');
    expect(attachBaseline(fast, draft({ waitDroneSeconds: GOALS_V1.lowLoadWaitSeconds - 0.1 }))).toBe(true);
    expect(campaignOf(fast).peaks[0]?.baseline?.lowLoad).toBe(true);
    const slow = recorded('deadline');
    expect(attachBaseline(slow, draft({ waitDroneSeconds: GOALS_V1.lowLoadWaitSeconds }))).toBe(true);
    expect(campaignOf(slow).peaks[0]?.baseline?.lowLoad).toBe(false);
    // 副本里没有送达的订单（NaN）时只看主状态的
    const none = recorded('deadline');
    expect(attachBaseline(none, draft({ waitDroneSeconds: Number.NaN }))).toBe(true);
    expect(campaignOf(none).peaks[0]?.baseline?.lowLoad).toBe(true);
  });
});

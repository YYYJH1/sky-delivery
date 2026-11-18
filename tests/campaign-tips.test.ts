// 引导便签的八个时机、结局，以及经营模式状态的确定性：每一步的状态哈希相同，哈希覆盖口碑、解锁、策略、日结和小结、便签、结局的字段，存读档前后一致。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import {
  DAY_STEPS,
  OrderStatus,
  STEPS_PER_SECOND,
  TIP_IDS,
  advance,
  applyCommand,
  fleetOf,
  hashState,
  quoteCommand,
  recordPeakSummary,
  refreshShops,
  settleDay,
  step,
  unreadTips,
} from '../src/core/index.ts';
import type { SimState, StepObserver, TipId } from '../src/core/index.ts';
import { campaignOf, campaignState, clickOpening, expectRejected, must, outcomeOrder, quietState, roofWhere, runningState, unlockAll, withMoney } from './campaign-helpers.ts';

const OLD_SMALL = roofWhere((r) => r.district === 0 && r.size === 'small');
const OFFICE_ROOF = roofWhere((r) => r.district === 1);

function tipSteps(state: SimState): [TipId, number][] {
  return campaignOf(state).tips.map((t) => [t.id, t.step]);
}

describe('便签：八个时机，每条最多出现一次', () => {
  it('八条便签的编号就是词表 tips 的键，顺序相同', () => {
    expect(TIP_IDS).toEqual(['firstOrder', 'autoDispatchOn', 'firstRedOrder', 'boardReady', 'canAddBay', 'dataClerk', 'gateBusy', 'openOffice']);
  });

  it('开局没有便签；游戏开始、第一张订单出现的那一步放出「点击订单，派出一架无人机」，出现的步是 0', () => {
    const state = campaignState({ seed: 42 });
    expect(campaignOf(state).tips).toEqual([]);
    step(state);
    expect(campaignOf(state).tips).toEqual([{ id: 'firstOrder', step: 0, station: null, read: false }]);
    expect(state.orders.length).toBe(1);
  });

  it('第五张订单送达：开局的五张订单都有了结果、自动派单打开的那一步，放出「新订单会自动派出」', () => {
    const state = campaignState({ seed: 42 });
    let flip = -1;
    for (let i = 0; i < 1200 && flip < 0; i++) {
      clickOpening(state);
      const at = state.step;
      step(state);
      if (campaignOf(state).opening.done) flip = at;
    }
    expect(flip).toBeGreaterThan(300);
    expect(tipSteps(state)).toContainEqual(['autoDispatchOn', flip]);
    expect(campaignOf(state).tips.filter((t) => t.id === 'autoDispatchOn').length).toBe(1);
    // 五张订单都送达了，最后一张送达的下一步打开
    const five = state.orders.slice(0, 5);
    expect(five.every((o) => o.status === OrderStatus.Delivered)).toBe(true);
    expect(flip).toBe(Math.max(...five.map((o) => o.tDeliver)) + 1);
  });

  it('自动派单打开之前，订单再老也不放「想先送哪张，点它一下」：开局没人点击，订单等了一百多秒', () => {
    const state = campaignState({ seed: 42 });
    advance(state, 400); // 第一张订单已经等了 40 秒
    expect(campaignOf(state).opening.done).toBe(false);
    expect(tipSteps(state)).toEqual([['firstOrder', 0]]);
  });

  it.each([42, 43, 44])('自动派单后第一次有还没送到的订单下单超过 22 秒：与逐步暴力检查的结果相同，种子 %i', (seed) => {
    const state = campaignState({ seed });
    let brute = -1;
    const observer: StepObserver = {
      after(phase, s) {
        if (phase !== 'tips' || brute >= 0 || !campaignOf(s).opening.done) return;
        // 还没送到：没有送达也没有退单。下单超过 22 秒：步数差大于 220
        if (s.orders.some((o) => o.tDeliver < 0 && o.tCancel < 0 && s.step - o.tOrder > 22 * STEPS_PER_SECOND)) brute = s.step;
      },
    };
    for (let i = 0; i < 2 * DAY_STEPS; i++) {
      clickOpening(state);
      step(state, observer);
    }
    const tip = campaignOf(state).tips.find((t) => t.id === 'firstRedOrder');
    expect(brute).toBeGreaterThan(0);
    expect(tip?.step).toBe(brute);
    expect(campaignOf(state).tips.filter((t) => t.id === 'firstRedOrder').length).toBe(1);
  });

  it('下单超过 22 秒，不含 22 秒整：第 221 步才放，第 220 步还没有', () => {
    const state = quietState({}, false);
    for (const d of state.drones) d.removed = true; // 没有飞机，订单一直等着
    outcomeOrder(state, { district: 0, tOrder: 0 });
    advance(state, 221); // 执行了第 0 到 220 步，订单已经等了 220 步，不是超过
    expect(campaignOf(state).tips.some((t) => t.id === 'firstRedOrder')).toBe(false);
    step(state);
    expect(campaignOf(state).tips.filter((t) => t.id === 'firstRedOrder').map((t) => t.step)).toEqual([221]);
  });

  it('调度台、价签、数据员、写字楼区的四条便签随各自的开放一起放出：同一次日结里先调度台，再价签，再数据员，最后写字楼区', () => {
    const state = withMoney(quietState({}, false), 500);
    campaignOf(state).districts[0]!.star = 3;
    state.step = 2 * DAY_STEPS;
    settleDay(state, 1);
    expect(tipSteps(state)).toEqual([['boardReady', 2 * DAY_STEPS], ['canAddBay', 2 * DAY_STEPS], ['dataClerk', 2 * DAY_STEPS], ['openOffice', 2 * DAY_STEPS]]);
  });

  it('第一次有站点在一场高峰里有无人机排队的时间大于一成：生成这样的小结时放出，参数是比例最大的站的编号，只放一次', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: OLD_SMALL });
    // 午高峰 900 步里，0 号站有 99 步（11%）有无人机排队，第二座站有 180 步（20%）
    Object.assign(campaignOf(state).tally.peak, { steps: 900, queue: [99, 180] });
    outcomeOrder(state, { district: 0, tOrder: 700, delivered: 900 });
    state.step = 1800;
    recordPeakSummary(state, 0, 'noon');
    expect(campaignOf(state).tips).toEqual([{ id: 'gateBusy', step: 1800, station: second, read: false }]);
    // 晚高峰也满足：不再放第二条
    Object.assign(campaignOf(state).tally.peak, { steps: 950, queue: [0, 500] });
    outcomeOrder(state, { district: 0, tOrder: 2300, delivered: 2500 });
    state.step = 3400;
    recordPeakSummary(state, 0, 'evening');
    expect(campaignOf(state).tips.filter((t) => t.id === 'gateBusy').length).toBe(1);
  });

  it('排队的时间不大于一成：不放，大于一成：放。比例用排队的步数和这一场的步数直接比，不取记录里下取整的百分数，10.9% 记 10，也大于一成', () => {
    // 900 步的一成是 90 步。90 步正好是一成，不算大于。91 步是 10.1%，98 步是 10.9%，记录里下取整都是 10，便签要放
    const cases: readonly (readonly [number, number, boolean])[] = [
      [900, 0, false],
      [900, 89, false],
      [900, 90, false],
      [900, 91, true],
      [900, 98, true],
      [900, 99, true],
      [900, 900, true],
      [950, 95, false], // 晚高峰 950 步，一成是 95 步
      [950, 96, true],
      [1000, 100, false],
      [1000, 101, true],
    ];
    for (const [steps, queue, expected] of cases) {
      const state = withMoney(quietState());
      Object.assign(campaignOf(state).tally.peak, { steps, queue: [queue] });
      outcomeOrder(state, { district: 0, tOrder: 700, delivered: 900 });
      state.step = 1800;
      const record = recordPeakSummary(state, 0, 'noon');
      expect(campaignOf(state).tips.some((t) => t.id === 'gateBusy'), `一场 ${steps} 步，排队 ${queue} 步`).toBe(expected);
      // 记录里仍是下取整的百分数
      expect(record.stations[0]?.queuePct).toBe(Math.floor((100 * queue) / steps));
    }
  });

  it('记录里下取整的百分数相同的两座站：参数取真实占比大的站，不取编号小的', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: OLD_SMALL });
    // 900 步里，0 号站排队 91 步（10.1%），第二座站排队 98 步（10.9%），记录里的下取整都是 10
    Object.assign(campaignOf(state).tally.peak, { steps: 900, queue: [91, 98] });
    outcomeOrder(state, { district: 0, tOrder: 700, delivered: 900 });
    state.step = 1800;
    const record = recordPeakSummary(state, 0, 'noon');
    expect(record.stations.map((row) => row.queuePct)).toEqual([10, 10]);
    expect(campaignOf(state).tips).toEqual([{ id: 'gateBusy', step: 1800, station: second, read: false }]);
  });

  it('比例相同的两座站：参数取编号小的；只有等降落、没有等起飞的排队也算排队，等降落的平均架数不再决定便签', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: OLD_SMALL });
    Object.assign(campaignOf(state).tally.peak, { steps: 900, queue: [180, 180] });
    state.step = 1800;
    recordPeakSummary(state, 0, 'noon');
    expect(campaignOf(state).tips).toEqual([{ id: 'gateBusy', step: 1800, station: 0, read: false }]);
    // 平均有 1.4 架在等降落（旧的条件）：没有排队的计数时不放便签
    const quiet = withMoney(quietState());
    const row = quiet.stats.landWait[0] as number[];
    for (let sec = 60; sec < 150; sec++) row[sec] = 14;
    quiet.step = 1800;
    const record = recordPeakSummary(quiet, 0, 'noon');
    expect(record.extra).toMatchObject({ id: 'landQueue', station: 0 });
    expect(campaignOf(quiet).tips.some((t) => t.id === 'gateBusy')).toBe(false);
  });

  it('一局里八条便签各出现一次：开局点单，新增停机位和购买无人机，换成「时限优先」，某场高峰上空有无人机排队，老街到三星', () => {
    const state = campaignState({ seed: 42 });
    const campaign = campaignOf(state);
    for (let i = 0; i < 3 * DAY_STEPS + 1; i++) {
      clickOpening(state);
      const now = state.step;
      if (now === 3000) campaign.money += 300; // 保证第一次日结时余额够 120
      if (now >= 3601 && now % 20 === 1) {
        if ((state.stations[0] as { bays: number }).bays < 4) applyCommand(state, { type: 'buyBay', station: 0 });
        if (fleetOf(state, 0) < 4) applyCommand(state, { type: 'buyDrone', station: 0 });
      }
      if (now === 4100) applyCommand(state, { type: 'setRules', rules: { select: 'deadline' } });
      if (now === 5000) {
        // 第二天午高峰（第 4200 到 5100 步）里，0 号站有无人机排队的步数加上 400，占这一场的四成以上
        const queue = campaign.tally.peak.queue;
        queue[0] = (queue[0] ?? 0) + 400;
      }
      if (now === 10000) campaign.districts[0]!.star = 3; // 第三天的日结时老街是三星
      step(state);
    }
    const tips = campaign.tips;
    expect(tips.map((t) => t.id).sort()).toEqual([...TIP_IDS].sort());
    expect(tips.length).toBe(8);
    expect(tips.map((t) => t.step)).toEqual([...tips.map((t) => t.step)].sort((a, b) => a - b));
    const at = (id: TipId): number => tips.find((t) => t.id === id)?.step ?? -1;
    expect(at('firstOrder')).toBe(0);
    expect(at('autoDispatchOn')).toBeGreaterThan(300);
    expect(at('firstRedOrder')).toBeGreaterThan(at('autoDispatchOn'));
    expect(at('boardReady')).toBeGreaterThan(0);
    expect(at('canAddBay')).toBe(DAY_STEPS);
    expect(at('dataClerk')).toBe(DAY_STEPS); // 数据员随价签一起到岗，便签同一步放出
    expect(at('gateBusy')).toBe(5400);
    expect(tips.find((t) => t.id === 'gateBusy')?.station).toBe(0);
    // 老街到三星的那次日结放出「写字楼区已可开通」：订单少的开局，第二天的日结时老街就到了三星，脚本在第三天强制三星只是兜底
    const reachedThree = campaign.days.find((d) => (d.districts[0] as { star: number }).star >= 3);
    expect(reachedThree).toBeDefined();
    expect(at('openOffice')).toBe(reachedThree?.step);
  });

  it('跑几天：每条便签最多出现一次，按出现的先后排队，出现的步不减', () => {
    const state = campaignState({ seed: 42 });
    for (let i = 0; i < 5 * DAY_STEPS + 1; i++) {
      clickOpening(state);
      step(state);
    }
    const tips = campaignOf(state).tips;
    expect(new Set(tips.map((t) => t.id)).size).toBe(tips.length);
    expect(tips.map((t) => t.step)).toEqual([...tips.map((t) => t.step)].sort((a, b) => a - b));
    expect(tips.length).toBeGreaterThanOrEqual(5);
    // 与各自的触发条件一致
    const campaign = campaignOf(state);
    const stepOf = (id: TipId): number | undefined => tips.find((t) => t.id === id)?.step;
    expect(stepOf('firstOrder')).toBe(0);
    expect(stepOf('boardReady')).toBe(campaign.unlocks.selectColumn);
    expect(stepOf('canAddBay')).toBe(campaign.unlocks.priceTags);
    expect(stepOf('dataClerk')).toBe(campaign.unlocks.dataClerk);
    if (campaign.unlocks.showOffice >= 0) expect(stepOf('openOffice')).toBe(campaign.unlocks.showOffice);
  });
});

describe('便签：标记已读', () => {
  it('readTip 命令把便签标记已读，界面读出还没读的，已经读过的再标一次也成功', () => {
    const state = campaignState({ seed: 42 });
    advance(state, 1);
    expect(unreadTips(state).map((t) => t.id)).toEqual(['firstOrder']);
    expect(quoteCommand(state, { type: 'readTip', tip: 'firstOrder' })).toEqual({ ok: true, reason: null, kind: 'free', price: 0 });
    expect(must(state, { type: 'readTip', tip: 'firstOrder' })).toBe(-1);
    expect(campaignOf(state).tips[0]?.read).toBe(true);
    expect(unreadTips(state)).toEqual([]);
    expect(must(state, { type: 'readTip', tip: 'firstOrder' })).toBe(-1);
    // 已读的便签还留在队列里，所以「出现过」永远查得到，不会再出现
    expect(campaignOf(state).tips.length).toBe(1);
    advance(state, 5);
    expect(campaignOf(state).tips.filter((t) => t.id === 'firstOrder').length).toBe(1);
  });

  it('队列里没有的便签（还没出现的，或者不存在的）：unknownTarget，状态不变', () => {
    const state = campaignState({ seed: 42 });
    advance(state, 1);
    expectRejected(state, { type: 'readTip', tip: 'gateBusy' }, 'unknownTarget');
    expectRejected(state, { type: 'readTip', tip: 'nope' as never }, 'unknownTarget');
    expectRejected(state, { type: 'readTip', tip: 3 as never }, 'unknownTarget');
  });

  it('只标记指定的一条，其余不动', () => {
    const state = withMoney(quietState({}, false), 500);
    campaignOf(state).districts[0]!.star = 3;
    state.step = 2 * DAY_STEPS;
    settleDay(state, 1);
    must(state, { type: 'readTip', tip: 'canAddBay' });
    expect(campaignOf(state).tips.map((t) => [t.id, t.read])).toEqual([['boardReady', false], ['canAddBay', true], ['dataClerk', false], ['openOffice', false]]);
  });
});

describe('结局：三个片区都到了四星', () => {
  /** 三个片区都开通，星级各给定，没有订单。 */
  function withStars(stars: [number, number, number], open: [boolean, boolean, boolean] = [true, true, true]): SimState {
    const state = quietState({}, false);
    const campaign = campaignOf(state);
    campaign.districts.forEach((d, k) => {
      d.open = open[k] as boolean;
      d.star = stars[k] as number;
    });
    refreshShops(state);
    campaign.delivered = 321;
    return state;
  }

  it('三个片区都到四星的那次日结记下结局：做日结的步、用了几天、一共送了多少单', () => {
    const state = withStars([4, 4, 4]);
    state.step = 4 * DAY_STEPS;
    settleDay(state, 3);
    expect(campaignOf(state).ending).toEqual({ step: 4 * DAY_STEPS, days: 4, orders: 321 });
  });

  it('还有片区没到四星，或者没开通：不记', () => {
    const three = withStars([4, 4, 3]);
    three.step = DAY_STEPS;
    settleDay(three, 0);
    expect(campaignOf(three).ending).toBeNull();
    const closed = withStars([4, 4, 4], [true, true, false]);
    closed.step = DAY_STEPS;
    settleDay(closed, 0);
    expect(campaignOf(closed).ending).toBeNull();
  });

  it('只记一次：之后星级再高、再过几天、再日结，结局不变，游戏照常运行', () => {
    const state = withStars([4, 4, 4]);
    state.step = 2 * DAY_STEPS;
    settleDay(state, 1);
    const first = structuredClone(campaignOf(state).ending);
    expect(first).toEqual({ step: 2 * DAY_STEPS, days: 2, orders: 321 });
    campaignOf(state).delivered = 999;
    for (const d of campaignOf(state).districts) d.star = 5;
    state.step = 3 * DAY_STEPS;
    settleDay(state, 2);
    expect(campaignOf(state).ending).toEqual(first);
    // 真实的一步里再做一次日结（第 3 × 3600 步开始时），结局仍然不变，游戏照常运行
    advance(state, 100);
    expect(state.step).toBe(3 * DAY_STEPS + 100);
    expect(campaignOf(state).ending).toEqual(first);
  });

  it('真实的运行：三个片区一开始就是四星，第一次日结记下结局，送达的订单数与到那一步为止送达的订单一致', () => {
    const state = runningState(12, [4, 4, 4], [true, true, true]);
    for (let i = 0; i < 3 * DAY_STEPS + 1; i++) step(state);
    const ending = campaignOf(state).ending;
    expect(ending?.step).toBe(DAY_STEPS);
    expect(ending?.days).toBe(1);
    expect(ending?.orders).toBe(state.orders.filter((o) => o.tDeliver >= 0 && o.tDeliver < DAY_STEPS).length);
    expect(ending?.orders).toBeGreaterThan(20);
    expect(campaignOf(state).days.length).toBe(3);
  });

  it('送达的订单总数：每送达一张加一，与状态里送达的订单一致', () => {
    const state = campaignState({ seed: 45 });
    for (let i = 0; i < 2 * DAY_STEPS; i++) {
      clickOpening(state);
      step(state);
    }
    expect(campaignOf(state).delivered).toBe(state.orders.filter((o) => o.status === OrderStatus.Delivered).length);
    expect(campaignOf(state).delivered).toBeGreaterThan(40);
  });
});

// ---- 确定性 ----

/** 一段带命令和直接改状态的脚本，覆盖日结、解锁、两套策略、小结、便签、结局以外的新字段。两次运行用同样的脚本。 */
function scripted(seed: number): { state: SimState; hashes: string[] } {
  const state = campaignState({ seed });
  const hashes: string[] = [hashState(state)];
  for (let i = 0; i < 3 * DAY_STEPS; i++) {
    clickOpening(state);
    if (i === 1) unlockAll(state);
    if (i === 1500) {
      campaignOf(state).money += 200; // 停机位涨到 140 之后，第一天中午的余额不够，先补一点
      must(state, { type: 'buyBay', station: 0 });
    }
    if (i === 3000) campaignOf(state).money += 3000;
    if (i === 3010) must(state, { type: 'buyDrone', station: 0 });
    if (i === 3020) must(state, { type: 'setRules', rules: { select: 'deadline' } });
    if (i === DAY_STEPS + 50) {
      campaignOf(state).districts[0]!.star = 3;
      campaignOf(state).money += 3000;
    }
    if (i === DAY_STEPS + 60) must(state, { type: 'openDistrict', district: 1 });
    if (i === DAY_STEPS + 70) must(state, { type: 'setRules', rules: { select: 'roundtrip', zone: 'strict' }, peak: 'evening' });
    if (i === DAY_STEPS + 80) must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    if (i === DAY_STEPS + 90) must(state, { type: 'buyDoubleBox' });
    if (i === 2 * DAY_STEPS + 300) must(state, { type: 'setRules', rules: { pool: 'same' }, peak: 'noon' });
    step(state);
    hashes.push(hashState(state));
  }
  return { state, hashes };
}

describe('经营模式的状态：确定性', () => {
  it('带命令运行三个游戏日，两次运行每一步的状态哈希相同；哈希随状态变化，不是常数', () => {
    const a = scripted(51);
    const b = scripted(51);
    expect(a.hashes).toEqual(b.hashes);
    expect(new Set(a.hashes).size).toBeGreaterThan(a.hashes.length * 0.95);
    const campaign = campaignOf(a.state);
    // 脚本确实走到了新字段：日结（第 3600 步和第 7200 步）、六场小结、便签、两套策略
    expect(campaign.days.length).toBe(2);
    expect(campaign.peaks.length).toBe(6);
    expect(campaign.ruleSets).not.toBeNull();
    expect(campaign.tips.length).toBeGreaterThanOrEqual(3); // 脚本用 unlockAll 直接开放，没有经过开放的便签
    expect(campaign.unlocks.ruleSets).toBeGreaterThan(0);
    expect(a.state.capacity).toBe(2);
  });

  it('不同的种子结果不同', () => {
    expect(scripted(51).hashes.at(-1)).not.toBe(scripted(52).hashes.at(-1));
  });

  it('存档式的复制（JSON 往返）之后继续运行，每一步的哈希与不复制时相同，新字段原样保留', () => {
    const { state } = scripted(53);
    const restored = JSON.parse(JSON.stringify(state)) as SimState;
    expect(restored).toEqual(state);
    expect(hashState(restored)).toBe(hashState(state));
    for (let i = 0; i < 2 * DAY_STEPS; i++) {
      step(state);
      step(restored);
      if (i % 97 === 0) expect(hashState(restored)).toBe(hashState(state));
    }
    expect(hashState(restored)).toBe(hashState(state));
    expect(restored).toEqual(state);
    expect(campaignOf(restored).days.length).toBe(4); // 脚本走到第 10800 步之前，之后又走了两个游戏日：第 10800 步和第 14400 步各做一次日结
  });

  it('分段推进等于一次推进：日结、两套策略的切换、小结都与怎么分段无关', () => {
    const make = (): SimState => {
      const s = runningState(61);
      unlockAll(s);
      campaignOf(s).districts[0]!.star = 3;
      campaignOf(s).money = 5000;
      must(s, { type: 'openDistrict', district: 1 });
      must(s, { type: 'setRules', rules: { select: 'roundtrip' }, peak: 'evening' });
      return s;
    };
    const whole = make();
    advance(whole, 2 * DAY_STEPS + 50);
    const parts = make();
    const chunks = [1, 1, 5, 493, 1500, 2149, 2999];
    chunks.push(2 * DAY_STEPS + 50 - chunks.reduce((a, b) => a + b, 0));
    for (const n of chunks) advance(parts, n);
    expect(parts.step).toBe(whole.step);
    expect(hashState(parts)).toBe(hashState(whole));
    expect(parts).toEqual(whole);
  });
});

describe('经营模式的状态：哈希覆盖口碑、解锁、策略、日结和小结、便签、结局的字段', () => {
  /** 跑到有日结、小结、便签、两套策略、结局的状态。 */
  function rich(): SimState {
    const { state } = scripted(54);
    campaignOf(state).ending = { step: 1, days: 1, orders: 1 };
    return state;
  }

  it('改动口碑计数、各项开放的步、两套策略、日结和小结的记录、便签、送达总数、结局里的任何一个字段，哈希都会变', () => {
    const state = rich();
    const base = hashState(state);
    const mutate: [string, (c: ReturnType<typeof campaignOf>) => void][] = [
      ['rating.misses', (c) => (c.rating[0]!.misses += 1)],
      ['rating.noUpgrade', (c) => (c.rating[1]!.noUpgrade += 1)],
      ['unlocks.priceTags', (c) => (c.unlocks.priceTags += 1)],
      ['unlocks.showCampus', (c) => (c.unlocks.showCampus += 1)],
      ['ruleSets.noon.select', (c) => (c.ruleSets!.noon.select += 'x')],
      ['ruleSets.evening.pool', (c) => (c.ruleSets!.evening.pool += 'x')],
      ['days.income', (c) => (c.days[0]!.income += 0.5)],
      ['days.pending', (c) => (c.days[1]!.pending += 1)],
      ['days.districts.kind', (c) => (c.days[0]!.districts[0]!.kind = 'starDown')],
      ['days.districts.newShops', (c) => c.days[0]!.districts[0]!.newShops.push({ shop: 0, direction: 'east' })],
      ['peaks.main', (c) => (c.peaks[0]!.main = { id: 'road' })],
      ['peaks.revenue', (c) => (c.peaks[1]!.revenue += 1)],
      ['peaks.districts.delta', (c) => (c.peaks[2]!.districts[0]!.delta = 99)],
      ['peaks.segments', (c) => (c.peaks[0]!.segments = null)],
      ['peaks.early', (c) => (c.peaks[0]!.early = 7)],
      ['peaks.extra', (c) => (c.peaks[3]!.extra = { id: 'notNearest', percent: 1 })],
      ['peaks.districts.line', (c) => (c.peaks[2]!.districts[0]!.line = (c.peaks[2]!.districts[0]!.line ?? 0) + 1)],
      ['peaks.districts.met', (c) => (c.peaks[2]!.districts[0]!.met = c.peaks[2]!.districts[0]!.met !== true)],
      ['peaks.cleared', (c) => (c.peaks[1]!.cleared = c.peaks[1]!.cleared !== true)],
      ['peaks.baseline', (c) => (c.peaks[1]!.baseline = { orders: 1, onTime: 1, late: 0, lateOpen: 0, cancelled: 0, revenue: 5, districts: [], lowLoad: false })],
      ['days.peaksJudged', (c) => (c.days[0]!.peaksJudged += 1)],
      ['days.peaksCleared', (c) => (c.days[0]!.peaksCleared += 1)],
      ['goals', (c) => (c.goals = { day: 0, peak: 'noon', step: 600, goals: [] })],
      ['goals.line', (c) => (c.goals = { day: 0, peak: 'noon', step: 600, goals: [{ district: 0, kind: 'line', line: 70, basis: 'next' }] })],
      ['tips.read', (c) => (c.tips[0]!.read = !c.tips[0]!.read)],
      ['tips.station', (c) => (c.tips[0]!.station = 3)],
      ['delivered', (c) => (c.delivered += 1)],
      ['ending.orders', (c) => (c.ending!.orders += 1)],
      ['ending', (c) => (c.ending = null)],
      ['ruleSets', (c) => (c.ruleSets = null)],
      ['nearestOwned', (c) => (c.nearestOwned = !c.nearestOwned)],
      ['tally.peak.steps', (c) => (c.tally.peak.steps += 1)],
      ['tally.peak.fleet', (c) => (c.tally.peak.fleet[0]![2]! += 1)],
      ['tally.peak.back', (c) => (c.tally.peak.back[0]! += 1)],
      ['tally.peak.takeoffWait', (c) => (c.tally.peak.takeoffWait[0]! += 1)],
      ['tally.peak.queue', (c) => (c.tally.peak.queue[0]! += 1)],
      ['tally.peak.sorties', (c) => (c.tally.peak.sorties[0]! += 1)],
      ['tally.day.drones', (c) => (c.tally.day.drones[5]! += 1)],
      ['tally.day.used', (c) => (c.tally.day.used[5]! += 1)],
      ['peaks.fleet', (c) => (c.peaks[0]!.fleet = null)],
      ['peaks.fleet.work', (c) => (c.peaks[1]!.fleet!.work += 1)],
      ['peaks.fleetBack', (c) => (c.peaks[1]!.fleetBack = (c.peaks[1]!.fleetBack ?? 0) + 1)],
      ['peaks.fleetBack.null', (c) => (c.peaks[2]!.fleetBack = null)],
      ['peaks.stations', (c) => (c.peaks[2]!.stations = [])],
      ['peaks.stations.queuePct', (c) => (c.peaks[2]!.stations[0]!.queuePct += 1)],
      ['peaks.stations.gateWait', (c) => (c.peaks[3]!.stations[0]!.gateWait = 99)],
      ['days.busy', (c) => (c.days[0]!.busy = null)],
      ['days.busy.segment', (c) => (c.days[1]!.busy![9]! += 1)],
      ['unlocks.dataClerk', (c) => (c.unlocks.dataClerk += 1)],
      ['forecast.charges', (c) => (c.forecast.charges += 1)],
      ['effectWatches', (c) => c.effectWatches.push({ kind: 'gate', step: 5, station: 0, level: 2, peak: 'noon', beforeDay: 0, before: 1.5, left: 3, twins: [] })],
      ['effectWatches.twins', (c) => c.effectWatches.push({ kind: 'gate', step: 5, station: 0, level: 2, peak: 'noon', beforeDay: 0, before: 1.5, left: 3, twins: [{ day: 1, peak: 'noon', value: 1.1 }] })],
      ['days.effects', (c) => c.days[0]!.effects.push({ kind: 'nearest', station: null, level: null, peak: 'evening', beforeDay: 0, afterDay: 1, before: 30, after: 25, twin: 31 })],
      ['days.effects.after', (c) => (c.days[1]!.effects = [{ kind: 'doubleBox', station: null, level: null, peak: 'noon', beforeDay: 0, afterDay: 1, before: 1, after: 1.25, twin: 1.2 }])],
    ];
    const missed: string[] = [];
    for (const [name, change] of mutate) {
      const copy = structuredClone(state);
      change(campaignOf(copy));
      if (hashState(copy) === base) missed.push(name);
    }
    expect(missed).toEqual([]);
  });

  it('哈希还覆盖沙盒之外的 state.rules：分开的两套里现在生效的那一套就是它', () => {
    const state = rich();
    const copy = structuredClone(state);
    copy.rules.select += 'x';
    expect(hashState(copy)).not.toBe(hashState(state));
  });
});

describe('经营模式的状态：是可以序列化的普通对象', () => {
  it('没有 NaN、Infinity 和 undefined：JSON 往返之后逐项相同', () => {
    const { state } = scripted(55);
    const text = JSON.stringify(state.campaign);
    expect(text).not.toContain('null,null');
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') expect(Number.isFinite(value), path).toBe(true);
      else if (value === undefined) throw new Error(`undefined at ${path}`);
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(state.campaign, 'campaign');
    expect(JSON.parse(text)).toEqual(state.campaign);
  });

  it('新店的编号都是地图 v1 里的店', () => {
    const { state } = scripted(56);
    for (const day of campaignOf(state).days) {
      for (const line of day.districts) for (const shop of line.newShops) expect(MAP_V1.shops[shop.shop]?.district).toBe(line.district);
    }
  });
});

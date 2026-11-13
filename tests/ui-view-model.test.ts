// 从状态算出界面数据：小票、日程、价签、改装、站点小卡、退回按钮、候选屋顶。
// 期望的价格和上限都由价格表（ECONOMY_V1）和核心的算价函数得出，不写死数字，价格表重新校准之后这里不用改。
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { DAY_STEPS, DroneState, advance, applyCommand, bayPrice, createState, dronePrice, gatePrice, hashState, pushTip, stationPrice } from '../src/core/index.ts';
import { fastForward } from '../src/ui/debug-params.ts';
import { DEFAULT_VIEW, computeUiData, refundOption, wholeMoney } from '../src/ui/view-model.ts';
import { campaignOf, campaignState, must, quietState, runningState, unlockAll, withMoney } from './campaign-helpers.ts';

function data(state: ReturnType<typeof campaignState>): NonNullable<ReturnType<typeof computeUiData>> {
  const d = computeUiData(state);
  if (d === null) throw new Error('no ui data');
  return d;
}

describe('小票和日程', () => {
  it('开局：第 1 天 9:30，资金 0，今日收入 0，不在高峰里', () => {
    const d = data(campaignState());
    expect(d).toMatchObject({ step: 0, day: 1, clock: '9:30', dayFraction: 0, peak: null, balance: 0, earned: 0 });
  });

  it('余额向下取整：显示的数够买什么，就真的能买', () => {
    expect(wholeMoney(120.9)).toBe(120);
    expect(wholeMoney(120)).toBe(120);
    expect(wholeMoney(0.4)).toBe(0);
    expect(wholeMoney(-3)).toBe(0);
    expect(wholeMoney(69.9999999999)).toBe(70); // 浮点误差留了余量
    const price = bayPrice(3); // 开局的站下一个停机位的价格
    const state = campaignState();
    campaignOf(state).money = price + 0.4;
    expect(data(state).balance).toBe(price);
    unlockAll(state);
    expect(applyCommand(state, { type: 'buyBay', station: 0 }).ok).toBe(true);
  });

  it('今日收入取当天的 income，按送达那一天算，前一天的不计入', () => {
    const state = campaignState();
    const camp = campaignOf(state);
    camp.income = [310.7, 55.2];
    expect(data(state).earned).toBe(310);
    state.step = DAY_STEPS + 10;
    expect(data(state).earned).toBe(55);
    state.step = 2 * DAY_STEPS;
    expect(data(state).earned).toBe(0); // 第三天还没有进账
  });

  it('时刻和高峰跟着步数走', () => {
    const state = campaignState();
    state.step = 700;
    expect(data(state)).toMatchObject({ day: 1, clock: '11:50', peak: 'noon' });
    state.step = DAY_STEPS + 2300;
    expect(data(state)).toMatchObject({ day: 2, peak: 'evening' });
  });

  it('真实运行：替玩家点完开局的订单，跑到 90 秒，送达的订单有了进账，第一天没买东西，进账就是余额', () => {
    const state = campaignState();
    fastForward(state, 90);
    const d = data(state);
    expect(d.clock).toBe('12:30');
    expect(d.balance).toBeGreaterThan(0);
    expect(d.earned).toBe(d.balance);
  });
});

describe('站点小卡', () => {
  it('开局只有一座站：一号站，自带的停机位和飞机，上限按它所在的屋顶（中屋顶），起降口 1 级，没有飞机等降落', () => {
    const d = data(campaignState());
    expect(MAP_V1.roofs.find((r) => r.opening)?.size).toBe('medium');
    expect(d.stations).toHaveLength(1);
    expect(d.stations[0]).toMatchObject({
      id: 0,
      number: 1,
      bays: ECONOMY_V1.baysAtBuild,
      bayLimit: ECONOMY_V1.bayCap.medium,
      drones: ECONOMY_V1.openingDrones,
      gateLevel: 1,
      holding: 0,
    });
    expect(d.fallbackStation).toBe(0);
  });

  it('买了停机位和飞机，小卡里的数跟着变', () => {
    const state = withMoney(unlockAll(campaignState()));
    must(state, { type: 'buyBay', station: 0 });
    must(state, { type: 'buyDrone', station: 0 });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(data(state).stations[0]).toMatchObject({ bays: 3, drones: 3, gateLevel: 2 });
  });

  it('新建的站：编号是它的编号加一，上限按屋顶大小，退回的站不再出现，编号不回收', () => {
    const state = withMoney(unlockAll(campaignState()));
    const a = must(state, { type: 'buildStation', roof: 4 }); // 老街的大屋顶
    const b = must(state, { type: 'buildStation', roof: 1 }); // 老街的小屋顶
    expect(data(state).stations.map((s) => [s.number, s.bayLimit])).toEqual([
      [1, ECONOMY_V1.bayCap.medium],
      [a + 1, ECONOMY_V1.bayCap.large],
      [b + 1, ECONOMY_V1.bayCap.small],
    ]);
    must(state, { type: 'refundStation', station: a });
    expect(data(state).stations.map((s) => s.number)).toEqual([1, b + 1]);
    const c = must(state, { type: 'buildStation', roof: 3 });
    expect(c).toBe(3);
    expect(data(state).stations.map((s) => s.number)).toEqual([1, 3, 4]);
  });

  it('等降落的架数：状态是 LandQueue 的飞机', () => {
    const state = campaignState();
    const drone = state.drones[0]!;
    drone.state = DroneState.LandQueue;
    drone.station = 0;
    expect(data(state).stations[0]?.holding).toBe(1);
    drone.removed = true;
    expect(data(state).stations[0]?.holding).toBe(0);
  });

  it('小卡里带这座站的两张价签和起降口一行', () => {
    const state = withMoney(unlockAll(campaignState()));
    const card = data(state).stations[0]!;
    expect(card.tags.addBay).toMatchObject({ price: bayPrice(3), ok: true });
    expect(card.tags.addDrone).toMatchObject({ price: dronePrice(3), ok: false, reason: 'fleetFull' });
    expect(card.gate).toMatchObject({ key: 'gate2', price: gatePrice(2), note: 'desc' });
  });
});

describe('退回按钮', () => {
  it('开局自带的东西不能退：开局的站、飞机和停机位都不是今天买的', () => {
    const state = withMoney(campaignState());
    expect(data(state).stations[0]?.refund).toBeNull();
    expect(refundOption(state, 0)).toBeNull();
  });

  it('今天买的飞机可以退，退回的钱是当时付的钱', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buyBay', station: 0 });
    const drone = must(state, { type: 'buyDrone', station: 0 });
    expect(refundOption(state, 0)).toEqual({ what: 'drone', command: { type: 'refundDrone', drone }, amount: dronePrice(3) });
  });

  it('先退飞机，再退停机位，最后退站：买的顺序倒过来', () => {
    const state = withMoney(quietState());
    const station = must(state, { type: 'buildStation', roof: 1 });
    const bay = must(state, { type: 'buyBay', station });
    expect(bay).toBe(station);
    must(state, { type: 'buyDrone', station });
    const first = refundOption(state, station);
    expect(first?.what).toBe('drone');
    expect(first?.amount).toBe(dronePrice(1)); // 新站上的第一架飞机
    expect(applyCommand(state, first!.command).ok).toBe(true);
    const second = refundOption(state, station);
    expect(second).toMatchObject({ what: 'bay', amount: bayPrice(3), command: { type: 'refundBay', station } });
    expect(applyCommand(state, second!.command).ok).toBe(true);
    const third = refundOption(state, station);
    expect(third?.what).toBe('station');
    // 退站：站价加上当天买的停机位，这里停机位已经退掉了
    expect(third?.amount).toBe(stationPrice(1, 1));
    expect(applyCommand(state, third!.command).ok).toBe(true);
    expect(refundOption(state, station)).toBeNull();
  });

  it('过了日界，前一天买的不能退', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buyBay', station: 0 });
    must(state, { type: 'buyDrone', station: 0 });
    expect(refundOption(state, 0)).not.toBeNull();
    state.step = DAY_STEPS;
    expect(refundOption(state, 0)).toBeNull();
  });

  it('退回的钱显示的是核心的报价，退回之后余额正好加上这笔钱', () => {
    const state = withMoney(quietState(), 1000);
    must(state, { type: 'buyBay', station: 0 });
    must(state, { type: 'buyDrone', station: 0 });
    const option = refundOption(state, 0);
    const before = campaignOf(state).money;
    expect(applyCommand(state, option!.command).ok).toBe(true);
    expect(campaignOf(state).money).toBe(before + option!.amount);
  });
});

describe('新建站点和改装', () => {
  it('新建站点：价格是最便宜的候选屋顶，开局钱不够，变淡，但能进入选屋顶的状态', () => {
    const b = data(campaignState()).build;
    expect(b.tag).toMatchObject({ price: Math.min(...b.candidates.map((c) => stationPrice(1, c.roof))), ok: false, dim: true });
    expect(b.canEnter).toBe(true);
    expect(b.candidates.map((c) => c.roof)).toEqual([1, 2, 3, 4, 5]);
  });

  it('站数到上限之后不能进入选屋顶的状态', () => {
    const state = withMoney(quietState(), 100_000);
    for (const roof of [1, 2, 3]) must(state, { type: 'buildStation', roof });
    expect(data(state).build.canEnter).toBe(false);
  });

  it('改装：双层货箱、就近降落（只有一座站时没开放）、没选站时起降口列 2 级，价格取自价格表', () => {
    const d = data(unlockAll(campaignState()));
    expect(d.doubleBox).toMatchObject({ key: 'doubleBox', price: ECONOMY_V1.doubleBoxPrice, note: 'desc' });
    expect(d.nearbyLanding).toMatchObject({ key: 'nearbyLanding', price: ECONOMY_V1.nearestLandingPrice, note: 'locked' });
    expect(d.gateWithoutStation).toMatchObject({ key: 'gate2', price: gatePrice(2), note: 'needStation' });
  });
});

describe('片区纸条、调度台、小结、日结、便签、结局的字段', () => {
  it('开局：纸条是老街的，暂无完成订单，没有调度台、小结、日结、便签、结局', () => {
    const d = data(campaignState());
    expect(d.note).toMatchObject({ district: 0, name: '老街', star: 1, kind: 'noData', text: fmt(STR.hud.districtNote.noData, { district: '老街' }) });
    expect(d.noteChoices).toEqual([0]);
    expect(d).toMatchObject({ board: null, summary: null, dayEnd: null, tip: null, ending: null });
  });

  it('界面自己的选择：看哪个片区的纸条，没开通的片区换成编号最小的已开通的', () => {
    const state = campaignState();
    expect(computeUiData(state, { ...DEFAULT_VIEW, noteDistrict: 2 })?.note.district).toBe(0);
    campaignOf(state).districts[1]!.open = true;
    expect(computeUiData(state, { ...DEFAULT_VIEW, noteDistrict: 1 })?.note.name).toBe('写字楼区');
    expect(computeUiData(state)?.noteChoices).toEqual([0, 1]);
  });

  it('日结小票的内容只在日结小票开着时才算：开着时是最近一次日结', () => {
    const state = runningState(42);
    advance(state, DAY_STEPS + 1);
    expect(computeUiData(state, { ...DEFAULT_VIEW, dayEndOpen: false })?.dayEnd).toBeNull();
    expect(computeUiData(state, { ...DEFAULT_VIEW, dayEndOpen: true })?.dayEnd).toMatchObject({ title: '日结', day: '第 1 天' });
  });

  it('最近的小结只在今天有：生成之后有，第二天没有', () => {
    const state = runningState(42);
    advance(state, 1801);
    expect(computeUiData(state)?.summary).toMatchObject({ title: '午高峰小结' });
    advance(state, DAY_STEPS);
    expect(campaignOf(state).peaks).toHaveLength(3); // 第一天的午晚两场，第二天的午高峰
    expect(computeUiData(state)?.summary).toMatchObject({ title: '午高峰小结', period: '第 2 天  11:30-14:30' });
    state.step = 2 * DAY_STEPS + 10;
    expect(computeUiData(state)?.summary).toBeNull();
  });

  it('白板跟着选择：页签选的那一套、调度台有没有', () => {
    const state = unlockAll(campaignState());
    expect(computeUiData(state)?.board?.title).toBe('调度台');
    expect(computeUiData(state, { ...DEFAULT_VIEW, boardPeak: 'evening' })?.board?.shownPeak).toBeNull(); // 没分成两套
  });

  it('便签和结局：最早没读的一张，结局的整句', () => {
    const state = campaignState();
    pushTip(state, 'autoDispatchOn');
    expect(computeUiData(state)?.tip).toEqual({ id: 'autoDispatchOn', text: STR.tips.autoDispatchOn, queued: 0 });
    campaignOf(state).ending = { step: 5, days: 4, orders: 12 };
    expect(computeUiData(state)?.ending).toBe(fmt(STR.system.ending, { orders: 12, days: 4 }));
  });

  it('价签、双层货箱、开通价签的显示跟着开放项', () => {
    const state = campaignState();
    expect(computeUiData(state)).toMatchObject({ tagsShown: false, doubleBoxShown: false, openTags: [] });
    unlockAll(state);
    const d = data(state);
    expect(d.tagsShown).toBe(true);
    expect(d.doubleBoxShown).toBe(true);
    expect(d.openTags.map((t) => t.district)).toEqual([1, 2]);
  });
});

describe('只读', () => {
  it('算界面数据不改状态', () => {
    const state = withMoney(campaignState(), 900);
    advance(state, 300);
    const before = hashState(state);
    const json = JSON.stringify(state);
    computeUiData(state);
    computeUiData(state);
    expect(hashState(state)).toBe(before);
    expect(JSON.stringify(state)).toBe(json);
  });

  it('沙盒模式没有余额和站点的经营数据，返回 null', () => {
    expect(computeUiData(createState({}))).toBeNull();
  });

  it('同一个状态算两次，结果完全相同', () => {
    const state = withMoney(campaignState(), 900);
    advance(state, 200);
    expect(JSON.stringify(computeUiData(state))).toBe(JSON.stringify(computeUiData(state)));
  });
});

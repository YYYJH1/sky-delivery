// 数据员和推演次数：数据员随价签一起到岗，推演次数从开局起每场高峰加一次、攒到上限，useForecast 命令扣一次。
// 推演本身（复制状态、换订单序列、运行）在应用层，这里只测核心里记的那部分：开放的时刻、次数、命令的成功和失败、不影响模拟。
import { describe, expect, it } from 'vitest';
import { FORECAST_V1 } from '../src/content/forecast_v1.ts';
import { UNLOCKS_V1 } from '../src/content/unlocks_v1.ts';
import {
  DAY_STEPS,
  FORECAST_V1 as coreForecast,
  advance,
  applyCommand,
  createState,
  forwardToShadow,
  hashState,
  isForwarded,
  isUnlocked,
  openShadow,
  quoteCommand,
  recordPeakSummary,
  step,
  unreadTips,
} from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { campaignOf, expectRejected, must, quietState, runningState, unlockAll, withMoney } from './campaign-helpers.ts';
import { OPENING } from './helpers.ts';

const NOON = 1800; // 午高峰的小结时刻（天内）
const EVENING = 3400; // 晚高峰的小结时刻
const BALANCE = UNLOCKS_V1.priceTagsBalance;

/** 第一次日结时余额刚好够，价签在日结的那一步（第 3600 步）开放，数据员同时到岗。没有订单，两场小结都是空的。 */
function atPriceTags(): SimState {
  const state = quietState({}, false);
  advance(state, DAY_STEPS);
  campaignOf(state).money = BALANCE;
  step(state);
  return state;
}

describe('内容表里的数：推演次数的上限、每场加几次、订单序列数、效果记录的天数', () => {
  it('上限 4 次，每场高峰加 1 次，一次推演用 16 套订单序列，效果记录写 3 次日结', () => {
    expect(FORECAST_V1).toEqual({ maxCharges: 4, chargesPerPeak: 1, sequences: 16, effectDays: 3 });
  });

  it('应用层只能经核心的入口读内容表，入口导出的就是内容表里的这张表', () => {
    expect(coreForecast).toBe(FORECAST_V1);
    expect(coreForecast.sequences).toBe(16);
  });
});

describe('数据员：随价签一起到岗，推演不收费', () => {
  it('开局没到岗：推演失败，原因是 ruleLocked，状态一点不变，就算已经攒了次数也一样', () => {
    const state = quietState({}, false);
    expect(isUnlocked(state, 'dataClerk')).toBe(false);
    expect(campaignOf(state).unlocks.dataClerk).toBe(-1);
    campaignOf(state).forecast.charges = 3;
    expectRejected(state, { type: 'useForecast' }, 'ruleLocked');
    expect(campaignOf(state).forecast.charges).toBe(3);
  });

  it('价签开放的那一步，数据员同时到岗，开放的步相同；资金不够的购买也不影响推演，因为推演不收费', () => {
    const state = atPriceTags();
    const campaign = campaignOf(state);
    expect(campaign.unlocks.priceTags).toBe(DAY_STEPS);
    expect(campaign.unlocks.doubleBox).toBe(DAY_STEPS);
    expect(campaign.unlocks.dataClerk).toBe(DAY_STEPS);
    expect(isUnlocked(state, 'dataClerk')).toBe(true);
    campaign.money = 0;
    must(state, { type: 'useForecast' });
  });

  it('到岗时放出「数据员已到岗」的便签，出现的步就是到岗的那一步，排在「可新增停机位」后面，只放一次，用 readTip 标记已读', () => {
    const state = atPriceTags();
    const tips = campaignOf(state).tips.map((t) => [t.id, t.step]);
    expect(tips.filter(([id]) => id === 'canAddBay' || id === 'dataClerk')).toEqual([['canAddBay', DAY_STEPS], ['dataClerk', DAY_STEPS]]);
    const unread = (): string[] => unreadTips(state).map((t) => t.id).filter((id) => id === 'canAddBay' || id === 'dataClerk');
    expect(unread()).toEqual(['canAddBay', 'dataClerk']);
    must(state, { type: 'readTip', tip: 'dataClerk' });
    expect(unread()).toEqual(['canAddBay']);
    advance(state, DAY_STEPS + 100);
    expect(campaignOf(state).tips.filter((t) => t.id === 'dataClerk')).toHaveLength(1);
  });

  it('价签没开放时数据员也没到岗：第一次日结余额差一点，不到岗，之后余额达到门槛的那一步价签和数据员一起开放', () => {
    const state = quietState({}, false);
    advance(state, DAY_STEPS);
    campaignOf(state).money = BALANCE - 0.01;
    step(state); // 第 3600 步：日结
    expect(isUnlocked(state, 'priceTags')).toBe(false);
    expect(isUnlocked(state, 'dataClerk')).toBe(false);
    expect(campaignOf(state).tips.some((t) => t.id === 'dataClerk')).toBe(false);
    advance(state, 50);
    campaignOf(state).money = BALANCE;
    step(state);
    expect(campaignOf(state).unlocks.priceTags).toBe(DAY_STEPS + 51);
    expect(campaignOf(state).unlocks.dataClerk).toBe(DAY_STEPS + 51);
    expect(campaignOf(state).tips.filter((t) => t.id === 'dataClerk').map((t) => t.step)).toEqual([DAY_STEPS + 51]);
  });

  it('第一次日结之前，余额再多也没到岗', () => {
    const state = withMoney(quietState({}, false));
    advance(state, DAY_STEPS);
    expect(campaignOf(state).days).toHaveLength(0);
    expect(isUnlocked(state, 'dataClerk')).toBe(false);
  });

  it('次数从开局起就累积，到岗时已经有 2 次：第一天的午、晚两场小结各加一次', () => {
    const state = atPriceTags();
    expect(campaignOf(state).peaks).toHaveLength(2);
    expect(campaignOf(state).forecast.charges).toBe(2);
    must(state, { type: 'useForecast' });
    must(state, { type: 'useForecast' });
    expectRejected(state, { type: 'useForecast' }, 'noForecastCharge');
  });

  it('价签已开放、数据员没开放的状态（读档的旧存档，或外部改过的状态）：下一步开始时补开，开放的步取这一步，放出便签', () => {
    const state = withMoney(quietState());
    campaignOf(state).unlocks.dataClerk = -1;
    campaignOf(state).forecast.charges = 1;
    expectRejected(state, { type: 'useForecast' }, 'ruleLocked');
    state.step = 4321;
    step(state);
    expect(campaignOf(state).unlocks.dataClerk).toBe(4321);
    expect(campaignOf(state).tips.filter((t) => t.id === 'dataClerk').map((t) => t.step)).toEqual([4321]);
    must(state, { type: 'useForecast' });
  });

  it('同一个状态，在下一个命令之后也补开：命令执行完立刻检查开放条件', () => {
    const state = withMoney(quietState());
    campaignOf(state).unlocks.dataClerk = -1;
    must(state, { type: 'buyBay', station: 0 });
    expect(campaignOf(state).unlocks.dataClerk).toBe(state.step);
  });

  it('开放之后不再锁上，开放的步不会被改写：余额掉到门槛以下也一样', () => {
    const state = atPriceTags();
    campaignOf(state).money = 1;
    advance(state, 2 * DAY_STEPS);
    expect(campaignOf(state).unlocks.dataClerk).toBe(DAY_STEPS);
    expect(isUnlocked(state, 'dataClerk')).toBe(true);
  });

  it('沙盒模式没有开放这回事，推演命令也不是沙盒的命令：notCampaign', () => {
    const sandbox = createState({ ...OPENING });
    expect(isUnlocked(sandbox, 'dataClerk')).toBe(true);
    expect(quoteCommand(sandbox, { type: 'useForecast' })).toMatchObject({ ok: false, reason: 'notCampaign' });
  });
});

describe('推演次数：每场高峰的小结生成时加一次，攒到上限为止', () => {
  it('开局是 0', () => {
    expect(campaignOf(quietState({}, false)).forecast).toEqual({ charges: 0 });
  });

  it('小结时刻加一次，只在小结时刻加：日结、开放、命令都不加。一直加到上限，之后每一场都停在上限', () => {
    const state = quietState({}, false);
    const jumps: [number, number][] = []; // [这一步结束后的步数，加完之后的次数]
    let last = 0;
    for (let i = 0; i < 4 * DAY_STEPS; i++) {
      step(state);
      const now = campaignOf(state).forecast.charges;
      if (now !== last) jumps.push([state.step, now]);
      last = now;
    }
    // 第 0 到 3 天每天两场小结：第 1800 步和第 3400 步，各加一次；加到 4 次就停了，第 5400 步和之后的小结不再加
    expect(jumps).toEqual([
      [NOON + 1, 1],
      [EVENING + 1, 2],
      [DAY_STEPS + NOON + 1, 3],
      [DAY_STEPS + EVENING + 1, 4],
    ]);
    expect(campaignOf(state).peaks).toHaveLength(8);
    expect(campaignOf(state).forecast.charges).toBe(FORECAST_V1.maxCharges);
  });

  it('用掉之后，下一场高峰的小结补一次；用掉几次，就要几场高峰才能补回来', () => {
    const state = atPriceTags(); // 第 3601 步，到岗时有 2 次
    advance(state, DAY_STEPS); // 第 1 天的午、晚两场小结之后：4 次，第 7201 步
    expect(campaignOf(state).forecast.charges).toBe(4);
    must(state, { type: 'useForecast' });
    expect(campaignOf(state).forecast.charges).toBe(3);
    advance(state, NOON); // 第 2 天午高峰的小结之后
    expect(campaignOf(state).forecast.charges).toBe(4);
    must(state, { type: 'useForecast' });
    must(state, { type: 'useForecast' });
    must(state, { type: 'useForecast' });
    expect(campaignOf(state).forecast.charges).toBe(1);
    advance(state, DAY_STEPS); // 第 2 天的晚高峰和第 3 天的午高峰，两场
    expect(campaignOf(state).forecast.charges).toBe(3);
  });

  it('在已攒满的时候再生成一场小结：停在上限，不溢出，也不丢已有的', () => {
    const state = quietState({}, false);
    campaignOf(state).forecast.charges = FORECAST_V1.maxCharges;
    state.step = NOON;
    recordPeakSummary(state, 0, 'noon');
    expect(campaignOf(state).forecast.charges).toBe(FORECAST_V1.maxCharges);
    campaignOf(state).forecast.charges = FORECAST_V1.maxCharges - 1;
    state.step = EVENING;
    recordPeakSummary(state, 0, 'evening');
    expect(campaignOf(state).forecast.charges).toBe(FORECAST_V1.maxCharges);
  });

  it('次数按小结生成的次数算，与这一场有没有订单、有没有结果无关', () => {
    const state = runningState(31); // 有随机订单
    advance(state, DAY_STEPS);
    expect(campaignOf(state).peaks).toHaveLength(2);
    expect(campaignOf(state).forecast.charges).toBe(2);
  });
});

describe('useForecast：免费，扣一次次数', () => {
  /** 数据员到岗、有 3 次的状态，余额为 0。 */
  function ready(): SimState {
    const state = unlockAll(quietState({}, false));
    campaignOf(state).forecast.charges = 3;
    campaignOf(state).money = 0;
    return state;
  }

  it('成功：次数减一，返回 -1，价签说免费，价格 0；余额、花费、便签和别的状态一点不变', () => {
    const state = ready();
    const quote = quoteCommand(state, { type: 'useForecast' });
    expect(quote).toEqual({ ok: true, reason: null, kind: 'free', price: 0 });
    const before = JSON.parse(JSON.stringify(state)) as SimState;
    expect(must(state, { type: 'useForecast' })).toBe(-1);
    expect(campaignOf(state).forecast.charges).toBe(2);
    // 除了次数，别的都和命令之前相同
    const after = JSON.parse(JSON.stringify(state)) as SimState;
    campaignOf(after).forecast.charges = 3;
    expect(after).toEqual(before);
    expect(campaignOf(state).money).toBe(0);
    expect(campaignOf(state).spent).toBe(0);
  });

  it('问价不改状态', () => {
    const state = ready();
    const hash = hashState(state);
    quoteCommand(state, { type: 'useForecast' });
    expect(hashState(state)).toBe(hash);
  });

  it('次数用完：noForecastCharge，状态一点不变，问价也给出同样的原因', () => {
    const state = ready();
    must(state, { type: 'useForecast' });
    must(state, { type: 'useForecast' });
    must(state, { type: 'useForecast' });
    expect(campaignOf(state).forecast.charges).toBe(0);
    expect(quoteCommand(state, { type: 'useForecast' })).toEqual({ ok: false, reason: 'noForecastCharge', kind: 'free', price: 0 });
    expectRejected(state, { type: 'useForecast' }, 'noForecastCharge');
    expect(campaignOf(state).forecast.charges).toBe(0);
  });

  it('数据员没到岗：ruleLocked，不管有没有次数；两个条件都不满足时先报没到岗', () => {
    const state = quietState({}, false);
    expect(campaignOf(state).forecast.charges).toBe(0);
    expectRejected(state, { type: 'useForecast' }, 'ruleLocked'); // 没到岗，也没有次数
    campaignOf(state).forecast.charges = 2;
    expectRejected(state, { type: 'useForecast' }, 'ruleLocked'); // 没到岗，有次数
    expect(quoteCommand(state, { type: 'useForecast' })).toEqual({ ok: false, reason: 'ruleLocked', kind: 'free', price: 0 });
  });

  it('不看余额：没有钱也能推演；也不改余额', () => {
    const state = ready();
    campaignOf(state).money = 0;
    must(state, { type: 'useForecast' });
    expect(campaignOf(state).money).toBe(0);
  });

  it('不做给小结对照的副本：不在转发的命令里，转发给副本什么也不改，副本也没有对不上', () => {
    const state = ready();
    expect(isForwarded({ type: 'useForecast' })).toBe(false);
    const shadow = openShadow(structuredClone(state), 0, 'noon');
    const hash = hashState(shadow.state);
    must(state, { type: 'useForecast' });
    forwardToShadow(shadow, state, { type: 'useForecast' });
    expect(hashState(shadow.state)).toBe(hash);
    expect(campaignOf(shadow.state).forecast.charges).toBe(3); // 副本的次数不变，主状态扣了一次
    expect(shadow.diverged).toBe(false);
  });

  it('不影响模拟：同一局里在各个时刻使用推演，除了推演次数，每一步的状态都和不使用的一局相同', () => {
    const make = (): SimState => {
      const s = runningState(21);
      unlockAll(s);
      campaignOf(s).money = 5000;
      return s;
    };
    const used = make();
    const plain = make();
    const shopping = [{ type: 'buyBay', station: 0 }, { type: 'buyDrone', station: 0 }, { type: 'upgradeGate', station: 0 }, { type: 'buyDoubleBox' }] as const;
    let uses = 0;
    for (let i = 0; i < 3 * DAY_STEPS; i++) {
      if (i % 400 === 0) {
        const command = shopping[(i / 400) % shopping.length]!;
        expect(applyCommand(used, command)).toEqual(applyCommand(plain, command)); // 有的购买会因为上限失败，两边的结果相同
      }
      if (i % 233 === 0 && campaignOf(used).forecast.charges > 0) {
        must(used, { type: 'useForecast' });
        uses += 1;
      }
      step(used);
      step(plain);
      if (i % 250 === 0) {
        // 次数不同，其余相同：把推演的一局的次数换成不推演的那一局的，哈希应当相同
        const copy = structuredClone(used);
        campaignOf(copy).forecast = { ...campaignOf(plain).forecast };
        expect(hashState(copy), `第 ${i} 步`).toBe(hashState(plain));
      }
    }
    expect(uses).toBeGreaterThanOrEqual(4);
    expect(campaignOf(used).forecast.charges).not.toBe(campaignOf(plain).forecast.charges);
  });

  it('没有人使用推演的运行里，次数只增不减，最后停在上限', () => {
    const state = runningState(41);
    let previous = 0;
    for (let i = 0; i < 3 * DAY_STEPS; i++) {
      step(state);
      const now = campaignOf(state).forecast.charges;
      expect(now).toBeGreaterThanOrEqual(previous);
      expect(now).toBeLessThanOrEqual(FORECAST_V1.maxCharges);
      previous = now;
    }
    expect(previous).toBe(FORECAST_V1.maxCharges);
  });
});

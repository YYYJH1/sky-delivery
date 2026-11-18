// 数据员的推演在界面里的部分：入口的显示条件，选项的名称和命令，推演单各行的文字和数的写法，
// 点「推演」之后的流程（出了结果才扣次数，取消和无法推演不扣，推演进行中不能再点，次数用完时提示），日结小票里的效果记录。
// 推演的计算和后台线程在 forecast.test.ts、forecast-client.test.ts，这里用假的线程，只管界面这一边。
import { describe, expect, it } from 'vitest';
import { summarizeForecast } from '../src/app/index.ts';
import type { ForecastDone } from '../src/app/index.ts';
import { createForecastClient } from '../src/app/forecast-client.ts';
import type { WorkerLike } from '../src/app/forecast-client.ts';
import type { ForecastReply, ForecastRequest, ForecastRunRequest } from '../src/app/forecast-worker.ts';
import type { ForecastPart, ForecastUnavailable } from '../src/app/forecast.ts';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { DAY_STEPS, FORECAST_V1, applyCommand, hashState, quoteCommand, recordTwin, settleDay } from '../src/core/index.ts';
import type { Command, EffectLine, PeakFleet, PeakName, PeakRecord, PeakStationRow, SimState } from '../src/core/index.ts';
import { computeBoard } from '../src/ui/board.ts';
import { buyLines } from '../src/ui/card.ts';
import { applyDebug, parseGameParams } from '../src/ui/debug-params.ts';
import {
  ON_TIME_EVEN,
  REVENUE_EVEN,
  chargesText,
  doneView,
  failedView,
  forecastButton,
  forecastCommand,
  forecastInfo,
  forecastMarks,
  forecastOptionName,
  onTimeText,
  revenueText,
  runningView,
  upgradeForecast,
} from '../src/ui/forecast.ts';
import type { ForecastDoneView, ForecastFailedView, ForecastOption, ForecastRunningView, ForecastSheetState } from '../src/ui/forecast.ts';
import { createForecastFlow } from '../src/ui/forecast-flow.ts';
import { failureText } from '../src/ui/reasons.ts';
import { gateItem, stationTags } from '../src/ui/tags.ts';
import { dayEndTicket, effectLines, effectText, latestDayEnd, sentenceLines } from '../src/ui/tickets.ts';
import { computeUiData, upgradeRows } from '../src/ui/view-model.ts';
import { campaignOf, campaignState, must, quietState, unlockAll, withMoney } from './campaign-helpers.ts';

function data(state: SimState): NonNullable<ReturnType<typeof computeUiData>> {
  const d = computeUiData(state);
  if (d === null) throw new Error('no ui data');
  return d;
}

/** 按调试参数开局的状态，和游戏页面里一样：打开「合单策略」一栏时这一栏自动换成顺路合并，开通写字楼区时分成午晚两套。 */
function applyDebugState(search: string): SimState {
  const state = campaignState();
  applyDebug(state, parseGameParams(search));
  return state;
}

describe('文字：照词表', () => {
  it('推演单和按钮的十四条文字，选项名称的九条文字', () => {
    expect(STR.hud.forecast).toMatchObject({
      button: '推演',
      charges: '推演次数 {count}/{max}',
      running: '推演中',
      title: '推演　{option}',
      tally: '{runs} 次中 {better} 次更好，{worse} 次更差',
      onTimeMore: '准时订单平均多 {count} 单',
      onTimeLess: '准时订单平均少 {count} 单',
      onTimeSame: '准时订单平均持平',
      revenueMore: '收入平均增加 ¥{amount}',
      revenueLess: '收入平均减少 ¥{amount}',
      revenueSame: '收入平均持平',
      unclear: '差别不明显',
      scope: '统计至第二场高峰小结',
      failed: '无法推演　{reason}',
    });
    expect(STR.hud.forecast.option).toEqual({
      addBay: '{station}号站新增停机位',
      addDrone: '{station}号站购买无人机',
      gate: '{station}号站起降口 {level} 级',
      doubleBox: '双层货箱',
      nearestBuy: '就近降落',
      nearestOn: '开启就近降落',
      nearestOff: '关闭就近降落',
      card: '{column}改为{card}',
      cardInPeak: '{peak}{column}改为{card}',
    });
  });

  it('标题和无法推演的两条，中间是全角空格', () => {
    const full = String.fromCodePoint(0x3000);
    expect(STR.hud.forecast.title).toBe(`推演${full}{option}`);
    expect(STR.hud.forecast.failed).toBe(`无法推演${full}{reason}`);
  });
});

describe('选项的名称和命令', () => {
  const cases: { option: ForecastOption; name: string; command: Command }[] = [
    { option: { kind: 'addBay', station: 1 }, name: '二号站新增停机位', command: { type: 'buyBay', station: 1 } },
    { option: { kind: 'addDrone', station: 0 }, name: '一号站购买无人机', command: { type: 'buyDrone', station: 0 } },
    { option: { kind: 'gate', station: 1, level: 2 }, name: '二号站起降口 2 级', command: { type: 'upgradeGate', station: 1 } },
    { option: { kind: 'gate', station: 3, level: 3 }, name: '四号站起降口 3 级', command: { type: 'upgradeGate', station: 3 } },
    { option: { kind: 'doubleBox' }, name: '双层货箱', command: { type: 'buyDoubleBox' } },
    { option: { kind: 'nearestBuy' }, name: '就近降落', command: { type: 'buyNearestLanding' } },
    { option: { kind: 'nearestOn' }, name: '开启就近降落', command: { type: 'setNearestLanding', on: true } },
    { option: { kind: 'nearestOff' }, name: '关闭就近降落', command: { type: 'setNearestLanding', on: false } },
    { option: { kind: 'card', column: 'select', rule: 'deadline', peak: null }, name: '调度策略改为时限优先', command: { type: 'setRules', rules: { select: 'deadline' } } },
    { option: { kind: 'card', column: 'pool', rule: 'any', peak: 'evening' }, name: '晚高峰合单策略改为顺路合并', command: { type: 'setRules', rules: { pool: 'any' }, peak: 'evening' } },
    { option: { kind: 'card', column: 'zone', rule: 'strict', peak: 'noon' }, name: '午高峰协同策略改为仅限最近站点', command: { type: 'setRules', rules: { zone: 'strict' }, peak: 'noon' } },
    { option: { kind: 'card', column: 'select', rule: 'prioOffice', peak: null }, name: '调度策略改为写字楼区优先', command: { type: 'setRules', rules: { select: 'prioOffice' } } },
  ];

  it('每种选项的名称：站号写成汉字，栏名和卡名取调度台上的，分午晚两套时前面加高峰名', () => {
    for (const c of cases) expect(forecastOptionName(c.option), JSON.stringify(c.option)).toBe(c.name);
  });

  it('每种选项换成核心的命令，分午晚两套时命令带 peak，没分开时不带', () => {
    for (const c of cases) expect(forecastCommand(c.option), JSON.stringify(c.option)).toEqual(c.command);
  });

  it('选项的命令在核心里都能问价：条件满足时可以，钱不够时只是资金不足（推演照样算），换卡不收费', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: 1 }); // 第二座站，就近降落才能买
    const purchases = [
      { kind: 'addBay', station: 0 },
      { kind: 'addDrone', station: 1 },
      { kind: 'gate', station: 0, level: 2 },
      { kind: 'doubleBox' },
      { kind: 'nearestBuy' },
    ] as const;
    const card = { kind: 'card', column: 'select', rule: 'deadline', peak: null } as const;
    for (const option of [...purchases, card]) expect(quoteCommand(state, forecastCommand(option)).ok, JSON.stringify(option)).toBe(true);
    campaignOf(state).money = 1;
    for (const option of purchases) expect(quoteCommand(state, forecastCommand(option)), JSON.stringify(option)).toMatchObject({ ok: false, reason: 'notEnoughMoney' });
    expect(quoteCommand(state, forecastCommand(card))).toMatchObject({ ok: true, kind: 'free', price: 0 });
  });
});

describe('入口的显示条件', () => {
  it('数据员没到岗：没有推演次数的数据，所有入口都不显示', () => {
    const state = campaignState();
    expect(forecastInfo(state)).toBeNull();
    expect(data(state).forecast).toBeNull();
    expect(forecastButton(null, { kind: 'doubleBox' }, false)).toBeNull();
    expect(forecastButton(null, { kind: 'doubleBox' }, true)).toBeNull();
  });

  it('数据员到岗（随价签开放）之后：给出还剩几次和上限，上限取自内容表', () => {
    const state = unlockAll(campaignState());
    expect(data(state).forecast).toEqual({ charges: 0, max: FORECAST_V1.maxCharges });
    campaignOf(state).forecast.charges = 3;
    expect(data(state).forecast).toEqual({ charges: 3, max: FORECAST_V1.maxCharges });
    expect(chargesText({ charges: 3, max: 4 })).toBe('推演次数 3/4');
  });

  it('只开了价签没有开数据员的状态（不会出现，核心把两项一起开放）：以数据员的开放为准', () => {
    const state = campaignState();
    campaignOf(state).unlocks.priceTags = 0;
    expect(data(state).forecast).toBeNull();
    campaignOf(state).unlocks.dataClerk = 0;
    expect(data(state).forecast).not.toBeNull();
  });

  it('沙盒模式没有数据员', () => {
    expect(forecastInfo({ ...campaignState(), campaign: null })).toBeNull();
  });

  it('按钮：没有可推演的选项时不显示；有选项时写「推演」，次数用完变淡，推演进行中写「推演中」，不能再点', () => {
    const option: ForecastOption = { kind: 'doubleBox' };
    expect(forecastButton({ charges: 2, max: 4 }, null, false)).toBeNull();
    expect(forecastButton({ charges: 2, max: 4 }, option, false)).toEqual({ text: '推演', dim: false, busy: false });
    expect(forecastButton({ charges: 0, max: 4 }, option, false)).toEqual({ text: '推演', dim: true, busy: false });
    expect(forecastButton({ charges: 2, max: 4 }, option, true)).toEqual({ text: '推演中', dim: false, busy: true });
    expect(forecastButton({ charges: 0, max: 4 }, option, true)).toEqual({ text: '推演中', dim: false, busy: true });
  });
});

describe('改装单里哪些节点能推演', () => {
  it('没买过的、已经开放的节点：双层货箱。没选站点时起降口两行没有，只有一座站时就近降落没开放，也没有', () => {
    const state = withMoney(quietState());
    const rows = upgradeRows(data(state), null);
    expect(rows.map((r) => r.key)).toEqual(['doubleBox', 'gate2', 'gate3', 'nearbyLanding']);
    expect(rows.map(upgradeForecast)).toEqual([{ kind: 'doubleBox' }, null, null, null]);
  });

  it('选中一座一级站：起降口 2 级能推演，3 级要先到 2 级，没有；升到 2 级之后 3 级能推演，2 级已购买，没有', () => {
    const state = withMoney(quietState());
    expect(upgradeRows(data(state), 0).map(upgradeForecast)).toEqual([{ kind: 'doubleBox' }, { kind: 'gate', station: 0, level: 2 }, null, null]);
    must(state, { type: 'upgradeGate', station: 0 });
    expect(upgradeRows(data(state), 0).map(upgradeForecast)).toEqual([{ kind: 'doubleBox' }, null, { kind: 'gate', station: 0, level: 3 }, null]);
    must(state, { type: 'upgradeGate', station: 0 });
    expect(upgradeRows(data(state), 0).map(upgradeForecast)).toEqual([{ kind: 'doubleBox' }, null, null, null]);
  });

  it('买过的节点没有：双层货箱买下之后不再列推演', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buyDoubleBox' });
    expect(upgradeForecast(upgradeRows(data(state), null)[0]!)).toBeNull();
  });

  it('资金不足的节点也能推演：节点变淡，推演照样可以点', () => {
    const state = withMoney(quietState(), 5);
    const rows = upgradeRows(data(state), 0);
    expect(rows[0]).toMatchObject({ key: 'doubleBox', dim: true });
    expect(upgradeForecast(rows[0]!)).toEqual({ kind: 'doubleBox' });
    expect(upgradeForecast(rows[1]!)).toEqual({ kind: 'gate', station: 0, level: 2 });
  });

  it('就近降落：有两座站时没买过的能推演；买下之后推演切换开关，开着时推演关闭，关着时推演开启', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: 1 });
    expect(upgradeForecast(upgradeRows(data(state), null)[3]!)).toEqual({ kind: 'nearestBuy' });
    must(state, { type: 'buyNearestLanding' });
    expect(upgradeForecast(upgradeRows(data(state), null)[3]!)).toEqual({ kind: 'nearestOff' });
    must(state, { type: 'setNearestLanding', on: false });
    expect(upgradeForecast(upgradeRows(data(state), null)[3]!)).toEqual({ kind: 'nearestOn' });
  });
});

describe('站点小卡的「本站可购买」里哪些项有「推演」按钮', () => {
  const lines = (state: SimState, station = 0): ReturnType<typeof buyLines> => buyLines(state, station, stationTags(state, station), gateItem(state, station));

  it('三项都能买时各带一个选项：新增停机位、购买无人机、起降口的下一级，站号是这座站', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: 1 }); // 新站有空闲停机位，三项都买得了
    expect(lines(state, second).map((l) => l.reason)).toEqual([null, null, null]);
    expect(lines(state, second).map((l) => l.forecast)).toEqual([
      { kind: 'addBay', station: second },
      { kind: 'addDrone', station: second },
      { kind: 'gate', station: second, level: 2 },
    ]);
  });

  it('不是钱的原因买不了的项没有按钮：没有空闲停机位的购买无人机，停机位已达上限的新增停机位，起降口已是 3 级的这一项', () => {
    const state = withMoney(quietState());
    // 开局的站停机位都有飞机：购买无人机没有空闲停机位，另两项照常有
    expect(lines(state)[1]).toMatchObject({ key: 'drone', reason: '该站点没有空闲停机位', forecast: null });
    expect(lines(state)[0]?.forecast).toEqual({ kind: 'addBay', station: 0 });
    expect(lines(state)[2]?.forecast).toEqual({ kind: 'gate', station: 0, level: 2 });
    // 停机位加到屋顶的上限
    for (let i = ECONOMY_V1.baysAtBuild; i < ECONOMY_V1.bayCap.medium; i++) must(state, { type: 'buyBay', station: 0 });
    expect(lines(state)[0]).toMatchObject({ key: 'bay', reason: `停机位已达上限（${ECONOMY_V1.bayCap.medium} 个）`, forecast: null });
    // 起降口升到 2 级之后列 3 级，还能买，有按钮。升到 3 级之后写已购买，没有按钮
    must(state, { type: 'upgradeGate', station: 0 });
    expect(lines(state)[2]?.forecast).toEqual({ kind: 'gate', station: 0, level: 3 });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(lines(state)[2]).toMatchObject({ key: 'gate', reason: '已购买', forecast: null });
    // 停机位加满之后有了空位，购买无人机能买了，有按钮
    expect(lines(state).map((l) => l.forecast)).toEqual([null, { kind: 'addDrone', station: 0 }, null]);
  });

  it('全城的无人机总数已不少于停机位总数时，购买无人机也没有按钮', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: 1 });
    expect(lines(state, second)[1]?.forecast).toEqual({ kind: 'addDrone', station: second });
    // 把停机位都占满：每买一架飞机少一个空位，买到全城停机位总数
    for (let i = 0; i < 200 && quoteCommand(state, { type: 'buyDrone', station: second }).ok; i++) must(state, { type: 'buyDrone', station: second });
    expect(quoteCommand(state, { type: 'buyDrone', station: second }).ok).toBe(false);
    expect(lines(state, second)[1]).toMatchObject({ key: 'drone', forecast: null });
    expect(lines(state, second)[1]?.reason).not.toBeNull();
  });

  it('只是钱不够的项照常有按钮，推演不受资金限制：三项都变淡，选项还在', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: 1 }); // 钱很多的状态里建站，再把钱改少
    campaignOf(state).money = 3;
    const rows = lines(state, second);
    expect(rows.map((l) => l.dim)).toEqual([true, true, true]);
    expect(rows.map((l) => l.reason)).toEqual([null, null, null]); // 钱不够不写原因
    expect(rows.map((l) => l.forecast)).toEqual([
      { kind: 'addBay', station: second },
      { kind: 'addDrone', station: second },
      { kind: 'gate', station: second, level: 2 },
    ]);
    // 开局的站钱不够，停机位又满了：购买无人机的原因是没有空闲停机位，钱不够排在后面，没有按钮；新增停机位只是钱不够，照常有
    const first = lines(state, 0);
    expect(first[0]).toMatchObject({ dim: true, reason: null, forecast: { kind: 'addBay', station: 0 } });
    expect(first[1]).toMatchObject({ dim: true, reason: '该站点没有空闲停机位', forecast: null });
  });

  it('有按钮的项，推演的命令在核心里问价：钱不够是资金不足，不是别的原因；没有按钮的项，问价是别的原因', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: 1 });
    campaignOf(state).money = 3;
    for (const row of lines(state, second)) {
      expect(row.forecast, row.key).not.toBeNull();
      expect(quoteCommand(state, forecastCommand(row.forecast as ForecastOption)).reason, row.key).toBe('notEnoughMoney');
    }
    campaignOf(state).money = 1_000_000;
    const full = lines(state, 0);
    expect(full[1]?.forecast).toBeNull();
    expect(quoteCommand(state, { type: 'buyDrone', station: 0 }).reason).toBe('fleetFull'); // 飞机数已等于停机位数
  });
});

describe('调度台的磁贴里哪些卡能推演', () => {
  const cardsOf = (state: SimState, peak: 'noon' | 'evening' | null): Map<string, ForecastOption | null> => {
    const board = computeBoard(state, peak);
    if (board === null) throw new Error('no board');
    return new Map(board.columns.flatMap((c) => c.cards.map((card) => [card.key, card.forecast] as const)));
  };

  it('现在选中的卡没有，没开放的卡没有，其余开放的卡把这一栏改成这张卡', () => {
    // 调度策略、合单策略、协同策略三栏开放，短程优先和「{片区}优先」没开放
    const state = applyDebugState('?unlock=selectColumn,poolColumn,zoneColumn');
    const cards = cardsOf(state, null);
    expect(cards.get('fifo')).toBeNull(); // 现在选中的
    expect(cards.get('deadline')).toEqual({ kind: 'card', column: 'select', rule: 'deadline', peak: null });
    expect(cards.get('roundtrip')).toBeNull(); // 没开放
    expect(cards.get('prio')).toBeNull(); // 没开放
    expect(cards.get('same')).toEqual({ kind: 'card', column: 'pool', rule: 'same', peak: null });
    expect(cards.get('any')).toBeNull(); // 开放合单策略时自动选了顺路合并
    expect(cards.get('hybrid')).toEqual({ kind: 'card', column: 'zone', rule: 'hybrid', peak: null });
    expect(cards.get('strict')).toEqual({ kind: 'card', column: 'zone', rule: 'strict', peak: null });
  });

  it('整栏没开放时没有卡，所以没有推演：没买双层货箱时合单策略一栏是空的', () => {
    const state = applyDebugState('?unlock=selectColumn');
    const cards = cardsOf(state, null);
    expect(cards.has('same')).toBe(false);
    expect(cards.has('hybrid')).toBe(false);
    expect(cards.get('deadline')).not.toBeNull();
  });

  it('「{片区}优先」推演磁贴上写着的那个片区；选中了它就没有', () => {
    const state = applyDebugState('?unlock=all');
    expect(cardsOf(state, null).get('prio')).toEqual({ kind: 'card', column: 'select', rule: 'prioOffice', peak: null });
    must(state, { type: 'setRules', rules: { select: 'prioCampus' } });
    expect(cardsOf(state, null).get('prio')).toBeNull();
  });

  it('分成午晚两套之后，推演的是白板上现在显示的那一套', () => {
    const state = applyDebugState('?unlock=all&open=1');
    must(state, { type: 'setRules', rules: { select: 'deadline' }, peak: 'evening' });
    expect(cardsOf(state, 'noon').get('deadline')).toEqual({ kind: 'card', column: 'select', rule: 'deadline', peak: 'noon' });
    expect(cardsOf(state, 'noon').get('fifo')).toBeNull();
    expect(cardsOf(state, 'evening').get('deadline')).toBeNull(); // 晚高峰这一套已经是时限优先
    expect(cardsOf(state, 'evening').get('fifo')).toEqual({ kind: 'card', column: 'select', rule: 'fifo', peak: 'evening' });
    // 不指定页签时跟着现在生效的那一套
    const inForce = computeBoard(state, null)?.shownPeak;
    expect(inForce === 'noon' || inForce === 'evening').toBe(true);
    const option = cardsOf(state, null).get(inForce === 'noon' ? 'deadline' : 'fifo');
    expect(option).toMatchObject({ kind: 'card', peak: inForce });
    expect(forecastCommand({ kind: 'card', column: 'select', rule: 'deadline', peak: 'noon' })).toEqual({ type: 'setRules', rules: { select: 'deadline' }, peak: 'noon' });
  });

});

describe('推演单上各行的文字和数的写法', () => {
  /** 一次推演的结果：每套订单序列上准时单数的差和收入的差。 */
  const resultOf = (onTimeDiffs: readonly number[], revenueDiffs?: readonly number[]): ForecastDone =>
    summarizeForecast(onTimeDiffs, revenueDiffs ?? onTimeDiffs.map((d) => d * 6.5), { startStep: 1000, endStep: 5000, price: 0 });
  const option: ForecastOption = { kind: 'gate', station: 1, level: 2 };

  it('准时订单：平均值保留一位小数，绝对值小于 0.05 单写持平', () => {
    expect(ON_TIME_EVEN).toBe(0.05);
    expect(onTimeText(8.0625)).toBe('准时订单平均多 8.1 单');
    expect(onTimeText(7.875)).toBe('准时订单平均多 7.9 单');
    expect(onTimeText(-2.5)).toBe('准时订单平均少 2.5 单');
    expect(onTimeText(-0.06)).toBe('准时订单平均少 0.1 单');
    expect(onTimeText(0.06)).toBe('准时订单平均多 0.1 单');
    expect(onTimeText(0.0499)).toBe('准时订单平均持平');
    expect(onTimeText(-0.0499)).toBe('准时订单平均持平');
    expect(onTimeText(0)).toBe('准时订单平均持平');
    expect(onTimeText(12)).toBe('准时订单平均多 12.0 单');
  });

  it('收入：平均值取整数，绝对值小于 0.5 元写持平', () => {
    expect(REVENUE_EVEN).toBe(0.5);
    expect(revenueText(52.4)).toBe('收入平均增加 ¥52');
    expect(revenueText(52.5)).toBe('收入平均增加 ¥53');
    expect(revenueText(-52.4)).toBe('收入平均减少 ¥52');
    expect(revenueText(0.5)).toBe('收入平均增加 ¥1');
    expect(revenueText(-0.5)).toBe('收入平均减少 ¥1');
    expect(revenueText(0.49)).toBe('收入平均持平');
    expect(revenueText(-0.49)).toBe('收入平均持平');
    expect(revenueText(0)).toBe('收入平均持平');
  });

  it('准时订单和收入各自判持平，互不影响', () => {
    const view = doneView(option, resultOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40]));
    expect(view.onTime).toBe('准时订单平均多 0.1 单');
    expect(view.revenue).toBe('收入平均增加 ¥3');
    const flat = doneView(option, resultOf(Array(16).fill(0), Array(16).fill(0)));
    expect(flat.onTime).toBe('准时订单平均持平');
    expect(flat.revenue).toBe('收入平均持平');
  });

  it('有明确结论：标题，每套一个记号，次数，准时订单，收入，统计范围；没有「差别不明显」', () => {
    const diffs = [9, 8, 7, 6, 6, 8, 9, 10, 7, 8, 9, 8, 7, 6, 8, 0];
    const result = resultOf(diffs, diffs.map((d) => d * 6.9));
    expect(result.verdict).toBe('better');
    const view = doneView(option, result);
    expect(view).toEqual<ForecastDoneView>({
      phase: 'done',
      title: '推演　二号站起降口 2 级',
      marks: [...Array<'better'>(15).fill('better'), 'tie'],
      tally: '16 次中 15 次更好，0 次更差',
      onTime: '准时订单平均多 7.3 单', // 合计 116，平均 7.25，保留一位小数时 5 进位
      revenue: `收入平均增加 ¥${String(Math.round((diffs.reduce((a, b) => a + b, 0) * 6.9) / 16))}`,
      unclear: null,
      scope: '统计至第二场高峰小结',
    });
  });

  it('更差的结论：次数里更差的在后，准时订单写少几单，收入写减少', () => {
    const diffs = [-2, -3, -1, -2, -2, -4, -1, -2, -3, -2, -1, -2, -3, -2, 0, 1];
    const result = resultOf(diffs, diffs.map((d) => d * 10));
    expect(result.verdict).toBe('worse');
    const view = doneView({ kind: 'doubleBox' }, result);
    expect(view.title).toBe('推演　双层货箱');
    expect(view.tally).toBe('16 次中 1 次更好，14 次更差');
    expect(view.onTime).toBe('准时订单平均少 1.8 单');
    expect(view.revenue).toBe('收入平均减少 ¥18');
    expect(view.unclear).toBeNull();
    expect(view.marks[0]).toBe('better');
    expect(view.marks[1]).toBe('tie');
    expect(view.marks.slice(2)).toEqual(Array(14).fill('worse'));
  });

  it('差别不明显：更好和更差的次数都不到门槛，多一行「差别不明显」', () => {
    const diffs = [3, -2, 1, 0, -1, 2, 4, -3, 0, 1, 2, -1, 0, 5, -2, 1];
    const result = resultOf(diffs, diffs.map((d) => d * 4));
    expect(result.verdict).toBe('unclear');
    const view = doneView(option, result);
    expect(view.unclear).toBe('差别不明显');
    expect(view.tally).toBe(`16 次中 ${String(result.better)} 次更好，${String(result.worse)} 次更差`);
    expect(view.marks.filter((m) => m === 'tie')).toHaveLength(result.tied);
  });

  it('记号：更好的在前，持平的居中，更差的在后，一套一个', () => {
    expect(forecastMarks([3, -1, 0, 2, 0])).toEqual(['better', 'better', 'tie', 'tie', 'worse']);
    expect(forecastMarks([])).toEqual([]);
    expect(forecastMarks([0, 0])).toEqual(['tie', 'tie']);
  });

  it('推演中和无法推演：标题加一行', () => {
    expect(runningView(option)).toEqual<ForecastRunningView>({ phase: 'running', title: '推演　二号站起降口 2 级', running: '推演中' });
    expect(failedView({ kind: 'addDrone', station: 0 }, '该站点没有空闲停机位')).toEqual<ForecastFailedView>({
      phase: 'failed',
      title: '推演　一号站购买无人机',
      failed: `无法推演${String.fromCodePoint(0x3000)}该站点没有空闲停机位`,
    });
  });

  it('各行的文字里没有没填的参数', () => {
    const view = doneView(option, resultOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7]));
    for (const text of [view.title, view.tally, view.onTime, view.revenue, view.scope]) expect(text).not.toMatch(/[{}]|undefined|NaN/);
  });
});

// ---- 点「推演」之后的流程 ----

/** 假的线程：收到的消息记下来，测试自己决定什么时候回复什么。 */
class ControlledWorker implements WorkerLike {
  onmessage: ((event: { data: ForecastReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  readonly received: ForecastRequest[] = [];

  postMessage(message: ForecastRequest): void {
    this.received.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** 收到的 run 请求。 */
  runs(): ForecastRunRequest[] {
    return this.received.filter((m): m is ForecastRunRequest => m.type === 'run');
  }

  /** 收到的 cancel 请求有几条。 */
  cancels(): number {
    return this.received.filter((m) => m.type === 'cancel').length;
  }

  reply(request: ForecastRunRequest, part: ForecastPart | ForecastUnavailable): void {
    this.onmessage?.({ data: { type: 'done', id: request.id, part } });
  }

  fail(request: ForecastRunRequest, message: string): void {
    this.onmessage?.({ data: { type: 'error', id: request.id, message } });
  }
}

/** 一个线程算完全部序列时的原始结果：每套订单序列上准时单数和收入的差。 */
function part(onTimeDiffs: readonly number[], revenueDiffs?: readonly number[]): ForecastPart {
  return { ok: true, from: 0, onTimeDiffs: [...onTimeDiffs], revenueDiffs: revenueDiffs === undefined ? onTimeDiffs.map((d) => d * 5) : [...revenueDiffs], startStep: 100, endStep: 4100, price: 0 };
}

const BETTER = Array.from({ length: FORECAST_V1.sequences }, (_, i) => (i === 0 ? 0 : 6));

/** 等承诺的回调跑完。 */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 一个带假线程的流程，游戏状态是开放全部、有钱、有 charges 次推演的经营模式。 */
function rig(charges = 2, unlocked = true) {
  const state = withMoney(quietState({}, unlocked));
  campaignOf(state).forecast.charges = charges;
  const worker = new ControlledWorker();
  const client = createForecastClient({ workers: 1, createWorker: () => worker });
  const shown: (ForecastSheetState | null)[] = [];
  const toasts: string[] = [];
  const requests: { option: Command; sequences: number }[] = [];
  const useForecast: Command = { type: 'useForecast' };
  const flow = createForecastFlow({
    state: () => state,
    request: (s, option, params) => {
      requests.push({ option, sequences: params.sequences });
      return client.request(s, option, params);
    },
    refuse: () => {
      const quote = quoteCommand(state, useForecast);
      return quote.ok ? null : failureText(quote.reason ?? 'unknownCommand');
    },
    charge: () => {
      const result = applyCommand(state, useForecast);
      return result.ok ? null : failureText(result.reason);
    },
    show: (sheet) => shown.push(sheet),
    toast: (text) => toasts.push(text),
  });
  const last = (): ForecastSheetState | null => shown[shown.length - 1] ?? null;
  return { state, worker, client, flow, shown, toasts, requests, last, charges: () => campaignOf(state).forecast.charges };
}

describe('点「推演」之后的流程', () => {
  const OPTION: ForecastOption = { kind: 'doubleBox' };

  it('点击：同时发出请求（序列数取内容表）和打开推演单写「推演中」，这时还没有扣次数', () => {
    const r = rig(2);
    r.flow.click(OPTION, 'upgrades');
    expect(r.requests).toEqual([{ option: { type: 'buyDoubleBox' }, sequences: FORECAST_V1.sequences }]);
    expect(r.worker.runs()).toHaveLength(1);
    expect(r.worker.runs()[0]).toMatchObject({ sequences: FORECAST_V1.sequences, from: 0, to: FORECAST_V1.sequences, option: { type: 'buyDoubleBox' } });
    expect(r.shown).toHaveLength(1);
    expect(r.last()).toMatchObject({ host: 'upgrades', view: { phase: 'running', title: '推演　双层货箱', running: '推演中' } });
    expect(r.charges()).toBe(2);
    expect(r.flow.busy()).toBe(true);
  });

  it('出了结果以后才扣一次次数，推演单显示结果', async () => {
    const r = rig(2);
    r.flow.click(OPTION, 'upgrades');
    r.worker.reply(r.worker.runs()[0]!, part(BETTER));
    await settled();
    expect(r.charges()).toBe(1);
    expect(r.flow.busy()).toBe(false);
    expect(r.shown).toHaveLength(2);
    const view = r.last()?.view as ForecastDoneView;
    expect(view.phase).toBe('done');
    expect(view.title).toBe('推演　双层货箱');
    expect(view.tally).toBe('16 次中 15 次更好，0 次更差');
    expect(view.marks).toEqual([...Array<'better'>(15).fill('better'), 'tie']);
    expect(view.onTime).toBe('准时订单平均多 5.6 单');
    expect(view.revenue).toBe('收入平均增加 ¥28');
    expect(view.unclear).toBeNull();
    // 同一个推演单的编号不变，host 不变
    expect(r.shown[1]?.id).toBe(r.shown[0]?.id);
    expect(r.last()?.host).toBe('upgrades');
  });

  it('推演单在算的时候关掉：取消请求，不扣次数，推演单收起，迟到的结果不再处理', async () => {
    const r = rig(2);
    r.flow.click(OPTION, 'card');
    const request = r.worker.runs()[0]!;
    r.flow.close();
    expect(r.last()).toBeNull();
    expect(r.flow.busy()).toBe(false);
    expect(r.worker.cancels()).toBe(1);
    r.worker.reply(request, part(BETTER)); // 线程里已经算完，回复晚到了
    await settled();
    expect(r.charges()).toBe(2);
    expect(r.last()).toBeNull();
    expect(r.shown.filter((s) => s !== null)).toHaveLength(1); // 只有「推演中」那一次
  });

  it('关掉之后可以再点：新的请求照常算，扣一次', async () => {
    const r = rig(2);
    r.flow.click(OPTION, 'card');
    r.flow.close();
    r.flow.click({ kind: 'addBay', station: 0 }, 'card');
    expect(r.worker.runs()).toHaveLength(2);
    r.worker.reply(r.worker.runs()[1]!, part(BETTER));
    await settled();
    expect(r.charges()).toBe(1);
    expect(r.last()?.view.phase).toBe('done');
    expect(r.last()?.view.title).toBe('推演　一号站新增停机位');
  });

  it('结果是无法推演：推演单写「无法推演」和原因，不扣次数', async () => {
    const r = rig(2);
    r.flow.click({ kind: 'addDrone', station: 0 }, 'card');
    r.worker.reply(r.worker.runs()[0]!, { ok: false, reason: 'noFreeBay' });
    await settled();
    expect(r.charges()).toBe(2);
    expect(r.flow.busy()).toBe(false);
    expect(r.last()?.view).toEqual({ phase: 'failed', title: '推演　一号站购买无人机', failed: `无法推演${String.fromCodePoint(0x3000)}该站点没有空闲停机位` });
  });

  it('无法推演的原因带数的：停机位已达上限写上限，取自这个状态', async () => {
    const r = rig(2);
    for (let i = ECONOMY_V1.baysAtBuild; i < ECONOMY_V1.bayCap.medium; i++) must(r.state, { type: 'buyBay', station: 0 });
    r.flow.click({ kind: 'addBay', station: 0 }, 'card');
    r.worker.reply(r.worker.runs()[0]!, { ok: false, reason: 'bayLimit' });
    await settled();
    expect((r.last()?.view as ForecastFailedView).failed).toBe(`无法推演${String.fromCodePoint(0x3000)}停机位已达上限（${String(ECONOMY_V1.bayCap.medium)} 个）`);
    expect(r.charges()).toBe(2);
  });

  it('起降口已是最高等级：推演单写无法推演和这个原因，不扣次数', async () => {
    const r = rig(2);
    must(r.state, { type: 'upgradeGate', station: 0 });
    must(r.state, { type: 'upgradeGate', station: 0 });
    r.flow.click({ kind: 'gate', station: 0, level: 3 }, 'card');
    r.worker.reply(r.worker.runs()[0]!, { ok: false, reason: 'gateMax' });
    await settled();
    expect(r.charges()).toBe(2);
    expect(r.last()?.view).toEqual({ phase: 'failed', title: '推演　一号站起降口 3 级', failed: `无法推演${String.fromCodePoint(0x3000)}起降口已是最高等级` });
  });

  it('后台线程出错：写无法推演和通用的原因，不扣次数，之后还能再点', async () => {
    const r = rig(2);
    r.flow.click(OPTION, 'upgrades');
    r.worker.fail(r.worker.runs()[0]!, 'boom');
    await settled();
    expect(r.charges()).toBe(2);
    expect(r.flow.busy()).toBe(false);
    expect(r.last()?.view).toMatchObject({ phase: 'failed', failed: `无法推演${String.fromCodePoint(0x3000)}${STR.reasons.generic}` });
    r.flow.click(OPTION, 'upgrades');
    expect(r.flow.busy()).toBe(true);
  });

  it('推演进行中再点：不响应，不发第二个请求，推演单不变', () => {
    const r = rig(3);
    r.flow.click(OPTION, 'upgrades');
    r.flow.click({ kind: 'addBay', station: 0 }, 'card');
    r.flow.click(OPTION, 'upgrades');
    expect(r.requests).toHaveLength(1);
    expect(r.worker.runs()).toHaveLength(1);
    expect(r.shown).toHaveLength(1);
    expect(r.toasts).toEqual([]);
  });

  it('次数为 0：点击时提示推演次数不足，不发请求，不开推演单', () => {
    const r = rig(0);
    r.flow.click(OPTION, 'upgrades');
    expect(r.toasts).toEqual(['推演次数不足']);
    expect(r.requests).toEqual([]);
    expect(r.worker.received).toEqual([]);
    expect(r.shown).toEqual([]);
    expect(r.flow.busy()).toBe(false);
  });

  it('数据员没到岗：点击时提示尚未解锁', () => {
    const r = rig(2, false);
    r.flow.click(OPTION, 'upgrades');
    expect(r.toasts).toEqual([STR.reasons.ruleLocked]);
    expect(r.requests).toEqual([]);
  });

  it('最后一次推演用完之后：次数是 0，再点提示次数不足；推演单上的结果还在', async () => {
    const r = rig(1);
    r.flow.click(OPTION, 'upgrades');
    r.worker.reply(r.worker.runs()[0]!, part(BETTER));
    await settled();
    expect(r.charges()).toBe(0);
    expect(r.last()?.view.phase).toBe('done');
    r.flow.click(OPTION, 'upgrades');
    expect(r.toasts).toEqual(['推演次数不足']);
    expect(r.last()?.view.phase).toBe('done');
  });

  it('出了结果时扣不了次数（不会出现，核心保证）：写无法推演和原因，不显示结果', async () => {
    const r = rig(1);
    r.flow.click(OPTION, 'upgrades');
    campaignOf(r.state).forecast.charges = 0; // 请求在算的时候次数被别处用掉了
    r.worker.reply(r.worker.runs()[0]!, part(BETTER));
    await settled();
    expect(r.charges()).toBe(0);
    expect(r.last()?.view).toMatchObject({ phase: 'failed', failed: `无法推演${String.fromCodePoint(0x3000)}推演次数不足` });
  });

  it('推演单按序号换新：每次点击一个新的序号', async () => {
    const r = rig(3);
    r.flow.click(OPTION, 'upgrades');
    r.worker.reply(r.worker.runs()[0]!, part(BETTER));
    await settled();
    r.flow.click({ kind: 'addBay', station: 0 }, 'card');
    expect(r.shown[0]?.id).not.toBe(r.last()?.id);
  });

  it('流程只读状态：请求和扣次数之外，游戏状态不变', async () => {
    const r = rig(2);
    const before = hashState(r.state);
    r.flow.click(OPTION, 'upgrades');
    expect(hashState(r.state)).toBe(before);
    r.worker.reply(r.worker.runs()[0]!, part(BETTER));
    await settled();
    expect(hashState(r.state)).not.toBe(before); // 只有次数少了一次
    campaignOf(r.state).forecast.charges += 1;
    expect(hashState(r.state)).toBe(before);
  });
});

// ---- 日结小票里的效果记录 ----

describe('日结小票里的效果记录', () => {
  const line = (patch: Partial<EffectLine>): EffectLine => ({ kind: 'gate', station: 1, level: 2, peak: 'noon', beforeDay: 0, afterDay: 1, before: 2.2, after: 0.46, twin: 1.44, ...patch });

  it('起降口：站号写成汉字，秒数保留一位小数，写现在的数和不升级时的数，不写购买前的数', () => {
    expect(effectText(line({}))).toBe('二号站起降口 2 级。起降排队 0.5 秒，不升级时 1.4 秒。');
    expect(effectText(line({ station: 0, level: 3, after: 0, twin: 0.95 }))).toBe('一号站起降口 3 级。起降排队 0.0 秒，不升级时 0.9 秒。');
    expect(effectText(line({ station: 11, level: 2 }))).toBe('12号站起降口 2 级。起降排队 0.5 秒，不升级时 1.4 秒。');
    expect(effectText(line({ before: 7.7 }))).toBe(effectText(line({ before: 0.1 }))); // 购买前的数留在记录里，界面不写
  });

  it('双层货箱：每趟单数保留一位小数', () => {
    expect(effectText(line({ kind: 'doubleBox', station: null, level: null, after: 1.5, twin: 1.2345 }))).toBe('双层货箱。每趟 1.5 单，不购买时 1.2 单。');
    expect(effectText(line({ kind: 'doubleBox', station: null, level: null, after: 1, twin: 0 }))).toBe('双层货箱。每趟 1.0 单，不购买时 0.0 单。');
  });

  it('就近降落：回站飞行的百分数取整数', () => {
    expect(effectText(line({ kind: 'nearest', station: null, level: null, after: 29, twin: 38 }))).toBe('就近降落。回站飞行 29%，不开启时 38%。');
    expect(effectText(line({ kind: 'nearest', station: null, level: null, after: 29.6, twin: 38.4 }))).toBe('就近降落。回站飞行 30%，不开启时 38%。');
  });

  it('起降口缺站号或等级（核心不会这样记）：不写', () => {
    expect(effectText(line({ station: null }))).toBeNull();
    expect(effectText(line({ level: null }))).toBeNull();
    expect(effectLines([line({ station: null }), line({ kind: 'doubleBox', station: null, level: null, after: 2, twin: 1 })])).toEqual(['双层货箱。每趟 2.0 单，不购买时 1.0 单。']);
  });

  it('文字取词表里与种类同名的一条，几行按记录的先后排', () => {
    const lines = effectLines([
      line({}),
      line({ kind: 'doubleBox', station: null, level: null, after: 1.3, twin: 1.1 }),
      line({ kind: 'nearest', station: null, level: null, after: 31, twin: 40 }),
    ]);
    expect(lines).toEqual([
      fmt(STR.dayEnd.effect.gate, { station: '二', level: 2, after: '0.5', twin: '1.4' }),
      fmt(STR.dayEnd.effect.doubleBox, { after: '1.3', twin: '1.1' }),
      fmt(STR.dayEnd.effect.nearest, { after: 31, twin: 40 }),
    ]);
  });

  it('小票很窄，每笔效果按句号分成两行：名称一行，现在的数和不购买时的数一行，句号留在句尾', () => {
    expect(sentenceLines('二号站起降口 2 级。起降排队 0.5 秒，不升级时 1.4 秒。')).toEqual(['二号站起降口 2 级。', '起降排队 0.5 秒，不升级时 1.4 秒。']);
    expect(sentenceLines('双层货箱。每趟 1.5 单，不购买时 1.2 单。')).toEqual(['双层货箱。', '每趟 1.5 单，不购买时 1.2 单。']);
    expect(sentenceLines('没有句号')).toEqual(['没有句号']);
    expect(sentenceLines('')).toEqual([]);
    for (const kind of ['gate', 'doubleBox', 'nearest'] as const) {
      const sample = effectText(line({ kind, station: kind === 'gate' ? 0 : null, level: kind === 'gate' ? 2 : null, after: 0.75, twin: 1.25 }));
      expect(sentenceLines(sample ?? '')).toHaveLength(2);
    }
  });

  it('没有效果行时不写：日结小票的效果记录是空的', () => {
    const state = quietState();
    state.step = DAY_STEPS;
    settleDay(state, 0);
    expect(campaignOf(state).days[0]?.effects).toEqual([]);
    expect(latestDayEnd(state)?.effects).toEqual([]);
  });

  describe('从购买到小票', () => {
    function stationRow(station: number, gateWait: number | null, sorties = 0): PeakStationRow {
      return { station, gateWait, landWaitAvg: 0, takeoffWaitPct: 0, queuePct: 0, sorties, fleet: null };
    }
    function fleetOfEmpty(empty: number): PeakFleet {
      return { loaded: 30, empty, work: 100 - 30 - empty - 10, queue: 5, parked: 5 };
    }
    function peakStub(day: number, peak: PeakName, patch: Partial<PeakRecord>): PeakRecord {
      return {
        day,
        peak,
        step: day * DAY_STEPS + (peak === 'noon' ? 1800 : 3400),
        orders: 0,
        onTime: 0,
        late: 0,
        lateOpen: 0,
        cancelled: 0,
        revenue: 0,
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
      };
    }
    /** 主状态生成了一场高峰的小结，副本同一场的小结记录是 twin，会话层把它记进每条跟踪。 */
    function addPeak(state: SimState, record: PeakRecord, twin: PeakRecord): void {
      campaignOf(state).peaks.push(record);
      for (const watch of campaignOf(state).effectWatches) recordTwin(watch, twin);
    }

    it('起降口、双层货箱、就近降落各买一次：下一天的日结小票上三句，在星级几行的后面，数照小票的写法', () => {
      const state = withMoney(quietState());
      const campaign = campaignOf(state);
      must(state, { type: 'buildStation', roof: 1 }); // 第二座站，就近降落才能买
      campaign.peaks.push(peakStub(0, 'noon', { onTime: 9, late: 0, fleet: fleetOfEmpty(38), fleetBack: 38, stations: [stationRow(0, 1.44, 4), stationRow(1, null, 2)] }));
      state.step = 2000;
      must(state, { type: 'upgradeGate', station: 0 });
      must(state, { type: 'buyDoubleBox' });
      must(state, { type: 'buyNearestLanding' });
      state.step = DAY_STEPS;
      settleDay(state, 0);
      expect(latestDayEnd(state)?.effects).toEqual([]); // 购买之后最近的午高峰还是购买前那一场，当天不写
      addPeak(
        state,
        peakStub(1, 'noon', { onTime: 9, late: 0, fleet: fleetOfEmpty(29), fleetBack: 29, stations: [stationRow(0, 0.46, 6), stationRow(1, null, 3)] }),
        peakStub(1, 'noon', { onTime: 9, late: 0, fleet: fleetOfEmpty(38), fleetBack: 38, stations: [stationRow(0, 1.44, 6), stationRow(1, null, 3)] }),
      );
      state.step = 2 * DAY_STEPS;
      settleDay(state, 1);
      const ticket = latestDayEnd(state);
      expect(ticket?.effects).toEqual([
        '一号站起降口 2 级。起降排队 0.5 秒，不升级时 1.4 秒。',
        '双层货箱。每趟 1.0 单，不购买时 1.0 单。',
        '就近降落。回站飞行 29%，不开启时 38%。',
      ]);
      // 数据来自日结记录，文字由小票排
      expect(ticket?.effects).toEqual(effectLines(campaign.days[1]!.effects));
    });

    it('星级的几行在前，效果在后：小票数据里两组分开，部件按这个顺序画', () => {
      const state = withMoney(quietState());
      const campaign = campaignOf(state);
      campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.5, 3)] }));
      state.step = 2000;
      must(state, { type: 'upgradeGate', station: 0 });
      state.step = DAY_STEPS;
      settleDay(state, 0);
      addPeak(state, peakStub(1, 'noon', { stations: [stationRow(0, 0.5, 5)] }), peakStub(1, 'noon', { stations: [stationRow(0, 1.7, 5)] }));
      state.step = 2 * DAY_STEPS;
      settleDay(state, 1);
      const record = campaign.days[1]!;
      const ticket = dayEndTicket(record, 1);
      expect(ticket.lines.length).toBeGreaterThan(0);
      expect(ticket.effects).toEqual(['一号站起降口 2 级。起降排队 0.5 秒，不升级时 1.7 秒。']);
      expect(ticket.lines).not.toContain(ticket.effects[0]);
    });

    it('副本这一场没有数：小票上不写这一笔', () => {
      const state = withMoney(quietState());
      const campaign = campaignOf(state);
      campaign.peaks.push(peakStub(0, 'noon', { stations: [stationRow(0, 1.5, 3)] }));
      state.step = 2000;
      must(state, { type: 'upgradeGate', station: 0 });
      state.step = DAY_STEPS;
      settleDay(state, 0);
      campaign.peaks.push(peakStub(1, 'noon', { stations: [stationRow(0, 0.5, 5)] })); // 读档之后副本不在，没有记它这一场的数
      state.step = 2 * DAY_STEPS;
      settleDay(state, 1);
      expect(latestDayEnd(state)?.effects).toEqual([]);
    });
  });
});

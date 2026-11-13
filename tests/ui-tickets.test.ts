// 高峰小结和日结两张长小票的版式数据：各行写什么，哪一列要不要显示，提前派出那一段的三种情况，说明句，各种片区行。
// 日结里的准时率线、退单率线、订单的下限取自内容表（STARS_V1），内容表重新校准之后这里不用改。
import { describe, expect, it } from 'vitest';
import { STARS_V1 } from '../src/content/stars_v1.ts';
import { DAY_STEPS, advance } from '../src/core/index.ts';
import type { DayDistrictRecord, DayRecord, ExtraSentence, MainSentence, PeakRecord } from '../src/core/index.ts';
import { dayEndTicket, dayLines, earlyBlock, extraSentence, latestDayEnd, latestSummary, mainSentence, signedDelta, summaryTicket, tenCells } from '../src/ui/tickets.ts';
import { campaignOf, campaignState, runningState } from './campaign-helpers.ts';

/** 升到 star 星的条件，二星到五星。 */
function rule(star: number): { onTimeMin: number; cancelBelow: number | null } {
  const found = STARS_V1.rules.find((r) => r.star === star);
  if (found === undefined) throw new Error(`no rule for star ${star}`);
  return found;
}

function peak(patch: Partial<PeakRecord> = {}): PeakRecord {
  return {
    day: 0,
    peak: 'noon',
    step: 1800,
    orders: 148,
    onTime: 121,
    late: 24,
    lateOpen: 3,
    cancelled: 3,
    revenue: 1036.7,
    districts: [{ district: 0, n: 60, onTime: 55, pct: 91, delta: null }],
    segments: { waitDrone: 38, waitGate: 12, waitPrep: 17, road: 33 },
    select: 'fifo',
    early: 0,
    changedMidPeak: false,
    main: { id: 'waitDrone' },
    extra: null,
    ...patch,
  };
}

function dayLine(patch: Partial<DayDistrictRecord> = {}): DayDistrictRecord {
  return {
    district: 0,
    kind: 'starKept',
    fromStar: 2,
    star: 2,
    n: 20,
    onTime: 15,
    cancelled: 1,
    onTimePct: 75,
    cancelPct: 5,
    needOnTimePct: null,
    needCancelPct: null,
    newShops: [],
    ...patch,
  };
}

function day(patch: Partial<DayRecord> = {}): DayRecord {
  return { day: 0, step: DAY_STEPS, ordered: 37, resolved: 36, onTime: 17, late: 17, cancelled: 2, pending: 1, income: 193.4, districts: [dayLine()], ...patch };
}

describe('高峰小结：标题和各行', () => {
  it('标题是高峰名加小结，时段按一天的时钟：午高峰 11:30-14:30，晚高峰 16:40-19:50，第几天从 1 数起', () => {
    expect(summaryTicket(peak(), 0, true)).toMatchObject({ title: '午高峰小结', period: '第 1 天  11:30-14:30' });
    expect(summaryTicket(peak({ day: 6, peak: 'evening' }), 3, true)).toMatchObject({ title: '晚高峰小结', period: '第 7 天  16:40-19:50' });
  });

  it('五个数：来单、准时、超时、其中还没送到（缩进）、退单、进账（取整）', () => {
    expect(summaryTicket(peak(), 0, true).rows).toEqual([
      { label: '来单', value: '148', indent: false },
      { label: '准时', value: '121', indent: false },
      { label: '超时', value: '24', indent: false },
      { label: '其中还没送到', value: '3', indent: true },
      { label: '退单', value: '3', indent: false },
      { label: '进账', value: '¥1036', indent: false },
    ]);
  });

  it('准时、超时、退单三项相加等于来单', () => {
    const rows = summaryTicket(peak(), 0, true).rows;
    const value = (label: string): number => Number(rows.find((r) => r.label === label)!.value);
    expect(value('准时') + value('超时') + value('退单')).toBe(value('来单'));
  });

  it('两个按钮：调度台开放时有「打开调度台」，还没开放时没有；「继续」一直有', () => {
    expect(summaryTicket(peak(), 0, true)).toMatchObject({ openBoard: '打开调度台', next: '继续' });
    expect(summaryTicket(peak(), 0, false)).toMatchObject({ openBoard: null, next: '继续' });
  });
});

describe('高峰小结：各片区准时和比昨天', () => {
  it('第一天没有前一天的数据：没有「比昨天」一列，每行的变化也是空的', () => {
    const view = summaryTicket(peak({ day: 0, districts: [{ district: 0, n: 10, onTime: 9, pct: 90, delta: null }] }), 0, true);
    expect(view.deltaHeader).toBeNull();
    expect(view.districts).toEqual([{ name: '老街', pct: '90%', bar: '■■■■■■■■■□', delta: '', noOrders: false }]);
  });

  it('第二天起有这一列：列头「比昨天（百分点）」，变化带正负号', () => {
    const view = summaryTicket(
      peak({
        day: 3,
        districts: [
          { district: 0, n: 60, onTime: 55, pct: 91, delta: 2 },
          { district: 1, n: 40, onTime: 30, pct: 74, delta: 12 },
          { district: 2, n: 30, onTime: 24, pct: 80, delta: -5 },
        ],
      }),
      0,
      true,
    );
    expect(view.districtHeader).toBe('各片区准时');
    expect(view.deltaHeader).toBe('比昨天（百分点）');
    expect(view.districts.map((d) => [d.name, d.pct, d.delta])).toEqual([['老街', '91%', '+2'], ['写字楼区', '74%', '+12'], ['大学城', '80%', '-5']]);
  });

  it('变化为 0 写 0，没有可比的（前一天这个片区没有订单）写空', () => {
    const view = summaryTicket(
      peak({ day: 2, districts: [{ district: 0, n: 10, onTime: 8, pct: 80, delta: 0 }, { district: 1, n: 5, onTime: 4, pct: 80, delta: null }] }),
      0,
      true,
    );
    expect(view.districts.map((d) => d.delta)).toEqual(['0', '']);
    expect(view.deltaHeader).toBe('比昨天（百分点）');
  });

  it('这一场某个片区没有订单：准时率那一列写「没有订单」，不写 0%，没有十格的条，也没有比昨天', () => {
    const view = summaryTicket(peak({ day: 1, districts: [{ district: 0, n: 0, onTime: 0, pct: null, delta: null }] }), 0, true);
    expect(view.districts[0]).toEqual({ name: '老街', pct: '没有订单', bar: '', delta: '', noOrders: true });
  });

  it('有的片区有订单，有的没有：没有订单的那一行写「没有订单」，别的行照常，比昨天这一列仍在', () => {
    const view = summaryTicket(
      peak({
        day: 2,
        districts: [
          { district: 0, n: 60, onTime: 54, pct: 90, delta: 3 },
          { district: 1, n: 0, onTime: 0, pct: null, delta: null },
          { district: 2, n: 30, onTime: 15, pct: 50, delta: -4 },
        ],
      }),
      0,
      true,
    );
    expect(view.deltaHeader).toBe('比昨天（百分点）');
    expect(view.districts).toEqual([
      { name: '老街', pct: '90%', bar: '■■■■■■■■■□', delta: '+3', noOrders: false },
      { name: '写字楼区', pct: '没有订单', bar: '', delta: '', noOrders: true },
      { name: '大学城', pct: '50%', bar: '■■■■■□□□□□', delta: '-4', noOrders: false },
    ]);
  });

  it('前一天没有订单、今天有：准时率照常写，没有可比的昨天，比昨天一栏写空', () => {
    const view = summaryTicket(
      peak({ day: 2, districts: [{ district: 0, n: 10, onTime: 8, pct: 80, delta: 1 }, { district: 1, n: 12, onTime: 6, pct: 50, delta: null }] }),
      0,
      true,
    );
    expect(view.districts[1]).toEqual({ name: '写字楼区', pct: '50%', bar: '■■■■■□□□□□', delta: '', noOrders: false });
  });

  it('第二天起但每个片区都没有可比的：没有这一列', () => {
    const view = summaryTicket(peak({ day: 1, districts: [{ district: 0, n: 10, onTime: 8, pct: 80, delta: null }] }), 0, true);
    expect(view.deltaHeader).toBeNull();
  });

  it('十格的条：每满 10% 一格实心', () => {
    expect(tenCells(0)).toBe('□□□□□□□□□□');
    expect(tenCells(9)).toBe('□□□□□□□□□□');
    expect(tenCells(10)).toBe('■□□□□□□□□□');
    expect(tenCells(59)).toBe('■■■■■□□□□□');
    expect(tenCells(91)).toBe('■■■■■■■■■□');
    expect(tenCells(100)).toBe('■■■■■■■■■■');
    expect(tenCells(null)).toBe('');
  });

  it('变化的正负号', () => {
    expect(signedDelta(5)).toBe('+5');
    expect(signedDelta(0)).toBe('0');
    expect(signedDelta(-12)).toBe('-12');
  });
});

describe('高峰小结：一张单的时间四段', () => {
  it('四项：等飞机、等起降、等出餐、路上，按 2 乘 2 的顺序，带百分数', () => {
    const view = summaryTicket(peak(), 0, true);
    expect(view.timeHeader).toBe('一张单的时间');
    expect(view.segments?.map((s) => [s.id, s.text, s.share])).toEqual([
      ['waitDrone', '等飞机 38%', 38],
      ['waitGate', '等起降 12%', 12],
      ['waitPrep', '等出餐 17%', 17],
      ['road', '路上 33%', 33],
    ]);
  });

  it('四项加起来是 100，说明点名的那一段画圈', () => {
    const view = summaryTicket(peak({ main: { id: 'road' } }), 0, true);
    expect(view.segments?.reduce((sum, s) => sum + s.share, 0)).toBe(100);
    expect(view.segments?.filter((s) => s.longest).map((s) => s.id)).toEqual(['road']);
  });

  it('主句不是在说哪一段最长（准时率高，没有订单）：不画圈', () => {
    const view = summaryTicket(peak({ main: { id: 'onTimeHigh', onTime: 93 } }), 0, true);
    expect(view.segments?.some((s) => s.longest)).toBe(false);
  });

  it('没有送达的订单：没有四段时间', () => {
    expect(summaryTicket(peak({ segments: null, main: { id: 'noDelivered' } }), 0, true).segments).toBeNull();
  });
});

describe('高峰小结：提前派出那一段', () => {
  it('当前的卡是「先下单的先送」：不显示这一段', () => {
    expect(earlyBlock(peak({ select: 'fifo', early: 0 }))).toBeNull();
    expect(summaryTicket(peak({ select: 'fifo' }), 0, true).early).toBeNull();
  });

  it('其他的卡：先写卡名，再写有几张订单、比按下单顺序更早派出', () => {
    expect(earlyBlock(peak({ select: 'deadline', early: 31 }))).toEqual({ name: '快超时的先送', lines: ['有 31 张订单', '比按下单顺序更早派出'] });
    expect(earlyBlock(peak({ select: 'prioOffice', early: 4 }))).toEqual({ name: '写字楼区的先送', lines: ['有 4 张订单', '比按下单顺序更早派出'] });
    expect(earlyBlock(peak({ select: 'roundtrip', early: 0 }))?.lines[0]).toBe('有 0 张订单');
  });

  it('一场高峰里中途换过规矩：只写「这一场中途换过规矩」，没有卡名', () => {
    expect(earlyBlock(peak({ select: 'deadline', early: null, changedMidPeak: true }))).toEqual({ name: null, lines: ['这一场中途换过规矩'] });
  });

  it('中途换过规矩、最后换成了先下单的先送：写中途换过规矩，不隐藏', () => {
    expect(earlyBlock(peak({ select: 'fifo', early: null, changedMidPeak: true }))).toEqual({ name: null, lines: ['这一场中途换过规矩'] });
  });
});

describe('高峰小结：说明句', () => {
  it('主句七条', () => {
    const cases: [MainSentence, string][] = [
      [{ id: 'noOrders' }, '这一场没有订单。'],
      [{ id: 'noDelivered' }, '这一场没有送达的订单。'],
      [{ id: 'onTimeHigh', onTime: 93 }, '这一场有 93% 的订单准时送到。'],
      [{ id: 'waitDrone' }, '订单主要在等飞机。'],
      [{ id: 'waitGate' }, '订单主要在等起降。'],
      [{ id: 'road' }, '订单主要花在路上。'],
      [{ id: 'waitPrep' }, '订单主要在等出餐。'],
    ];
    for (const [main, text] of cases) expect(mainSentence(main)).toBe(text);
  });

  it('附加句四条：站号是核心的编号加一，写成汉字', () => {
    const cases: [ExtraSentence, string][] = [
      [{ id: 'landQueue', station: 1, count: 3 }, '二号站平均有 3 架在等降落。'],
      [{ id: 'landQueue', station: 0, count: 1.5 }, '一号站平均有 1.5 架在等降落。'],
      [{ id: 'bayIdle', station: 0, percent: 73 }, '一号站的停机位有 73% 的时间是空的。'],
      [{ id: 'notNearest', percent: 41 }, '41% 的订单不是最近的站送的。'],
      [{ id: 'districtLow', district: 1, onTime: 52 }, '写字楼区的准时率是 52%。'],
    ];
    for (const [extra, text] of cases) expect(extraSentence(extra)).toBe(text);
  });

  it('说明：主句加最多一条附加句', () => {
    expect(summaryTicket(peak({ main: { id: 'waitDrone' }, extra: null }), 0, true).sentences).toEqual(['订单主要在等飞机。']);
    expect(summaryTicket(peak({ main: { id: 'waitDrone' }, extra: { id: 'landQueue', station: 1, count: 3 } }), 0, true).sentences).toEqual(['订单主要在等飞机。', '二号站平均有 3 架在等降落。']);
  });

  it('站号超过十时写数字', () => {
    expect(extraSentence({ id: 'landQueue', station: 11, count: 2 })).toBe('12号站平均有 2 架在等降落。');
  });
});

describe('最近的小结从小票的位置再次点开', () => {
  it('今天有小结：取最近的一条；日结出现之后（到了第二天）没有，内容并入日结', () => {
    const state = campaignState();
    expect(latestSummary(state, true)).toBeNull();
    campaignOf(state).peaks.push(peak({ day: 0, peak: 'noon' }), peak({ day: 0, peak: 'evening', step: 3400 }));
    state.step = 3450;
    expect(latestSummary(state, true)).toMatchObject({ index: 1, title: '晚高峰小结' });
    state.step = DAY_STEPS;
    expect(latestSummary(state, true)).toBeNull();
  });

  it('真实运行：第一场午高峰小结生成之后，今天能取到它', () => {
    const state = runningState(42);
    advance(state, 1801); // 小结在第 1800 步开始时生成
    expect(campaignOf(state).peaks).toHaveLength(1);
    const view = latestSummary(state, false);
    expect(view).toMatchObject({ title: '午高峰小结', period: '第 1 天  11:30-14:30', deltaHeader: null });
    expect(view?.rows.map((r) => r.label)).toEqual(['来单', '准时', '超时', '其中还没送到', '退单', '进账']);
    expect(view?.sentences.length).toBeGreaterThanOrEqual(1);
  });
});

describe('日结：各行', () => {
  it('标题、第几天、今天下单、有结果的三项（缩进）、还没有结果、进账', () => {
    const view = dayEndTicket(day(), 0);
    expect(view).toMatchObject({ title: '日结', day: '第 1 天', next: '继续' });
    expect(view.rows).toEqual([
      { label: '今天下单', value: '37', indent: false },
      { label: '今天有结果的', value: '36', indent: false },
      { label: '准时送达', value: '17', indent: true },
      { label: '超时送达', value: '17', indent: true },
      { label: '退单', value: '2', indent: true },
      { label: '还没有结果', value: '1', indent: false },
      { label: '进账', value: '¥193', indent: false },
    ]);
  });

  it('准时送达、超时送达、退单三项相加等于今天有结果的', () => {
    const rows = dayEndTicket(day(), 0).rows;
    const value = (label: string): number => Number(rows.find((r) => r.label === label)!.value);
    expect(value('准时送达') + value('超时送达') + value('退单')).toBe(value('今天有结果的'));
  });

  it('第几天从 1 数起', () => {
    expect(dayEndTicket(day({ day: 11 }), 11).day).toBe('第 12 天');
  });
});

describe('日结：各片区的一行', () => {
  it('升星：升几星，明天订单多两成半', () => {
    expect(dayLines(dayLine({ kind: 'starUp', fromStar: 1, star: 2 }))).toEqual(['老街升二星。明天订单多两成半。']);
    expect(dayLines(dayLine({ district: 1, kind: 'starUp', fromStar: 3, star: 4 }))).toEqual(['写字楼区升四星。明天订单多两成半。']);
  });

  it('升星带新店：每家一行，位置是片区加方位，店名取自词表', () => {
    const lines = dayLines(
      dayLine({
        kind: 'starUp',
        fromStar: 2,
        star: 3,
        newShops: [
          { shop: 8, direction: 'north' },
          { shop: 9, direction: 'middle' },
        ],
      }),
    );
    expect(lines).toEqual(['老街升三星。明天订单多两成半。', '老街北边要新开一家吴叔排骨面，明天开张。', '老街中间要新开一家拐角酸辣粉，明天开张。']);
    expect(dayLines(dayLine({ district: 2, kind: 'starUp', fromStar: 1, star: 2, newShops: [{ shop: 20, direction: 'east' }] }))[1]).toBe('大学城东边要新开一家大学路烧烤，明天开张。');
  });

  it('星级不变', () => {
    expect(dayLines(dayLine({ kind: 'starKept', star: 3 }))).toEqual(['老街三星，没变。']);
  });

  it('最近两天没有订单：星级不变', () => {
    expect(dayLines(dayLine({ district: 1, kind: 'noOrders', n: 0, onTimePct: null, cancelPct: null }))).toEqual(['写字楼区最近两天没有订单，星级不变。']);
  });

  it('最近两天有结果的订单太少：写不到下限张，星级不变，下限取自内容表', () => {
    expect(dayLines(dayLine({ kind: 'tooFewOrders', star: 2, n: 3, onTimePct: 100 }))).toEqual([`老街最近两天有结果的订单不到 ${STARS_V1.minSample} 张，星级不变。`]);
    expect(dayLines(dayLine({ district: 2, kind: 'tooFewOrders', star: 1, n: 0 }))).toEqual([`大学城最近两天有结果的订单不到 ${STARS_V1.minSample} 张，星级不变。`]);
  });

  it('可能掉星，准时率：写最近两天准时率和要保持的线，明天日结仍未达到会掉一星', () => {
    const need = rule(2).onTimeMin; // 三星要保持的线是二星的准时率线
    expect(dayLines(dayLine({ kind: 'dropByOnTime', star: 3, onTimePct: need - 8, needOnTimePct: need }))).toEqual([`老街最近两天准时率 ${need - 8}%，要保持在 ${need}% 以上。明天日结仍未达到，会掉一星。`]);
  });

  it('可能掉星，退单率', () => {
    const need = rule(3).cancelBelow as number; // 四星要保持的线是三星的退单率线
    expect(dayLines(dayLine({ kind: 'dropByCancel', star: 4, cancelPct: need + 2, needCancelPct: need }))).toEqual([`老街最近两天退单率 ${need + 2}%，要低于 ${need}%。明天日结仍未达到，会掉一星。`]);
  });

  it('掉星：掉到几星，明天订单少两成', () => {
    expect(dayLines(dayLine({ kind: 'starDown', fromStar: 3, star: 2 }))).toEqual(['老街掉到二星。明天订单少两成。']);
  });

  it('每个开通的片区一行，按片区编号；升星的片区后面跟着新店', () => {
    const view = dayEndTicket(
      day({
        districts: [
          dayLine({ district: 0, kind: 'starUp', fromStar: 2, star: 3, newShops: [{ shop: 10, direction: 'west' }] }),
          dayLine({ district: 1, kind: 'starKept', star: 2 }),
        ],
      }),
      0,
    );
    expect(view.lines).toEqual(['老街升三星。明天订单多两成半。', '老街西边要新开一家林姐锅贴，明天开张。', '写字楼区二星，没变。']);
  });

  it('所有写法的整句里没有没填的参数', () => {
    const kinds = ['starUp', 'starDown', 'starKept', 'noOrders', 'tooFewOrders', 'dropByOnTime', 'dropByCancel'] as const;
    for (const kind of kinds) {
      for (const line of dayLines(dayLine({ kind, onTimePct: null, cancelPct: null, needOnTimePct: null, needCancelPct: null }))) {
        expect(line).not.toMatch(/undefined|NaN|null|\{|\}/);
      }
    }
  });
});

describe('最近一次日结', () => {
  it('还没有日结：没有', () => {
    expect(latestDayEnd(campaignState())).toBeNull();
  });

  it('真实运行：第一天结束时生成日结，小票上的数就是记录里的数', () => {
    const state = runningState(42);
    advance(state, DAY_STEPS + 1); // 日结在第 3600 步开始时做
    const record = campaignOf(state).days[0]!;
    const view = latestDayEnd(state)!;
    expect(view.index).toBe(0);
    expect(view.rows.map((r) => r.value).slice(0, 6)).toEqual([record.ordered, record.resolved, record.onTime, record.late, record.cancelled, record.pending].map(String));
    // 每个开通的片区一行，升星的片区后面跟着每家新店一行
    const line = record.districts[0]!;
    expect(view.lines).toHaveLength(1 + line.newShops.length);
    expect(view.lines.every((l) => l.startsWith('老街'))).toBe(true);
  });
});

// 高峰小结和日结两张长小票的版式数据：各行写什么，哪一列要不要显示，提前派出那一段的三种情况，说明句，各种片区行。
// 日结里的准时率线、退单率线、订单的下限取自内容表（STARS_V1），内容表重新校准之后这里不用改。
import { describe, expect, it } from 'vitest';
import { GOALS_V1 } from '../src/content/goals_v1.ts';
import { STARS_V1 } from '../src/content/stars_v1.ts';
import { DAY_STEPS, advance } from '../src/core/index.ts';
import type { DayDistrictRecord, DayRecord, ExtraSentence, MainSentence, PeakBaseline, PeakFleet, PeakRecord, PeakStanding, Standing } from '../src/core/index.ts';
import { compareBlock, compareThreshold, dayEndTicket, dayLines, extraSentence, fleetBlock, gainTotalLine, latestDayEnd, latestSummary, mainSentence, recordNote, summaryTicket, tenCells } from '../src/ui/tickets.ts';
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
    districts: [{ district: 0, n: 60, onTime: 55, pct: 91, delta: null, line: null, met: null }],
    segments: { waitDrone: 38, waitGate: 12, waitPrep: 17, road: 33 },
    select: 'fifo',
    early: 0,
    changedMidPeak: false,
    main: { id: 'waitDrone' },
    extra: null,
    cleared: null,
    baseline: null,
    fleet: null,
    fleetBack: null,
    stations: [],
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
  return { day: 0, step: DAY_STEPS, ordered: 37, resolved: 36, onTime: 17, late: 17, cancelled: 2, pending: 1, income: 193.4, districts: [dayLine()], peaksJudged: 0, peaksCleared: 0, busy: null, effects: [], ...patch };
}

describe('高峰小结：标题和各行', () => {
  it('标题是高峰名加小结，时段按一天的时钟：午高峰 11:30-14:30，晚高峰 16:40-19:50，第几天从 1 数起', () => {
    expect(summaryTicket(peak(), 0, true)).toMatchObject({ title: '午高峰小结', period: '第 1 天  11:30-14:30' });
    expect(summaryTicket(peak({ day: 6, peak: 'evening' }), 3, true)).toMatchObject({ title: '晚高峰小结', period: '第 7 天  16:40-19:50' });
  });

  it('五个数：来单、准时、超时、其中还没送到（缩进）、退单、进账（取整）', () => {
    expect(summaryTicket(peak(), 0, true).rows).toEqual([
      { label: '订单', value: '148', indent: false, record: null },
      { label: '准时', value: '121', indent: false, record: null },
      { label: '超时', value: '24', indent: false, record: null },
      { label: '其中未送达', value: '3', indent: true, record: null },
      { label: '取消', value: '3', indent: false, record: null },
      { label: '收入', value: '¥1036', indent: false, record: null },
    ]);
  });

  it('准时、超时、退单三项相加等于来单', () => {
    const rows = summaryTicket(peak(), 0, true).rows;
    const value = (label: string): number => Number(rows.find((r) => r.label === label)!.value);
    expect(value('准时') + value('超时') + value('取消')).toBe(value('订单'));
  });

  it('两个按钮：调度台开放时有「打开调度台」，还没开放时没有；「继续」一直有', () => {
    expect(summaryTicket(peak(), 0, true)).toMatchObject({ openBoard: '打开调度台', next: '继续' });
    expect(summaryTicket(peak(), 0, false)).toMatchObject({ openBoard: null, next: '继续' });
  });
});

describe('高峰小结：各片区一行', () => {
  const row = (patch: Partial<PeakRecord['districts'][number]> = {}): PeakRecord['districts'][number] => ({ district: 0, n: 10, onTime: 9, pct: 90, delta: null, line: null, met: null, ...patch });

  it('片区名、准时率、十格的条。没有设线：没有目标，也没有达标一栏', () => {
    const view = summaryTicket(peak({ districts: [row()] }), 0, true);
    expect(view.districtHeader).toBe('各片区准时率');
    expect(view.districts).toEqual([{ name: '老街', pct: '90%', bar: '■■■■■■■■■□', noOrders: false, goal: null, mark: null }]);
  });

  it('不再有「比昨天」一列：变化还记在核心的记录里，小结上不写', () => {
    const view = summaryTicket(peak({ day: 3, districts: [row({ delta: 12 })] }), 0, true);
    expect(JSON.stringify(view)).not.toContain('比昨天');
    expect(view.districts[0]).not.toHaveProperty('delta');
  });

  it('有目标线：写「目标 {线}%」；订单够判时写已达标或未达标', () => {
    const met = summaryTicket(peak({ districts: [row({ line: 85, met: true })] }), 0, true).districts[0];
    expect(met).toMatchObject({ goal: '目标 85%', mark: { met: true, text: '已达标' } });
    const missed = summaryTicket(peak({ districts: [row({ line: 95, met: false })] }), 0, true).districts[0];
    expect(missed).toMatchObject({ goal: '目标 95%', mark: { met: false, text: '未达标' } });
  });

  it('订单不够判：写目标，没有达标一栏', () => {
    const view = summaryTicket(peak({ districts: [row({ n: 5, onTime: 5, pct: 100, line: 80, met: null })] }), 0, true);
    expect(view.districts[0]).toMatchObject({ goal: '目标 80%', mark: null });
  });

  it('各片区各自一行：有的达标，有的没达标，有的没有设线', () => {
    const view = summaryTicket(
      peak({ districts: [row({ line: 85, met: true }), row({ district: 1, n: 40, onTime: 30, pct: 75, line: 90, met: false }), row({ district: 2, n: 30, onTime: 15, pct: 50 })] }),
      0,
      true,
    );
    expect(view.districts.map((d) => [d.name, d.pct, d.goal, d.mark?.text ?? null])).toEqual([
      ['老街', '90%', '目标 85%', '已达标'],
      ['写字楼区', '75%', '目标 90%', '未达标'],
      ['大学城', '50%', null, null],
    ]);
  });

  it('这个片区这一场没有订单：准时率那一列写没有订单，没有条，没有目标，没有达标', () => {
    const view = summaryTicket(peak({ districts: [row({ n: 0, onTime: 0, pct: null, line: 80 })] }), 0, true);
    expect(view.districts[0]).toEqual({ name: '老街', pct: '无订单', bar: '', noOrders: true, goal: null, mark: null });
  });

  it('整张小结的标记：判过的片区全部达标并且没有退单时有，其余没有。连续达标只在判过目标的场次写', () => {
    const standing = (now: number, best: number): PeakStanding => ({ onTime: { value: 1, best: null, broken: false }, gain: null, streak: { now, best } });
    const cleared = summaryTicket(peak({ cleared: true }), 0, true, standing(3, 5));
    expect(cleared.cleared).toBe('本场全部达标且无取消');
    expect(cleared.streak).toBe('连续全部达标 3 场，最多 5 场');
    const missed = summaryTicket(peak({ cleared: false }), 0, true, standing(0, 5));
    expect(missed.cleared).toBeNull();
    expect(missed.streak).toBe('连续全部达标 0 场，最多 5 场');
    const none = summaryTicket(peak({ cleared: null }), 0, true, standing(3, 5));
    expect(none.cleared).toBeNull();
    expect(none.streak).toBeNull();
    expect(summaryTicket(peak({ cleared: true }), 0, true).streak).toBeNull(); // 没有成绩时不写
    // 还没有达标过（现在的和最多的都是 0）：没有什么可写的
    expect(summaryTicket(peak({ cleared: false }), 0, true, standing(0, 0)).streak).toBeNull();
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
});

describe('纪录的小字', () => {
  const standing = (value: number, best: number | null): Standing => ({ value, best, broken: best !== null && value > best });

  it('破了纪录写「新纪录」，没破写「纪录」和最好成绩，成绩与它相同时也写它', () => {
    expect(recordNote(standing(35, 31))).toEqual({ text: '新纪录', fresh: true });
    expect(recordNote(standing(20, 31))).toEqual({ text: '纪录 31', fresh: false });
    expect(recordNote(standing(31, 31))).toEqual({ text: '纪录 31', fresh: false });
  });

  it('之前没有同类的成绩（第一次）没有可比的，不写', () => {
    expect(recordNote(standing(20, null))).toBeNull();
    expect(recordNote(null)).toBeNull();
  });

  it('金额：纪录写整数，前面有人民币符号', () => {
    expect(recordNote(standing(310.7, 273.6), true)).toEqual({ text: '新纪录', fresh: true });
    expect(recordNote(standing(200, 273.6), true)).toEqual({ text: '纪录 ¥273', fresh: false });
  });

  it('小结里准时那一行带纪录，别的行没有', () => {
    const view = summaryTicket(peak(), 0, true, { onTime: standing(121, 140), gain: null, streak: { now: 0, best: 0 } });
    expect(view.rows.map((r) => r.record?.text ?? null)).toEqual([null, '纪录 140', null, null, null, null]);
    const fresh = summaryTicket(peak(), 0, true, { onTime: standing(150, 140), gain: null, streak: { now: 0, best: 0 } });
    expect(fresh.rows[1]?.record).toEqual({ text: '新纪录', fresh: true });
  });
});

describe('高峰小结：与开局策略的对照', () => {
  const baseline = (patch: Partial<PeakBaseline> = {}): PeakBaseline => ({
    orders: 148,
    onTime: 115,
    late: 28,
    lateOpen: 4,
    cancelled: 5,
    revenue: 987.4,
    districts: [{ district: 0, n: 148, onTime: 115, pct: 77 }],
    lowLoad: false,
    ...patch,
  });
  const standingWith = (gain: Standing | null): PeakStanding => ({ onTime: { value: 121, best: null, broken: false }, gain, streak: { now: 0, best: 0 } });

  it('这一场没有对照：没有这一段，小结上也没有「提前派出」和「比昨天」', () => {
    const view = summaryTicket(peak({ select: 'deadline', early: 31, baseline: null }), 0, true);
    expect(view.compare).toBeNull();
    expect(JSON.stringify(view)).not.toContain('更早派出');
    expect(JSON.stringify(view)).not.toContain('比昨天');
  });

  // 来单 148 单，门槛是 ⌈0.8 × √148⌉ = 10。多 15 单不小于门槛，不加「差别不明显」
  it('有对照：开局策略的卡，准时、取消、收入，比它多准时几单，各片区一行', () => {
    const view = summaryTicket(peak({ onTime: 130, baseline: baseline() }), 0, true);
    expect(view.compare).toEqual({
      header: '开局策略',
      cards: '先到先送，全站协同',
      row: '准时 115　取消 5　收入 ¥987',
      gain: '准时订单较开局策略多 15 单',
      record: null,
      districts: [{ name: '老街', pct: '77%', bar: '■■■■■■■□□□', noOrders: false, goal: null, mark: null }],
    });
  });

  it('比开局策略少准时：写少准时几单，不写纪录', () => {
    const block = compareBlock(peak({ onTime: 100, baseline: baseline() }), standingWith({ value: -15, best: 3, broken: false }));
    expect(block?.gain).toBe('准时订单较开局策略少 15 单');
    expect(block?.record).toBeNull();
  });

  it('准时单数相同：订单不多于运力时写那一句说明，否则写相同', () => {
    expect(compareBlock(peak({ onTime: 115, baseline: baseline({ lowLoad: true }) }), null)?.gain).toBe('本场订单未超出运力，两套策略结果接近');
    expect(compareBlock(peak({ onTime: 115, baseline: baseline({ lowLoad: false }) }), null)?.gain).toBe('准时订单与开局策略相同');
  });

  it('订单不多于运力，但准时单数不同：照写多或少几单，不写那一句说明', () => {
    expect(compareBlock(peak({ onTime: 116, baseline: baseline({ lowLoad: true }) }), null)?.gain).toBe('准时订单较开局策略多 1 单，差别不明显');
    expect(compareBlock(peak({ onTime: 114, baseline: baseline({ lowLoad: true }) }), null)?.gain).toBe('准时订单较开局策略少 1 单，差别不明显');
    expect(compareBlock(peak({ onTime: 130, baseline: baseline({ lowLoad: true }) }), null)?.gain).toBe('准时订单较开局策略多 15 单');
  });

  it('多准时的纪录：只在多准时的时候写，破了写新纪录', () => {
    const more = peak({ onTime: 130, baseline: baseline() });
    expect(compareBlock(more, standingWith({ value: 15, best: 20, broken: false }))?.record).toEqual({ text: '纪录 20', fresh: false });
    expect(compareBlock(more, standingWith({ value: 15, best: 2, broken: true }))?.record).toEqual({ text: '新纪录', fresh: true });
    expect(compareBlock(more, standingWith({ value: 15, best: null, broken: false }))?.record).toBeNull();
    expect(compareBlock(more, null)?.record).toBeNull();
  });

  // 来单 148，门槛 10：多 9 单加「差别不明显」，多 10 单和 15 单不加。差别不明显的多准时不算纪录，不写纪录的小字
  it('句末加了「差别不明显」的多准时不写纪录的小字：破了纪录和有旧纪录都一样', () => {
    const unclear = peak({ onTime: 124, baseline: baseline() });
    expect(compareBlock(unclear, standingWith({ value: 9, best: 2, broken: true }))?.gain).toBe('准时订单较开局策略多 9 单，差别不明显');
    expect(compareBlock(unclear, standingWith({ value: 9, best: 2, broken: true }))?.record).toBeNull();
    expect(compareBlock(unclear, standingWith({ value: 9, best: 20, broken: false }))?.record).toBeNull();
    expect(compareBlock(unclear, standingWith({ value: 9, best: null, broken: false }))?.record).toBeNull();
    // 经小结的版面数据也一样：纪录的成绩一路传到对照那一块
    const view = summaryTicket(unclear, 0, true, standingWith({ value: 9, best: 2, broken: true }));
    expect(view.compare?.gain).toBe('准时订单较开局策略多 9 单，差别不明显');
    expect(view.compare?.record).toBeNull();
  });

  it('不加「差别不明显」的多准时照写纪录：差等于门槛 10 单，和多 15 单', () => {
    for (const onTime of [125, 130]) {
      const more = peak({ onTime, baseline: baseline() });
      const gain = onTime - 115;
      expect(compareBlock(more, standingWith({ value: gain, best: 2, broken: true }))?.gain).toBe(`准时订单较开局策略多 ${gain} 单`);
      expect(compareBlock(more, standingWith({ value: gain, best: 2, broken: true }))?.record).toEqual({ text: '新纪录', fresh: true });
      expect(compareBlock(more, standingWith({ value: gain, best: 20, broken: false }))?.record).toEqual({ text: '纪录 20', fresh: false });
      expect(summaryTicket(more, 0, true, standingWith({ value: gain, best: 20, broken: false })).compare?.record).toEqual({ text: '纪录 20', fresh: false });
    }
  });

  it('少准时不写纪录，不论句末有没有「差别不明显」', () => {
    for (const onTime of [106, 100]) {
      const less = peak({ onTime, baseline: baseline() });
      expect(compareBlock(less, standingWith({ value: onTime - 115, best: 3, broken: false }))?.record).toBeNull();
    }
  });

  it('开局策略下某个片区没有订单：写没有订单，没有条', () => {
    const block = compareBlock(peak({ baseline: baseline({ districts: [{ district: 0, n: 0, onTime: 0, pct: null }] }) }), null);
    expect(block?.districts[0]).toEqual({ name: '老街', pct: '无订单', bar: '', noOrders: true, goal: null, mark: null });
  });
});

// 门槛是 ⌈GOALS_V1.compareUnclearK × √来单数⌉：准时单数的差不为 0，并且绝对值小于它，照写差几单，句末加「差别不明显」。依据是多套订单序列的模拟：单场的差的标准差约为 0.5 × √来单数。
describe('高峰小结：对照写「差别不明显」的门槛', () => {
  const MORE = '准时订单较开局策略多';
  const LESS = '准时订单较开局策略少';
  /** 这一场来单 orders 单，准时 onTime 单，开局策略准时 baselineOnTime 单。来单数和准时单数在这里各自取值，不互相约束。 */
  const gainText = (orders: number, onTime: number, baselineOnTime: number, lowLoad = false): string | undefined => {
    const baseline: PeakBaseline = { orders, onTime: baselineOnTime, late: 0, lateOpen: 0, cancelled: 0, revenue: 0, districts: [], lowLoad };
    return compareBlock(peak({ orders, onTime, baseline }), null)?.gain;
  };

  it('门槛取内容表里的系数乘来单数的平方根，向上取整', () => {
    expect(GOALS_V1.compareUnclearK).toBe(0.8);
    const table: readonly (readonly [number, number])[] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 2],
      [6, 2],
      [7, 3],
      [25, 4],
      [26, 5],
      [100, 8],
      [101, 9],
      [148, 10],
      [156, 10],
      [157, 11],
      [225, 12],
      [400, 16],
    ];
    for (const [orders, expected] of table) expect(compareThreshold(orders), `来单 ${orders}`).toBe(expected);
  });

  it('来单数 0 到 3000 的门槛，与整数算式一致：系数 0.8 即 4/5，门槛是使 25 × t² 不小于 16 × 来单数的最小整数 t', () => {
    expect(GOALS_V1.compareUnclearK).toBe(0.8);
    for (let orders = 0; orders <= 3000; orders++) {
      let t = 0;
      while (25 * t * t < 16 * orders) t += 1;
      expect(compareThreshold(orders), `来单 ${orders}`).toBe(t);
    }
  });

  it('差的绝对值等于门槛减 1 时加「差别不明显」，等于门槛时不加。多和少两个方向相同。来单 148，门槛 10', () => {
    expect(gainText(148, 124, 115)).toBe(`${MORE} 9 单，差别不明显`);
    expect(gainText(148, 125, 115)).toBe(`${MORE} 10 单`);
    expect(gainText(148, 126, 115)).toBe(`${MORE} 11 单`);
    expect(gainText(148, 106, 115)).toBe(`${LESS} 9 单，差别不明显`);
    expect(gainText(148, 105, 115)).toBe(`${LESS} 10 单`);
    expect(gainText(148, 104, 115)).toBe(`${LESS} 11 单`);
  });

  it('同样差 2 单：来单 6 单时门槛是 2，不加。来单 7 单时门槛是 3，加', () => {
    expect(gainText(7, 3, 1)).toBe(`${MORE} 2 单，差别不明显`);
    expect(gainText(7, 1, 3)).toBe(`${LESS} 2 单，差别不明显`);
    expect(gainText(7, 4, 1)).toBe(`${MORE} 3 单`);
    expect(gainText(6, 3, 1)).toBe(`${MORE} 2 单`);
    expect(gainText(6, 1, 3)).toBe(`${LESS} 2 单`);
  });

  it('门槛恰好是整数时（25 单门槛 4，100 单门槛 8）也是等于门槛时不加，来单多一单门槛才加一', () => {
    expect(compareThreshold(25)).toBe(4);
    expect(gainText(25, 18, 15)).toBe(`${MORE} 3 单，差别不明显`);
    expect(gainText(25, 19, 15)).toBe(`${MORE} 4 单`);
    expect(compareThreshold(26)).toBe(5);
    expect(gainText(26, 19, 15)).toBe(`${MORE} 4 单，差别不明显`);
    expect(gainText(26, 20, 15)).toBe(`${MORE} 5 单`);
    expect(gainText(100, 60, 53)).toBe(`${MORE} 7 单，差别不明显`);
    expect(gainText(100, 61, 53)).toBe(`${MORE} 8 单`);
    expect(gainText(100, 45, 53)).toBe(`${LESS} 8 单`);
    expect(gainText(100, 46, 53)).toBe(`${LESS} 7 单，差别不明显`);
  });

  it('各种来单数，差从 1 到门槛加 2：小于门槛的加，不小于的不加', () => {
    for (const orders of [2, 3, 7, 25, 26, 100, 148, 157, 400, 1000]) {
      const threshold = compareThreshold(orders);
      for (let gain = 1; gain <= threshold + 2; gain++) {
        const unclear = gain < threshold ? '，差别不明显' : '';
        expect(gainText(orders, 1000 + gain, 1000), `来单 ${orders} 多 ${gain}`).toBe(`${MORE} ${gain} 单${unclear}`);
        expect(gainText(orders, 1000, 1000 + gain), `来单 ${orders} 少 ${gain}`).toBe(`${LESS} ${gain} 单${unclear}`);
      }
    }
  });

  it('来单数很小：0 单时门槛是 0，1 单时门槛是 1，差为 1 照写，不加「差别不明显」。2 单时差 1 加，差 2 不加', () => {
    expect(compareThreshold(0)).toBe(0);
    expect(compareThreshold(1)).toBe(1);
    // 没有订单时两套策略的准时单数必然相同，下面两行是假设有差时的写法
    expect(gainText(0, 1, 0)).toBe(`${MORE} 1 单`);
    expect(gainText(0, 0, 1)).toBe(`${LESS} 1 单`);
    expect(gainText(1, 1, 0)).toBe(`${MORE} 1 单`);
    expect(gainText(1, 0, 1)).toBe(`${LESS} 1 单`);
    expect(gainText(2, 1, 0)).toBe(`${MORE} 1 单，差别不明显`);
    expect(gainText(2, 0, 1)).toBe(`${LESS} 1 单，差别不明显`);
    expect(gainText(2, 2, 0)).toBe(`${MORE} 2 单`);
    expect(gainText(2, 0, 2)).toBe(`${LESS} 2 单`);
  });

  it('差为 0：写相同，订单不多于运力时写那一句说明，都不加「差别不明显」，与来单数无关', () => {
    for (const orders of [0, 1, 2, 10, 148, 500]) {
      expect(gainText(orders, 5, 5), `来单 ${orders}`).toBe('准时订单与开局策略相同');
      expect(gainText(orders, 5, 5, true), `来单 ${orders}`).toBe('本场订单未超出运力，两套策略结果接近');
    }
  });

  it('订单不多于运力，差不为 0：照写多或少几单，门槛的规则相同', () => {
    expect(gainText(148, 124, 115, true)).toBe(`${MORE} 9 单，差别不明显`);
    expect(gainText(148, 125, 115, true)).toBe(`${MORE} 10 单`);
    expect(gainText(148, 105, 115, true)).toBe(`${LESS} 10 单`);
  });
});

describe('高峰小结：一张单的时间四段', () => {
  it('四项：等飞机、等起降、等出餐、路上，按 2 乘 2 的顺序，带百分数', () => {
    const view = summaryTicket(peak(), 0, true);
    expect(view.timeHeader).toBe('单均耗时构成');
    expect(view.segments?.map((s) => [s.id, s.text, s.share])).toEqual([
      ['waitDrone', '等待无人机 38%', 38],
      ['waitGate', '起降排队 12%', 12],
      ['waitPrep', '等待出餐 17%', 17],
      ['road', '在途 33%', 33],
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

describe('高峰小结：机队时间构成', () => {
  const fleet = (patch: Partial<PeakFleet> = {}): PeakFleet => ({ loaded: 20, empty: 36, work: 24, queue: 3, parked: 17, ...patch });

  it('标题和五项，按载货飞行、空载飞行、作业、排队、停放的顺序，带百分数', () => {
    const view = summaryTicket(peak({ fleet: fleet() }), 0, true);
    expect(view.fleet?.header).toBe('机队时间构成');
    expect(view.fleet?.items.map((i) => [i.id, i.text, i.share])).toEqual([
      ['loaded', '载货飞行 20%', 20],
      ['empty', '空载飞行 36%', 36],
      ['work', '作业 24%', 24],
      ['queue', '排队 3%', 3],
      ['parked', '停放 17%', 17],
    ]);
  });

  it('五项加起来是 100，最长的一项带标记，只有这一项', () => {
    const block = fleetBlock(fleet());
    expect(block?.items.reduce((sum, i) => sum + i.share, 0)).toBe(100);
    expect(block?.items.filter((i) => i.longest).map((i) => i.id)).toEqual(['empty']);
    expect(fleetBlock(fleet({ loaded: 5, empty: 5, work: 10, queue: 5, parked: 75 }))?.items.filter((i) => i.longest).map((i) => i.id)).toEqual(['parked']);
  });

  it('并列最长时，标靠前的一项', () => {
    const tie = fleetBlock(fleet({ loaded: 30, empty: 30, work: 20, queue: 10, parked: 10 }));
    expect(tie?.items.filter((i) => i.longest).map((i) => i.id)).toEqual(['loaded']);
    const lateTie = fleetBlock(fleet({ loaded: 10, empty: 10, work: 20, queue: 30, parked: 30 }));
    expect(lateTie?.items.filter((i) => i.longest).map((i) => i.id)).toEqual(['queue']);
  });

  it('没有机队时间构成（没有无人机，或者旧记录）：没有这一块', () => {
    expect(fleetBlock(null)).toBeNull();
    expect(summaryTicket(peak({ fleet: null }), 0, true).fleet).toBeNull();
  });

  it('单均耗时构成还在，机队时间构成是它之外另加的一块', () => {
    const view = summaryTicket(peak({ fleet: fleet() }), 0, true);
    expect(view.segments?.map((s) => s.id)).toEqual(['waitDrone', 'waitGate', 'waitPrep', 'road']);
    expect(view.timeHeader).toBe('单均耗时构成');
    // 没有送达的订单时没有四段时间，机队时间构成仍然有
    const none = summaryTicket(peak({ segments: null, main: { id: 'noDelivered' }, fleet: fleet() }), 0, true);
    expect(none.segments).toBeNull();
    expect(none.fleet?.items).toHaveLength(5);
  });

  it('整句里没有没填的参数', () => {
    for (const item of fleetBlock(fleet())?.items ?? []) expect(item.text).not.toMatch(/undefined|NaN|null|\{|\}/);
  });

  it('真实运行：第一场午高峰的小结里有机队时间构成，五项加起来是 100', () => {
    const state = runningState(42);
    advance(state, 1801);
    const view = latestSummary(state, false);
    expect(view?.fleet?.items).toHaveLength(5);
    expect(view?.fleet?.items.reduce((sum, i) => sum + i.share, 0)).toBe(100);
    expect(view?.fleet?.items.map((i) => i.share)).toEqual(Object.values(campaignOf(state).peaks[0]?.fleet ?? {}));
  });
});

describe('高峰小结：说明句', () => {
  it('主句七条', () => {
    const cases: [MainSentence, string][] = [
      [{ id: 'noOrders' }, '本场无订单。'],
      [{ id: 'noDelivered' }, '本场无已送达订单。'],
      [{ id: 'onTimeHigh', onTime: 93 }, '本场准时率 93%。'],
      [{ id: 'waitDrone' }, '订单耗时主要在等待无人机。'],
      [{ id: 'waitGate' }, '订单耗时主要在起降排队。'],
      [{ id: 'road' }, '订单耗时主要在途中。'],
      [{ id: 'waitPrep' }, '订单耗时主要在等待出餐。'],
    ];
    for (const [main, text] of cases) expect(mainSentence(main)).toBe(text);
  });

  it('附加句：等待起飞和空载飞行两条', () => {
    expect(extraSentence({ id: 'takeoffWait', station: 1, percent: 22 })).toBe('二号站有 22% 的时间有无人机等待起飞。');
    expect(extraSentence({ id: 'emptyFlight', percent: 38 })).toBe('本场无人机有 38% 的时间空载飞行。');
  });

  it('附加句四条：站号是核心的编号加一，写成汉字', () => {
    const cases: [ExtraSentence, string][] = [
      [{ id: 'landQueue', station: 1, count: 3 }, '二号站平均有 3 架无人机等待降落。'],
      [{ id: 'landQueue', station: 0, count: 1.5 }, '一号站平均有 1.5 架无人机等待降落。'],
      [{ id: 'bayIdle', station: 0, percent: 73 }, '一号站的停机位有 73% 的时间空闲。'],
      [{ id: 'notNearest', percent: 41 }, '41% 的订单由非最近站点配送。'],
      [{ id: 'districtLow', district: 1, onTime: 52 }, '写字楼区准时率 52%。'],
    ];
    for (const [extra, text] of cases) expect(extraSentence(extra)).toBe(text);
  });

  it('说明：主句加最多一条附加句', () => {
    expect(summaryTicket(peak({ main: { id: 'waitDrone' }, extra: null }), 0, true).sentences).toEqual(['订单耗时主要在等待无人机。']);
    expect(summaryTicket(peak({ main: { id: 'waitDrone' }, extra: { id: 'landQueue', station: 1, count: 3 } }), 0, true).sentences).toEqual(['订单耗时主要在等待无人机。', '二号站平均有 3 架无人机等待降落。']);
  });

  it('站号超过十时写数字', () => {
    expect(extraSentence({ id: 'landQueue', station: 11, count: 2 })).toBe('12号站平均有 2 架无人机等待降落。');
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
    expect(view).toMatchObject({ title: '午高峰小结', period: '第 1 天  11:30-14:30', compare: null, cleared: null });
    expect(view?.rows.map((r) => r.label)).toEqual(['订单', '准时', '超时', '其中未送达', '取消', '收入']);
    expect(view?.sentences.length).toBeGreaterThanOrEqual(1);
  });

  it('真实运行：第三天的午高峰小结，准时那一行有纪录的小字（之前有两个午高峰），老街一行有目标', () => {
    const state = runningState(42);
    advance(state, 2 * DAY_STEPS + 1801);
    expect(campaignOf(state).peaks).toHaveLength(5);
    const view = latestSummary(state, false);
    expect(view?.title).toBe('午高峰小结');
    const onTime = view?.rows[1];
    expect(onTime?.label).toBe('准时');
    expect(onTime?.record?.text).toMatch(/^(新纪录|纪录 \d+)$/);
    expect(view?.rows.filter((r) => r.record !== null)).toHaveLength(1);
    expect(view?.districts[0]?.goal ?? '').toMatch(/^(目标 \d+%)?$/);
  });
});

describe('日结：各行', () => {
  it('标题、第几天、今天下单、完成的三项（缩进）、还没完成、进账', () => {
    const view = dayEndTicket(day(), 0);
    expect(view).toMatchObject({ title: '日结', day: '第 1 天', next: '继续' });
    expect(view.rows).toEqual([
      { label: '今日订单', value: '37', indent: false, record: null },
      { label: '今日完成', value: '36', indent: false, record: null },
      { label: '准时送达', value: '17', indent: true, record: null },
      { label: '超时送达', value: '17', indent: true, record: null },
      { label: '取消', value: '2', indent: true, record: null },
      { label: '未完成', value: '1', indent: false, record: null },
      { label: '收入', value: '¥193', indent: false, record: null },
    ]);
    expect(view.metrics).toEqual([]);
  });

  it('准时送达、超时送达、退单三项相加等于今天完成的', () => {
    const rows = dayEndTicket(day(), 0).rows;
    const value = (label: string): number => Number(rows.find((r) => r.label === label)!.value);
    expect(value('准时送达') + value('超时送达') + value('取消')).toBe(value('今日完成'));
  });

  it('第几天从 1 数起', () => {
    expect(dayEndTicket(day({ day: 11 }), 11).day).toBe('第 12 天');
  });

  it('进账带纪录：破了写新纪录，没破写纪录和最好的一天', () => {
    const fresh = dayEndTicket(day(), 3, { value: 193.4, best: 150, broken: true });
    expect(fresh.rows[6]?.record).toEqual({ text: '新纪录', fresh: true });
    const old = dayEndTicket(day(), 3, { value: 193.4, best: 273.6, broken: false });
    expect(old.rows[6]?.record).toEqual({ text: '纪录 ¥273', fresh: false });
    expect(dayEndTicket(day(), 0, { value: 193.4, best: null, broken: false }).rows[6]?.record).toBeNull();
  });
});

describe('日结：今天达标的场数和累计的对照', () => {
  it('今天有高峰判了达标：写判了几场，几场全部达标；没有判过的不写', () => {
    expect(dayEndTicket(day({ peaksJudged: 2, peaksCleared: 1 }), 2).metrics).toEqual(['今日评定 2 场高峰，1 场全部达标且无取消。']);
    expect(dayEndTicket(day({ peaksJudged: 1, peaksCleared: 0 }), 2).metrics).toEqual(['今日评定 1 场高峰，0 场全部达标且无取消。']);
    expect(dayEndTicket(day({ peaksJudged: 0, peaksCleared: 0 }), 2).metrics).toEqual([]);
  });

  it('累计准时订单较开局策略多或少的单数：多少相抵为 0，或者没有对照过，不写', () => {
    expect(gainTotalLine(23, 6)).toBe('累计准时订单较开局策略多 23 单。');
    expect(gainTotalLine(-4, 6)).toBe('累计准时订单较开局策略少 4 单。');
    expect(gainTotalLine(0, 6)).toBeNull();
    expect(gainTotalLine(0, 0)).toBeNull();
  });

  it('两句都有时，先写今天的场数，再写累计', () => {
    const view = dayEndTicket(day({ peaksJudged: 2, peaksCleared: 2 }), 2, null, { total: 12, peaks: 8 });
    expect(view.metrics).toEqual(['今日评定 2 场高峰，2 场全部达标且无取消。', '累计准时订单较开局策略多 12 单。']);
  });

  it('真实运行：日结的小票有进账，没有对照过时没有累计', () => {
    const state = runningState(42);
    advance(state, DAY_STEPS + 1);
    const view = latestDayEnd(state);
    expect(view?.rows[6]?.label).toBe('收入');
    expect(view?.metrics ?? []).toEqual([]);
  });
});

describe('日结：各片区的一行', () => {
  it('升星：升几星，明天订单多两成半', () => {
    expect(dayLines(dayLine({ kind: 'starUp', fromStar: 1, star: 2 }))).toEqual(['老街升至二星，明日订单量增加 25%。']);
    expect(dayLines(dayLine({ district: 1, kind: 'starUp', fromStar: 3, star: 4 }))).toEqual(['写字楼区升至四星，明日订单量增加 25%。']);
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
    expect(lines).toEqual(['老街升至三星，明日订单量增加 25%。', '老街北边新店「吴叔排骨面」明日开业。', '老街中间新店「拐角酸辣粉」明日开业。']);
    expect(dayLines(dayLine({ district: 2, kind: 'starUp', fromStar: 1, star: 2, newShops: [{ shop: 20, direction: 'east' }] }))[1]).toBe('大学城东边新店「大学路烧烤」明日开业。');
  });

  it('星级不变', () => {
    expect(dayLines(dayLine({ kind: 'starKept', star: 3 }))).toEqual(['老街保持三星。']);
  });

  it('最近两天没有订单：星级不变', () => {
    expect(dayLines(dayLine({ district: 1, kind: 'noOrders', n: 0, onTimePct: null, cancelPct: null }))).toEqual(['写字楼区近两日无订单，星级不变。']);
  });

  it('最近两天完成的订单太少：写不到下限张，星级不变，下限取自内容表', () => {
    expect(dayLines(dayLine({ kind: 'tooFewOrders', star: 2, n: 3, onTimePct: 100 }))).toEqual([`老街近两日完成订单不足 ${STARS_V1.minSample} 单，星级不变。`]);
    expect(dayLines(dayLine({ district: 2, kind: 'tooFewOrders', star: 1, n: 0 }))).toEqual([`大学城近两日完成订单不足 ${STARS_V1.minSample} 单，星级不变。`]);
  });

  it('可能降星，准时率：写近两日准时率和保星线，明日日结仍未达标将降一星', () => {
    const need = rule(2).onTimeMin; // 三星要保持的线是二星的准时率线
    expect(dayLines(dayLine({ kind: 'dropByOnTime', star: 3, onTimePct: need - 8, needOnTimePct: need }))).toEqual([`老街近两日准时率 ${need - 8}%，低于保星线 ${need}%，明日日结仍未达标将降一星。`]);
  });

  it('可能降星，取消率', () => {
    const need = rule(3).cancelBelow as number; // 四星要保持的线是三星的退单率线
    expect(dayLines(dayLine({ kind: 'dropByCancel', star: 4, cancelPct: need + 2, needCancelPct: need }))).toEqual([`老街近两日取消率 ${need + 2}%，未低于保星要求的 ${need}%，明日日结仍未达标将降一星。`]);
  });

  it('掉星：掉到几星，明天订单少两成', () => {
    expect(dayLines(dayLine({ kind: 'starDown', fromStar: 3, star: 2 }))).toEqual(['老街降至二星，明日订单量减少 20%。']);
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
    expect(view.lines).toEqual(['老街升至三星，明日订单量增加 25%。', '老街西边新店「林姐锅贴」明日开业。', '写字楼区保持二星。']);
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

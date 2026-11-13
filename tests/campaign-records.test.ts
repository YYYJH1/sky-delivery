// 纪录：午高峰和晚高峰各自的准时单数最多，单日进账最多，比开局策略多准时的单数单场最多，连续达标的场数，累计的对照。
import { describe, expect, it } from 'vitest';
import { gainTotal, incomeStanding, peakGain, peakStanding } from '../src/core/index.ts';
import type { DayRecord, PeakBaseline, PeakName, PeakRecord } from '../src/core/index.ts';

function baseline(onTime: number): PeakBaseline {
  return { orders: 40, onTime, late: 40 - onTime, lateOpen: 0, cancelled: 0, revenue: 0, districts: [], lowLoad: false };
}

function peak(day: number, name: PeakName, onTime: number, patch: Partial<PeakRecord> = {}): PeakRecord {
  return {
    day,
    peak: name,
    step: day * 3600 + (name === 'noon' ? 1800 : 3400),
    orders: 40,
    onTime,
    late: 40 - onTime,
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
    ...patch,
  };
}

function dayOf(day: number, income: number): DayRecord {
  return { day, step: (day + 1) * 3600, ordered: 0, resolved: 0, onTime: 0, late: 0, cancelled: 0, pending: 0, income, districts: [], peaksJudged: 0, peaksCleared: 0 };
}

describe('准时单数最多：午高峰和晚高峰各比各的', () => {
  const peaks = [peak(0, 'noon', 20), peak(0, 'evening', 30), peak(1, 'noon', 25), peak(1, 'evening', 28), peak(2, 'noon', 25), peak(2, 'evening', 31)];

  it('第一次出现的午高峰或晚高峰：没有可比的，不算破纪录', () => {
    expect(peakStanding(peaks, 0)?.onTime).toEqual({ value: 20, best: null, broken: false });
    expect(peakStanding(peaks, 1)?.onTime).toEqual({ value: 30, best: null, broken: false });
  });

  it('比之前同一种高峰的最好成绩多才是破纪录：午高峰 25 比 20 多，晚高峰 28 比 30 少', () => {
    expect(peakStanding(peaks, 2)?.onTime).toEqual({ value: 25, best: 20, broken: true });
    expect(peakStanding(peaks, 3)?.onTime).toEqual({ value: 28, best: 30, broken: false });
  });

  it('与最好成绩相同不算破，晚高峰 31 比 30 多算破', () => {
    expect(peakStanding(peaks, 4)?.onTime).toEqual({ value: 25, best: 25, broken: false });
    expect(peakStanding(peaks, 5)?.onTime).toEqual({ value: 31, best: 30, broken: true });
  });

  it('越界的下标没有成绩', () => {
    expect(peakStanding(peaks, 6)).toBeNull();
    expect(peakStanding([], 0)).toBeNull();
  });
});

describe('比开局策略多准时的单数', () => {
  it('这一场的准时数减去对照的准时数，没有对照为 null', () => {
    expect(peakGain(peak(0, 'noon', 30, { baseline: baseline(24) }))).toBe(6);
    expect(peakGain(peak(0, 'noon', 20, { baseline: baseline(24) }))).toBe(-4);
    expect(peakGain(peak(0, 'noon', 20))).toBeNull();
  });

  it('单场最多：所有有对照的场次之间比，午晚不分，没有对照的场次不参与', () => {
    const peaks = [
      peak(0, 'noon', 30, { baseline: baseline(28) }), // 2
      peak(0, 'evening', 30), // 没有对照
      peak(1, 'noon', 30, { baseline: baseline(20) }), // 10
      peak(1, 'evening', 30, { baseline: baseline(25) }), // 5
      peak(2, 'noon', 30, { baseline: baseline(15) }), // 15
    ];
    expect(peakStanding(peaks, 0)?.gain).toEqual({ value: 2, best: null, broken: false });
    expect(peakStanding(peaks, 1)?.gain).toBeNull();
    expect(peakStanding(peaks, 2)?.gain).toEqual({ value: 10, best: 2, broken: true });
    expect(peakStanding(peaks, 3)?.gain).toEqual({ value: 5, best: 10, broken: false });
    expect(peakStanding(peaks, 4)?.gain).toEqual({ value: 15, best: 10, broken: true });
  });

  it('累计：每场比开局策略多或少的单数相加，有的场次是负数，没有对照的场次不算，同时给出有对照的场数', () => {
    const peaks = [peak(0, 'noon', 30, { baseline: baseline(24) }), peak(0, 'evening', 30), peak(1, 'noon', 20, { baseline: baseline(24) }), peak(1, 'evening', 30, { baseline: baseline(20) })];
    expect(gainTotal(peaks)).toEqual({ total: 12, peaks: 3 });
    expect(gainTotal([])).toEqual({ total: 0, peaks: 0 });
    expect(gainTotal([peak(0, 'noon', 20)])).toEqual({ total: 0, peaks: 0 });
  });
});

describe('连续达标的场数', () => {
  const cleared = (value: boolean | null): Partial<PeakRecord> => ({ cleared: value });

  it('达标的场连续累加，现在的值和最多的值都算到这一场为止', () => {
    const peaks = [peak(0, 'noon', 1, cleared(true)), peak(0, 'evening', 1, cleared(true)), peak(1, 'noon', 1, cleared(true))];
    expect(peakStanding(peaks, 0)?.streak).toEqual({ now: 1, best: 1 });
    expect(peakStanding(peaks, 1)?.streak).toEqual({ now: 2, best: 2 });
    expect(peakStanding(peaks, 2)?.streak).toEqual({ now: 3, best: 3 });
  });

  it('判过但没有全部达标，连续就断了，现在的值归零，最多的值留着，断了不罚：之后重新累加', () => {
    const peaks = [
      peak(0, 'noon', 1, cleared(true)),
      peak(0, 'evening', 1, cleared(true)),
      peak(1, 'noon', 1, cleared(false)),
      peak(1, 'evening', 1, cleared(true)),
    ];
    expect(peakStanding(peaks, 2)?.streak).toEqual({ now: 0, best: 2 });
    expect(peakStanding(peaks, 3)?.streak).toEqual({ now: 1, best: 2 });
  });

  it('没有判过目标的场（没有设线，订单不够判）不算断，也不加', () => {
    const peaks = [peak(0, 'noon', 1, cleared(true)), peak(0, 'evening', 1, cleared(null)), peak(1, 'noon', 1, cleared(true))];
    expect(peakStanding(peaks, 1)?.streak).toEqual({ now: 1, best: 1 });
    expect(peakStanding(peaks, 2)?.streak).toEqual({ now: 2, best: 2 });
  });

  it('一场都没有判过：两个值都是 0', () => {
    expect(peakStanding([peak(0, 'noon', 1)], 0)?.streak).toEqual({ now: 0, best: 0 });
  });
});

describe('单日进账最多', () => {
  const days = [dayOf(0, 230), dayOf(1, 410.5), dayOf(2, 380), dayOf(3, 410.5), dayOf(4, 500)];

  it('第一天没有可比的；比之前各天的最好成绩多才是破纪录，相同不算', () => {
    expect(incomeStanding(days, 0)).toEqual({ value: 230, best: null, broken: false });
    expect(incomeStanding(days, 1)).toEqual({ value: 410.5, best: 230, broken: true });
    expect(incomeStanding(days, 2)).toEqual({ value: 380, best: 410.5, broken: false });
    expect(incomeStanding(days, 3)).toEqual({ value: 410.5, best: 410.5, broken: false });
    expect(incomeStanding(days, 4)).toEqual({ value: 500, best: 410.5, broken: true });
  });

  it('越界的下标没有成绩', () => {
    expect(incomeStanding(days, 5)).toBeNull();
    expect(incomeStanding([], 0)).toBeNull();
  });
});

// 日程纸条的时刻换算：一天 3600 步对应 9:30 到 21:30，两个高峰各占一段，标记按步数摆。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, EVENING_WINDOW, NOON_WINDOW, SUMMARY_DELAY } from '../src/core/index.ts';
import {
  DAY_LENGTH_MINUTES,
  DAY_START_MINUTES,
  PEAK_BANDS,
  TICK_MARKS,
  activePeak,
  clockText,
  dayFraction,
  dayNumber,
  minuteOfDay,
} from '../src/ui/schedule.ts';

describe('游戏内时刻', () => {
  it('一天从 9:30 开始，到 21:30 结束，一天 720 分钟', () => {
    expect(DAY_START_MINUTES).toBe(570);
    expect(DAY_LENGTH_MINUTES).toBe(720);
    expect(clockText(0)).toBe('9:30');
  });

  it('每秒 10 步，每秒走 2 个游戏分钟，每 5 步走 1 分钟', () => {
    expect(clockText(4)).toBe('9:30');
    expect(clockText(5)).toBe('9:31');
    expect(clockText(10)).toBe('9:32');
    expect(clockText(300)).toBe('10:30');
    expect(clockText(1800)).toBe('15:30');
  });

  it('两个高峰的起止时刻：午高峰 11:30 到 14:30，晚高峰 16:40 到 19:50', () => {
    expect(clockText(NOON_WINDOW.start)).toBe('11:30');
    expect(clockText(NOON_WINDOW.end)).toBe('14:30');
    expect(clockText(EVENING_WINDOW.start)).toBe('16:40');
    expect(clockText(EVENING_WINDOW.end)).toBe('19:50');
  });

  it('一天的最后一步是 21:29，下一步是第二天的 9:30', () => {
    expect(clockText(DAY_STEPS - 1)).toBe('21:29');
    expect(clockText(DAY_STEPS)).toBe('9:30');
    expect(dayNumber(DAY_STEPS - 1)).toBe(1);
    expect(dayNumber(DAY_STEPS)).toBe(2);
  });

  it('分钟补零，小时不补零', () => {
    expect(clockText(5 * 35)).toBe('10:05');
    expect(clockText(5 * 31)).toBe('10:01');
    expect(clockText(0)).toBe('9:30');
  });

  it('第几天从 1 数起，每 3600 步加一天', () => {
    expect([0, 3599, 3600, 7199, 7200, 10800].map(dayNumber)).toEqual([1, 1, 2, 2, 3, 4]);
  });

  it('当天过去的分钟数，0 到 719', () => {
    expect(minuteOfDay(0)).toBe(0);
    expect(minuteOfDay(DAY_STEPS - 1)).toBe(719);
    expect(minuteOfDay(DAY_STEPS)).toBe(0);
    expect(minuteOfDay(DAY_STEPS + 1500)).toBe(300);
  });
});

describe('纸条上的位置', () => {
  it('当前时刻的位置是当天已走步数占 3600 的比例，不含 1', () => {
    expect(dayFraction(0)).toBe(0);
    expect(dayFraction(1800)).toBe(0.5);
    expect(dayFraction(DAY_STEPS - 1)).toBeLessThan(1);
    expect(dayFraction(DAY_STEPS)).toBe(0);
    expect(dayFraction(DAY_STEPS + 900)).toBe(0.25);
  });

  it('两个高峰的位置取自核心的窗口', () => {
    expect(PEAK_BANDS.map((b) => b.key)).toEqual(['noon', 'evening']);
    expect(PEAK_BANDS[0]).toEqual({ key: 'noon', from: 600 / 3600, to: 1500 / 3600 });
    expect(PEAK_BANDS[1]).toEqual({ key: 'evening', from: 2150 / 3600, to: 3100 / 3600 });
    for (const band of PEAK_BANDS) {
      expect(band.from).toBeGreaterThan(0);
      expect(band.to).toBeLessThan(1);
      expect(band.from).toBeLessThan(band.to);
    }
    expect(PEAK_BANDS[0]!.to).toBeLessThan(PEAK_BANDS[1]!.from);
  });

  it('刻度每两个小时一格，从 10 点到 20 点，位置与时刻对得上', () => {
    expect(TICK_MARKS.map((t) => t.hour)).toEqual([10, 12, 14, 16, 18, 20]);
    for (const t of TICK_MARKS) {
      const minute = Math.round(t.at * DAY_LENGTH_MINUTES);
      expect(Math.floor((DAY_START_MINUTES + minute) / 60)).toBe(t.hour);
      expect((DAY_START_MINUTES + minute) % 60).toBe(0);
    }
  });

  it('小结在高峰结束 30 秒后生成，晚高峰的小结还在一天之内', () => {
    expect(EVENING_WINDOW.end + SUMMARY_DELAY).toBeLessThan(DAY_STEPS);
  });
});

describe('当前在哪个高峰', () => {
  it('午高峰是 [600, 1500)，晚高峰是 [2150, 3100)，两端含起不含止', () => {
    expect([0, 599].map(activePeak)).toEqual([null, null]);
    expect([600, 1499].map(activePeak)).toEqual(['noon', 'noon']);
    expect([1500, 2149].map(activePeak)).toEqual([null, null]);
    expect([2150, 3099].map(activePeak)).toEqual(['evening', 'evening']);
    expect([3100, 3599].map(activePeak)).toEqual([null, null]);
  });

  it('第二天同样', () => {
    expect(activePeak(DAY_STEPS + 700)).toBe('noon');
    expect(activePeak(DAY_STEPS + 2200)).toBe('evening');
    expect(activePeak(DAY_STEPS + 100)).toBeNull();
  });
});

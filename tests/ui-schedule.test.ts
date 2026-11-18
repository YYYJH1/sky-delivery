// 日程纸条的时刻换算：一天 3600 步对应 9:30 到 21:30，两个高峰各占一段，标记按步数摆。
import { describe, expect, it } from 'vitest';
import { BUSY_SEGMENTS, DAY_STEPS, EVENING_WINDOW, NOON_WINDOW, SUMMARY_DELAY } from '../src/core/index.ts';
import {
  BUSY_OPACITY_MAX,
  BUSY_OPACITY_MIN,
  DAY_LENGTH_MINUTES,
  DAY_START_MINUTES,
  PEAK_BANDS,
  TICK_MARKS,
  activePeak,
  busyCells,
  busyOpacity,
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

describe('运力占用带', () => {
  const flat = (value: number): number[] => new Array<number>(BUSY_SEGMENTS).fill(value);

  it('24 格，铺满整条时间轴：第一格从 0 开始，最后一格到 1 结束，首尾相接', () => {
    const cells = busyCells(flat(50)) ?? [];
    expect(cells).toHaveLength(24);
    expect(cells[0]?.from).toBe(0);
    expect(cells[23]?.to).toBe(1);
    cells.forEach((cell, i) => {
      expect(cell.to).toBeGreaterThan(cell.from);
      if (i > 0) expect(cell.from).toBe(cells[i - 1]?.to);
    });
  });

  it('每格 150 步，也就是 30 个游戏分钟：第 i 格从游戏时钟 9:30 加 30i 分钟开始', () => {
    const cells = busyCells(flat(0)) ?? [];
    cells.forEach((cell, i) => {
      expect(cell.from).toBeCloseTo((i * 150) / DAY_STEPS, 12);
      expect(clockText(i * 150)).toBe(clockText(Math.round(cell.from * DAY_STEPS)));
    });
    expect(clockText(0)).toBe('9:30');
    expect(clockText(150)).toBe('10:00');
    expect(clockText(23 * 150)).toBe('21:00');
  });

  it('与刻度对齐：每个整点刻度（10 点到 20 点）正好是某一格的起点，位置用同一个比例', () => {
    const cells = busyCells(flat(0)) ?? [];
    for (const tick of TICK_MARKS) {
      expect(cells.some((c) => Math.abs(c.from - tick.at) < 1e-12), `${tick.hour} 点`).toBe(true);
    }
  });

  it('与高峰区段对齐：午高峰的起止（11:30 和 14:30）正好是格的边界，晚高峰在第 15 格里面', () => {
    const cells = busyCells(flat(0)) ?? [];
    const noon = PEAK_BANDS[0]!;
    expect(cells.some((c) => Math.abs(c.from - noon.from) < 1e-12)).toBe(true);
    expect(cells.some((c) => Math.abs(c.from - noon.to) < 1e-12)).toBe(true);
    const evening = PEAK_BANDS[1]!;
    const start = cells.find((c) => c.from <= evening.from && evening.from < c.to);
    expect(start).toBe(cells[14]); // 16:40 在第 15 格（16:30 到 17:00）里
  });

  it('每格的占用百分数照记录里的，取整后限制在 0 到 100', () => {
    const values = [0, 7, 50, 99, 100, 120, -4, 33.9, ...flat(1).slice(8)];
    const cells = busyCells(values) ?? [];
    expect(cells.slice(0, 8).map((c) => c.pct)).toEqual([0, 7, 50, 99, 100, 100, 0, 33]);
  });

  it('深浅按占用百分数：越多越深，0 最淡，100 最深，都在 10% 到 55% 之内', () => {
    expect(BUSY_OPACITY_MIN).toBe(0.1);
    expect(BUSY_OPACITY_MAX).toBe(0.55);
    expect(busyOpacity(0)).toBe(BUSY_OPACITY_MIN);
    expect(busyOpacity(100)).toBe(BUSY_OPACITY_MAX);
    expect(busyOpacity(50)).toBeCloseTo((BUSY_OPACITY_MIN + BUSY_OPACITY_MAX) / 2, 3);
    let last = -1;
    for (let pct = 0; pct <= 100; pct++) {
      const opacity = busyOpacity(pct);
      expect(opacity).toBeGreaterThanOrEqual(BUSY_OPACITY_MIN);
      expect(opacity).toBeLessThanOrEqual(BUSY_OPACITY_MAX);
      expect(opacity).toBeGreaterThanOrEqual(last);
      last = opacity;
    }
    expect(busyOpacity(-20)).toBe(BUSY_OPACITY_MIN);
    expect(busyOpacity(400)).toBe(BUSY_OPACITY_MAX);
    expect(busyOpacity(Number.NaN)).toBe(BUSY_OPACITY_MIN);
  });

  it('格里带着涂色的不透明度：占用多的格比占用少的格深', () => {
    const cells = busyCells([...flat(10).slice(0, 12), ...flat(90).slice(12)]) ?? [];
    expect(cells[0]?.opacity).toBe(busyOpacity(10));
    expect(cells[23]?.opacity).toBe(busyOpacity(90));
    expect((cells[23]?.opacity ?? 0) > (cells[0]?.opacity ?? 1)).toBe(true);
  });

  it('没有占用数（旧存档的记录，还没有日结）或者个数不是 24：不画这条带', () => {
    expect(busyCells(null)).toBeNull();
    expect(busyCells([])).toBeNull();
    expect(busyCells(flat(10).slice(1))).toBeNull();
    expect(busyCells([...flat(10), 10])).toBeNull();
  });
});

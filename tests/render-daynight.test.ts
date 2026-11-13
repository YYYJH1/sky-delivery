// 昼夜：游戏内的时刻对应哪一种画面状态，以及渐变的比例。纯函数，在 node 里直接调用。
import { describe, expect, it } from 'vitest';
import { NIGHT_FROM_TICK } from '../src/audio/triggers.ts';
import { DAY_STEPS } from '../src/core/index.ts';
import { DUSK_FADE_FROM, DUSK_FADE_TO, NIGHT_FADE_FROM, NIGHT_FADE_TO, dominantLook, lookAtStep, looksWithin, stepAtClock } from '../src/render/daynight.ts';
import type { LookBlend } from '../src/render/daynight.ts';
import { LOOK_NAMES, hexToRgb, mixColor, palFor } from '../src/render/look.ts';
import type { Look } from '../src/render/look.ts';
import { clockText } from '../src/ui/schedule.ts';

const single = (look: Look): LookBlend => ({ from: look, to: look, mix: 0 });

describe('渐变的时刻', () => {
  it('白天保持到 17:00，17:00 到 18:00 渐变到傍晚，18:30 到 19:00 渐变到夜间', () => {
    expect(clockText(DUSK_FADE_FROM)).toBe('17:00');
    expect(clockText(DUSK_FADE_TO)).toBe('18:00');
    expect(clockText(NIGHT_FADE_FROM)).toBe('18:30');
    expect(clockText(NIGHT_FADE_TO)).toBe('19:00');
    expect([DUSK_FADE_FROM, DUSK_FADE_TO, NIGHT_FADE_FROM, NIGHT_FADE_TO]).toEqual([2250, 2550, 2700, 2850]);
  });

  it('夜间全亮的时刻和夜间环境声开始的时刻是同一步', () => {
    expect(NIGHT_FADE_TO).toBe(NIGHT_FROM_TICK);
  });

  it('几点几分换算成当天的第几步，和界面的时钟一致', () => {
    expect(stepAtClock(9, 30)).toBe(0);
    expect(stepAtClock(14, 0)).toBe(1350);
    expect(stepAtClock(21, 30)).toBe(DAY_STEPS);
    for (const step of [0, 1350, 2400, 2775, 3150, 3595]) {
      const minutes = 9 * 60 + 30 + Math.floor(step / 5);
      expect(clockText(step)).toBe(`${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`);
    }
  });
});

describe('一天里每一刻的画面', () => {
  it('一天的开头到 17:00 是白天，没有渐变', () => {
    for (const step of [0, 1, 600, 1350, 2000, DUSK_FADE_FROM - 1, DUSK_FADE_FROM - 0.001]) expect(lookAtStep(step)).toEqual(single('day'));
  });

  it('17:00 正好还是白天，过了 17:00 开始向傍晚渐变', () => {
    expect(lookAtStep(DUSK_FADE_FROM)).toEqual(single('day'));
    const just = lookAtStep(DUSK_FADE_FROM + 1);
    expect(just.from).toBe('day');
    expect(just.to).toBe('dusk');
    expect(just.mix).toBeGreaterThan(0);
    expect(just.mix).toBeLessThan(0.01);
  });

  it('17:30 白天和傍晚各占一半', () => {
    const mid = lookAtStep(stepAtClock(17, 30));
    expect(mid).toEqual({ from: 'day', to: 'dusk', mix: 0.5 });
  });

  it('18:00 渐变结束，18:00 到 18:30 是傍晚，没有渐变', () => {
    const almost = lookAtStep(DUSK_FADE_TO - 1);
    expect(almost.from).toBe('day');
    expect(almost.to).toBe('dusk');
    expect(almost.mix).toBeGreaterThan(0.99);
    expect(almost.mix).toBeLessThan(1);
    for (const step of [DUSK_FADE_TO, DUSK_FADE_TO + 1, stepAtClock(18, 15), NIGHT_FADE_FROM - 1, NIGHT_FADE_FROM - 0.001]) expect(lookAtStep(step)).toEqual(single('dusk'));
  });

  it('18:30 正好还是傍晚，过了 18:30 开始向夜间渐变，18:45 各占一半', () => {
    expect(lookAtStep(NIGHT_FADE_FROM)).toEqual(single('dusk'));
    const just = lookAtStep(NIGHT_FADE_FROM + 1);
    expect(just.from).toBe('dusk');
    expect(just.to).toBe('night');
    expect(just.mix).toBeGreaterThan(0);
    expect(just.mix).toBeLessThan(0.01);
    expect(lookAtStep(stepAtClock(18, 45))).toEqual({ from: 'dusk', to: 'night', mix: 0.5 });
  });

  it('19:00 渐变结束，19:00 到一天结束是夜间', () => {
    const almost = lookAtStep(NIGHT_FADE_TO - 1);
    expect(almost.from).toBe('dusk');
    expect(almost.to).toBe('night');
    expect(almost.mix).toBeGreaterThan(0.99);
    for (const step of [NIGHT_FADE_TO, NIGHT_FADE_TO + 1, 3150, DAY_STEPS - 1, DAY_STEPS - 0.001]) expect(lookAtStep(step)).toEqual(single('night'));
  });

  it('渐变的比例在渐变里只增不减，始终在 0 和 1 之间', () => {
    for (const [start, end, from, to] of [
      [DUSK_FADE_FROM, DUSK_FADE_TO, 'day', 'dusk'],
      [NIGHT_FADE_FROM, NIGHT_FADE_TO, 'dusk', 'night'],
    ] as const) {
      let previous = 0;
      for (let step = start + 1; step < end; step += 0.5) {
        const blend = lookAtStep(step);
        expect(blend.from).toBe(from);
        expect(blend.to).toBe(to);
        expect(blend.mix).toBeGreaterThan(0);
        expect(blend.mix).toBeLessThan(1);
        expect(blend.mix).toBeGreaterThanOrEqual(previous);
        previous = blend.mix;
      }
    }
  });

  it('渐变的两头是缓的：头一分钟变得很少，中间变得快', () => {
    const early = lookAtStep(DUSK_FADE_FROM + 5).mix;
    const middle = lookAtStep(stepAtClock(17, 30) + 5).mix - lookAtStep(stepAtClock(17, 30)).mix;
    expect(early).toBeLessThan(middle / 4);
  });

  it('不带小数的步和带小数的步用同一条曲线', () => {
    expect(lookAtStep(2400.5).mix).toBeGreaterThan(0.5);
    expect(lookAtStep(2400.5).mix).toBeLessThan(lookAtStep(2401).mix);
    expect(lookAtStep(2400.5)).toEqual(lookAtStep(2400.5 + DAY_STEPS));
  });
});

describe('跨天', () => {
  it('一天结束，第二天的第一步直接回到白天，不渐变', () => {
    expect(lookAtStep(DAY_STEPS - 1)).toEqual(single('night'));
    expect(lookAtStep(DAY_STEPS)).toEqual(single('day'));
    expect(lookAtStep(DAY_STEPS + 1)).toEqual(single('day'));
    expect(lookAtStep(2 * DAY_STEPS - 1)).toEqual(single('night'));
    expect(lookAtStep(2 * DAY_STEPS)).toEqual(single('day'));
  });

  it('每天都一样：隔几天的同一步画面相同，包括渐变中的比例', () => {
    for (const step of [0, 700, 2250, 2300, 2400.25, 2549, 2550, 2650, 2700, 2775, 2849, 2850, 3000, 3599.9]) {
      for (const days of [1, 2, 5, 20]) expect(lookAtStep(step + days * DAY_STEPS)).toEqual(lookAtStep(step));
    }
  });

  it('第二天的 17:30 同样是白天和傍晚各占一半', () => {
    expect(lookAtStep(DAY_STEPS + stepAtClock(17, 30))).toEqual({ from: 'day', to: 'dusk', mix: 0.5 });
    expect(lookAtStep(3 * DAY_STEPS + stepAtClock(18, 45))).toEqual({ from: 'dusk', to: 'night', mix: 0.5 });
  });

  it('不会出现下雨：时刻只在白天、傍晚、夜间之间走', () => {
    for (let step = 0; step < 2 * DAY_STEPS; step += 7) {
      const blend = lookAtStep(step);
      expect(['day', 'dusk', 'night']).toContain(blend.from);
      expect(['day', 'dusk', 'night']).toContain(blend.to);
    }
  });

  it('步数不是有限的数时当作一天的开头，负数按前一天的同一刻算', () => {
    expect(lookAtStep(Number.NaN)).toEqual(single('day'));
    expect(lookAtStep(Number.POSITIVE_INFINITY)).toEqual(single('day'));
    expect(lookAtStep(-1)).toEqual(single('night'));
    expect(lookAtStep(-DAY_STEPS + 1000)).toEqual(lookAtStep(1000));
  });
});

describe('调试参数固定画面', () => {
  it('给了固定的状态，一天里每一刻都是它，没有渐变，渐变中间也一样', () => {
    for (const look of LOOK_NAMES) {
      for (const step of [0, 1350, 2250, 2400, 2550, 2700, 2775, 2850, 3150, DAY_STEPS - 1, DAY_STEPS, 5 * DAY_STEPS + 2400]) {
        expect(lookAtStep(step, look)).toEqual(single(look));
      }
    }
  });

  it('不给固定的状态（null 和不传）时按时刻走', () => {
    expect(lookAtStep(2400, null)).toEqual(lookAtStep(2400));
    expect(lookAtStep(3150, null)).toEqual(single('night'));
  });

  it('固定画面下雨：可以，而且是调试参数才能得到的', () => {
    expect(lookAtStep(3150, 'rain')).toEqual(single('rain'));
    expect(lookAtStep(1350, 'day')).toEqual(single('day'));
  });
});

describe('动态层用哪一种画法', () => {
  it('没有渐变时就是当前状态', () => {
    expect(dominantLook(single('night'))).toBe('night');
    expect(dominantLook(single('day'))).toBe('day');
  });

  it('渐变过半之前用下面一层的，过半之后用上面一层的', () => {
    expect(dominantLook({ from: 'dusk', to: 'night', mix: 0.49 })).toBe('dusk');
    expect(dominantLook({ from: 'dusk', to: 'night', mix: 0.5 })).toBe('night');
    expect(dominantLook({ from: 'day', to: 'dusk', mix: 0.9 })).toBe('dusk');
  });

  it('一天里的切换只有三次：17:30、18:45 和第二天的开头，其余时刻保持不变', () => {
    const seen: [number, string][] = [];
    let last = dominantLook(lookAtStep(0));
    seen.push([0, last]);
    for (let step = 1; step < 2 * DAY_STEPS; step++) {
      const look = dominantLook(lookAtStep(step));
      if (look !== last) {
        seen.push([step, look]);
        last = look;
      }
    }
    expect(seen).toEqual([
      [0, 'day'],
      [stepAtClock(17, 30), 'dusk'],
      [stepAtClock(18, 45), 'night'],
      [DAY_STEPS, 'day'],
      [DAY_STEPS + stepAtClock(17, 30), 'dusk'],
      [DAY_STEPS + stepAtClock(18, 45), 'night'],
    ]);
  });
});

describe('提前烘焙要用到哪些状态', () => {
  it('现在用着的排在最前面，白天的上午只有白天', () => {
    expect(looksWithin(0, 300)).toEqual(['day']);
    expect(looksWithin(1350, 300)).toEqual(['day']);
    expect(looksWithin(DUSK_FADE_FROM - 300, 300)).toEqual(['day']);
  });

  it('离 17:00 不到提前量时，傍晚也要烘焙好', () => {
    expect(looksWithin(DUSK_FADE_FROM - 299, 300)).toEqual(['day', 'dusk']);
    expect(looksWithin(DUSK_FADE_FROM, 300)).toEqual(['day', 'dusk']);
  });

  it('渐变中间：两种状态都在用，渐变结束之后的下一种也算进来', () => {
    expect(looksWithin(2400, 100)).toEqual(['day', 'dusk']);
    expect(looksWithin(2500, 300)).toEqual(['day', 'dusk', 'night']);
  });

  it('傍晚的保持期里要把夜间烘焙好，夜间留着复用', () => {
    expect(looksWithin(2600, 100)).toEqual(['dusk']);
    expect(looksWithin(2600, 300)).toEqual(['dusk', 'night']);
    expect(looksWithin(3000, 300)).toEqual(['night']);
  });

  it('夜间快结束时，第二天的白天提前烘焙好', () => {
    expect(looksWithin(DAY_STEPS - 301, 300)).toEqual(['night']);
    expect(looksWithin(DAY_STEPS - 300, 300)).toEqual(['night', 'day']);
    expect(looksWithin(DAY_STEPS - 1, 300)).toEqual(['night', 'day']);
  });

  it('提前量跨过整个一段时，中间那一种也算进来', () => {
    expect(looksWithin(2200, 500)).toEqual(['day', 'dusk']);
    expect(looksWithin(2200, 700)).toEqual(['day', 'dusk', 'night']);
    expect(looksWithin(0, 10 * DAY_STEPS)).toEqual(['day', 'dusk', 'night']);
  });

  it('固定画面时只有固定的那一种，不管提前量多大', () => {
    for (const look of LOOK_NAMES) {
      expect(looksWithin(0, 10 * DAY_STEPS, look)).toEqual([look]);
      expect(looksWithin(2400, 300, look)).toEqual([look]);
    }
  });

  it('提前量是 0、负数或不是有限的数时，只有现在的', () => {
    expect(looksWithin(2400, 0)).toEqual(['day', 'dusk']);
    expect(looksWithin(2400, -50)).toEqual(['day', 'dusk']);
    expect(looksWithin(2400, Number.NaN)).toEqual(['day', 'dusk']);
    expect(looksWithin(3000, 0)).toEqual(['night']);
  });

  it('和逐步采样的结果一致：往后看 ahead 步之内出现过的状态都在里面，没出现过的不在', () => {
    for (const ahead of [1, 50, 150, 300, 600, 1000]) {
      for (let step = 0; step < DAY_STEPS; step += 37) {
        const expected: Look[] = [];
        for (let s = step; s <= step + ahead; s += 0.5) {
          const blend = lookAtStep(s);
          for (const look of [blend.from, blend.to]) if (!expected.includes(look)) expected.push(look);
        }
        for (const look of looksWithin(step, ahead)) expect(expected, `${step} ${ahead}`).toContain(look);
        for (const look of expected) expect(looksWithin(step, ahead), `${step} ${ahead}`).toContain(look);
      }
    }
  });
});

describe('渐变时的底色', () => {
  const day = palFor('day').paper;
  const dusk = palFor('dusk').paper;
  const night = palFor('night').paper;
  const rgb = (n: number): [number, number, number] => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

  it('比例为 0 是第一种状态的纸色，为 1 是第二种的', () => {
    expect(rgb(mixColor(day, dusk, 0))).toEqual(hexToRgb(day));
    expect(rgb(mixColor(day, dusk, 1))).toEqual(hexToRgb(dusk));
    expect(rgb(mixColor(dusk, night, 0))).toEqual(hexToRgb(dusk));
    expect(rgb(mixColor(dusk, night, 1))).toEqual(hexToRgb(night));
  });

  it('中间按通道线性混合，每个通道都在两端之间', () => {
    const [a, b] = [hexToRgb(dusk), hexToRgb(night)];
    const mid = rgb(mixColor(dusk, night, 0.5));
    for (let c = 0; c < 3; c++) {
      expect(mid[c]).toBe(Math.round(((a[c] as number) + (b[c] as number)) / 2));
      expect(mid[c]).toBeGreaterThanOrEqual(Math.min(a[c] as number, b[c] as number));
      expect(mid[c]).toBeLessThanOrEqual(Math.max(a[c] as number, b[c] as number));
    }
  });

  it('比例超出 0 到 1 时夹在两端，同一种颜色混合还是它自己', () => {
    expect(mixColor(day, night, -3)).toBe(mixColor(day, night, 0));
    expect(mixColor(day, night, 7)).toBe(mixColor(day, night, 1));
    expect(rgb(mixColor(night, night, 0.37))).toEqual(hexToRgb(night));
  });

  it('白天向夜间的底色一路变深：亮度随比例单调下降', () => {
    const luma = (n: number): number => {
      const [r, g, b] = rgb(n);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let previous = Number.POSITIVE_INFINITY;
    for (let k = 0; k <= 20; k++) {
      const value = luma(mixColor(day, night, k / 20));
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });
});

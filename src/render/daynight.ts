// 昼夜：游戏内的时刻决定地图用哪一种画面状态，相邻两种状态之间渐变。纯函数，只由步数决定，不读系统时钟，不碰浏览器。
// 一天从 9:30 到 21:30：白天保持到 17:00，17:00 到 18:00 渐变到傍晚，傍晚保持到 18:30，18:30 到 19:00 渐变到夜间，
// 夜间保持到一天结束，第二天从 9:30 起直接回到白天，不渐变。夜间全亮的时刻是 19:00，和夜间环境声开始的时刻一致。
// 渐变不是实时光照：两种状态各有一套画好的静态层，这里只给出两者各占多少。下雨不跟着时刻走，只能固定指定。
import { DAY_STEPS } from '../core/index.ts';
import type { Look } from './look.ts';

/** 这一刻的画面：下面一层是 from，满不透明度。mix 大于 0 时 to 叠在上面，不透明度是 mix。 */
export interface LookBlend {
  readonly from: Look;
  /** 叠在上面的状态，没有渐变时与 from 相同。 */
  readonly to: Look;
  /** to 占的比例，0 到 1。没有渐变时是 0，渐变进行中严格在 0 和 1 之间。 */
  readonly mix: number;
}

/** 游戏的一天从 9:30 开始，分钟数。 */
const DAY_START_MINUTES = 9 * 60 + 30;
/** 每个游戏分钟对应的步数：3600 步对应 12 小时。 */
const STEPS_PER_MINUTE = DAY_STEPS / (12 * 60);

/** 一天里几点几分对应第几步，从 9:30 数起。 */
export function stepAtClock(hour: number, minute = 0): number {
  return (hour * 60 + minute - DAY_START_MINUTES) * STEPS_PER_MINUTE;
}

/** 白天开始向傍晚渐变。 */
export const DUSK_FADE_FROM = stepAtClock(17, 0);
/** 傍晚完全盖住白天。 */
export const DUSK_FADE_TO = stepAtClock(18, 0);
/** 傍晚开始向夜间渐变。 */
export const NIGHT_FADE_FROM = stepAtClock(18, 30);
/** 夜间完全盖住傍晚。 */
export const NIGHT_FADE_TO = stepAtClock(19, 0);

/** 一天被分成的几段：每一段里 from 和 to 不变，两者相同的是不渐变的一段。 */
interface Segment {
  readonly from: Look;
  readonly to: Look;
  readonly start: number;
  readonly end: number;
}

const SEGMENTS: readonly Segment[] = [
  { from: 'day', to: 'day', start: 0, end: DUSK_FADE_FROM },
  { from: 'day', to: 'dusk', start: DUSK_FADE_FROM, end: DUSK_FADE_TO },
  { from: 'dusk', to: 'dusk', start: DUSK_FADE_TO, end: NIGHT_FADE_FROM },
  { from: 'dusk', to: 'night', start: NIGHT_FADE_FROM, end: NIGHT_FADE_TO },
  { from: 'night', to: 'night', start: NIGHT_FADE_TO, end: DAY_STEPS },
];

/** 一天里每一段的起点。第 0 步同时是上一天的终点，往后看到第二天时用得上。 */
const BOUNDARIES: readonly number[] = SEGMENTS.map((s) => s.start);

/** 当天的第几步，0 到 DAY_STEPS，不含终点。步数可以带小数，不是有限的数时当作一天的开头。 */
function stepOfDay(step: number): number {
  if (!Number.isFinite(step)) return 0;
  return ((step % DAY_STEPS) + DAY_STEPS) % DAY_STEPS;
}

/** 先慢后快再慢的缓动：渐变的两头不突然开始或结束，中点正好是一半。 */
function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function single(look: Look): LookBlend {
  return { from: look, to: look, mix: 0 };
}

/**
 * 这一步的画面。pinned 给了就固定用那一种，不随时刻变。
 * 一天从第 0 步重新数：步数超过一天时按当天的第几步算，所以每天都一样，第二天的第 0 步回到白天。
 */
export function lookAtStep(step: number, pinned: Look | null = null): LookBlend {
  if (pinned !== null) return single(pinned);
  const t = stepOfDay(step);
  for (const seg of SEGMENTS) {
    if (t < seg.start || t >= seg.end) continue;
    if (seg.from === seg.to) return single(seg.from);
    const mix = ease((t - seg.start) / (seg.end - seg.start));
    return mix > 0 ? { from: seg.from, to: seg.to, mix } : single(seg.from);
  }
  return single('day');
}

/** 动态层（飞机、小票、字）用哪一种状态的画法：渐变过半之前用下面一层的，过半之后用上面一层的。 */
export function dominantLook(blend: LookBlend): Look {
  return blend.mix < 0.5 ? blend.from : blend.to;
}

/**
 * 从 step 起往后 ahead 步之内会用到的状态，按先后排，现在用着的在最前面。渲染器用它提前烘焙下一种状态。
 * 一天的各段里用到的状态不变，只要看起点、终点和中间的每个分界点就够了。
 */
export function looksWithin(step: number, ahead: number, pinned: Look | null = null): Look[] {
  const found: Look[] = [];
  const add = (blend: LookBlend): void => {
    for (const look of [blend.from, blend.to]) if (!found.includes(look)) found.push(look);
  };
  add(lookAtStep(step, pinned));
  if (pinned !== null || !(ahead > 0)) return found;
  const t0 = stepOfDay(step);
  const end = t0 + ahead;
  for (let day = 0; day * DAY_STEPS <= end; day++) {
    for (const boundary of BOUNDARIES) {
      const at = day * DAY_STEPS + boundary;
      if (at > t0 && at <= end) add(lookAtStep(at));
    }
  }
  add(lookAtStep(end));
  return found;
}

// 运行循环：累加器、一帧最多 6 步、暂停、三档速度、窗口不可见时的补算和离开、系统时间倒退。
import { describe, expect, it } from 'vitest';
import { STEP_MS, createRng, nextRange } from '../src/core/index.ts';
import {
  AWAY_AFTER_MS,
  CATCH_UP_STEPS_PER_FRAME,
  MAX_STEPS_PER_FRAME,
  SPEEDS,
  awaySecondsSince,
  createLoop,
} from '../src/app/index.ts';
import type { FrameResult, Loop, Speed } from '../src/app/index.ts';
import { WALL } from './save-helpers.ts';

/** 从 start 起，每隔 dt 毫秒调用一帧，共 count 帧，返回每一帧的结果。 */
function run(loop: Loop, start: number, dt: number, count: number): FrameResult[] {
  const out: FrameResult[] = [];
  for (let i = 0; i < count; i++) out.push(loop.frame(start + i * dt));
  return out;
}

const total = (frames: FrameResult[], pick: (f: FrameResult) => number = (f) => f.steps): number => frames.reduce((sum, f) => sum + pick(f), 0);

describe('固定步长和累加器', () => {
  it('一步是 100 毫秒：第一帧不推进，之后每满 100 毫秒走一步，剩下的是插值系数', () => {
    const loop = createLoop();
    expect(STEP_MS).toBe(100);
    expect(loop.frame(1000)).toEqual({ steps: 0, catchUpSteps: 0, alpha: 0, owedSteps: 0 });
    expect(loop.frame(1100)).toMatchObject({ steps: 1, alpha: 0 });
    expect(loop.frame(1150)).toMatchObject({ steps: 0, alpha: 0.5 });
    expect(loop.frame(1175)).toMatchObject({ steps: 0, alpha: 0.75 });
    expect(loop.frame(1200)).toMatchObject({ steps: 1, alpha: 0 });
    expect(loop.frame(1290)).toMatchObject({ steps: 0 });
    const last = loop.frame(1320);
    expect(last.steps).toBe(1);
    expect(last.alpha).toBeCloseTo(0.2, 9);
  });

  it('不论帧率多少，走过的步数都是经过的毫秒数除以 100 取整：60 帧、144 帧、30 帧、不规则的帧', () => {
    for (const fps of [30, 60, 144]) {
      const loop = createLoop();
      const frames = run(loop, 0, 1000 / fps, fps * 10 + 1);
      // 帧间隔不是整数毫秒，浮点误差可能让最后一步晚一帧才到，所以允许差 1
      expect(Math.abs(total(frames) - 100), `${fps} 帧`).toBeLessThanOrEqual(1);
    }
    // 整数毫秒的帧间隔是精确的
    for (const dt of [10, 20, 25, 50]) expect(total(run(createLoop(), 0, dt, 10_000 / dt + 1))).toBe(100);
    // 不规则的帧间隔，每一帧不到 100 毫秒，所以不会碰到每帧 6 步的上限
    const rng = createRng(7);
    const loop = createLoop();
    let now = 0;
    let steps = 0;
    loop.frame(now);
    for (let i = 0; i < 5000; i++) {
      now += nextRange(rng, 1, 99);
      const f = loop.frame(now);
      steps += f.steps;
      expect(f.alpha).toBeGreaterThanOrEqual(0);
      expect(f.alpha).toBeLessThan(1);
    }
    expect(Math.abs(steps - Math.floor(now / STEP_MS))).toBeLessThanOrEqual(1);
  });

  it('一帧最多走 6 步：帧间隔很长时（卡顿、断点），补不上的部分丢掉，不越追越卡', () => {
    expect(MAX_STEPS_PER_FRAME).toBe(6);
    const loop = createLoop();
    loop.frame(0);
    const stalled = loop.frame(10_000);
    expect(stalled.steps).toBe(6);
    expect(stalled.alpha).toBeLessThan(1);
    // 丢掉的 9.4 秒不会再还：之后的帧回到正常节奏
    const after = run(loop, 10_016, 16, 100);
    expect(total(after)).toBeLessThanOrEqual(17);
    expect(Math.max(...after.map((f) => f.steps))).toBeLessThanOrEqual(1);
  });

  it('刚好 6 步和 7 步的边界', () => {
    const a = createLoop();
    a.frame(0);
    expect(a.frame(600).steps).toBe(6);
    const b = createLoop();
    b.frame(0);
    expect(b.frame(700).steps).toBe(6);
    const c = createLoop();
    c.frame(0);
    expect(c.frame(599).steps).toBe(5);
  });

  it('帧时间往回走或不是有限数字：按没有经过时间处理，不出错', () => {
    const loop = createLoop();
    loop.frame(1000);
    expect(loop.frame(900).steps).toBe(0);
    expect(loop.frame(Number.NaN).steps).toBe(0);
    expect(loop.frame(Number.POSITIVE_INFINITY).steps).toBe(0);
    expect(loop.frame(1000).steps).toBe(1); // 从 900 往前走了 100
    expect(loop.alpha()).toBeGreaterThanOrEqual(0);
  });
});

describe('三档速度', () => {
  it('只有 1、2、3 三档，其他的值报错', () => {
    expect(SPEEDS).toEqual([1, 2, 3]);
    const loop = createLoop();
    for (const bad of [0, 4, 1.5, -1, 10, Number.NaN]) expect(() => loop.setSpeed(bad as Speed), String(bad)).toThrow(RangeError);
    expect(() => createLoop({ speed: 5 as Speed })).toThrow(RangeError);
    expect(loop.speed()).toBe(1);
  });

  it.each([1, 2, 3] as const)('%s 倍速：步长仍是 100 毫秒，只是每帧走的步数变多，10 秒走 100 乘倍速步', (speed) => {
    const loop = createLoop({ speed });
    const frames = run(loop, 0, 50, 201); // 50 毫秒一帧，10 秒
    expect(total(frames)).toBe(100 * speed);
    // 每一帧走的步数是 0 到 2（1 倍速）、1 到 1（2 倍速，每帧正好 100 毫秒的游戏时间）、1 到 2（3 倍速）
    const per = frames.slice(1).map((f) => f.steps);
    expect(Math.min(...per)).toBe(Math.floor((50 * speed) / 100));
    expect(Math.max(...per)).toBe(Math.ceil((50 * speed) / 100));
  });

  it('变速在帧之间切换，累加器里已有的零头保留，下一帧按新速度累加', () => {
    const loop = createLoop();
    loop.frame(0);
    expect(loop.frame(60)).toMatchObject({ steps: 0, alpha: 0.6 });
    loop.setSpeed(3);
    // 再过 20 毫秒：零头 60 加 20 乘 3 等于 120，走 1 步，剩 20
    const f = loop.frame(80);
    expect(f.steps).toBe(1);
    expect(f.alpha).toBeCloseTo(0.2, 9);
    loop.setSpeed(2);
    expect(loop.frame(130).steps).toBe(1); // 20 + 50 * 2 = 120
  });

  it('倍速下一帧也最多走 6 步', () => {
    const loop = createLoop({ speed: 3 });
    loop.frame(0);
    expect(loop.frame(1000).steps).toBe(6);
  });
});

describe('暂停', () => {
  it('暂停时不执行：步数是 0，插值系数不变；取消暂停之后接着走', () => {
    const loop = createLoop();
    loop.frame(0);
    loop.frame(130);
    const before = loop.alpha();
    loop.setPaused(true);
    expect(loop.paused()).toBe(true);
    for (const f of run(loop, 200, 16, 200)) {
      expect(f.steps).toBe(0);
      expect(f.alpha).toBe(before);
    }
    loop.setPaused(false);
    // 暂停了 3 秒，取消暂停后的第一帧只算这一帧自己的 16 毫秒，不会一下子补上 3 秒
    const resumed = loop.frame(3400);
    expect(resumed.steps).toBe(0);
    expect(loop.frame(3500).steps).toBe(1);
  });

  it('暂停期间调用方不再调用 frame，取消暂停之后的第一帧也不会补上停下的时间', () => {
    const loop = createLoop();
    loop.frame(0);
    loop.setPaused(true);
    loop.setPaused(false);
    expect(loop.frame(60_000).steps).toBe(0);
    expect(loop.frame(60_100).steps).toBe(1);
  });

  it('togglePause 来回切换', () => {
    const loop = createLoop({ paused: true });
    expect(loop.paused()).toBe(true);
    loop.togglePause();
    expect(loop.paused()).toBe(false);
    loop.togglePause();
    expect(loop.paused()).toBe(true);
  });

  it('暂停时换速度，取消暂停后按新速度走', () => {
    const loop = createLoop();
    loop.frame(0);
    loop.setPaused(true);
    loop.setSpeed(3);
    loop.setPaused(false);
    loop.frame(100);
    expect(loop.frame(200).steps).toBe(3);
  });
});

describe('窗口不可见：不到 60 秒，恢复时补算', () => {
  it('补算的步数是不可见的毫秒数乘倍速除以 100，分几帧补完，每帧最多补 30 步', () => {
    expect(AWAY_AFTER_MS).toBe(60_000);
    expect(CATCH_UP_STEPS_PER_FRAME).toBe(30);
    for (const speed of [1, 2, 3] as const) {
      const loop = createLoop({ speed });
      loop.frame(0);
      loop.hide(WALL);
      expect(loop.hidden()).toBe(true);
      const outcome = loop.show(WALL + 10_000);
      expect(outcome).toEqual({ kind: 'resumed', hiddenMs: 10_000, catchUpSteps: 100 * speed });
      expect(loop.hidden()).toBe(false);
      expect(loop.owedSteps()).toBe(100 * speed);
      // 之后每帧只补一部分
      const frames: FrameResult[] = [];
      let now = 20_000;
      while (loop.owedSteps() > 0 && frames.length < 100) {
        frames.push(loop.frame(now));
        now += 16;
      }
      expect(total(frames, (f) => f.catchUpSteps)).toBe(100 * speed);
      expect(Math.max(...frames.map((f) => f.catchUpSteps))).toBe(CATCH_UP_STEPS_PER_FRAME);
      expect(frames.length).toBe(Math.ceil((100 * speed) / CATCH_UP_STEPS_PER_FRAME));
      for (const f of frames) expect(f.steps).toBeLessThanOrEqual(CATCH_UP_STEPS_PER_FRAME + MAX_STEPS_PER_FRAME);
      expect(frames[frames.length - 1]?.owedSteps).toBe(0);
    }
  });

  it('补算期间真实的时间照样在走：每一帧的步数是正常的累加加上补算的', () => {
    const loop = createLoop();
    loop.frame(0);
    loop.hide(WALL);
    loop.show(WALL + 5_000); // 欠 50 步
    // 恢复后的第一帧没有上一帧，不累加时间，只补 30 步。之后每帧 100 毫秒，正常的 1 步加上补算的
    const frames = run(loop, 1_000, 100, 4);
    expect(frames.map((f) => [f.steps, f.catchUpSteps, f.owedSteps])).toEqual([
      [30, 30, 20],
      [21, 20, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
  });

  it('恢复可见之后的第一帧不把不可见的这段帧间隔算进去，否则会白白丢掉 6 步以外的时间', () => {
    const loop = createLoop();
    loop.frame(0);
    loop.hide(WALL);
    loop.show(WALL + 30_000);
    const first = loop.frame(30_016); // 帧时间钟也走了 30 秒
    expect(first.steps - first.catchUpSteps).toBe(0);
    expect(first.catchUpSteps).toBe(30);
  });

  it('补完之后，游戏时间与真实时间一致：前台的时间加上不可见的时间，乘倍速，除以 100，一步不多一步不少', () => {
    const loop = createLoop({ speed: 2 });
    // 前台 99 个 16 毫秒（第一帧不算时间），不可见 20 秒，再前台 187 个 16 毫秒
    let steps = total(run(loop, 0, 16, 100));
    loop.hide(WALL);
    expect(loop.show(WALL + 20_000)).toEqual({ kind: 'resumed', hiddenMs: 20_000, catchUpSteps: 400 });
    const after = run(loop, 100_000, 16, 188);
    steps += total(after);
    expect(loop.owedSteps()).toBe(0);
    expect(total(after, (f) => f.catchUpSteps)).toBe(400);
    expect(steps).toBe(Math.floor(((99 + 187) * 16 + 20_000) * 2 / STEP_MS)); // 491
  });

  it('不可见 59.999 秒仍然补算，60 秒整按关闭处理', () => {
    const a = createLoop();
    a.hide(WALL);
    expect(a.show(WALL + AWAY_AFTER_MS - 1)).toEqual({ kind: 'resumed', hiddenMs: 59_999, catchUpSteps: 599 });
    expect(a.alpha()).toBeCloseTo(0.99, 9); // 零头 99 毫秒留在累加器里
    const b = createLoop();
    b.hide(WALL);
    expect(b.show(WALL + AWAY_AFTER_MS)).toEqual({ kind: 'away', hiddenMs: 60_000, awaySeconds: 60 });
  });

  it('暂停着的时候不可见：没有欠的时间，不补算', () => {
    const loop = createLoop({ paused: true });
    loop.frame(0);
    loop.hide(WALL);
    expect(loop.show(WALL + 30_000)).toEqual({ kind: 'resumed', hiddenMs: 30_000, catchUpSteps: 0 });
    expect(loop.owedSteps()).toBe(0);
    loop.setPaused(false);
    expect(total(run(loop, 40_000, 16, 20))).toBeLessThanOrEqual(3);
  });

  it('不可见期间调用 frame（比如桌面端的定时器）：不推进', () => {
    const loop = createLoop();
    loop.frame(0);
    loop.hide(WALL);
    expect(total(run(loop, 100, 1000, 50))).toBe(0);
    expect(loop.frame(60_000).steps).toBe(0);
  });

  it('重复的 hide 只认第一次，没有 hide 的 show 什么也不做', () => {
    const loop = createLoop();
    loop.hide(WALL);
    loop.hide(WALL + 50_000);
    expect(loop.show(WALL + 10_000)).toMatchObject({ kind: 'resumed', hiddenMs: 10_000 });
    expect(loop.show(WALL + 99_000)).toEqual({ kind: 'resumed', hiddenMs: 0, catchUpSteps: 0 });
  });

  it('欠下的步数补到一半又隐藏、又恢复：欠的一直累计，不丢', () => {
    const loop = createLoop();
    loop.frame(0);
    loop.hide(WALL);
    loop.show(WALL + 10_000); // 欠 100
    loop.frame(10_000); // 补了 30
    expect(loop.owedSteps()).toBe(70);
    loop.hide(WALL + 11_000);
    loop.show(WALL + 16_000); // 又欠 50
    expect(loop.owedSteps()).toBe(120);
  });

  it('lastActiveWallMs：不可见时是变为不可见的时刻，否则是传入的时间', () => {
    const loop = createLoop();
    expect(loop.lastActiveWallMs(WALL + 5)).toBe(WALL + 5);
    loop.hide(WALL + 100);
    expect(loop.lastActiveWallMs(WALL + 9999)).toBe(WALL + 100);
    loop.show(WALL + 200);
    expect(loop.lastActiveWallMs(WALL + 300)).toBe(WALL + 300);
  });
});

describe('窗口不可见：超过 60 秒，按程序关闭处理', () => {
  it('不补算，报告离开的秒数，欠下的步数也清零，之后的帧是正常的', () => {
    for (const speed of [1, 2, 3] as const) {
      const loop = createLoop({ speed });
      loop.frame(0);
      loop.hide(WALL);
      const outcome = loop.show(WALL + 90_500);
      expect(outcome).toEqual({ kind: 'away', hiddenMs: 90_500, awaySeconds: 90.5 });
      expect(loop.owedSteps()).toBe(0);
      const frames = run(loop, 100_000, 100, 10);
      expect(total(frames, (f) => f.catchUpSteps)).toBe(0);
      expect(total(frames)).toBe(9 * speed);
    }
  });

  it('不论速度和暂停，离开多久都如实报告，包括很久', () => {
    for (const ms of [60_000, 60_001, 3_600_000, 86_400_000 * 3]) {
      const loop = createLoop({ paused: true, speed: 3 });
      loop.hide(WALL);
      expect(loop.show(WALL + ms)).toEqual({ kind: 'away', hiddenMs: ms, awaySeconds: ms / 1000 });
    }
  });

  it('此前没补完的欠账，在这次超过时限之后一并作废', () => {
    const loop = createLoop();
    loop.frame(0);
    loop.hide(WALL);
    loop.show(WALL + 10_000);
    expect(loop.owedSteps()).toBe(100);
    loop.hide(WALL + 11_000);
    expect(loop.show(WALL + 11_000 + 61_000).kind).toBe('away');
    expect(loop.owedSteps()).toBe(0);
  });

  it('时限可以通过参数调整', () => {
    const loop = createLoop({ awayAfterMs: 5_000 });
    loop.hide(WALL);
    expect(loop.show(WALL + 5_000).kind).toBe('away');
    loop.hide(WALL);
    expect(loop.show(WALL + 4_999).kind).toBe('resumed');
  });
});

describe('系统时间被调回过去', () => {
  it('不可见的时长按 0 处理：不补算，不报告离开，不出错', () => {
    for (const back of [1, 1000, 3_600_000, 10 ** 12]) {
      const loop = createLoop();
      loop.frame(0);
      loop.hide(WALL);
      expect(() => loop.show(WALL - back)).not.toThrow();
      expect(loop.owedSteps()).toBe(0);
    }
    const loop = createLoop();
    loop.hide(WALL);
    expect(loop.show(WALL - 5_000)).toEqual({ kind: 'resumed', hiddenMs: 0, catchUpSteps: 0 });
    loop.hide(WALL);
    expect(loop.show(WALL)).toEqual({ kind: 'resumed', hiddenMs: 0, catchUpSteps: 0 });
  });

  it('系统时间不是有限数字：同样按 0 处理', () => {
    const loop = createLoop();
    loop.hide(Number.NaN); // 没有记下
    expect(loop.hidden()).toBe(false);
    loop.hide(WALL);
    expect(loop.show(Number.NaN)).toEqual({ kind: 'resumed', hiddenMs: 0, catchUpSteps: 0 });
    loop.hide(WALL);
    expect(loop.show(Number.POSITIVE_INFINITY).kind).toBe('resumed');
  });

  it('离开的秒数：正常、倒退、非有限', () => {
    expect(awaySecondsSince(0, 90_500)).toBe(90.5);
    expect(awaySecondsSince(WALL, WALL)).toBe(0);
    expect(awaySecondsSince(WALL, WALL - 1)).toBe(0);
    expect(awaySecondsSince(WALL, WALL - 86_400_000)).toBe(0);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(awaySecondsSince(bad, WALL)).toBe(0);
      expect(awaySecondsSince(WALL, bad)).toBe(0);
    }
  });

  it('帧时间钟与系统时间互不影响：系统时间乱跳，前台的帧照常走', () => {
    const loop = createLoop();
    run(loop, 0, 100, 3);
    // 前台没有不可见，系统时间怎么变都不进入循环
    expect(total(run(loop, 300, 100, 10))).toBe(10);
  });
});

describe('重置和参数', () => {
  it('reset 清掉累加器、欠下的步数和不可见的记录，速度和暂停保持', () => {
    const loop = createLoop({ speed: 2 });
    loop.frame(0);
    loop.frame(70);
    loop.hide(WALL);
    loop.show(WALL + 5_000);
    loop.setPaused(true);
    loop.reset();
    expect(loop.alpha()).toBe(0);
    expect(loop.owedSteps()).toBe(0);
    expect(loop.hidden()).toBe(false);
    expect(loop.speed()).toBe(2);
    expect(loop.paused()).toBe(true);
  });

  it('参数检查', () => {
    expect(() => createLoop({ maxStepsPerFrame: 0 })).toThrow(RangeError);
    expect(() => createLoop({ catchUpStepsPerFrame: 1.5 })).toThrow(RangeError);
    expect(() => createLoop({ awayAfterMs: 0 })).toThrow(RangeError);
    expect(() => createLoop({ awayAfterMs: Number.NaN })).toThrow(RangeError);
    const loop = createLoop({ maxStepsPerFrame: 2, catchUpStepsPerFrame: 5 });
    loop.frame(0);
    expect(loop.frame(10_000).steps).toBe(2);
  });
});

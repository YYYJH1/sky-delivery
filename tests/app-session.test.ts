// 运行会话：把运行循环、自动保存的判断和存档模块接在一起。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, advance, createState, hashState, summaryStep } from '../src/core/index.ts';
import type { ConfigOverrides, PeakName, SimState } from '../src/core/index.ts';
import { CHANGE_SAVE_DELAY_MS, createSession } from '../src/app/index.ts';
import type { AutosaveReason, SaveReport, Session, SessionHost, Speed } from '../src/app/index.ts';
import { MemoryStore, loadGame } from '../src/save/index.ts';
import type { KeyValueStore } from '../src/save/index.ts';
import { BUSY, FaultyStore, WALL } from './save-helpers.ts';

interface Rig {
  state: SimState;
  store: KeyValueStore;
  session: Session;
  reports: SaveReport[];
  aways: number[];
  /** 已经推进的总步数，由 host.advance 累计。 */
  advanced: { calls: number[] };
}

function rig(options: { config?: ConfigOverrides; state?: SimState; store?: KeyValueStore; savedStep?: number | null; speed?: Speed } = {}): Rig {
  const state = options.state ?? createState(options.config ?? BUSY);
  const store = options.store ?? new MemoryStore();
  const reports: SaveReport[] = [];
  const aways: number[] = [];
  const advanced = { calls: [] as number[] };
  const host: SessionHost = {
    state: () => state,
    advance: (steps) => {
      advanced.calls.push(steps);
      advance(state, steps);
    },
    away: (seconds) => aways.push(seconds),
    saved: (report) => reports.push(report),
  };
  const session = createSession({
    store,
    host,
    savedStep: options.savedStep,
    loop: options.speed === undefined ? {} : { speed: options.speed },
  });
  return { state, store, session, reports, aways, advanced };
}

/** 每隔 dtMs 毫秒调用一帧，直到状态走到第 untilStep 步。帧时间和墙上时间同步前进。返回最后一帧之后的帧时间。 */
function playTo(r: Rig, untilStep: number, from = 0, dtMs = 50): number {
  let now = from;
  r.session.frame(now, WALL + now);
  while (r.state.step < untilStep) {
    now += dtMs;
    r.session.frame(now, WALL + now);
  }
  return now;
}

const PEAKS: PeakName[] = ['noon', 'evening'];

/** 参照：1 倍速、每帧最多走 1 步时，每一步是否触发保存，以及原因。 */
function expectedSaves(totalSteps: number): [AutosaveReason, number][] {
  const summaries = new Set<number>();
  for (let d = 0; d * DAY_STEPS <= totalSteps; d++) for (const peak of PEAKS) summaries.add(summaryStep(d, peak));
  const out: [AutosaveReason, number][] = [];
  let last = 0;
  for (let s = 1; s <= totalSteps; s++) {
    const reason: AutosaveReason | null = s % DAY_STEPS === 0 ? 'day' : summaries.has(s) ? 'summary' : s - last >= 300 ? 'interval' : null;
    if (reason !== null) {
      out.push([reason, s]);
      last = s;
    }
  }
  return out;
}

describe('自动保存的时机（会话）', () => {
  it('1 倍速运行 2 个游戏日：每 30 秒一次，高峰小结之后一次，日结之后一次，保存时间是当时的墙上时间', async () => {
    const r = rig();
    playTo(r, 2 * DAY_STEPS);
    await r.session.flush();
    const got = r.reports.map((report): [AutosaveReason, number] => [report.reason, report.step]);
    expect(got).toEqual(expectedSaves(2 * DAY_STEPS));
    expect(got.filter(([reason]) => reason === 'summary')).toHaveLength(4);
    expect(got.filter(([reason]) => reason === 'day')).toHaveLength(2);
    for (const report of r.reports) {
      expect(report.outcome.ok).toBe(true);
      // 1 倍速、每 50 毫秒一帧：第 s 步在第 2s 帧走完，墙上时间是 WALL + 100 * s
      if (report.outcome.ok) expect(report.outcome.savedAt).toBe(WALL + 100 * report.step);
    }
    // 存下的最后一份就是最后那一步的状态
    const loaded = await loadGame(r.store, WALL);
    expect(loaded.status).toBe('ok');
    expect(loaded.state && hashState(loaded.state)).toBe(hashState(r.state));
  });

  it('3 倍速、一帧走一两步：越过的高峰小结和日结一个不漏，各算一次', async () => {
    const r = rig({ speed: 3 });
    let now = 0;
    r.session.frame(now, WALL);
    while (r.state.step < 2 * DAY_STEPS + 20) {
      now += 40;
      r.session.frame(now, WALL + now);
    }
    await r.session.flush();
    expect(r.reports.filter((x) => x.reason === 'summary')).toHaveLength(4);
    expect(r.reports.filter((x) => x.reason === 'day')).toHaveLength(2);
    const summarySteps = [0, 1].flatMap((d) => PEAKS.map((peak) => summaryStep(d, peak)));
    for (const [i, report] of r.reports.filter((x) => x.reason === 'summary').entries()) {
      expect(report.step - (summarySteps[i] as number)).toBeGreaterThanOrEqual(0);
      expect(report.step - (summarySteps[i] as number)).toBeLessThanOrEqual(1);
    }
    expect(r.reports.every((x) => x.outcome.ok)).toBe(true);
  });

  it('一帧推进的步数是交给 host.advance 的：1 倍速每帧 0 或 1 步，补算时一次几十步', () => {
    const r = rig();
    playTo(r, 50);
    expect(Math.max(...r.advanced.calls)).toBe(1);
    expect(r.advanced.calls.reduce((a, b) => a + b, 0)).toBe(r.state.step);
  });

  it('窗口变为不可见时保存，保存时间就是变为不可见的那一刻。紧接着页面关闭不再重复保存', async () => {
    const r = rig();
    const now = playTo(r, 360); // 第 300 步存过一次
    const hiddenAt = WALL + now + 7;
    r.session.hide(hiddenAt);
    r.session.close(hiddenAt + 4_000);
    r.session.close(hiddenAt + 4_500);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['interval', 'hidden']);
    expect(r.reports[1]?.step).toBe(360);
    const loaded = await loadGame(r.store, WALL);
    expect(loaded.save?.savedAt).toBe(hiddenAt);
    expect(loaded.state?.step).toBe(360);
  });

  it('页面关闭时保存，保存时间是关闭的这一刻', async () => {
    const r = rig();
    const now = playTo(r, 150);
    r.session.close(WALL + now + 12);
    await r.session.flush();
    expect(r.reports.map((x) => [x.reason, x.step])).toEqual([['closing', 150]]);
    const loaded = await loadGame(r.store, WALL);
    expect(loaded.save?.savedAt).toBe(WALL + now + 12);
    expect(loaded.state && hashState(loaded.state)).toBe(hashState(r.state));
  });

  it('什么都没变就不存：存档之后窗口变不可见、页面关闭都不会再写', async () => {
    const r = rig({ savedStep: 0 }); // 开局就是读档来的，这一步已经存过
    r.session.hide(WALL);
    r.session.close(WALL + 1);
    await r.session.flush();
    expect(r.reports).toEqual([]);
    expect(await r.store.keys()).toEqual([]);
  });

  it('新开的局从没存过：第一次不可见就存', async () => {
    const r = rig();
    r.session.hide(WALL);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['hidden']);
  });

  it('玩家暂停时做了操作（买东西、换规矩卡）：没有走步数，也算变过，下一次不可见时保存', async () => {
    const r = rig();
    const now = playTo(r, 400);
    r.session.close(WALL + now + 1); // 先存一次，之后没有变化
    r.session.loop.setPaused(true);
    for (let i = 1; i <= 50; i++) r.session.frame(now + i * 16, WALL + now + i * 16); // 暂停期间调用 frame，一步也不走
    r.session.hide(WALL + now + 900);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['interval', 'closing']);
    r.session.show(WALL + now + 1000);
    r.session.noteChange();
    r.session.hide(WALL + now + 2000);
    r.session.close(WALL + now + 2100);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['interval', 'closing', 'hidden']);
    expect(r.reports[2]?.step).toBe(r.reports[1]?.step);
  });

  it('不可见超过 60 秒：不补算，调用 host.away 报告离开的秒数，之后关闭时要保存（离开结算会改状态）', async () => {
    const r = rig({ savedStep: 0 });
    r.session.hide(WALL);
    const outcome = r.session.show(WALL + 90_000);
    expect(outcome).toEqual({ kind: 'away', hiddenMs: 90_000, awaySeconds: 90 });
    expect(r.aways).toEqual([90]);
    expect(r.state.step).toBe(0);
    r.session.close(WALL + 91_000);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['closing']);
  });

  it('不可见不到 60 秒：恢复后每帧补一部分，状态一共多走 hiddenMs 除以 100 步', async () => {
    const r = rig({ savedStep: 0 });
    const now = playTo(r, 200);
    const before = r.state.step;
    r.session.hide(WALL + now);
    const outcome = r.session.show(WALL + now + 12_300);
    expect(outcome).toEqual({ kind: 'resumed', hiddenMs: 12_300, catchUpSteps: 123 });
    expect(r.aways).toEqual([]);
    let t = now + 100_000;
    for (let i = 0; i < 6; i++) {
      r.session.frame(t, WALL + t);
      t += 16;
    }
    expect(r.session.loop.owedSteps()).toBe(0);
    expect(r.state.step - before).toBeGreaterThanOrEqual(123);
    expect(r.state.step - before).toBeLessThanOrEqual(124);
    await r.session.flush();
  });

  it('host 没有提供 away 和 saved 也能用', async () => {
    const state = createState(BUSY);
    const store = new MemoryStore();
    const session = createSession({ store, host: { state: () => state, advance: (n) => advance(state, n) } });
    session.hide(WALL);
    session.show(WALL + 120_000);
    session.close(WALL + 121_000);
    await session.flush();
    expect((await loadGame(store, WALL)).status).toBe('ok');
  });
});

describe('保存失败和读档开局', () => {
  it('这次没存成：不当作存过，下一个间隔或者窗口变不可见时再试', async () => {
    const faulty = new FaultyStore(new MemoryStore());
    faulty.failAt = 0; // 第一次写出错
    const r = rig({ store: faulty });
    const now = playTo(r, 320);
    await r.session.flush();
    expect(r.reports.map((x) => [x.reason, x.step, x.outcome.ok])).toEqual([['interval', 300, false]]);
    // 窗口变为不可见：状态仍然没存成过，所以保存
    r.session.hide(WALL + now + 1);
    await r.session.flush();
    expect(r.reports.map((x) => [x.reason, x.outcome.ok])).toEqual([
      ['interval', false],
      ['hidden', true],
    ]);
    expect((await loadGame(faulty, WALL)).status).toBe('ok');
  });

  it('失败之后一个间隔到了也会再试', async () => {
    const faulty = new FaultyStore(new MemoryStore());
    faulty.failAt = 0;
    const r = rig({ store: faulty });
    playTo(r, 650);
    await r.session.flush();
    expect(r.reports.map((x) => [x.step, x.outcome.ok])).toEqual([
      [300, false],
      [600, true],
    ]);
  });

  it('保存时 host.state 之外的任何意外都不让渲染帧出错：存储抛出同步的错误，也只是报告失败', async () => {
    const broken: KeyValueStore = {
      get: () => {
        throw new Error('storage is gone');
      },
      set: () => Promise.reject(new Error('storage is gone')),
      remove: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
    };
    const r = rig({ store: broken });
    expect(() => playTo(r, 350)).not.toThrow();
    await r.session.flush();
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]?.outcome.ok).toBe(false);
    expect(r.state.step).toBeGreaterThanOrEqual(350);
  });

  it('读档开局：这一步已经存过，到下一个间隔才存', async () => {
    const first = rig({ savedStep: 0 });
    playTo(first, 1000);
    first.session.close(WALL + 99_999);
    await first.session.flush();
    const loaded = await loadGame(first.store, WALL);
    expect(loaded.state?.step).toBe(1000);

    const second = rig({ state: loaded.state as SimState, store: first.store, savedStep: 1000 });
    const now = playTo(second, 1299);
    expect(second.reports).toEqual([]);
    playTo(second, 1300, now);
    await second.session.flush();
    expect(second.reports.map((x) => [x.reason, x.step])).toEqual([['interval', 1300]]);
  });

  it('restart：换了一份状态之后，循环清零，当前步算作已经存过（或者指定）', async () => {
    const r = rig({ savedStep: 0 });
    playTo(r, 100);
    r.session.loop.hide(WALL + 5_000);
    r.session.restart();
    expect(r.session.loop.hidden()).toBe(false);
    expect(r.session.loop.owedSteps()).toBe(0);
    r.session.close(WALL + 6_000);
    await r.session.flush();
    expect(r.reports).toEqual([]);
    r.session.restart(null);
    r.session.close(WALL + 7_000);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['closing']);
  });
});

describe('从头到尾：运行、关闭、再打开，之后的进程与不间断运行相同', () => {
  it('跑到第 1500 步页面关闭，读档重开，再跑到第 3000 步，状态哈希与一口气跑到 3000 步相同', async () => {
    const before = new MemoryStore();
    const a = rig({ store: before });
    const now = playTo(a, 1500);
    expect(a.state.step).toBe(1500);
    a.session.close(WALL + now);
    await a.session.flush();

    // 重开：新的状态对象、新的会话，只有存储里的数据是连着的
    const store = new MemoryStore(before.snapshot());
    const loaded = await loadGame(store, WALL + now + 5_000);
    expect(loaded.status).toBe('ok');
    const b = rig({ state: loaded.state as SimState, store, savedStep: 1500 });
    playTo(b, 3000);
    expect(b.state.step).toBe(3000);

    const straight = createState(BUSY);
    advance(straight, 3000);
    expect(hashState(b.state)).toBe(hashState(straight));
    await b.session.flush();
  });
});

describe('玩家操作之后保存', () => {
  const D = CHANGE_SAVE_DELAY_MS;

  /** 暂停着，每隔 16 毫秒一帧，从 fromMs 到 toMs（相对 WALL）。帧时间和墙上时间同步。 */
  function pausedFrames(r: Rig, fromMs: number, toMs: number): void {
    for (let t = fromMs; t <= toMs; t += 16) r.session.frame(t, WALL + t);
  }

  it('暂停时买了东西：过一小会儿就保存，不用等到窗口不可见或页面关闭；保存的是操作之后的状态', async () => {
    const r = rig({ savedStep: 0 });
    r.session.loop.setPaused(true);
    pausedFrames(r, 0, 1000);
    expect(r.reports).toEqual([]);
    const at = 1000;
    r.session.noteChange(); // 玩家在这一刻买了东西
    pausedFrames(r, at + 16, at + D - 40); // 从这一刻起还不到时间
    await r.session.flush();
    expect(r.reports).toEqual([]);
    pausedFrames(r, at + D - 24, at + D + 300);
    await r.session.flush();
    expect(r.reports.map((x) => [x.reason, x.step, x.outcome.ok])).toEqual([['change', 0, true]]);
    // 这之后什么也没变，再久也不重复保存
    pausedFrames(r, at + D + 316, at + 30_000);
    await r.session.flush();
    expect(r.reports).toHaveLength(1);
    expect((await loadGame(r.store, WALL)).status).toBe('ok');
  });

  it('保存时间是保存那一刻的墙上时间', async () => {
    const r = rig({ savedStep: 0 });
    r.session.loop.setPaused(true);
    r.session.frame(0, WALL);
    r.session.noteChange();
    pausedFrames(r, 16, D + 200);
    await r.session.flush();
    const outcome = r.reports[0]?.outcome;
    expect(outcome?.ok && outcome.savedAt).toBeGreaterThanOrEqual(WALL + D);
    expect(outcome?.ok && outcome.savedAt).toBeLessThanOrEqual(WALL + D + 40);
  });

  it('一连串操作合并成一次保存：从第一个操作起算，中间再有操作不重新计时', async () => {
    const r = rig({ savedStep: 0 });
    r.session.loop.setPaused(true);
    r.session.frame(0, WALL);
    r.session.noteChange();
    r.session.frame(16, WALL + 16);
    for (const t of [D * 0.2, D * 0.4, D * 0.6, D * 0.8]) {
      pausedFrames(r, t, t + 16);
      r.session.noteChange();
    }
    pausedFrames(r, D * 0.8 + 32, D + 300);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['change']);
    // 保存之后的新操作，重新计时，过了时间又存一次
    const again = D + 316;
    r.session.noteChange();
    pausedFrames(r, again, again + D - 40);
    await r.session.flush();
    expect(r.reports).toHaveLength(1);
    pausedFrames(r, again + D - 24, again + D + 300);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['change', 'change']);
  });

  it('游戏在运行时操作之后同样保存：间隔还没到，也不用等', async () => {
    const r = rig({ savedStep: 0 });
    let now = playTo(r, 50);
    r.session.noteChange();
    const end = now + D + 200;
    while (now < end) {
      now += 50;
      r.session.frame(now, WALL + now);
    }
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['change']);
    expect(r.reports[0]?.step).toBeGreaterThan(50);
    expect(r.reports[0]?.step).toBeLessThan(300);
  });

  it('保存没成功：不会每隔一小会儿重试一次，等下一个间隔或者窗口不可见时再试', async () => {
    const faulty = new FaultyStore(new MemoryStore());
    faulty.failAt = 0;
    const r = rig({ store: faulty, savedStep: 0 });
    r.session.loop.setPaused(true);
    r.session.frame(0, WALL);
    r.session.noteChange();
    pausedFrames(r, 16, D + 300);
    await r.session.flush();
    expect(r.reports.map((x) => [x.reason, x.outcome.ok])).toEqual([['change', false]]);
    pausedFrames(r, D + 316, 60_000);
    await r.session.flush();
    expect(r.reports).toHaveLength(1);
    // 窗口变不可见时，状态仍然没存成，保存
    r.session.hide(WALL + 61_000);
    await r.session.flush();
    expect(r.reports.map((x) => [x.reason, x.outcome.ok])).toEqual([
      ['change', false],
      ['hidden', true],
    ]);
  });

  it('不可见超过 60 秒回来，离开结算改了状态：过一小会儿就保存，不等到下一个间隔', async () => {
    const r = rig({ savedStep: 0 });
    r.session.loop.setPaused(true);
    r.session.frame(0, WALL);
    r.session.hide(WALL + 10);
    r.session.show(WALL + 120_000);
    expect(r.aways).toEqual([119.99]);
    pausedFrames(r, 120_000, 120_000 + D + 100);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['change']);
    // 窗口不可见时保存的那一份没有这笔进账，所以这一次是必要的
  });

  it('系统时间被调回过去：计时从现在重新算，不会一直等下去', async () => {
    const r = rig({ savedStep: 0 });
    r.session.loop.setPaused(true);
    r.session.frame(0, WALL);
    r.session.noteChange();
    r.session.frame(16, WALL + 16); // 记下操作的时间
    // 墙上时间一下子倒退一天，帧时间照常走
    const back = WALL - 86_400_000;
    for (let t = 32; t <= D + 300; t += 16) r.session.frame(t, back + t);
    await r.session.flush();
    expect(r.reports.map((x) => x.reason)).toEqual(['change']);
  });

  it('什么都没变的时候不存：读档开局之后，暂停着放着不动，再久也没有保存', async () => {
    const r = rig({ savedStep: 0 });
    r.session.loop.setPaused(true);
    pausedFrames(r, 0, 20_000);
    await r.session.flush();
    expect(r.reports).toEqual([]);
  });

  it('可以调整等多久', async () => {
    const state = createState(BUSY);
    const store = new MemoryStore();
    const reports: SaveReport[] = [];
    const session = createSession({
      store,
      host: { state: () => state, advance: (n) => advance(state, n), saved: (report) => reports.push(report) },
      savedStep: 0,
      changeDelayMs: 500,
      loop: { paused: true },
    });
    session.frame(0, WALL);
    session.noteChange();
    for (let t = 16; t <= 600; t += 16) session.frame(t, WALL + t);
    await session.flush();
    expect(reports.map((x) => x.reason)).toEqual(['change']);
  });
});

// 推演的后台线程和给界面用的接口：用假的线程在线程之外驱动，核对消息格式、分段合成、取消和顶替、出错。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { forecast, forecastPartRuns, mergeForecast } from '../src/app/index.ts';
import type { ForecastDone, ForecastResult } from '../src/app/index.ts';
import { hardwareThreads, workerEnv } from '../src/app/browser.ts';
import { ForecastCancelled, MAX_FORECAST_WORKERS, createForecastClient, defaultWorkerCount, splitRange, workerCountFor } from '../src/app/forecast-client.ts';
import type { WorkerLike } from '../src/app/forecast-client.ts';
import { createForecastHost } from '../src/app/forecast-worker.ts';
import type { ForecastReply, ForecastRequest, ForecastRunRequest } from '../src/app/forecast-worker.ts';
import type { Command, SimState } from '../src/core/index.ts';
import { playGame } from '../tools/autoplay-lib.ts';
import { campaignOf } from './campaign-helpers.ts';

let state: SimState;
const BOX: Command = { type: 'buyDoubleBox' };
const GATE: Command = { type: 'upgradeGate', station: 0 };

beforeAll(() => {
  state = playGame('balanced', 42, { days: 6 }).state;
}, 60_000);

const after = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 假的线程：像浏览器那样把消息复制一份，隔一拍交给线程里的处理逻辑，回复也隔一拍送回来。 */
class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: ForecastReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  readonly received: ForecastRequest[] = [];
  private readonly host = createForecastHost(
    (reply) => {
      setTimeout(() => {
        if (!this.terminated) this.onmessage?.({ data: structuredClone(reply) });
      }, 0);
    },
    () => after(0),
  );

  postMessage(message: ForecastRequest): void {
    const copy = structuredClone(message);
    this.received.push(copy);
    setTimeout(() => {
      if (!this.terminated) void this.host.handle(copy);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function fakeClient(workers: number): { client: ReturnType<typeof createForecastClient>; made: FakeWorker[] } {
  const made: FakeWorker[] = [];
  const client = createForecastClient({
    workers,
    createWorker: () => {
      const w = new FakeWorker();
      made.push(w);
      return w;
    },
  });
  return { client, made };
}

const done = (r: ForecastResult): ForecastDone => {
  if (!r.ok) throw new Error(`unavailable: ${r.reason}`);
  return r;
};

describe('分段', () => {
  it('把序列编号分成连续的、长度相差不超过 1 的几段', () => {
    expect(splitRange(16, 4)).toEqual([{ from: 0, to: 4 }, { from: 4, to: 8 }, { from: 8, to: 12 }, { from: 12, to: 16 }]);
    expect(splitRange(16, 3)).toEqual([{ from: 0, to: 6 }, { from: 6, to: 11 }, { from: 11, to: 16 }]);
    expect(splitRange(3, 4)).toEqual([{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }]);
    expect(splitRange(16, 1)).toEqual([{ from: 0, to: 16 }]);
    expect(splitRange(1, 4)).toEqual([{ from: 0, to: 1 }]);
    for (const total of [1, 2, 7, 16, 33, 64]) {
      for (const n of [1, 2, 3, 4, 8]) {
        const parts = splitRange(total, n);
        expect(parts[0]?.from).toBe(0);
        expect(parts[parts.length - 1]?.to).toBe(total);
        parts.forEach((p, i) => {
          if (i > 0) expect(p.from).toBe((parts[i - 1] as { to: number }).to);
          expect(p.to).toBeGreaterThan(p.from);
        });
        const sizes = parts.map((p) => p.to - p.from);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('线程数：逻辑核数减一，在 1 到 4 之间', () => {
    expect([1, 2, 3, 4, 5, 8, 64, 208].map(workerCountFor)).toEqual([1, 1, 2, 3, 4, 4, 4, 4]);
    expect(workerCountFor(0)).toBe(1);
    const n = defaultWorkerCount();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(MAX_FORECAST_WORKERS);
  });

  it('各段的原始结果合起来，与一次算完的完全相同，次序不影响', () => {
    const whole = forecast(state, BOX, { sequences: 6 });
    const parts = [
      { from: 0, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 6 },
    ].map((range) => {
      const run = forecastPartRuns(state, [BOX], { sequences: 6, range });
      for (;;) {
        const next = run.next();
        if (next.done === true) return next.value[0] as NonNullable<(typeof next.value)[number]>;
      }
    });
    expect(mergeForecast(6, parts)).toEqual(whole);
    expect(mergeForecast(6, [...parts].reverse())).toEqual(whole);
    // 缺一段，或者重叠，都不能合
    expect(() => mergeForecast(6, [parts[0]!, parts[2]!])).toThrow(RangeError);
    expect(() => mergeForecast(6, [parts[0]!, parts[0]!, parts[1]!, parts[2]!])).toThrow(RangeError);
    expect(() => mergeForecast(6, [])).toThrow(RangeError);
  });

  it('区间要落在序列数以内', () => {
    for (const range of [{ from: -1, to: 2 }, { from: 3, to: 2 }, { from: 0, to: 7 }, { from: 0.5, to: 2 }]) {
      expect(() => forecastPartRuns(state, [BOX], { sequences: 6, range }).next()).toThrow(RangeError);
    }
  });
});

describe('环境的适配', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { WorkerGlobalScope: g.WorkerGlobalScope, postMessage: g.postMessage, addEventListener: g.addEventListener };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  });

  it('逻辑核数取不到时按两核算', () => {
    expect(hardwareThreads()).toBeGreaterThanOrEqual(1);
    vi.stubGlobal('navigator', {});
    expect(hardwareThreads()).toBe(2);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    expect(hardwareThreads()).toBe(8);
    vi.unstubAllGlobals();
  });

  it('不在 Web Worker 里，线程的环境是 null，导入后台线程的文件没有副作用', () => {
    expect(workerEnv()).toBeNull();
  });

  it('在 Web Worker 里取到全局的收发消息', () => {
    const sent: unknown[] = [];
    const listeners: ((event: { data: unknown }) => void)[] = [];
    g.WorkerGlobalScope = function WorkerGlobalScope() {};
    g.postMessage = (m: unknown) => sent.push(m);
    g.addEventListener = (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener);
    const env = workerEnv();
    expect(env).not.toBeNull();
    env?.postMessage({ hello: 1 });
    env?.addEventListener('message', () => undefined);
    expect(sent).toEqual([{ hello: 1 }]);
    expect(listeners).toHaveLength(1);
  });
});

describe('后台线程的处理逻辑', () => {
  function runRequest(id: number, sequences = 3, from = 0, to = sequences): ForecastRunRequest {
    return { type: 'run', id, state: structuredClone(state), option: BOX, sequences, salt: 0, from, to };
  }

  it('收到 run 请求，回复 done，带这一段的原始结果', async () => {
    const replies: ForecastReply[] = [];
    const host = createForecastHost((r) => replies.push(r), () => Promise.resolve());
    await host.handle(runRequest(7, 3, 1, 3));
    expect(replies).toHaveLength(1);
    const reply = replies[0] as ForecastReply;
    expect(reply.type).toBe('done');
    if (reply.type !== 'done') return;
    expect(reply.id).toBe(7);
    expect(reply.part).toMatchObject({ ok: true, from: 1 });
    expect((reply.part as { onTimeDiffs: number[] }).onTimeDiffs).toHaveLength(2);
  });

  it('选项不能执行时，回复里是无法推演和原因', async () => {
    const replies: ForecastReply[] = [];
    const host = createForecastHost((r) => replies.push(r), () => Promise.resolve());
    await host.handle({ ...runRequest(1), option: { type: 'upgradeGate', station: 99 } });
    expect(replies).toEqual([{ type: 'done', id: 1, part: { ok: false, reason: 'unknownTarget' } }]);
  });

  it('参数不合法时回复 error', async () => {
    const replies: ForecastReply[] = [];
    const host = createForecastHost((r) => replies.push(r), () => Promise.resolve());
    await host.handle(runRequest(1, 0, 0, 0));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'error', id: 1 });
  });

  it('新请求到了，更早的请求在下一个让出点停下，不再回复', async () => {
    const replies: ForecastReply[] = [];
    const gates: (() => void)[] = [];
    const host = createForecastHost((r) => replies.push(r), () => new Promise<void>((resolve) => gates.push(resolve)));
    const first = host.handle(runRequest(1, 3));
    const second = host.handle(runRequest(2, 3));
    expect(gates).toHaveLength(2);
    // 先放行第一个请求的让出点：它发现被顶替，直接结束
    gates[0]?.();
    await first;
    expect(replies).toEqual([]);
    // 第二个请求一套一套放行，直到回复
    let released = 1;
    while (replies.length === 0) {
      gates[released]?.();
      released += 1;
      await after(0);
    }
    await second;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'done', id: 2 });
  });

  it('cancel 请求让手上的请求停下，不回复', async () => {
    const replies: ForecastReply[] = [];
    const gates: (() => void)[] = [];
    const host = createForecastHost((r) => replies.push(r), () => new Promise<void>((resolve) => gates.push(resolve)));
    const first = host.handle(runRequest(1, 3));
    await host.handle({ type: 'cancel' });
    gates[0]?.();
    await first;
    expect(replies).toEqual([]);
  });
});

describe('给界面用的接口', () => {
  it('一个线程：结果与直接推演的完全相同，请求里带状态、选项、序列数和盐', async () => {
    const { client, made } = fakeClient(1);
    const result = await client.request(state, BOX, { sequences: 4, salt: 3 }).promise;
    expect(result).toEqual(forecast(state, BOX, { sequences: 4, salt: 3 }));
    expect(made).toHaveLength(1);
    const sent = (made[0] as FakeWorker).received;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'run', sequences: 4, salt: 3, from: 0, to: 4, option: BOX });
    client.dispose();
  });

  it('默认 16 套序列', async () => {
    const { client } = fakeClient(1);
    const result = await client.request(state, GATE).promise;
    expect(done(result).sequences).toBe(16);
    client.dispose();
  }, 60_000);

  it('三个线程：序列分成三段，合成的结果与一个线程算的完全相同', async () => {
    const { client, made } = fakeClient(3);
    const result = await client.request(state, BOX, { sequences: 7 }).promise;
    expect(result).toEqual(forecast(state, BOX, { sequences: 7 }));
    expect(made).toHaveLength(3);
    expect(made.map((w) => (w.received[0] as ForecastRunRequest).from)).toEqual([0, 3, 5]);
    expect(made.map((w) => (w.received[0] as ForecastRunRequest).to)).toEqual([3, 5, 7]);
    client.dispose();
  });

  it('序列数少于线程数时，只用需要的线程', async () => {
    const { client, made } = fakeClient(4);
    const result = await client.request(state, BOX, { sequences: 2 }).promise;
    expect(result).toEqual(forecast(state, BOX, { sequences: 2 }));
    expect(made.filter((w) => w.received.length > 0)).toHaveLength(2);
    client.dispose();
  });

  it('选项不能推演时，结果是无法推演和原因', async () => {
    const { client } = fakeClient(2);
    const result = await client.request(state, { type: 'upgradeGate', station: 99 }, { sequences: 4 }).promise;
    expect(result).toEqual({ ok: false, reason: 'unknownTarget' });
    client.dispose();
  });

  it('请求时就复制状态：之后界面线程改了状态，不影响推演', async () => {
    const { client } = fakeClient(2);
    const live = structuredClone(state);
    const expected = forecast(state, BOX, { sequences: 4 });
    const handle = client.request(live, BOX, { sequences: 4 });
    campaignOf(live).money = 0;
    live.rules.select = 'fifo';
    live.step += 500;
    expect(await handle.promise).toEqual(expected);
    client.dispose();
  });

  it('cancel：Promise 以 ForecastCancelled 拒绝，线程收到取消，之后的请求照常', async () => {
    const { client, made } = fakeClient(2);
    const handle = client.request(state, BOX, { sequences: 4 });
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(ForecastCancelled);
    expect(made.every((w) => w.received.some((m) => m.type === 'cancel'))).toBe(true);
    handle.cancel(); // 再取消一次什么也不做
    const again = await client.request(state, BOX, { sequences: 4 }).promise;
    expect(again).toEqual(forecast(state, BOX, { sequences: 4 }));
    expect(made).toHaveLength(2); // 线程复用
    client.dispose();
  });

  it('同一时刻只跑一个：新的请求取消旧的，旧的以 ForecastCancelled 拒绝，新的出结果', async () => {
    const { client, made } = fakeClient(2);
    const first = client.request(state, BOX, { sequences: 6 });
    const second = client.request(state, GATE, { sequences: 6 });
    await expect(first.promise).rejects.toBeInstanceOf(ForecastCancelled);
    expect(await second.promise).toEqual(forecast(state, GATE, { sequences: 6 }));
    // 取消旧请求之后旧请求的回复就算送到也不会混进新请求的结果
    await after(50);
    expect(made).toHaveLength(2);
    // 旧请求的 cancel 不会取消新请求
    const third = client.request(state, BOX, { sequences: 4 });
    first.cancel();
    expect(await third.promise).toEqual(forecast(state, BOX, { sequences: 4 }));
    client.dispose();
  });

  it('被顶替的请求没人处理它的拒绝，也不报未处理的拒绝', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    const { client } = fakeClient(1);
    client.request(state, BOX, { sequences: 2 });
    const second = client.request(state, GATE, { sequences: 2 });
    await second.promise;
    await after(20);
    process.off('unhandledRejection', listener);
    expect(unhandled).toEqual([]);
    client.dispose();
  });

  it('client.cancel 取消现在跑着的推演', async () => {
    const { client } = fakeClient(1);
    const handle = client.request(state, BOX, { sequences: 4 });
    client.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(ForecastCancelled);
    client.cancel(); // 没有在跑的，什么也不做
    client.dispose();
  });

  it('线程回复 error：Promise 以 Error 拒绝，线程保留，之后的请求照常', async () => {
    const { client, made } = fakeClient(2);
    await expect(client.request(state, BOX, { sequences: 0 }).promise).rejects.toThrow(/sequences/);
    const ok = await client.request(state, BOX, { sequences: 4 }).promise;
    expect(ok).toEqual(forecast(state, BOX, { sequences: 4 }));
    expect(made).toHaveLength(2);
    client.dispose();
  });

  it('线程出错（onerror）：Promise 以 Error 拒绝，线程全部丢掉，下一次请求重建', async () => {
    const { client, made } = fakeClient(2);
    const handle = client.request(state, BOX, { sequences: 4 });
    (made[0] as FakeWorker).onerror?.({});
    await expect(handle.promise).rejects.toThrow(/worker failed/);
    expect(made.every((w) => w.terminated)).toBe(true);
    const result = await client.request(state, BOX, { sequences: 4 }).promise;
    expect(result).toEqual(forecast(state, BOX, { sequences: 4 }));
    expect(made).toHaveLength(4);
    client.dispose();
  });

  it('dispose 关掉全部线程，并取消现在跑着的推演', async () => {
    const { client, made } = fakeClient(2);
    const handle = client.request(state, BOX, { sequences: 4 });
    client.dispose();
    await expect(handle.promise).rejects.toBeInstanceOf(ForecastCancelled);
    expect(made.every((w) => w.terminated)).toBe(true);
  });

  it('创建线程失败：Promise 以 Error 拒绝', async () => {
    const client = createForecastClient({
      workers: 2,
      createWorker: () => {
        throw new Error('no worker');
      },
    });
    await expect(client.request(state, BOX).promise).rejects.toThrow('no worker');
  });
});

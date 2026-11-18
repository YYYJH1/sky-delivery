// 给界面用的推演接口：把推演交给后台线程，返回 Promise，可以取消。
// 同一时刻只跑一个推演：新的请求先取消还没出结果的旧请求，旧请求的 Promise 以 ForecastCancelled 拒绝。
// 序列分给几个线程并行算（线程数见 workerCountFor），各线程的结果按序列编号合成，
// 合成的结果与一个线程算的完全相同。线程在第一次请求时才创建，之后复用，出错时丢掉，下一次请求重建。
// 状态在请求时就用 postMessage 复制出去，请求之后界面线程继续推进游戏不影响推演。
//
// 这个文件里的 new Worker(new URL('./forecast-worker.ts', import.meta.url), { type: 'module' }) 是 Vite 认的写法，构建时把线程的代码打成单独的文件。
// 为了在没有 DOM 类型的配置下也能通过类型检查，Worker 在这里用结构类型声明，运行时取的是全局的 Worker。
import type { Command, SimState } from '../core/index.ts';
import { hardwareThreads } from './browser.ts';
import { DEFAULT_SEQUENCES, mergeForecast } from './forecast.ts';
import type { ForecastParams, ForecastPart, ForecastResult, ForecastUnavailable } from './forecast.ts';
import type { ForecastReply, ForecastRequest } from './forecast-worker.ts';

/** 并行的线程数上限。 */
export const MAX_FORECAST_WORKERS = 4;

/** 后台线程用到的那几个成员。 */
export interface WorkerLike {
  postMessage(message: ForecastRequest): void;
  terminate(): void;
  onmessage: ((event: { data: ForecastReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

declare const Worker: new (url: URL, options: { type: 'module' }) => WorkerLike;

/** 真实的后台线程。 */
function spawnWorker(): WorkerLike {
  return new Worker(new URL('./forecast-worker.ts', import.meta.url), { type: 'module' });
}

/** 逻辑核数为 cores 时用几个线程：留一个核给界面，不超过 MAX_FORECAST_WORKERS，至少 1 个。 */
export function workerCountFor(cores: number): number {
  return Math.min(MAX_FORECAST_WORKERS, Math.max(1, Math.floor(cores) - 1));
}

/** 这台机器上默认用几个线程。 */
export function defaultWorkerCount(): number {
  return workerCountFor(hardwareThreads());
}

/** 请求被取消：界面或者新的请求取消了它。 */
export class ForecastCancelled extends Error {
  constructor() {
    super('forecast cancelled');
    this.name = 'ForecastCancelled';
  }
}

export interface ForecastHandle {
  /** 出结果时完成。被取消时以 ForecastCancelled 拒绝，线程出错时以 Error 拒绝。 */
  readonly promise: Promise<ForecastResult>;
  /** 取消这次推演。已经出结果或已经被取消的什么也不做。 */
  cancel(): void;
}

export interface ForecastClient {
  /** 开始一次推演，取消还没出结果的上一次。序列数和盐见 ForecastParams，缺省取默认值。 */
  request(state: SimState, option: Command, params?: Pick<ForecastParams, 'sequences' | 'salt'>): ForecastHandle;
  /** 取消现在跑着的推演，没有则什么也不做。 */
  cancel(): void;
  /** 关掉全部后台线程，取消现在跑着的推演。之后再请求会重新创建线程。 */
  dispose(): void;
}

export interface ForecastClientOptions {
  /** 并行的线程数，缺省 defaultWorkerCount()。 */
  workers?: number;
  /** 创建后台线程的函数，缺省是真实的 Web Worker。测试里传假的。 */
  createWorker?: () => WorkerLike;
}

/** 把 [0, total) 分成至多 n 段连续的、长度相差不超过 1 的区间。 */
export function splitRange(total: number, n: number): { from: number; to: number }[] {
  const parts = Math.max(1, Math.min(n, total));
  const out: { from: number; to: number }[] = [];
  let from = 0;
  for (let i = 0; i < parts; i++) {
    const to = from + Math.floor(total / parts) + (i < total % parts ? 1 : 0);
    out.push({ from, to });
    from = to;
  }
  return out;
}

interface Active {
  id: number;
  promise: Promise<ForecastResult>;
  /** 各线程回复的区间结果，下标与线程一致 */
  parts: (ForecastPart | ForecastUnavailable | null)[];
  sequences: number;
  busy: WorkerLike[];
  resolve(result: ForecastResult): void;
  reject(error: Error): void;
}

export function createForecastClient(options: ForecastClientOptions = {}): ForecastClient {
  const size = Math.max(1, Math.floor(options.workers ?? defaultWorkerCount()));
  const create = options.createWorker ?? spawnWorker;
  let pool: WorkerLike[] = [];
  let active: Active | null = null;
  let lastId = 0;

  /** 关掉全部线程，下一次请求重建。 */
  const drop = (): void => {
    for (const w of pool) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
    pool = [];
  };

  /** 结束现在的请求：给还在算的线程发取消，Promise 以 error 拒绝。被取消的请求没人接着处理时不报未处理的拒绝。 */
  const abort = (error: Error): void => {
    const a = active;
    if (a === null) return;
    active = null;
    if (error instanceof ForecastCancelled) a.promise.catch(() => undefined);
    for (const w of a.busy) w.postMessage({ type: 'cancel' });
    a.reject(error);
  };

  const onReply = (index: number, reply: ForecastReply): void => {
    const a = active;
    if (a === null || reply.id !== a.id) return; // 已经被取消或被顶替的请求
    if (reply.type === 'error') {
      abort(new Error(reply.message));
      return;
    }
    a.parts[index] = reply.part;
    if (a.parts.every((p) => p !== null)) {
      active = null;
      a.resolve(mergeForecast(a.sequences, a.parts as (ForecastPart | ForecastUnavailable)[]));
    }
  };

  const ensure = (): void => {
    while (pool.length < size) {
      const w = create();
      const index = pool.length;
      w.onmessage = (event) => onReply(index, event.data);
      w.onerror = () => {
        drop();
        abort(new Error('forecast worker failed'));
      };
      pool.push(w);
    }
  };

  return {
    request(state, option, params = {}): ForecastHandle {
      abort(new ForecastCancelled());
      const sequences = params.sequences ?? DEFAULT_SEQUENCES;
      const salt = params.salt ?? 0;
      const id = ++lastId;
      let resolve: Active['resolve'] = () => undefined;
      let reject: Active['reject'] = () => undefined;
      const promise = new Promise<ForecastResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      try {
        ensure();
        const ranges = splitRange(Math.max(1, sequences), size);
        active = { id, promise, parts: ranges.map(() => null), sequences, busy: pool.slice(0, ranges.length), resolve, reject };
        ranges.forEach(({ from, to }, i) => {
          (pool[i] as WorkerLike).postMessage({ type: 'run', id, state, option, sequences, salt, from, to });
        });
      } catch (error) {
        // 线程创建失败，或者状态复制不出去：已经发出去的请求要取消，没发出去就直接拒绝
        const failure = error instanceof Error ? error : new Error(String(error));
        if (active === null) reject(failure);
        else abort(failure);
      }
      return {
        promise,
        cancel(): void {
          if (active !== null && active.id === id) abort(new ForecastCancelled());
        },
      };
    },

    cancel(): void {
      abort(new ForecastCancelled());
    },

    dispose(): void {
      abort(new ForecastCancelled());
      drop();
    },
  };
}

// ---- 共用的一个客户端 ----
let shared: ForecastClient | null = null;

/** 界面用的入口：共用一个客户端，同一时刻只跑一个推演。 */
export function requestForecast(state: SimState, option: Command, params?: Pick<ForecastParams, 'sequences' | 'salt'>): ForecastHandle {
  shared ??= createForecastClient();
  return shared.request(state, option, params);
}

/** 取消共用客户端上的推演，并关掉它的线程。 */
export function disposeForecast(): void {
  shared?.dispose();
  shared = null;
}

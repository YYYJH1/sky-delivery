// 推演的后台线程。模块形式的 Web Worker，由 forecast-client.ts 用 new Worker(new URL(...), { type: 'module' }) 起。
// 收到一条 run 请求（状态、选项、序列数、盐，以及要算的序列区间），在线程里逐套序列推演，回复这个区间上的原始结果。
// 每算完一套序列让出一次，所以 cancel 请求和新的 run 请求能在两套之间处理：被取消的请求不再回复。
// 状态随 postMessage 复制进来，线程里读写的是自己的一份，不影响界面线程的游戏状态。
//
// 消息格式：
//   界面线程发来 { type: 'run', id, state, option, sequences, salt, from, to }：推演 option，总序列数 sequences，只算编号 [from, to)。
//   界面线程发来 { type: 'cancel' }：停下手上的请求，不回复。
//   线程回复 { type: 'done', id, part }：part 是这个区间上的原始结果，由 mergeForecast 合成最终结果。
//   线程回复 { type: 'error', id, message }：推演抛了错。
// 这个文件同时导出 createForecastHost，测试里用假的 post 和 pause 在线程之外驱动它。
// 线程的全局环境经过 browser.ts 的 workerEnv 取，不在线程里（界面线程，Node）导入这个文件没有副作用。
import type { Command, SimState } from '../core/index.ts';
import { workerEnv } from './browser.ts';
import { forecastPartRuns } from './forecast.ts';
import type { ForecastPart, ForecastUnavailable } from './forecast.ts';

export interface ForecastRunRequest {
  type: 'run';
  id: number;
  state: SimState;
  option: Command;
  /** 总序列数。序列的种子和结论的门槛都按它算 */
  sequences: number;
  salt: number;
  /** 这个线程算的序列编号区间 [from, to) */
  from: number;
  to: number;
}

export interface ForecastCancelRequest {
  type: 'cancel';
}

export type ForecastRequest = ForecastRunRequest | ForecastCancelRequest;

export interface ForecastDoneReply {
  type: 'done';
  id: number;
  part: ForecastPart | ForecastUnavailable;
}

export interface ForecastErrorReply {
  type: 'error';
  id: number;
  message: string;
}

export type ForecastReply = ForecastDoneReply | ForecastErrorReply;

export interface ForecastHost {
  /** 处理一条请求。run 请求的 Promise 在回复发出或被取消时完成。 */
  handle(request: ForecastRequest): Promise<void>;
}

/**
 * 请求的处理逻辑。post 发出回复，pause 在两套序列之间让出，让线程的消息队列有机会处理取消和新请求。
 * 同一时刻只有最新的请求在往下算，更早的请求在下一个让出点发现自己被顶替，直接结束。
 */
export function createForecastHost(post: (reply: ForecastReply) => void, pause: () => Promise<void>): ForecastHost {
  /** 允许继续的请求编号，0 表示没有 */
  let current = 0;

  return {
    async handle(request: ForecastRequest): Promise<void> {
      if (request.type === 'cancel') {
        current = 0;
        return;
      }
      const id = request.id;
      current = id;
      try {
        const run = forecastPartRuns(request.state, [request.option], {
          sequences: request.sequences,
          salt: request.salt,
          range: { from: request.from, to: request.to },
        });
        let next = run.next();
        while (next.done !== true) {
          await pause();
          if (current !== id) return;
          next = run.next();
        }
        post({ type: 'done', id, part: next.value[0] as ForecastPart | ForecastUnavailable });
      } catch (error) {
        if (current === id) post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

/**
 * 用 MessageChannel 让出：不像定时器那样受最小延迟的限制，又能让排在前面的消息先处理。
 * 端口只用到 onmessage 和 postMessage，用结构类型声明，没有 DOM 类型的配置下也能通过检查。
 */
function channelPause(): () => Promise<void> {
  const channel = new MessageChannel() as unknown as { port1: { onmessage: (() => void) | null }; port2: { postMessage(message: unknown): void } };
  let wake: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  return () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      channel.port2.postMessage(0);
    });
}

// ---- 线程入口 ----
const env = workerEnv();
if (env !== null) {
  const host = createForecastHost((reply) => env.postMessage(reply), channelPause());
  env.addEventListener('message', (event) => {
    void host.handle(event.data as ForecastRequest);
  });
}

// 推演耗时测量页：在浏览器里通过后台线程推演一个局面，记下每次的耗时。由 tools/forecast-bench.ts 用无头 Chrome 打开。
// 地址的参数：workers 并行的线程数，runs 重复几次，sequences 订单序列数。
// 局面和选项从同目录的 state.json 和 option.json 读，结果放在 window.__bench，测量脚本从那里取。
// 这个文件在 tools/ 下，按没有 DOM 类型的配置检查，所以页面全局用 globalThis 取。
import { createForecastClient } from '../../src/app/forecast-client.ts';
import type { Command, SimState } from '../../src/core/index.ts';

interface Run {
  /** 从发出请求到拿到结果，界面线程上看到的总用时，毫秒 */
  totalMs: number;
  /** 发出请求这一下占用界面线程的时间（状态复制给各个线程），毫秒 */
  postMs: number;
  result: unknown;
}

interface PageGlobals {
  location: { search: string };
  navigator: { userAgent: string; hardwareConcurrency: number };
  __bench?: unknown;
}

const g = globalThis as unknown as PageGlobals;

async function main(): Promise<void> {
  const query = new URLSearchParams(g.location.search);
  const workers = Number(query.get('workers') ?? '1');
  const runs = Number(query.get('runs') ?? '5');
  const sequences = Number(query.get('sequences') ?? '16');
  const [stateText, optionText] = await Promise.all([fetch('state.json').then((r) => r.text()), fetch('option.json').then((r) => r.text())]);
  const parseStart = performance.now();
  const state = JSON.parse(stateText) as SimState;
  const option = JSON.parse(optionText) as Command;
  const parseMs = performance.now() - parseStart;

  const client = createForecastClient({ workers });
  const out: Run[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const handle = client.request(state, option, { sequences });
    const t1 = performance.now();
    const result = await handle.promise;
    const t2 = performance.now();
    out.push({ totalMs: t2 - t0, postMs: t1 - t0, result });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  client.dispose();
  g.__bench = { done: true, workers, sequences, parseMs, userAgent: g.navigator.userAgent, hardwareConcurrency: g.navigator.hardwareConcurrency, runs: out };
}

main().catch((error: unknown) => {
  g.__bench = { done: true, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
});

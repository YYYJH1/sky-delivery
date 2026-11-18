// 推演的耗时测量：Node 上一组，无头 Chrome 里一组。
// 用法：node --disable-warning=ExperimentalWarning tools/forecast-bench.ts [选项]
//
// Node：均衡玩法的自动玩家生成第 6、16、30 天日结之后的局面（playGame 的 days 参数），每个局面推演一个选项（就近降落的购买），
// 记下总耗时，以及复制状态和推进状态各占多少，共用复制和完整复制各测一遍。
// 浏览器：用 Vite 把 tools/forecast-bench-page 打包成页面（和游戏的构建走同一套 Vite 和 worker 的处理），用 vite preview 提供，
// 无头 Chrome 打开它，页面通过 forecast-client.ts 的后台线程推演第 30 天的局面，记下每次的耗时。线程数各取一遍。
// 浏览器里的结果与 Node 里的逐位比较。
//
// Chrome 的路径由 --chrome 或环境变量 CHROME_BIN 给出。临时文件只放在 --tmp-dir 下，不能在 /tmp、/var/tmp、/dev/shm 下。
// Chrome 和 Vite 服务在结束和出错时都会关掉。Chrome 的启动、DevTools 协议的连接和关闭都在本文件里，只用来打开页面并读出结果。
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build, preview } from 'vite';
import type { PreviewServer } from 'vite';
import { advanceTo, copyFull, copyShared, emptyTiming, forecast } from '../src/app/forecast.ts';
import type { ForecastDone, ForecastResult, StateCopier } from '../src/app/forecast.ts';
import { STEP_PHASES } from '../src/core/index.ts';
import type { Command, SimState } from '../src/core/index.ts';
import { playGame } from './autoplay-lib.ts';

const GAME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_DIR = join(GAME, 'tools', 'forecast-bench-page');
const DEFAULT_OUT = join(GAME, 'out', 'forecast-bench');
const FORBIDDEN_TMP = ['/tmp', '/var/tmp', '/dev/shm'];
/** 测耗时用的选项：就近降落的购买，第 6、16、30 天的局面里都能推演（余额不够时补足）。 */
const OPTION: Command = { type: 'buyNearestLanding' };
const DAYS = [6, 16, 30];

// ---- 小工具 ----
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const median = (v: readonly number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const range = (v: readonly number[]): string => `${Math.round(Math.min(...v))} 到 ${Math.round(Math.max(...v))}`;
const ms0 = (x: number): string => String(Math.round(x));
const hostLine = (): string => `本机负载（1、5、15 分钟）${loadavg().map((x) => x.toFixed(1)).join('、')}，${new Date().toISOString()}`;

function mustForecast(result: ForecastResult): ForecastDone {
  if (!result.ok) throw new Error(`推演失败：${result.reason}`);
  return result;
}

// ---- Node 上的耗时 ----

interface NodeRow {
  day: number;
  orders: number;
  steps: number;
  copier: string;
  totalMs: number[];
  copyMs: number[];
  advanceMs: number[];
  copies: number;
  state: SimState;
}

function measureNode(seed: number, sequences: number, runs: number): { rows: NodeRow[]; text: string } {
  const rows: NodeRow[] = [];
  const copiers: [string, StateCopier][] = [['共用', copyShared], ['完整', copyFull]];
  for (const day of DAYS) {
    const { state } = playGame('balanced', seed, { days: day });
    for (const [name, copy] of copiers) {
      forecast(state, OPTION, { sequences, copy }); // 热身
      const row: NodeRow = { day, orders: state.orders.length, steps: 0, copier: name, totalMs: [], copyMs: [], advanceMs: [], copies: 0, state };
      for (let i = 0; i < runs; i++) {
        const timing = emptyTiming(() => performance.now());
        const t0 = performance.now();
        const result = mustForecast(forecast(state, OPTION, { sequences, copy, timing }));
        row.totalMs.push(performance.now() - t0);
        row.copyMs.push(timing.copyMs);
        row.advanceMs.push(timing.advanceMs);
        row.copies = timing.copies;
        row.steps = result.steps;
      }
      rows.push(row);
    }
  }
  // 只测复制：一份状态复制一次要多久
  const copyOnly = DAYS.map((day) => {
    const row = rows.find((r) => r.day === day) as NodeRow;
    const per = (copy: StateCopier): number => {
      copy(row.state);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) copy(row.state);
      return (performance.now() - t0) / 20;
    };
    return { day, shared: per(copyShared), full: per(copyFull) };
  });

  const lines: string[] = [];
  lines.push('# 推演的耗时：Node');
  lines.push(`Node ${process.version}。${hostLine()}`);
  lines.push(`局面：均衡玩法，种子 ${seed}，第 ${DAYS.join('、')} 天日结之后（playGame 的 days 参数）。选项：就近降落的购买。${sequences} 套订单序列，每套复制并推进两份状态，每份推进到第二场高峰的小结生成之后。`);
  lines.push(`每个局面先热身 1 次，再测 ${runs} 次，下面取中位数，括号里是范围，单位毫秒。共用是已有结果的订单与输入共用，完整是整个状态 structuredClone。`);
  lines.push('每行依次是：局面，订单数，每份状态推进的步数，复制方式，总耗时，复制状态的用时，推进状态的用时，其他（报价、汇总），复制占总耗时的比例。');
  lines.push('');
  for (const r of rows) {
    const total = median(r.totalMs);
    const copy = median(r.copyMs);
    const advance = median(r.advanceMs);
    lines.push(
      `第 ${r.day} 天，订单 ${r.orders}，${r.steps} 步，${r.copier}复制：总耗时 ${ms0(total)}（${range(r.totalMs)}），复制 ${ms0(copy)}，推进 ${ms0(advance)}，其他 ${ms0(Math.max(0, total - copy - advance))}，复制占 ${((100 * copy) / total).toFixed(1)}%`,
    );
  }
  lines.push('');
  lines.push('只复制一份状态的用时（20 次的平均，毫秒）：');
  for (const c of copyOnly) lines.push(`第 ${String(c.day).padStart(2)} 天  共用 ${c.shared.toFixed(2)}  完整 ${c.full.toFixed(2)}`);
  lines.push('');
  const day30 = rows.filter((r) => r.day === 30 && r.copier === '共用')[0] as NodeRow;
  lines.push(`第 30 天推进一份状态（${day30.steps} 步）的平均用时 ${(median(day30.advanceMs) / day30.copies).toFixed(1)} 毫秒，复制一份 ${(median(day30.copyMs) / day30.copies).toFixed(2)} 毫秒。`);
  lines.push('');
  lines.push(...profileLines(day30.state, day30.steps));
  return { rows, text: lines.join('\n') };
}

/**
 * 第 30 天的局面推进 steps 步，一步里各个阶段的用时（STEP_PHASES 里的八个），以及把载量改成 1、合单策略改成单独配送之后的推进用时。
 * 每个变体先推进 2 次热身，再测 5 次取中位数。
 */
function profileLines(state: SimState, steps: number): string[] {
  const phases = new Map<string, number[]>();
  const whole: number[] = [];
  for (let rep = 0; rep < 7; rep++) {
    const copy = structuredClone(state);
    const mine = new Map<string, number>();
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) {
      for (const phase of STEP_PHASES) {
        const t = performance.now();
        phase.run(copy);
        mine.set(phase.name, (mine.get(phase.name) ?? 0) + performance.now() - t);
      }
      copy.step += 1;
    }
    if (rep < 2) continue;
    whole.push(performance.now() - t0);
    for (const [name, ms] of mine) phases.set(name, [...(phases.get(name) ?? []), ms]);
  }
  const total = [...phases.values()].reduce((sum, v) => sum + median(v), 0);
  const lines = [
    `下面用第 30 天的局面本身，不带选项，用原来的订单序列，推进 ${steps} 步。订单序列和有没有选项都与上面推演里的 32 份状态不同，每份的用时与上面的平均值有出入，看的是各阶段的比例。`,
    `各阶段的用时（每个阶段在每一步前后各读一次时钟，所以合计比整体推进略大，毫秒，5 次的中位数）：`,
  ];
  for (const [name, v] of phases) lines.push(`  ${name.padEnd(9)} ${median(v).toFixed(1).padStart(6)}  ${((100 * median(v)) / total).toFixed(1)}%`);
  lines.push(`  合计 ${total.toFixed(1)}，不分阶段计时的整体推进 ${median(whole).toFixed(1)}`);

  const small: number[] = [];
  for (let rep = 0; rep < 7; rep++) {
    const copy = structuredClone(state);
    copy.capacity = 1;
    copy.rules.pool = 'single';
    const sets = copy.campaign?.ruleSets ?? null;
    if (sets !== null) {
      sets.noon.pool = 'single';
      sets.evening.pool = 'single';
    }
    const t0 = performance.now();
    advanceTo(copy, copy.step + steps);
    if (rep >= 2) small.push(performance.now() - t0);
  }
  lines.push(`同一个局面把载量改成 1、合单策略改成单独配送，推进 ${steps} 步 ${median(small).toFixed(1)} 毫秒，原来（载量 ${state.capacity}，${state.rules.pool === 'any' ? '顺路合并' : state.rules.pool}）${median(whole).toFixed(1)} 毫秒。`);
  return lines;
}

// ---- Chrome 和 DevTools 协议 ----

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class Cdp {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers: ((message: CdpMessage) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
        else entry.resolve(message.result);
      } else {
        for (const handler of this.handlers) handler(message);
      }
    });
    ws.addEventListener('close', () => this.failAll(new Error('与浏览器的连接已断开')));
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', () => resolveOpen(), { once: true });
      ws.addEventListener('error', () => rejectOpen(new Error(`连不上 ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  onEvent(handler: (message: CdpMessage) => void): void {
    this.handlers.push(handler);
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`DevTools 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolveSend(v as T), reject: rejectSend, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // 已经关了
    }
  }
}

interface Browser {
  child: ChildProcess;
  cdp: Cdp;
  version: string;
}

const isAlive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait(true);
    });
  });
}

async function launchChrome(chrome: string, workDir: string): Promise<Browser> {
  // 路径要短：Chrome 在 TMPDIR 下建单例的套接字，整条路径超过 107 个字符就启动失败
  const dirs = { user: 'user-data', cache: 'disk-cache', config: 'xdg-config', xdgCache: 'xdg-cache', data: 'xdg-data', state: 'xdg-state', home: 'home', tmp: 't' };
  for (const sub of Object.values(dirs)) mkdirSync(join(workDir, sub), { recursive: true });
  const args = [
    `--user-data-dir=${join(workDir, dirs.user)}`,
    `--disk-cache-dir=${join(workDir, dirs.cache)}`,
    '--disable-dev-shm-usage',
    '--no-proxy-server',
    '--no-first-run',
    '--mute-audio',
    '--force-device-scale-factor=1',
    '--window-size=1280,720',
    '--remote-debugging-port=0',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-sync',
    '--disable-crash-reporter',
    'about:blank',
  ];
  const env = {
    ...process.env,
    TMPDIR: join(workDir, dirs.tmp),
    XDG_CONFIG_HOME: join(workDir, dirs.config),
    XDG_CACHE_HOME: join(workDir, dirs.xdgCache),
    XDG_DATA_HOME: join(workDir, dirs.data),
    XDG_STATE_HOME: join(workDir, dirs.state),
    HOME: join(workDir, dirs.home),
  };
  // detached：Chrome 自成一个进程组，结束时整组一起关
  const child = spawn(chrome, args, { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderr = '';
  const wsUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error(`Chrome 15 秒内没有给出调试地址：\n${stderr.slice(-1500)}`)), 15_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-6000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m?.[1]) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectUrl(new Error(`Chrome 提前退出（${code ?? signal}）：\n${stderr.slice(-1500)}`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectUrl(error);
    });
  });
  const cdp = await Cdp.connect(wsUrl);
  const info = await cdp.send<{ product: string }>('Browser.getVersion');
  return { child, cdp, version: info.product };
}

async function stopChrome(browser: Browser | null): Promise<void> {
  if (!browser) return;
  const { child, cdp } = browser;
  try {
    await cdp.send('Browser.close', {}, undefined, 5000);
  } catch {
    // 连接可能已经断了，下面按进程组关闭
  }
  cdp.close();
  await waitExit(child, 4000);
  // 主进程退出后，同一进程组里的渲染、网络等子进程可能还没退完，把整组收掉
  const group = child.pid;
  if (group !== undefined) {
    for (const [signal, wait] of [['SIGTERM', 400], ['SIGKILL', 200]] as const) {
      try {
        process.kill(-group, signal);
      } catch {
        return; // 进程组里已经没有进程了
      }
      await sleep(wait);
    }
  }
}

// ---- 浏览器里的耗时 ----

interface PageRun {
  totalMs: number;
  postMs: number;
  result: ForecastResult;
}

interface PageOut {
  done: true;
  error?: string;
  workers: number;
  sequences: number;
  parseMs: number;
  userAgent: string;
  hardwareConcurrency: number;
  runs: PageRun[];
}

async function runPage(cdp: Cdp, baseUrl: string, workers: number, runs: number, sequences: number): Promise<PageOut> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const problems: string[] = [];
  cdp.onEvent((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = (message.params?.exceptionDetails ?? {}) as { text?: string; exception?: { description?: string } };
      problems.push(`页面异常：${details.exception?.description ?? details.text ?? '未知'}`);
    }
  });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `${baseUrl}/index.html?workers=${workers}&runs=${runs}&sequences=${sequences}` }, sessionId);
    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
      const r = await cdp.send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__bench ?? null)', returnByValue: true }, sessionId);
      const text = r.result.value;
      if (text !== undefined && text !== 'null') {
        const out = JSON.parse(text) as PageOut;
        if (out.error !== undefined) throw new Error(`页面脚本出错：${out.error}`);
        return out;
      }
      if (problems.length > 0) throw new Error(problems.join('\n'));
      if (Date.now() > deadline) throw new Error('页面 15 分钟内没有测完');
      await sleep(500);
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }, undefined, 5000).catch(() => undefined);
  }
}

async function measureBrowser(chrome: string, tmpBase: string, seed: number, sequences: number, runs: number, workerCounts: readonly number[]): Promise<string> {
  const workDir = mkdtempSync(join(tmpBase, 'b-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  const cleanup = async (): Promise<void> => {
    await stopChrome(browser).catch(() => undefined);
    await server?.close().catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    // 局面和选项：第 30 天，同一个局面在 Node 里推演一遍作对照
    const { state } = playGame('balanced', seed, { days: 30 });
    const reference = mustForecast(forecast(state, OPTION, { sequences }));

    const dist = join(workDir, 'dist');
    const started = performance.now();
    await build({ root: PAGE_DIR, configFile: false, base: './', logLevel: 'warn', cacheDir: join(workDir, 'vite-cache'), build: { outDir: dist, emptyOutDir: true } });
    const buildMs = performance.now() - started;
    writeFileSync(join(dist, 'state.json'), JSON.stringify(state));
    writeFileSync(join(dist, 'option.json'), JSON.stringify(OPTION));
    server = await preview({
      root: PAGE_DIR,
      configFile: false,
      logLevel: 'warn',
      build: { outDir: dist },
      preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
    });
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite 没有给出监听端口');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await launchChrome(chrome, workDir);

    const lines: string[] = [];
    lines.push('# 推演的耗时：浏览器');
    lines.push(`${browser.version}（无头），Vite 构建 ${ms0(buildMs)} 毫秒，页面和后台线程都是构建出来的文件（vite build 加 vite preview），页面地址 ${baseUrl}。${hostLine()}`);
    lines.push(`局面：均衡玩法，种子 ${seed}，第 30 天日结之后（订单 ${state.orders.length} 张，状态 JSON ${(JSON.stringify(state).length / 1e6).toFixed(1)} MB）。选项：就近降落的购买。${sequences} 套订单序列。`);
    lines.push(`每个线程数各开一个新页面，在同一个页面里连续推演 ${runs} 次。第 1 次是冷启动（线程刚创建，代码还没有预热），第 2 次起是热的。单位毫秒。`);
    lines.push('总耗时是界面线程上从发出请求到拿到结果的时间，包含把状态复制给线程。发请求占用界面线程是 postMessage 序列化状态的时间。线程里的复制和推进各占多少，src/app 的文件不读系统时钟，浏览器里没有分开记，见 timing_node.txt。');
    lines.push('');
    lines.push('每行依次是：线程数，第几次，总耗时，发请求占用界面线程的时间，与 Node 里同一局面的结果比较。');
    let hardware = 0;
    for (const workers of workerCounts) {
      const out = await runPage(browser.cdp, baseUrl, workers, runs, sequences);
      hardware = out.hardwareConcurrency;
      out.runs.forEach((r, i) => {
        const same = JSON.stringify(r.result) === JSON.stringify(reference) ? '逐位相同' : '不同';
        lines.push(`线程 ${workers}，第 ${i + 1} 次（${i === 0 ? '冷' : '热'}）：总耗时 ${ms0(r.totalMs)}，发请求占用界面线程 ${ms0(r.postMs)}，结果${same}`);
      });
      const hot = out.runs.slice(1);
      if (hot.length > 0) {
        lines.push(`线程 ${workers}，热的 ${hot.length} 次：总耗时中位数 ${ms0(median(hot.map((r) => r.totalMs)))}（${range(hot.map((r) => r.totalMs))}），发请求占用界面线程中位数 ${ms0(median(hot.map((r) => r.postMs)))}`);
      }
      lines.push(`线程 ${workers}：页面解析状态 JSON 用了 ${ms0(out.parseMs)} 毫秒`);
    }
    lines.push('');
    lines.push(`目标：第 30 天的局面在浏览器里完成一次推演不超过 2000 毫秒。页面报告的逻辑核数 ${hardware}，默认线程数 min(4, 核数 - 1)。`);
    return lines.join('\n');
  } finally {
    await cleanup();
  }
}

// ---- 主程序 ----

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'out-dir': { type: 'string' },
      'tmp-dir': { type: 'string' },
      chrome: { type: 'string' },
      seed: { type: 'string' },
      runs: { type: 'string' },
      sequences: { type: 'string' },
      workers: { type: 'string' },
      'node-only': { type: 'boolean' },
      'browser-only': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      '用法：node --disable-warning=ExperimentalWarning tools/forecast-bench.ts [--chrome 路径] [--tmp-dir 目录] [--out-dir 目录] [--seed 42] [--runs 5] [--sequences 16] [--workers 1,2,4] [--node-only] [--browser-only]\n',
    );
    return;
  }
  const seed = Number(values.seed ?? '42');
  const runs = Number(values.runs ?? '5');
  const sequences = Number(values.sequences ?? '16');
  const workerCounts = (values.workers ?? '1,2,4').split(',').map(Number);
  const outDir = resolve(values['out-dir'] ?? DEFAULT_OUT);
  mkdirSync(outDir, { recursive: true });

  if (values['browser-only'] !== true) {
    const { text } = measureNode(seed, sequences, runs);
    writeFileSync(join(outDir, 'timing_node.txt'), `${text}\n`);
    process.stdout.write(`${text}\n\n`);
  }
  if (values['node-only'] !== true) {
    const chrome = (values.chrome ?? process.env.CHROME_BIN ?? '').trim();
    if (chrome === '') throw new Error('没有指定无头 Chrome：请用 --chrome <路径> 指定，或设置环境变量 CHROME_BIN');
    if (chrome.includes('/') && !existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}`);
    const tmpBase = resolve(values['tmp-dir'] ?? process.env.TMPDIR ?? '');
    if (tmpBase === '' || tmpBase === resolve('')) throw new Error('没有临时目录：请设置 TMPDIR，或用 --tmp-dir 指定');
    if (FORBIDDEN_TMP.some((p) => tmpBase === p || tmpBase.startsWith(`${p}/`))) throw new Error(`临时目录不能在 ${FORBIDDEN_TMP.join('、')} 下：${tmpBase}`);
    mkdirSync(tmpBase, { recursive: true });
    const text = await measureBrowser(chrome, tmpBase, seed, sequences, runs, workerCounts);
    writeFileSync(join(outDir, 'timing_browser.txt'), `${text}\n`);
    process.stdout.write(`${text}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`耗时测量出错：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});

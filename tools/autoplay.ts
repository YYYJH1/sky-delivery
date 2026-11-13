// 自动购买脚本的命令行：把全部（玩法 × 订单种子）分给最多 16 个工作线程并行运行，
// 写出每局的原始数据（runs.jsonl，一局一行）、节点时间表（nodes.csv）、汇总表（summary.md 和 summary.json）和运行信息（run_info.json）。
// 一局怎么玩见 autoplay-lib.ts 开头的说明，汇总的口径见 autoplay-summary.ts。
// 用法：npm run autoplay -- [--policies 列表] [--seeds 42-91] [--days 16] [--workers 16] [--out 目录] [--label 名称]
//       npm run autoplay -- --resummarize 目录     不重跑，用目录里的 runs.jsonl 重写汇总表
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
// 补丁必须在核心之前加载（核心在加载时就用内容表算出一些东西），所以它排在核心之前
import { PATCH_ENV, PATCH_TABLES, applyPatch } from './autoplay-patch.ts';
import { CONTENT_VERSION } from '../src/core/index.ts';
import { CLICK_DELAY, DECIDE_EVERY, DEFAULT_DAYS, NODE_INFO, POLICIES, POLICY_IDS, playGame, stepsToMinutes } from './autoplay-lib.ts';
import type { PolicyId, RunRecord } from './autoplay-lib.ts';
import { renderMarkdown, summarize } from './autoplay-summary.ts';
import { jsonReplacer, parseSeeds } from './headless-lib.ts';

export const MAX_WORKERS = 16; // 工作线程最多 16 个，不按核数无限开
export const DEFAULT_SEEDS = '42-91'; // 50 个订单种子
const DEFAULT_OUT = fileURLToPath(new URL('../out/autoplay/latest/', import.meta.url));

export interface Task {
  policy: PolicyId;
  seed: number;
  days: number;
  clickDelay: number;
}

// ---- 线程池 ----

interface Request {
  runId: number;
  id: number;
  task: Task;
}

type Reply = { runId: number; id: number; ok: true; record: RunRecord } | { runId: number; id: number; ok: false; error: string };

function workerMain(): void {
  const port = parentPort;
  if (!port) return;
  port.on('message', (request: Request) => {
    try {
      const { record } = playGame(request.task.policy, request.task.seed, { days: request.task.days, clickDelay: request.task.clickDelay });
      const reply: Reply = { runId: request.runId, id: request.id, ok: true, record };
      port.postMessage(reply);
    } catch (error) {
      const reply: Reply = { runId: request.runId, id: request.id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
      port.postMessage(reply);
    }
  });
}

export interface Pool {
  readonly size: number;
  /** 把任务分发给工作线程，按任务表的顺序返回记录。有一个任务出错就整体报错。 */
  run(tasks: readonly Task[], onProgress?: (done: number) => void): Promise<RunRecord[]>;
  close(): Promise<void>;
}

export function createPool(size: number): Pool {
  if (!Number.isInteger(size) || size < 1 || size > MAX_WORKERS) throw new RangeError(`workers must be 1 to ${MAX_WORKERS}`);
  const workers = Array.from({ length: size }, () => new Worker(new URL(import.meta.url), { execArgv: ['--disable-warning=ExperimentalWarning'] }));
  let runCount = 0;

  function run(tasks: readonly Task[], onProgress?: (done: number) => void): Promise<RunRecord[]> {
    return new Promise((resolve, reject) => {
      if (tasks.length === 0) {
        resolve([]);
        return;
      }
      const runId = ++runCount;
      const results = new Array<RunRecord>(tasks.length);
      let next = 0;
      let done = 0;
      let settled = false;
      const detach: (() => void)[] = [];
      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        for (const off of detach) off();
        if (error) reject(error);
        else resolve(results);
      };
      const feed = (worker: Worker): void => {
        if (next >= tasks.length) return;
        const id = next++;
        const request: Request = { runId, id, task: tasks[id] as Task };
        worker.postMessage(request);
      };
      for (const worker of workers) {
        const onMessage = (reply: Reply): void => {
          if (settled || reply.runId !== runId) return;
          if (!reply.ok) {
            finish(new Error(`task ${reply.id} failed: ${reply.error}`));
            return;
          }
          results[reply.id] = reply.record;
          done++;
          onProgress?.(done);
          if (done === tasks.length) finish(null);
          else feed(worker);
        };
        const onError = (error: Error): void => finish(error);
        const onExit = (code: number): void => finish(new Error(`a worker exited with code ${code}`));
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        detach.push(() => {
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        });
        feed(worker);
      }
    });
  }

  return {
    size,
    run,
    async close() {
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

// ---- 输出 ----

/** 每局一行的节点表：节点时间（分钟，没有发生留空）、最长的间隔和攒钱（游戏日）、局末状态。 */
export function nodesCsv(records: readonly RunRecord[]): string {
  const header = ['policy', 'seed', ...NODE_INFO.map((n) => n.id), 'maxGapDays', 'maxSavingDays', 'purchases', 'cardChanges', 'finalMoney', 'finalStars', 'stations', 'drones', 'bays'];
  const lines = records.map((r) => {
    const cells = [
      r.policy,
      String(r.seed),
      ...NODE_INFO.map((n) => {
        const v = r.nodes[n.id];
        return v === null ? '' : String(Math.round(stepsToMinutes(v) * 1000) / 1000);
      }),
      (r.maxGap / 3600).toFixed(3),
      (r.maxSaving / 3600).toFixed(3),
      String(r.purchases.length),
      String(r.cardChanges),
      r.final.money.toFixed(1),
      r.final.stars.join('/'),
      String(r.final.stations),
      String(r.final.drones),
      String(r.final.bays),
    ];
    return cells.join(',');
  });
  return [header.join(','), ...lines].join('\n') + '\n';
}

export function runsJsonl(records: readonly RunRecord[]): string {
  return records.map((r) => JSON.stringify(r, jsonReplacer)).join('\n') + '\n';
}

export function parseRunsJsonl(text: string): RunRecord[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunRecord);
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const OPTIONS = {
  policies: { type: 'string' },
  seeds: { type: 'string' },
  days: { type: 'string' },
  workers: { type: 'string' },
  out: { type: 'string' },
  label: { type: 'string' },
  'click-delay': { type: 'string' },
  patch: { type: 'string' },
  resummarize: { type: 'string' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

const HELP = `用法：npm run autoplay -- [选项]

  --policies <列表>   玩法，逗号分隔，默认全部：${POLICY_IDS.join(',')}
  --seeds <列表>      订单种子，如 42-91 或 42,43（默认 ${DEFAULT_SEEDS}，50 个）
  --days <n>          每局的游戏日数（默认 ${DEFAULT_DAYS}，设计要求至少 12）
  --workers <n>       工作线程数，最多 ${MAX_WORKERS}（默认 ${MAX_WORKERS}，不超过机器的核数）
  --out <目录>        输出目录（默认 out/autoplay/latest）
  --label <名称>      汇总表的标题（默认取目录名）
  --click-delay <步>  开局订单出现之后脚本隔多少步点击（默认 ${CLICK_DELAY}，即 1 秒）
  --patch <文件或 JSON>  试数值：把一份补丁合并进内容表再运行，不改任何文件，补丁会记进 run_info.json。
                      写法见 tools/autoplay-patch.ts，例如 '{"economy":{"districtOpenPrice":[0,300,1600]}}'
  --resummarize <目录>  不重跑，读目录里的 runs.jsonl，重写 nodes.csv、summary.md 和 summary.json
  --quiet             不打印汇总表
  --help              显示本说明

玩法：${POLICY_IDS.map((id) => `${id}（${POLICIES[id].name}）`).join('，')}。
每局每隔 ${DECIDE_EVERY} 步（1 秒）做一次决定。同一个订单种子和同一种玩法的结果逐位相同。
`;

function toInt(name: string, text: string | undefined, fallback: number, min: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (text.trim() === '' || !Number.isInteger(n) || n < min) throw new RangeError(`--${name} must be an integer >= ${min}, got "${text}"`);
  return n;
}

function parsePolicies(text: string | undefined): PolicyId[] {
  if (text === undefined) return [...POLICY_IDS];
  const ids = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const id of ids) if (!(POLICY_IDS as readonly string[]).includes(id)) throw new RangeError(`unknown policy "${id}"`);
  return ids as PolicyId[];
}

/** --patch 的值：以 { 开头就是 JSON 文本，否则是文件路径。 */
function loadPatch(text: string | undefined): unknown {
  if (text === undefined) return null;
  const raw = text.trim().startsWith('{') ? text : readFileSync(text, 'utf8');
  return JSON.parse(raw) as unknown;
}

function baseName(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? dir;
}

function writeSummaries(dir: string, records: RunRecord[], label: string, quiet: boolean): void {
  writeFileSync(`${dir}/nodes.csv`, nodesCsv(records));
  const summary = summarize(records, label);
  writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, jsonReplacer, 2) + '\n');
  const markdown = renderMarkdown(summary);
  writeFileSync(`${dir}/summary.md`, markdown);
  if (!quiet) process.stdout.write('\n' + markdown);
}

async function main(): Promise<void> {
  const values = parseArgs({ options: OPTIONS, strict: true }).values;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.resummarize !== undefined) {
    const dir = values.resummarize.replace(/\/+$/, '');
    const records = parseRunsJsonl(readFileSync(`${dir}/runs.jsonl`, 'utf8'));
    writeSummaries(dir, records, values.label ?? baseName(dir), values.quiet === true);
    return;
  }

  const policies = parsePolicies(values.policies);
  const seeds = parseSeeds(values.seeds ?? DEFAULT_SEEDS);
  const days = toInt('days', values.days, DEFAULT_DAYS, 1);
  const clickDelay = toInt('click-delay', values['click-delay'], CLICK_DELAY, 0);
  const workers = Math.min(toInt('workers', values.workers, MAX_WORKERS, 1), MAX_WORKERS, Math.max(1, cpus().length));
  const out = (values.out ?? DEFAULT_OUT).replace(/\/+$/, '');
  const patch = loadPatch(values.patch);
  if (patch !== null) {
    applyPatch(structuredClone(PATCH_TABLES), patch); // 先在副本上试一遍，补丁写错时在这里报错，不等到工作线程里
    process.env[PATCH_ENV] = JSON.stringify(patch); // 工作线程创建时带上，在核心加载之前合并
  }
  mkdirSync(out, { recursive: true });

  const tasks: Task[] = [];
  for (const policy of policies) for (const seed of seeds) tasks.push({ policy, seed, days, clickDelay });
  const t0 = performance.now();
  const startedAt = new Date();
  const log = (message: string): void => {
    process.stdout.write(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${message}\n`);
  };
  log(`pid ${process.pid}，工作线程 ${workers}，${policies.length} 种玩法 × ${seeds.length} 个种子 = ${tasks.length} 局，每局 ${days} 天`);

  const pool = createPool(workers);
  let records: RunRecord[];
  try {
    const every = Math.max(1, Math.floor(tasks.length / 10));
    records = await pool.run(tasks, (done) => {
      if (done % every === 0 || done === tasks.length) log(`运行 ${done}/${tasks.length}`);
    });
  } finally {
    await pool.close();
  }
  const wallMs = performance.now() - t0;

  writeFileSync(`${out}/runs.jsonl`, runsJsonl(records));
  writeSummaries(out, records, values.label ?? baseName(out), values.quiet === true);

  const dirty = git(['status', '--porcelain', '--untracked-files=no'])
    .split('\n')
    .filter((l) => l !== '' && !l.includes('/results/'));
  const info = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    uncommittedTrackedFiles: dirty,
    node: process.version,
    contentVersion: CONTENT_VERSION,
    patch, // 试数值的补丁，没有时为 null：有补丁时这批数据对应的内容表不是仓库里的那一份
    workers,
    settings: { policies, seeds, days, clickDelay, decideEvery: DECIDE_EVERY },
    runs: records.length,
    wallSeconds: Math.round(wallMs) / 1000,
    files: {
      'runs.jsonl': '每局一行：节点（步）、每天的记录、全部购买、过河单、局末状态、状态哈希',
      'nodes.csv': '每局一行：节点时间（分钟，没发生留空）、最长间隔和攒钱（游戏日）、局末状态',
      'summary.md / summary.json': '汇总表',
    },
  };
  writeFileSync(`${out}/run_info.json`, JSON.stringify(info, jsonReplacer, 2) + '\n');
  log(`已写出 ${out}，用时 ${(wallMs / 1000).toFixed(1)} 秒`);
}

// 入口模块才运行：主线程跑主流程，工作线程等任务。测试里导入本文件时不会触发
const entry = (import.meta as unknown as { main?: boolean }).main === true;
if (entry && isMainThread) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(2);
  });
} else if (entry) {
  workerMain();
}

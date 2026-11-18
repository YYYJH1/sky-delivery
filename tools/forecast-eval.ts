// 推演的方向核对：推演给出的方向对不对。
// 用法：nice -n 10 node --disable-warning=ExperimentalWarning tools/forecast-eval.ts [选项]
//
// 局面：均衡玩法的自动玩家，种子 42 到 47，第 6、10、16、22、30 天日结之后的状态，共 30 个（playGame 的 days 参数）。
// 选项：每个局面里能推演的选项，包括每座站起降口的下一级，双层货箱（没买过时），就近降落（没买过且已开放时买，买过时切换开关），
// 每座站买一架无人机（有空位时），每个已开放的策略栏里的每张别的卡（午晚分成两套之后，每套各算一个选项）。余额不够的也算。
// 真值：每个选项用 64 套订单序列（盐 1，序列与推演的不同）算出准时单数差的平均值和样本标准差。
// 推演：用 app/forecast.ts 的函数，盐 0。这里跑 32 套，前 16 套就是推演的结果，取前 8 套和前 32 套看序列数的影响。
// 统计范围：真值平均值的绝对值不小于半个标准差的选项（平均值为 0 的不算）。统计推演的平均值与真值方向相同的比例，以及推演的结论的分布。
//
// 一个局面是一个子进程，同时最多 --jobs 个（默认 7，加上本进程不超过 8 个）。结果写进 --out 目录：direction.txt 和 direction.json。
// 加 --report-only 时不重算，读 --out 目录里已有的 direction.json 重新出统计。
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { forecastBatch, signTestThreshold, summarizeForecast } from '../src/app/forecast.ts';
import type { ForecastDone } from '../src/app/forecast.ts';
import { CAMPAIGN_RULES_V1 } from '../src/content/rules_v1.ts';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { RULE_NAMES, quoteCommand, ruleOpen } from '../src/core/index.ts';
import type { Command, RuleColumn, SimState } from '../src/core/index.ts';
import { playGame } from './autoplay-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '..', 'out', 'forecast-eval');

const DEFAULT_SEEDS = [42, 43, 44, 45, 46, 47];
const DEFAULT_DAYS = [6, 10, 16, 22, 30];
/** 真值用的盐：序列与推演的（盐 0）不同。 */
const TRUTH_SALT = 1;
const TRUTH_SEQUENCES = 64;
/** 推演跑的序列数，前 16 套是推演本身，8 和 32 是对照。 */
const FORECAST_SEQUENCES = 32;
const PRIMARY = 16;
/** 统计范围：真值平均值不小于半个标准差。 */
const SCOPE_SD = 0.5;
const TARGET_RATE = 0.9;

// ---- 选项 ----

export type OptionKind = 'gate' | 'box' | 'nearest' | 'drone' | 'card';

export interface LabeledOption {
  kind: OptionKind;
  label: string;
  option: Command;
}

const COLUMNS: readonly RuleColumn[] = ['select', 'zone', 'pool'];
const COLUMN_NAMES: Readonly<Record<RuleColumn, string>> = { select: '调度策略', zone: '协同策略', pool: '合单策略' };
const PEAK_NAMES = { noon: '午高峰一套', evening: '晚高峰一套' } as const;

/** 现在这个局面里可以推演的选项。能买或只差钱的才算，条件不满足的不列。 */
export function listOptions(state: SimState): LabeledOption[] {
  const campaign = state.campaign;
  if (campaign === null) return [];
  const out: LabeledOption[] = [];
  const add = (kind: OptionKind, label: string, option: Command): void => {
    const quote = quoteCommand(state, option);
    if (quote.ok || quote.reason === 'notEnoughMoney') out.push({ kind, label, option });
  };
  const live = state.stations.filter((s) => !s.removed);
  for (const s of live) {
    const level = (campaign.stations[s.id] as { gateLevel: number }).gateLevel;
    if (level < ECONOMY_V1.gateSeconds.length) add('gate', `${s.id + 1} 号站起降口升到 ${level + 1} 级`, { type: 'upgradeGate', station: s.id });
  }
  if (state.capacity < ECONOMY_V1.doubleBoxCapacity) add('box', '双层货箱', { type: 'buyDoubleBox' });
  if (!campaign.nearestOwned) add('nearest', '就近降落（购买）', { type: 'buyNearestLanding' });
  else {
    const on = state.returnRule === 'nearest';
    add('nearest', `就近降落（${on ? '关闭' : '开启'}）`, { type: 'setNearestLanding', on: !on });
  }
  for (const s of live) add('drone', `${s.id + 1} 号站买一架无人机`, { type: 'buyDrone', station: s.id });
  const sets = campaign.ruleSets;
  for (const peak of sets === null ? [null] : (['noon', 'evening'] as const)) {
    for (const column of COLUMNS) {
      const current = peak === null || sets === null ? state.rules[column] : sets[peak][column];
      for (const id of CAMPAIGN_RULES_V1[column]) {
        if (id === current || !ruleOpen(state, column, id)) continue;
        const where = peak === null ? '' : `${PEAK_NAMES[peak]}，`;
        const command: Command = peak === null ? { type: 'setRules', rules: { [column]: id } } : { type: 'setRules', rules: { [column]: id }, peak };
        add('card', `${where}${COLUMN_NAMES[column]}换成${RULE_NAMES[id] ?? id}`, command);
      }
    }
  }
  return out;
}

// ---- 一个局面的结果 ----

interface OptionRow {
  kind: OptionKind;
  label: string;
  option: Command;
  price: number;
  /** 余额不够，推演时补足 */
  short: boolean;
  /** 真值：64 套序列上的准时单数差 */
  truth: number[];
  truthRevenue: number;
  /** 推演：32 套序列上的准时单数差和收入差，前 16 套是推演 */
  fc: number[];
  fcRevenue: number[];
}

interface StateRow {
  seed: number;
  day: number;
  step: number;
  stations: number;
  drones: number;
  orders: number;
  capacity: number;
  returnRule: string;
  split: boolean;
  rules: string;
  money: number;
  truthSeconds: number;
  forecastSeconds: number;
  options: OptionRow[];
}

function evaluateState(seed: number, day: number): StateRow {
  const { state } = playGame('balanced', seed, { days: day });
  const campaign = state.campaign;
  if (campaign === null) throw new Error('campaign state expected');
  const options = listOptions(state);
  const commands = options.map((o) => o.option);
  const t0 = performance.now();
  const truth = forecastBatch(state, commands, { sequences: TRUTH_SEQUENCES, salt: TRUTH_SALT });
  const t1 = performance.now();
  const fc = forecastBatch(state, commands, { sequences: FORECAST_SEQUENCES, salt: 0 });
  const t2 = performance.now();
  const rows: OptionRow[] = options.map((o, i) => {
    const t = truth[i];
    const f = fc[i];
    if (t === undefined || f === undefined || !t.ok || !f.ok) throw new Error(`option ${o.label} could not be forecast`);
    return {
      kind: o.kind,
      label: o.label,
      option: o.option,
      price: f.price,
      short: campaign.money < f.price,
      truth: t.onTimeDiffs,
      truthRevenue: t.meanRevenue,
      fc: f.onTimeDiffs,
      fcRevenue: f.revenueDiffs,
    };
  });
  const live = state.stations.filter((s) => !s.removed);
  return {
    seed,
    day,
    step: state.step,
    stations: live.length,
    drones: state.drones.filter((d) => !d.removed).length,
    orders: state.orders.length,
    capacity: state.capacity,
    returnRule: state.returnRule,
    split: campaign.ruleSets !== null,
    rules: JSON.stringify(state.rules),
    money: Math.round(campaign.money),
    truthSeconds: (t1 - t0) / 1000,
    forecastSeconds: (t2 - t1) / 1000,
    options: rows,
  };
}

// ---- 统计 ----

const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
/** 样本标准差，除以 n - 1。 */
const sd = (v: readonly number[]): number => {
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
};
const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

type Verdict = ForecastDone['verdict'];
const VERDICT_NAMES: Readonly<Record<Verdict, string>> = { better: '更好', worse: '更差', unclear: '差别不明显' };

interface Analysed {
  row: OptionRow;
  state: StateRow;
  mu: number;
  sigma: number;
  inScope: boolean;
  /** 序列数 8、16、32 时的推演 */
  at: Record<number, ForecastDone>;
  /** 推演的平均值与真值方向相同 */
  agree: Record<number, boolean>;
}

function analyse(state: StateRow, row: OptionRow): Analysed {
  const mu = mean(row.truth);
  const sigma = sd(row.truth);
  const inScope = mu !== 0 && Math.abs(mu) >= SCOPE_SD * sigma;
  const at: Record<number, ForecastDone> = {};
  const agree: Record<number, boolean> = {};
  for (const n of [8, PRIMARY, 32]) {
    const r = summarizeForecast(row.fc.slice(0, n), row.fcRevenue.slice(0, n), { startStep: state.step, endStep: 0, price: row.price });
    at[n] = r;
    agree[n] = sign(r.meanOnTime) === sign(mu) && mu !== 0;
  }
  return { row, state, mu, sigma, inScope, at, agree };
}

const pct = (a: number, b: number): string => (b === 0 ? '无' : `${((100 * a) / b).toFixed(1)}%`);
const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);

function verdictCounts(items: readonly Analysed[], n: number): Record<Verdict, number> {
  const out: Record<Verdict, number> = { better: 0, worse: 0, unclear: 0 };
  for (const a of items) out[(a.at[n] as ForecastDone).verdict] += 1;
  return out;
}

/** 与真值方向相反的明确结论：推演说更好而真值为负，或推演说更差而真值为正。 */
function wrongVerdicts(items: readonly Analysed[], n: number): number {
  let wrong = 0;
  for (const a of items) {
    const v = (a.at[n] as ForecastDone).verdict;
    if ((v === 'better' && a.mu < 0) || (v === 'worse' && a.mu > 0)) wrong += 1;
  }
  return wrong;
}

function report(states: readonly StateRow[]): string {
  const lines: string[] = [];
  const all: Analysed[] = [];
  for (const s of states) for (const o of s.options) all.push(analyse(s, o));
  const scope = all.filter((a) => a.inScope);
  const outside = all.filter((a) => !a.inScope);
  const degenerate = all.filter((a) => a.mu === 0).length;

  lines.push('## 总览');
  lines.push(`局面 ${states.length} 个，选项 ${all.length} 个，平均每个局面 ${f1(all.length / states.length)} 个。`);
  lines.push(`真值 ${TRUTH_SEQUENCES} 套序列（盐 ${TRUTH_SALT}），推演 ${FORECAST_SEQUENCES} 套序列的前 ${PRIMARY} 套（盐 0）。`);
  lines.push(`统计范围：真值平均值的绝对值不小于 ${SCOPE_SD} 个标准差，并且平均值不为 0。范围内 ${scope.length} 个，占 ${pct(scope.length, all.length)}。范围外 ${outside.length} 个，其中真值平均值恰为 0 的 ${degenerate} 个。`);
  lines.push('');

  lines.push('## 方向（范围内的选项，推演的平均值与真值的平均值同号）');
  lines.push('序列数  方向一致  比例     目标 ≥ 90%  平均值恰为 0');
  for (const n of [8, PRIMARY, 32]) {
    const ok = scope.filter((a) => a.agree[n]).length;
    const zero = scope.filter((a) => (a.at[n] as ForecastDone).meanOnTime === 0).length;
    lines.push(`${String(n).padStart(4)}    ${String(ok).padStart(4)} / ${scope.length}   ${pct(ok, scope.length).padStart(6)}   ${ok >= TARGET_RATE * scope.length ? '达到' : '未达到'}      ${zero}`);
  }
  lines.push('');

  lines.push(`## 结论的分布（${PRIMARY} 套）`);
  const header = '                         更好   更差   差别不明显   与真值方向相反的明确结论';
  lines.push(header);
  const printCounts = (name: string, items: readonly Analysed[], n = PRIMARY): void => {
    const c = verdictCounts(items, n);
    lines.push(`${name.padEnd(20, '　')}${String(c.better).padStart(6)} ${String(c.worse).padStart(6)} ${String(c.unclear).padStart(10)}     ${wrongVerdicts(items, n)}`);
  };
  printCounts('范围内', scope);
  printCounts('　其中真值为正', scope.filter((a) => a.mu > 0));
  printCounts('　其中真值为负', scope.filter((a) => a.mu < 0));
  printCounts('范围外', outside);
  printCounts('全部', all);
  lines.push('');

  lines.push('## 序列数 8、16、32 的结论分布（范围内）');
  lines.push('序列数  门槛  更好   更差   差别不明显   与真值方向相反的明确结论');
  for (const n of [8, PRIMARY, 32]) {
    const c = verdictCounts(scope, n);
    lines.push(`${String(n).padStart(4)}    ${String(signTestThreshold(n)).padStart(4)}  ${String(c.better).padStart(5)} ${String(c.worse).padStart(6)} ${String(c.unclear).padStart(10)}     ${wrongVerdicts(scope, n)}`);
  }
  lines.push('');

  lines.push('## 分类（16 套，范围内）');
  lines.push('类型          范围内 / 全部   方向一致   更好 更差 差别不明显');
  const kinds: [OptionKind, string][] = [['gate', '起降口升级'], ['box', '双层货箱'], ['nearest', '就近降落'], ['drone', '买无人机'], ['card', '策略卡']];
  for (const [kind, name] of kinds) {
    const items = all.filter((a) => a.row.kind === kind);
    const inside = items.filter((a) => a.inScope);
    const c = verdictCounts(inside, PRIMARY);
    lines.push(`${name.padEnd(8, '　')}${String(inside.length).padStart(6)} / ${String(items.length).padEnd(5)}${String(inside.filter((a) => a.agree[PRIMARY]).length).padStart(6)} / ${String(inside.length).padEnd(4)} ${String(c.better).padStart(5)} ${String(c.worse).padStart(4)} ${String(c.unclear).padStart(8)}`);
  }
  lines.push('');

  lines.push('## 按效果大小分（16 套，范围内，效果大小是真值平均值的绝对值除以标准差）');
  lines.push('效果大小        选项数  方向一致   更好 更差 差别不明显');
  const bins: [string, number, number][] = [['0.5 到 1', 0.5, 1], ['1 到 2', 1, 2], ['2 以上', 2, Infinity]];
  for (const [name, lo, hi] of bins) {
    const items = scope.filter((a) => {
      const size = Math.abs(a.mu) / a.sigma;
      return size >= lo && size < hi;
    });
    const c = verdictCounts(items, PRIMARY);
    lines.push(`${name.padEnd(10, '　')}${String(items.length).padStart(6)}   ${String(items.filter((a) => a.agree[PRIMARY]).length).padStart(5)} / ${String(items.length).padEnd(4)}${String(c.better).padStart(5)} ${String(c.worse).padStart(4)} ${String(c.unclear).padStart(8)}`);
  }
  lines.push('');

  lines.push('## 分局面（16 套，范围内）');
  lines.push('第几天  选项数  范围内  方向一致');
  for (const day of [...new Set(states.map((s) => s.day))].sort((a, b) => a - b)) {
    const items = all.filter((a) => a.state.day === day);
    const inside = items.filter((a) => a.inScope);
    lines.push(`${String(day).padStart(4)}    ${String(items.length).padStart(5)}   ${String(inside.length).padStart(5)}   ${inside.filter((a) => a.agree[PRIMARY]).length} / ${inside.length}`);
  }
  lines.push('');

  lines.push('## 方向不一致的选项（16 套，范围内）');
  const wrong = scope.filter((a) => !a.agree[PRIMARY]);
  if (wrong.length === 0) lines.push('无');
  for (const a of wrong) {
    const r = a.at[PRIMARY] as ForecastDone;
    lines.push(`种子 ${a.state.seed} 第 ${a.state.day} 天 ${a.row.label}：真值 ${f2(a.mu)} ± ${f2(a.sigma)}（${f2(Math.abs(a.mu) / a.sigma)} 个标准差），推演 ${f2(r.meanOnTime)}，更好 ${r.better} 更差 ${r.worse} 持平 ${r.tied}，${VERDICT_NAMES[r.verdict]}`);
  }
  lines.push('');

  lines.push('## 明确结论与真值方向相反的选项（16 套，全部选项）');
  const contradicted = all.filter((a) => {
    const v = (a.at[PRIMARY] as ForecastDone).verdict;
    return (v === 'better' && a.mu < 0) || (v === 'worse' && a.mu > 0);
  });
  if (contradicted.length === 0) lines.push('无');
  for (const a of contradicted) {
    const r = a.at[PRIMARY] as ForecastDone;
    lines.push(`种子 ${a.state.seed} 第 ${a.state.day} 天 ${a.row.label}：真值 ${f2(a.mu)} ± ${f2(a.sigma)}（${f2(Math.abs(a.mu) / a.sigma)} 个标准差，${a.inScope ? '范围内' : '范围外'}），推演 ${f2(r.meanOnTime)}，更好 ${r.better} 更差 ${r.worse} 持平 ${r.tied}，${VERDICT_NAMES[r.verdict]}`);
  }
  return lines.join('\n');
}

function rawText(states: readonly StateRow[]): string {
  const lines: string[] = [];
  lines.push('# 推演的方向核对：原始输出');
  lines.push(`局面：均衡玩法，种子 ${[...new Set(states.map((s) => s.seed))].join('、')}，第 ${[...new Set(states.map((s) => s.day))].join('、')} 天日结之后。真值 ${TRUTH_SEQUENCES} 套序列（盐 ${TRUTH_SALT}），推演 ${PRIMARY} 套序列（盐 0）。`);
  lines.push('每个选项一行：价格，真值（准时单数差的平均值 ± 样本标准差，平均值是标准差的几倍，收入差的平均值），范围，推演（准时单数差的平均值，更好、更差、持平的套数，结论，收入差的平均值），方向。');
  lines.push('范围：真值平均值的绝对值不小于半个标准差。方向：推演的平均值与真值的平均值同号。余额不够的选项标 * 号，推演时余额补足。');
  lines.push('');
  for (const s of states) {
    lines.push(`== 种子 ${s.seed}，第 ${s.day} 天日结之后（step ${s.step}）`);
    lines.push(`站点 ${s.stations}，无人机 ${s.drones}，订单 ${s.orders}，载量 ${s.capacity}，飞完回哪 ${s.returnRule}，余额 ¥${s.money}，策略 ${s.rules}，${s.split ? '午晚分成两套' : '只有一套'}。真值用时 ${f1(s.truthSeconds)} 秒，推演用时 ${f1(s.forecastSeconds)} 秒（${FORECAST_SEQUENCES} 套）。`);
    for (const o of s.options) {
      const a = analyse(s, o);
      const r = a.at[PRIMARY] as ForecastDone;
      const price = `${o.short ? '*' : ' '}¥${o.price}`;
      lines.push(
        `${o.label.padEnd(24, '　')} ${price.padStart(7)}  真值 ${f2(a.mu).padStart(6)} ± ${f2(a.sigma).padStart(5)} (${f2(a.sigma === 0 ? 0 : a.mu / a.sigma).padStart(5)}σ) 收入 ${f1(o.truthRevenue).padStart(6)}  ${a.inScope ? '范围内' : '范围外'}  推演 ${f2(r.meanOnTime).padStart(6)} 更好 ${String(r.better).padStart(2)} 更差 ${String(r.worse).padStart(2)} 持平 ${String(r.tied).padStart(2)} ${VERDICT_NAMES[r.verdict].padEnd(5, '　')} 收入 ${f1(r.meanRevenue).padStart(6)}  ${a.inScope ? (a.agree[PRIMARY] ? '方向一致' : '方向不一致') : '-'}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---- 子进程和调度 ----

function runChild(script: string, seed: number, day: number): Promise<StateRow> {
  return new Promise((resolveJob, rejectJob) => {
    const child = spawn(process.execPath, [...process.execArgv, script, '--child', '--seeds', String(seed), '--days', String(day)], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '' },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once('error', rejectJob);
    child.once('exit', (code) => {
      if (code !== 0) {
        rejectJob(new Error(`子进程失败：种子 ${seed} 第 ${day} 天，退出码 ${String(code)}`));
        return;
      }
      resolveJob(JSON.parse(out) as StateRow);
    });
  });
}

async function runAll(seeds: readonly number[], days: readonly number[], jobs: number): Promise<StateRow[]> {
  const script = fileURLToPath(import.meta.url);
  // 天数大的局面更慢，先派
  const queue = days.flatMap((day) => seeds.map((seed) => ({ seed, day }))).sort((a, b) => b.day - a.day || a.seed - b.seed);
  const results: StateRow[] = [];
  const started = performance.now();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue[next++];
      if (job === undefined) return;
      const row = await runChild(script, job.seed, job.day);
      results.push(row);
      process.stderr.write(`完成 种子 ${job.seed} 第 ${job.day} 天，选项 ${row.options.length} 个，用时 ${f1((performance.now() - started) / 1000)} 秒（累计）\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  return results.sort((a, b) => a.seed - b.seed || a.day - b.day);
}

function numbers(text: string | undefined, fallback: readonly number[]): number[] {
  if (text === undefined) return [...fallback];
  return text.split(',').map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n)) throw new Error(`不是整数：${x}`);
    return n;
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { seeds: { type: 'string' }, days: { type: 'string' }, jobs: { type: 'string' }, out: { type: 'string' }, child: { type: 'boolean' }, 'report-only': { type: 'boolean' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help) {
    process.stdout.write('用法：nice -n 10 node --disable-warning=ExperimentalWarning tools/forecast-eval.ts [--seeds 42,43] [--days 6,30] [--jobs 7] [--out 目录] [--report-only]\n');
    return;
  }
  const seeds = numbers(values.seeds, DEFAULT_SEEDS);
  const days = numbers(values.days, DEFAULT_DAYS);
  if (values.child === true) {
    // 子进程：一个局面，结果以 JSON 写到标准输出
    process.stdout.write(JSON.stringify(evaluateState(seeds[0] as number, days[0] as number)));
    return;
  }
  const jobs = Number(values.jobs ?? '7');
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 7) throw new Error('--jobs 取 1 到 7，加上本进程不超过 8 个进程');
  const out = resolve(values.out ?? DEFAULT_OUT);
  // --report-only：不重算，读已有的 direction.json 重新出统计
  const rows = values['report-only'] === true ? (JSON.parse(readFileSync(join(out, 'direction.json'), 'utf8')) as StateRow[]) : await runAll(seeds, days, jobs);
  const text = `${rawText(rows)}\n# 统计\n\n${report(rows)}\n`;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'direction.txt'), text);
  writeFileSync(join(out, 'direction.json'), JSON.stringify(rows));
  process.stdout.write(`${report(rows)}\n\n已写入 ${join(out, 'direction.txt')}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`推演核对出错：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

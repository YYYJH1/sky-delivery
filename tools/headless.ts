// 无头脚本：运行指定的游戏日数，打印统计表，可选写出 JSON。
// 用法：npm run headless -- --scenario threeDistricts --drones 16 --rate 68 --select deadline --zone strict
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_CONFIG,
  DISTRICT_NAMES,
  LAYOUTS,
  RULE_NAMES,
  SCENARIOS,
  averageMetrics,
  makeConfig,
  peakSummary,
  ruleIds,
  runDays,
  runMetrics,
} from '../src/core/index.ts';
import type { ConfigOverrides, MeanMetrics, PeakName, PeakSummary } from '../src/core/index.ts';
import { average, fixed, formatTable, jsonReplacer, parseSeeds, percent } from './headless-lib.ts';

const HELP = `用法：npm run headless -- [选项]

  --scenario <名称>   ${SCENARIOS.join(' | ')}（默认 ${DEFAULT_CONFIG.scenario}）
  --layout <名称>     ${LAYOUTS.join(' | ')}（默认 ${DEFAULT_CONFIG.layout}）
  --drones <n>        飞机数（默认 ${DEFAULT_CONFIG.drones}）
  --rate <x>          高峰每分钟订单数（默认 ${DEFAULT_CONFIG.peakRate}）
  --select <规则>     调度策略：${ruleIds('select').join(' | ')}（默认 ${DEFAULT_CONFIG.rules.select}）
  --zone <规则>       协同策略：${ruleIds('zone').join(' | ')}（默认 ${DEFAULT_CONFIG.rules.zone}）
  --pool <规则>       合单策略：${ruleIds('pool').join(' | ')}（默认 ${DEFAULT_CONFIG.rules.pool}）
  --capacity <n>      载量，一趟最多装几份，大单占 2 份（默认 ${DEFAULT_CONFIG.capacity}，要一起送需要 2 以上）
  --gate <秒>         起降口两次动作开始之间的最小间隔（默认 ${DEFAULT_CONFIG.gateInterval}）
  --days <n>          游戏日数（默认 3）
  --seeds <列表>      订单种子，如 42-46 或 42,43,44（默认 42-46）
  --map-seed <n>      地图种子（默认 ${DEFAULT_CONFIG.mapSeed}）
  --extra-bays <n>    每座站多出的停机位（默认 ${DEFAULT_CONFIG.extraBays}）
  --json <路径>       把全部结果写成 JSON 文件
  --detail            再打印高峰小结和运行指标两张表
  --help              显示本说明

指标取第 2 天起的平均（只有一天时取第 1 天）。每个种子最后多跑 240 秒不再来单的时间，让每张订单都有结局。
`;

const OPTIONS = {
  scenario: { type: 'string' },
  layout: { type: 'string' },
  drones: { type: 'string' },
  rate: { type: 'string' },
  select: { type: 'string' },
  zone: { type: 'string' },
  pool: { type: 'string' },
  capacity: { type: 'string' },
  gate: { type: 'string' },
  days: { type: 'string' },
  seeds: { type: 'string' },
  'map-seed': { type: 'string' },
  'extra-bays': { type: 'string' },
  json: { type: 'string' },
  detail: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; strict: true }>>['values'];

function toNumber(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) throw new RangeError(`--${name} must be a number, got "${text}"`);
  return n;
}

function build(values: Values): { base: ConfigOverrides; days: number; seeds: number[] } {
  const base: ConfigOverrides = {
    scenario: (values.scenario ?? DEFAULT_CONFIG.scenario) as ConfigOverrides['scenario'],
    layout: (values.layout ?? DEFAULT_CONFIG.layout) as ConfigOverrides['layout'],
    drones: toNumber('drones', values.drones, DEFAULT_CONFIG.drones),
    peakRate: toNumber('rate', values.rate, DEFAULT_CONFIG.peakRate),
    gateInterval: toNumber('gate', values.gate, DEFAULT_CONFIG.gateInterval),
    mapSeed: toNumber('map-seed', values['map-seed'], DEFAULT_CONFIG.mapSeed),
    extraBays: toNumber('extra-bays', values['extra-bays'], DEFAULT_CONFIG.extraBays),
    capacity: toNumber('capacity', values.capacity, DEFAULT_CONFIG.capacity),
    rules: {
      select: values.select ?? DEFAULT_CONFIG.rules.select,
      zone: values.zone ?? DEFAULT_CONFIG.rules.zone,
      pool: values.pool ?? DEFAULT_CONFIG.rules.pool,
    },
  };
  makeConfig(base); // 提前检查取值，错误信息比运行中途报错清楚
  const days = toNumber('days', values.days, 3);
  if (!Number.isInteger(days) || days < 1) throw new RangeError('--days must be a positive integer');
  return { base, days, seeds: parseSeeds(values.seeds ?? '42-46') };
}

interface SeedResult {
  seed: number;
  mean: MeanMetrics;
  daily: ReturnType<typeof runMetrics>['daily'];
  summaries: { noon: PeakSummary[]; evening: PeakSummary[] };
}

function summariesFor(state: ReturnType<typeof runDays>, days: number, peak: PeakName): PeakSummary[] {
  const from = days > 1 ? 1 : 0;
  return Array.from({ length: days - from }, (_, i) => peakSummary(state, from + i, peak));
}

function run(base: ConfigOverrides, days: number, seeds: number[]): SeedResult[] {
  return seeds.map((seed) => {
    const state = runDays({ ...base, seed }, days);
    const { daily, mean } = runMetrics(state, days);
    return {
      seed,
      mean,
      daily,
      summaries: { noon: summariesFor(state, days, 'noon'), evening: summariesFor(state, days, 'evening') },
    };
  });
}

// ---- 表格 ----
const DISTRICTS = DISTRICT_NAMES.length;

function withMean(rows: string[][], meanRow: string[]): string[][] {
  return [...rows, meanRow];
}

function mainRow(label: string, m: MeanMetrics): string[] {
  const districts = Array.from({ length: DISTRICTS }, (_, k) => percent(m.day.districts[k]?.onTimeRate ?? Number.NaN));
  return [
    label,
    fixed(m.day.nOrders),
    percent(m.day.onTimeRate),
    percent(m.noon.onTimeRate),
    percent(m.evening.onTimeRate),
    percent(m.day.cancelRate),
    percent(m.noon.cancelRate),
    percent(m.evening.cancelRate),
    fixed(m.day.revenue),
    fixed(m.day.durMean),
    fixed(m.day.distPerOrder, 0),
    ...districts,
  ];
}

const MAIN_HEADERS = [
  '种子',
  '日均单数',
  '准时%全天',
  '准时%午',
  '准时%晚',
  '退单%全天',
  '退单%午',
  '退单%晚',
  '收入',
  '送达均时s',
  '每单飞行距离',
  ...DISTRICT_NAMES.map((n) => `准时%${n}`),
];

function perStation(values: number[], digits: number, asPercent = false): string {
  return values.map((v) => (asPercent ? percent(v) : fixed(v, digits))).join('/');
}

function runtimeRow(label: string, m: MeanMetrics): string[] {
  const s = m.day.segments;
  return [
    label,
    fixed(s.waitDrone),
    fixed(s.waitGate),
    fixed(s.waitPrep),
    fixed(s.road),
    fixed(m.day.nEarly),
    perStation(m.day.stations.map((x) => x.landWaitAvg), 3),
    perStation(m.day.stations.map((x) => x.bayEmptyShare), 1, true),
    percent(m.day.nonNearestRate),
    percent(m.day.emptyShare),
    percent(m.day.sharedRate),
  ];
}

const RUNTIME_HEADERS = [
  '种子',
  '等飞机s',
  '等起降s',
  '等出餐s',
  '路上s',
  '提前派出/天',
  '等降落架数(各站)',
  '空停机位%(各站)',
  '非最近站%',
  '空飞%',
  '同乘%',
];

type SummaryField = (s: PeakSummary) => number;
const SUMMARY_FIELDS: [string, SummaryField][] = [
  ['来单', (s) => s.nOrders],
  ['准时', (s) => s.nOnTime],
  ['超时', (s) => s.nLate],
  ['未送到', (s) => s.nLateOpen],
  ['退单', (s) => s.nCancelled],
  ['进账', (s) => s.revenue],
  ['提前派出', (s) => s.early.count ?? Number.NaN],
];

function summaryRow(label: string, perPeak: PeakSummary[][]): string[] {
  const cells: string[] = [label];
  for (const list of perPeak) {
    for (const [, get] of SUMMARY_FIELDS) cells.push(fixed(average(list.map(get))));
  }
  return cells;
}

const SUMMARY_HEADERS = [
  '种子',
  ...['午', '晚'].flatMap((p) => SUMMARY_FIELDS.map(([name]) => `${p}${name}`)),
];

function describeRun(base: ConfigOverrides, days: number, seeds: number[]): string {
  const cfg = makeConfig(base);
  const rule = (id: string): string => `${RULE_NAMES[id] ?? id}(${id})`;
  return [
    `场景 ${cfg.scenario} · 布局 ${cfg.layout} · 飞机 ${cfg.drones} · 高峰 ${cfg.peakRate} 单/分钟`,
    `调度策略 ${rule(cfg.rules.select)} · 协同策略 ${rule(cfg.rules.zone)} · 合单策略 ${rule(cfg.rules.pool)} · 载量 ${cfg.capacity} · 起降间隔 ${cfg.gateInterval} 秒`,
    `${days} 天 · 地图种子 ${cfg.mapSeed} · 种子 ${seeds.join(',')} · 指标取第 ${days > 1 ? '2' : '1'} 天起的平均`,
  ].join('\n');
}

function main(): void {
  const values = parseArgs({ options: OPTIONS, strict: true }).values;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const started = performance.now();
  const { base, days, seeds } = build(values);
  const results = run(base, days, seeds);
  const mean = averageMetrics(results.map((r) => r.mean));

  const out: string[] = [describeRun(base, days, seeds), ''];
  out.push(formatTable(MAIN_HEADERS, withMean(results.map((r) => mainRow(String(r.seed), r.mean)), mainRow('均值', mean))));
  if (values.detail) {
    out.push('', '运行指标（全天）', '');
    out.push(formatTable(RUNTIME_HEADERS, withMean(results.map((r) => runtimeRow(String(r.seed), r.mean)), runtimeRow('均值', mean))));
    out.push('', '高峰小结（高峰结束 30 秒时的状态，超时含尚未送到的）', '');
    const summaryRows = results.map((r) => summaryRow(String(r.seed), [r.summaries.noon, r.summaries.evening]));
    const meanSummary = summaryRow('均值', [
      results.flatMap((r) => r.summaries.noon),
      results.flatMap((r) => r.summaries.evening),
    ]);
    out.push(formatTable(SUMMARY_HEADERS, withMean(summaryRows, meanSummary)));
  }
  out.push('', `用时 ${(performance.now() - started).toFixed(0)} 毫秒`);
  process.stdout.write(out.join('\n') + '\n');

  if (values.json) {
    const file = values.json;
    mkdirSync(dirname(file), { recursive: true });
    const body = { config: makeConfig(base), days, seeds, mean, perSeed: results };
    writeFileSync(file, JSON.stringify(body, jsonReplacer, 2) + '\n');
    process.stdout.write(`已写出 ${file}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

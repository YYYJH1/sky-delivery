// 经营模式的无头脚本：从开局运行若干游戏日，每天结束时打印来单、准时、超时、退单、进账、余额，以及各站的飞机数和停机位数。
// 每天结束时另外打印日结的结果：各片区的星级和最近两天的准时率、退单率，当天开放了什么，当天出现的便签，两场小结的主句和附加句。
// 可以给一个命令表（JSON 数组），在指定的步执行命令。开局的五张订单由脚本自动点击。
// 用法：npm run campaign -- --days 3 --seeds 42-51
//       npm run campaign -- --days 3 --commands 命令表.json --json 结果.json
//
// 命令表的写法：[{ "at": 3600, "command": { "type": "buyDrone", "station": 0 } }, ...]
// at 是执行命令的步（一个游戏日 3600 步，在这一步开始之前执行）。同一步的命令按表里的先后执行。
// command 的类型见 src/core/campaign/commands.ts 的 Command。命令失败时只打印原因，不中止运行。
// 想表达「有钱就买」时加 every 和 times：从 at 起每隔 every 步试一次，成功 times 次（缺省 1 次）为止，
// 例如 { "at": 3600, "every": 20, "times": 2, "command": { "type": "buyBay", "station": 0 } }。
// 连续失败的原因相同时只打印一行，写明次数。价签还没开放等原因导致的失败照常打印原因。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DAY_STEPS, PROMISE_STEPS, UNLOCK_KEYS, applyCommand, createState, makeConfig, quoteCommand, step } from '../src/core/index.ts';
import type { Command, CommandResult, ConfigOverrides, DayRecord, PeakRecord, PriceKind, SimState } from '../src/core/index.ts';
import { fixed, formatTable, jsonReplacer, parseSeeds } from './headless-lib.ts';

const HELP = `用法：npm run campaign -- [选项]

  --days <n>            运行的游戏日数（默认 3）
  --seeds <列表>        订单种子，如 42-51 或 42,43（默认 42）
  --commands <路径>     命令表（JSON），在指定的步执行命令
  --click-delay <步>    开局订单出现之后，脚本隔多少步点击它（默认 10，即 1 秒）
  --select <规则>       开局的「调度策略」（默认沿用配置）
  --zone <规则>         开局的「协同策略」
  --pool <规则>         开局的「合单策略」
  --json <路径>         把全部结果写成 JSON 文件
  --quiet               只打印汇总表，不打印每个种子的逐日表
  --help                显示本说明

每天的统计口径：来单是当天下的单。准时、超时、退单按结果产生的那一天算（与日结相同），准时指承诺时间内送达。
进账是当天送达的订单的进账合计，余额是当天最后一步结束时的余额。没有命令表时全程不买任何东西。
每个种子的逐日表之后还有日结之后的情况：各片区的星级和最近两天的准时率、退单率，当天开放了什么（名称@步），当天出现的便签，
两场高峰小结的主句和附加句的编号。日结在第二天的第 0 步做，归在它结束的那一天。
命令表里的条目可以加 every 和 times：从 at 起每隔 every 步试一次，成功 times 次（缺省 1 次）为止，用来写「有钱就买」。
连续失败的原因相同时合成一行，写明次数。价签还没开放等原因导致的失败都会打印原因。
`;

const OPTIONS = {
  days: { type: 'string' },
  seeds: { type: 'string' },
  commands: { type: 'string' },
  'click-delay': { type: 'string' },
  select: { type: 'string' },
  zone: { type: 'string' },
  pool: { type: 'string' },
  json: { type: 'string' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

interface ScheduledCommand {
  at: number;
  command: Command;
  every?: number; // 失败或还没做够时，隔多少步再试一次
  times?: number; // 要成功几次，缺省 1 次，只在写了 every 时起作用
}

interface StationRow {
  id: number;
  drones: number;
  bays: number;
  gateLevel: number;
}

export interface DayRow {
  day: number; // 从 1 数起
  orders: number; // 当天下的单
  onTime: number;
  late: number;
  cancelled: number;
  income: number;
  balance: number;
  stations: StationRow[];
}

export interface CommandLog {
  at: number; // 执行的步
  command: Command;
  result: CommandResult;
  kind: PriceKind; // 执行之前价签上的类型和价格：买、退回或不收费
  price: number;
  count?: number; // 重试时连续失败的原因相同，合并成一条：一共试了几次
  lastAt?: number; // 以及最后一次试的步
}

/** 一个游戏日结束时的情况。day 从 1 数起，数据取自这一天的日结和这一天里发生的事。 */
export interface DayReport {
  day: number;
  /** 日结之后各开通的片区：星级，最近两天完成的订单里的准时率和退单率（下取整的百分数，没有订单为 null），日结里这一行的写法 */
  districts: { district: number; star: number; n: number; onTimePct: number | null; cancelPct: number | null; kind: string }[];
  /** 这一天开放的东西和开放的步。日结在第二天的第 0 步做，归在它结束的那一天 */
  unlocked: { key: string; step: number }[];
  /** 这一天出现的便签 */
  tips: { id: string; step: number; station: number | null }[];
  /** 午高峰和晚高峰的小结：主句和附加句的编号 */
  peaks: { peak: string; main: string; extra: string | null }[];
}

export interface SeedRun {
  seed: number;
  days: DayRow[];
  commands: CommandLog[];
  opening: { orderSteps: number[]; deliveredSteps: number[]; doneStep: number }; // 开局订单的下单步、送达步，以及自动派单打开的那一步（没打开为 -1）
  report: DayReport[]; // 每天的日结、开放、便签和小结
  ending: { step: number; days: number; orders: number } | null; // 三个片区都到了四星
}

function toInt(name: string, text: string | undefined, fallback: number, min: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (text.trim() === '' || !Number.isInteger(n) || n < min) throw new RangeError(`--${name} must be an integer >= ${min}, got "${text}"`);
  return n;
}

function loadCommands(path: string | undefined): ScheduledCommand[] {
  if (path === undefined) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new RangeError('the command table must be a JSON array');
  const list = raw.map((item, i) => {
    const entry = item as { at?: unknown; command?: unknown };
    if (!Number.isInteger(entry.at) || (entry.at as number) < 0) throw new RangeError(`command ${i}: "at" must be a non-negative integer step`);
    if (typeof entry.command !== 'object' || entry.command === null || typeof (entry.command as { type?: unknown }).type !== 'string') {
      throw new RangeError(`command ${i}: "command" must be an object with a "type"`);
    }
    const every = (item as { every?: unknown }).every;
    const times = (item as { times?: unknown }).times;
    if (every !== undefined && (!Number.isInteger(every) || (every as number) < 1)) throw new RangeError(`command ${i}: "every" must be a positive integer`);
    if (times !== undefined && (!Number.isInteger(times) || (times as number) < 1)) throw new RangeError(`command ${i}: "times" must be a positive integer`);
    const scheduled: ScheduledCommand & { index: number } = { at: entry.at as number, command: entry.command as Command, index: i };
    if (every !== undefined) {
      scheduled.every = every as number;
      scheduled.times = (times as number | undefined) ?? 1;
    }
    return scheduled;
  });
  list.sort((a, b) => a.at - b.at || a.index - b.index);
  return list.map(({ index: _index, ...rest }) => rest);
}

/** 一天的统计，st 是运行结束时的状态，day 从 0 数起。 */
function dayRow(st: SimState, day: number): Omit<DayRow, 'balance' | 'stations'> {
  const from = day * DAY_STEPS;
  const to = from + DAY_STEPS;
  let orders = 0;
  let onTime = 0;
  let late = 0;
  let cancelled = 0;
  for (const o of st.orders) {
    if (o.tOrder >= from && o.tOrder < to) orders++;
    if (o.tDeliver >= from && o.tDeliver < to) {
      if (o.tDeliver - o.tOrder <= PROMISE_STEPS) onTime++;
      else late++;
    } else if (o.tCancel >= from && o.tCancel < to) {
      cancelled++;
    }
  }
  return { day: day + 1, orders, onTime, late, cancelled, income: (st.campaign?.income[day] as number | undefined) ?? 0 };
}

function stationRows(st: SimState): StationRow[] {
  return st.stations
    .filter((s) => !s.removed)
    .map((s) => ({
      id: s.id,
      drones: st.drones.filter((d) => !d.removed && d.home === s.id).length,
      bays: s.bays,
      gateLevel: (st.campaign?.stations[s.id] as { gateLevel: number }).gateLevel,
    }));
}

/** 这一步的事件归在哪一天：日结在第二天的第 0 步做，归在它结束的那一天，所以第 0 步和第 3600 步都归第 1 天（下标 0）。 */
function dayOfEvent(at: number): number {
  return at === 0 ? 0 : Math.floor((at - 1) / DAY_STEPS);
}

function sentenceIds(p: PeakRecord): { main: string; extra: string | null } {
  return { main: p.main.id, extra: p.extra === null ? null : p.extra.id };
}

/**
 * 每天的日结、开放、便签和小结。最后一天的日结要在 days × 3600 步开始时才做，所以在复制的状态上多走一步取数。
 * 复制只用来取数，不影响返回的状态。
 */
function buildReport(final: SimState, days: number): DayReport[] {
  const tail = structuredClone(final);
  step(tail);
  const campaign = tail.campaign as NonNullable<SimState['campaign']>;
  return Array.from({ length: days }, (_, d) => {
    const record = campaign.days[d] as DayRecord | undefined;
    const districts = (record?.districts ?? []).map((line) => ({
      district: line.district,
      star: line.star,
      n: line.n,
      onTimePct: line.onTimePct,
      cancelPct: line.cancelPct,
      kind: line.kind,
    }));
    const unlocked = UNLOCK_KEYS.map((key) => ({ key: key as string, step: campaign.unlocks[key] as number }))
      .filter((u) => u.step >= 0 && dayOfEvent(u.step) === d)
      .sort((a, b) => a.step - b.step);
    const tips = campaign.tips.filter((t) => dayOfEvent(t.step) === d).map((t) => ({ id: t.id as string, step: t.step, station: t.station }));
    const peaks = campaign.peaks.filter((p) => p.day === d).map((p) => ({ peak: p.peak as string, ...sentenceIds(p) }));
    return { day: d + 1, districts, unlocked, tips, peaks };
  });
}

/** 从开局运行若干游戏日。clickDelay 是开局订单出现之后脚本隔多少步点击。 */
export function runCampaign(overrides: ConfigOverrides, days: number, commands: readonly ScheduledCommand[], clickDelay: number): { state: SimState; run: SeedRun } {
  const state = createState({ ...overrides, mode: 'campaign' });
  const log: CommandLog[] = [];
  const balances: number[] = [];
  const stationsAt: StationRow[][] = [];
  const total = days * DAY_STEPS;
  // 待执行的命令按步排序，同一步按命令表里的先后。写了 every 的命令没做够时，隔 every 步再排进来
  interface Queued extends ScheduledCommand {
    order: number;
  }
  const queue: Queued[] = commands.map((c, order) => ({ ...c, order }));
  const lastFailure = new Map<number, CommandLog>();
  let doneStep = -1;
  for (let i = 0; i < total; i++) {
    while (queue.length > 0 && (queue[0] as Queued).at <= state.step) {
      const item = queue.shift() as Queued;
      const quote = quoteCommand(state, item.command);
      const result = applyCommand(state, item.command);
      const previous = lastFailure.get(item.order);
      if (!result.ok && previous !== undefined && !previous.result.ok && previous.result.reason === result.reason) {
        previous.count = (previous.count ?? 1) + 1;
        previous.lastAt = state.step;
      } else {
        const entry: CommandLog = { at: state.step, command: item.command, result, kind: quote.kind, price: quote.price };
        log.push(entry);
        if (result.ok) lastFailure.delete(item.order);
        else lastFailure.set(item.order, entry);
      }
      if (item.every !== undefined) {
        const remaining = (item.times ?? 1) - (result.ok ? 1 : 0);
        if (remaining > 0) {
          const again: Queued = { ...item, at: state.step + item.every, times: remaining };
          let at = queue.findIndex((q) => q.at > again.at || (q.at === again.at && q.order > again.order));
          if (at < 0) at = queue.length;
          queue.splice(at, 0, again);
        }
      }
    }
    // 开局的五张订单：出现一小会儿之后，脚本替玩家点击
    const campaign = state.campaign;
    if (campaign !== null && !campaign.opening.done) {
      for (const id of campaign.opening.orders) {
        const order = state.orders[id];
        if (order !== undefined && order.manualAt < 0 && state.step >= order.tOrder + clickDelay) {
          applyCommand(state, { type: 'prioritizeOrder', order: id });
        }
      }
    }
    const at = state.step;
    step(state);
    if (doneStep < 0 && state.campaign?.opening.done) doneStep = at; // 在这一步的产生订单阶段打开
    if (state.step % DAY_STEPS === 0) {
      balances.push(state.campaign?.money ?? 0);
      stationsAt.push(stationRows(state));
    }
  }
  const campaign = state.campaign;
  const opening = {
    orderSteps: (campaign?.opening.orders ?? []).map((id) => (state.orders[id] as { tOrder: number }).tOrder),
    deliveredSteps: (campaign?.opening.orders ?? []).map((id) => (state.orders[id] as { tDeliver: number }).tDeliver),
    doneStep,
  };
  const rows: DayRow[] = Array.from({ length: days }, (_, d) => ({
    ...dayRow(state, d),
    balance: balances[d] as number,
    stations: stationsAt[d] as StationRow[],
  }));
  const report = buildReport(state, days);
  const ending = (structuredClone(campaign?.ending ?? null) as SeedRun['ending']);
  return { state, run: { seed: state.config.seed, days: rows, commands: log, opening, report, ending } };
}

const DISTRICT_LABEL = ['老街', '写字楼区', '大学城'];

const DAY_HEADERS = ['天', '来单', '准时', '超时', '退单', '进账', '余额', '各站 飞机/停机位/起降口级'];

function dayCells(r: DayRow): string[] {
  return [
    String(r.day),
    String(r.orders),
    String(r.onTime),
    String(r.late),
    String(r.cancelled),
    fixed(r.income, 1),
    fixed(r.balance, 1),
    r.stations.map((s) => `站${s.id} ${s.drones}/${s.bays}/${s.gateLevel}`).join('  '),
  ];
}

/** 每天的日结、开放、便签和小结，一天几行。 */
function reportLines(run: SeedRun): string[] {
  const lines: string[] = ['日结之后（片区的星级，最近两天完成的订单里的准时率和退单率）'];
  const shown = (n: number | null): string => (n === null ? '-' : `${n}%`);
  for (const r of run.report) {
    const districts = r.districts.map((d) => `${DISTRICT_LABEL[d.district] ?? `片区${d.district}`} ${d.star}星 准时 ${shown(d.onTimePct)} 退单 ${shown(d.cancelPct)}（${d.n} 单，${d.kind}）`);
    lines.push(`  第 ${r.day} 天：${districts.length === 0 ? '日结还没有做' : districts.join('，')}`);
    lines.push(`    开放：${r.unlocked.length === 0 ? '无' : r.unlocked.map((u) => `${u.key}@${u.step}`).join(' ')}`);
    lines.push(`    便签：${r.tips.length === 0 ? '无' : r.tips.map((t) => `${t.id}@${t.step}${t.station === null ? '' : `(站${t.station})`}`).join(' ')}`);
    const peaks = r.peaks.map((p) => `${p.peak === 'noon' ? '午高峰' : '晚高峰'}小结 ${p.main}${p.extra === null ? '' : ` + ${p.extra}`}`);
    lines.push(`    ${peaks.length === 0 ? '小结：无' : peaks.join('，')}`);
  }
  if (run.ending !== null) lines.push(`  结局：第 ${run.ending.days} 天（日结在步 ${run.ending.step}），一共送了 ${run.ending.orders} 单`);
  return lines;
}

function main(): void {
  const values = parseArgs({ options: OPTIONS, strict: true }).values;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const days = toInt('days', values.days, 3, 1);
  const clickDelay = toInt('click-delay', values['click-delay'], 10, 0);
  const seeds = parseSeeds(values.seeds ?? '42');
  const commands = loadCommands(values.commands);
  const rules: Record<string, string> = {};
  if (values.select !== undefined) rules.select = values.select;
  if (values.zone !== undefined) rules.zone = values.zone;
  if (values.pool !== undefined) rules.pool = values.pool;
  makeConfig({ mode: 'campaign', rules }); // 提前检查取值

  const out: string[] = [`经营模式 · ${days} 天 · 种子 ${seeds.join(',')} · 命令 ${commands.length} 条 · 开局点击延迟 ${clickDelay} 步`, ''];
  const runs: SeedRun[] = [];
  for (const seed of seeds) {
    const { run } = runCampaign({ seed, rules }, days, commands, clickDelay);
    runs.push(run);
    if (!values.quiet) {
      const o = run.opening;
      out.push(
        `种子 ${seed}：开局订单下单步 ${o.orderSteps.join(',')}，送达步 ${o.deliveredSteps.join(',')}，自动派单打开的那一步 ${o.doneStep}`,
      );
      out.push(formatTable(DAY_HEADERS, run.days.map(dayCells)));
      for (const c of run.commands) {
        const price = c.kind === 'free' ? '' : ` ${c.kind === 'buy' ? '价格' : '退回'} ${c.price}`;
        const repeated = c.count === undefined ? '' : `，共 ${c.count} 次，最后一次在步 ${c.lastAt}`;
        out.push(`  命令 步 ${c.at} ${JSON.stringify(c.command)} -> ${c.result.ok ? `成功 id=${c.result.id}${price}` : `失败 ${c.result.reason}${price}${repeated}`}`);
      }
      out.push(...reportLines(run));
      out.push('');
    }
  }
  // 汇总：每天各种子的数字，一行一个种子一天
  const summary: string[][] = [];
  for (const run of runs) {
    for (const r of run.days) summary.push([String(run.seed), ...dayCells(r).slice(0, 7)]);
  }
  out.push('汇总（每行一个种子的一天）', '');
  out.push(formatTable(['种子', ...DAY_HEADERS.slice(0, 7)], summary));
  process.stdout.write(out.join('\n') + '\n');

  if (values.json) {
    mkdirSync(dirname(values.json), { recursive: true });
    writeFileSync(values.json, JSON.stringify({ days, seeds, commands, runs }, jsonReplacer, 2) + '\n');
    process.stdout.write(`已写出 ${values.json}\n`);
  }
}

// 只有直接运行本文件时才执行，被测试引用时不执行
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

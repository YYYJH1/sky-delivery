// 自动购买脚本的汇总：每个节点在各玩法下的分位数和达到比例，第一天升二星的比例，写字楼区的过河单比例，
// 攒钱时间，固定玩法能不能在目标时间内做到两个片区三星，结局的时间和到达比例，各片区在两场高峰里的订单占比，
// 均衡玩法的逐天数字，以及按校准目标逐条核对的结果。
// 全部是纯函数，输入是一批 RunRecord，输出是汇总对象和 Markdown 文本。
import { STARS_V1 } from '../src/content/stars_v1.ts';
import { DAY_STEPS } from '../src/core/index.ts';
import { MAIN_NODES, NODE_INFO, POLICIES, POLICY_IDS, stepsToMinutes } from './autoplay-lib.ts';
import type { NodeId, PolicyId, PurchaseRecord, RunRecord } from './autoplay-lib.ts';

// ---- 校准目标 ----

/** 校准目标里的数字，核对表（goalChecks）按它们判断。时间都是一倍速的游戏内分钟。 */
export const GOALS = {
  /** 均衡玩法结局的时间区间，中位数要落在里面，四分位尽量也在里面 */
  endingMinutes: [120, 180],
  /** 均衡玩法在这个时间之前到达结局的比例，不低于 endingShare */
  endingWithin: 240,
  endingShare: 0.9,
  /** 四种不需要判断的玩法在这个时间之前到达结局的比例，不超过 weakShare */
  weakWithin: 180,
  weakShare: 0.2,
  /** 任何一次购买的攒钱时间不超过这么多个游戏日 */
  savingDays: 2,
  /** 均衡玩法第一天升到二星的局占的比例，不低于这个数 */
  dayOneStar2: 0.8,
  /** 四星的准时率线（百分数）不超过这个数 */
  fourStarLine: 90,
  /** 大学城开通之后，午高峰的订单里写字楼区占的比例不低于这个数，晚高峰的订单里老街和大学城合起来占的比例也不低于这个数 */
  peakLead: 0.5,
} as const;

/** 四种不需要判断的玩法：只扩建一座站，全程不换卡，只买飞机，不操作。 */
export const WEAK_POLICIES: readonly PolicyId[] = ['singleStation', 'noCards', 'dronesOnly', 'idle'];

// ---- 分位数 ----

/**
 * 最近秩分位数：把 N 个值从小到大排，取第 ceil(p × N) 个（至少第 1 个）。结果一定是某一局的真实取值，
 * 所以「中位数不超过 12 分钟」就是「至少一半的局在 12 分钟之前达到」。null 表示没有达到，当作无穷大排在最后。
 * 结果是 null 表示这个分位数上的局没有达到。
 */
export function quantile(values: readonly (number | null)[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.map((v) => v ?? Number.POSITIVE_INFINITY).sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length - 1e-9));
  const v = sorted[Math.min(rank, sorted.length) - 1] as number;
  return Number.isFinite(v) ? v : null;
}

/** 只看有值的局的中位数（下中位数）。没有值时为 null。 */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1] as number;
}

function meanOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

// ---- 汇总对象 ----

export interface NodeStat {
  runs: number;
  reached: number; // 这一局里到达了
  p25: number | null; // 分钟
  p50: number | null;
  p75: number | null;
  /** 只看到达了的局：中位数和平均，分钟 */
  medianReached: number | null;
  meanReached: number | null;
}

export interface CrossRiverStat {
  runs: number; // 开通了写字楼区的局数
  /** 开通之后前 1、2、3 天：全部种子合起来，来自老街的店的订单占送往写字楼区的订单的比例 */
  pooled: { days1: number | null; days2: number | null; days3: number | null };
  orders3: number; // 前 3 天送往写字楼区的订单数，全部种子合计
  /** 每个种子前 3 天的比例（订单为 0 的种子不算）：下四分位、中位数、上四分位 */
  perRun3: { p25: number | null; p50: number | null; p75: number | null; n: number };
}

export interface SavingStat {
  runs: number;
  purchases: number; // 全部种子合计
  /** 每局最长的购买间隔，游戏日：中位数、最大值 */
  gapDaysMedian: number | null;
  gapDaysMax: number | null;
  /** 每局最长的攒钱时间，游戏日：中位数、最大值 */
  savingDaysMedian: number | null;
  savingDaysMax: number | null;
  /** 最长间隔不超过两个游戏日的局占的比例，攒钱时间同理 */
  gapWithinTwoDays: number;
  savingWithinTwoDays: number;
  /** 间隔超过两个游戏日的购买，按种类的次数 */
  overTwoDays: { type: string; count: number }[];
}

export interface PurchaseTypeStat {
  type: string;
  count: number;
  priceMedian: number | null;
  gapDaysMedian: number | null;
  gapDaysMax: number | null;
  savingDaysMax: number | null;
}

export interface FixedStat {
  runs: number;
  /** 老街和写字楼区都做到三星的局：在 60 分钟之前、72 分钟之前、局内（全部天数）的比例 */
  within60: number;
  within72: number;
  withinHorizon: number;
  /** 两个片区都做到三星的时间（取较晚的那个）：分位数，分钟 */
  bothThree: { p25: number | null; p50: number | null; p75: number | null };
  /** 局末两个片区的星级分布，用于看写字楼区是不是做到三星之后又掉星 */
  finalOfficeStars: Record<string, number>;
}

/** 一个玩法在局内到达结局的时间和比例。 */
export interface EndingStat {
  runs: number;
  reached: number; // 局内到达结局的局数
  p25: number | null; // 分钟
  p50: number | null;
  p75: number | null;
  /** 在 120、150、180、240 分钟之前到达结局的局占的比例 */
  within120: number;
  within150: number;
  within180: number;
  within240: number;
}

/** 一个时期里各片区在两场高峰的订单占比。 */
export interface ShareRow {
  runs: number; // 有这个时期的局数
  days: number; // 全部局的这个时期的天数合计
  noon: number[]; // 全部种子合并的午高峰订单数，下标是片区
  evening: number[];
  /** 每个（局、天）里，午高峰订单最多的那个片区占的比例：中位数和上四分位 */
  topNoon: { p50: number | null; p75: number | null };
  topEvening: { p50: number | null; p75: number | null };
}

/**
 * 三个时期，每个时期都从一件事发生之后的第一个整天算起：
 * twoDistricts 写字楼区开通之后，到大学城开通之前（没有开通大学城的局算到局末）。
 * campus 大学城开通之后，到结局那一天为止（没有到结局的局算到局末）。
 * after 结局之后到局末。
 */
export interface ShareStat {
  twoDistricts: ShareRow;
  campus: ShareRow;
  after: ShareRow;
}

export interface DailyStat {
  day: number;
  balance: number | null; // 中位数
  income: number | null;
  spent: number | null;
  stations: number | null;
  drones: number | null;
  stars: number[]; // 各片区星级的中位数，没开通的片区为 0
  onTimePct: (number | null)[]; // 各片区最近两天准时率的中位数
  openShare: number[]; // 各片区已开通的比例
}

export interface PolicySummary {
  id: PolicyId;
  name: string;
  runs: number;
  nodes: Record<NodeId, NodeStat>;
  /** 老街在第 1、2、3 天结束时已经到二星、三星的比例，写字楼区三星同理，下标是第几天 */
  starByDay: { oldStreet2: number[]; oldStreet3: number[]; office3: number[] };
  day1Star2: number; // 第一天日结时升到二星的局占的比例
  crossRiver: CrossRiverStat;
  saving: SavingStat;
  purchaseTypes: PurchaseTypeStat[];
  fixed: FixedStat;
  ending: EndingStat;
  shares: ShareStat;
  daily: DailyStat[];
}

/** 核对表的一行：目标，数值，是否达到。 */
export interface GoalCheck {
  goal: string;
  value: string;
  pass: boolean;
}

export interface Summary {
  label: string;
  seeds: number[];
  days: number;
  policies: PolicySummary[];
}

// ---- 计算 ----

function toMinutes(v: number | null): number | null {
  return v === null ? null : stepsToMinutes(v);
}

function nodeStat(records: readonly RunRecord[], id: NodeId): NodeStat {
  const values = records.map((r) => r.nodes[id]);
  const reached = values.filter((v): v is number => v !== null);
  const minutes = reached.map(stepsToMinutes);
  return {
    runs: records.length,
    reached: reached.length,
    p25: toMinutes(quantile(values, 0.25)),
    p50: toMinutes(quantile(values, 0.5)),
    p75: toMinutes(quantile(values, 0.75)),
    medianReached: medianOf(minutes),
    meanReached: meanOf(minutes),
  };
}

function shareReaching(records: readonly RunRecord[], id: NodeId, days: number): number[] {
  return Array.from({ length: days }, (_, d) => {
    const limit = (d + 1) * DAY_STEPS;
    return records.filter((r) => r.nodes[id] !== null && (r.nodes[id] as number) <= limit).length / Math.max(1, records.length);
  });
}

function crossRiverStat(records: readonly RunRecord[]): CrossRiverStat {
  const opened = records.filter((r) => r.crossRiver !== null);
  const pooled = (days: number): number | null => {
    let orders = 0;
    let fromOld = 0;
    for (const r of opened) {
      const c = r.crossRiver as NonNullable<RunRecord['crossRiver']>;
      for (let k = 0; k < days; k++) {
        orders += c.orders[k] as number;
        fromOld += c.fromOld[k] as number;
      }
    }
    return orders > 0 ? fromOld / orders : null;
  };
  let orders3 = 0;
  const shares: number[] = [];
  for (const r of opened) {
    const c = r.crossRiver as NonNullable<RunRecord['crossRiver']>;
    const o = (c.orders[0] as number) + (c.orders[1] as number) + (c.orders[2] as number);
    const f = (c.fromOld[0] as number) + (c.fromOld[1] as number) + (c.fromOld[2] as number);
    orders3 += o;
    if (o > 0) shares.push(f / o);
  }
  return {
    runs: opened.length,
    pooled: { days1: pooled(1), days2: pooled(2), days3: pooled(3) },
    orders3,
    perRun3: { p25: quantile(shares, 0.25), p50: quantile(shares, 0.5), p75: quantile(shares, 0.75), n: shares.length },
  };
}

function savingStat(records: readonly RunRecord[]): SavingStat {
  const gap = records.map((r) => r.maxGap / DAY_STEPS);
  const saving = records.map((r) => r.maxSaving / DAY_STEPS);
  const over = new Map<string, number>();
  let purchases = 0;
  for (const r of records) {
    purchases += r.purchases.length;
    for (const p of r.purchases) if (p.gap > 2 * DAY_STEPS) over.set(p.type, (over.get(p.type) ?? 0) + 1);
  }
  const n = Math.max(1, records.length);
  return {
    runs: records.length,
    purchases,
    gapDaysMedian: quantile(gap, 0.5),
    gapDaysMax: gap.length > 0 ? Math.max(...gap) : null,
    savingDaysMedian: quantile(saving, 0.5),
    savingDaysMax: saving.length > 0 ? Math.max(...saving) : null,
    gapWithinTwoDays: gap.filter((g) => g <= 2).length / n,
    savingWithinTwoDays: saving.filter((g) => g <= 2).length / n,
    overTwoDays: [...over.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  };
}

function purchaseTypeStats(records: readonly RunRecord[]): PurchaseTypeStat[] {
  const byType = new Map<string, PurchaseRecord[]>();
  for (const r of records) for (const p of r.purchases) byType.set(p.type, [...(byType.get(p.type) ?? []), p]);
  return [...byType.entries()]
    .map(([type, list]) => ({
      type,
      count: list.length,
      priceMedian: medianOf(list.map((p) => p.price)),
      gapDaysMedian: medianOf(list.map((p) => p.gap / DAY_STEPS)),
      gapDaysMax: Math.max(...list.map((p) => p.gap / DAY_STEPS)),
      savingDaysMax: Math.max(...list.map((p) => p.saving / DAY_STEPS)),
    }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function fixedStat(records: readonly RunRecord[], days: number): FixedStat {
  const both = records.map((r) => {
    const a = r.nodes.oldStreet3;
    const b = r.nodes.office3;
    return a !== null && b !== null ? Math.max(a, b) : null;
  });
  const within = (minutes: number): number => both.filter((v) => v !== null && stepsToMinutes(v) <= minutes).length / Math.max(1, records.length);
  const finalOfficeStars: Record<string, number> = {};
  for (const r of records) {
    const key = r.final.open[1] ? String(r.final.stars[1]) : '未开通';
    finalOfficeStars[key] = (finalOfficeStars[key] ?? 0) + 1;
  }
  return {
    runs: records.length,
    within60: within(60),
    within72: within(72),
    withinHorizon: within(days * 6),
    bothThree: { p25: toMinutes(quantile(both, 0.25)), p50: toMinutes(quantile(both, 0.5)), p75: toMinutes(quantile(both, 0.75)) },
    finalOfficeStars,
  };
}

function endingStat(records: readonly RunRecord[]): EndingStat {
  const values = records.map((r) => r.nodes.ending);
  const within = (minutes: number): number => values.filter((v) => v !== null && stepsToMinutes(v) <= minutes).length / Math.max(1, records.length);
  return {
    runs: records.length,
    reached: values.filter((v) => v !== null).length,
    p25: toMinutes(quantile(values, 0.25)),
    p50: toMinutes(quantile(values, 0.5)),
    p75: toMinutes(quantile(values, 0.75)),
    within120: within(120),
    within150: within(150),
    within180: within(180),
    within240: within(240),
  };
}

type Phase = 'twoDistricts' | 'campus' | 'after';

/** 一局里某个时期的游戏日范围（从 0 数起，含两端），没有这个时期为 null。开通那天只有半天，不算。 */
function phaseDays(r: RunRecord, phase: Phase): [number, number] | null {
  const day = (step: number | null | undefined): number | null => (step === null || step === undefined ? null : Math.floor(step / DAY_STEPS));
  const last = r.days - 1;
  const officeDay = day(r.nodes.officeOpened);
  const campusDay = day(r.nodes.campusOpened);
  // 结局在做日结的那一步记下，那一天的订单已经算在内，所以结局那一天是 ending / DAY_STEPS - 1
  const endingDay = r.nodes.ending === null || r.nodes.ending === undefined ? null : Math.round(r.nodes.ending / DAY_STEPS) - 1;
  let range: [number, number] | null = null;
  if (phase === 'twoDistricts' && officeDay !== null) range = [officeDay + 1, campusDay !== null ? campusDay - 1 : last];
  if (phase === 'campus' && campusDay !== null) range = [campusDay + 1, endingDay ?? last];
  if (phase === 'after' && endingDay !== null) range = [endingDay + 1, last];
  return range !== null && range[0] <= range[1] ? range : null;
}

function shareRow(records: readonly RunRecord[], phase: Phase): ShareRow {
  const districts = 3;
  const noon = new Array<number>(districts).fill(0);
  const evening = new Array<number>(districts).fill(0);
  const topNoon: number[] = [];
  const topEvening: number[] = [];
  let runs = 0;
  let days = 0;
  for (const r of records) {
    const range = phaseDays(r, phase);
    if (range === null || r.peakOrders === undefined) continue;
    runs += 1;
    for (let d = range[0]; d <= range[1]; d++) {
      days += 1;
      for (const [peak, total, tops] of [
        [r.peakOrders.noon[d], noon, topNoon],
        [r.peakOrders.evening[d], evening, topEvening],
      ] as const) {
        if (peak === undefined) continue;
        const sum = peak.reduce((a, b) => a + b, 0);
        peak.forEach((n, k) => {
          total[k] = (total[k] as number) + n;
        });
        if (sum > 0) tops.push(Math.max(...peak) / sum);
      }
    }
  }
  return {
    runs,
    days,
    noon,
    evening,
    topNoon: { p50: quantile(topNoon, 0.5), p75: quantile(topNoon, 0.75) },
    topEvening: { p50: quantile(topEvening, 0.5), p75: quantile(topEvening, 0.75) },
  };
}

function dailyStats(records: readonly RunRecord[], days: number): DailyStat[] {
  return Array.from({ length: days }, (_, d) => {
    const rows = records.map((r) => r.daily[d]).filter((x): x is NonNullable<typeof x> => x !== undefined);
    const lineOf = (row: NonNullable<(typeof rows)[number]>, k: number): { star: number; onTimePct: number | null } | undefined => row.lines.find((l) => l.district === k);
    const stars = [0, 1, 2].map((k) => medianOf(rows.map((row) => lineOf(row, k)?.star ?? 0)) ?? 0);
    const onTimePct = [0, 1, 2].map((k) => medianOf(rows.map((row) => lineOf(row, k)?.onTimePct).filter((v): v is number => v !== null && v !== undefined)));
    const openShare = [0, 1, 2].map((k) => rows.filter((row) => lineOf(row, k) !== undefined).length / Math.max(1, rows.length));
    return {
      day: d + 1,
      balance: medianOf(rows.map((row) => row.balance)),
      income: medianOf(rows.map((row) => row.income)),
      spent: medianOf(rows.map((row) => row.spent)),
      stations: medianOf(rows.map((row) => row.stations)),
      drones: medianOf(rows.map((row) => row.drones)),
      stars,
      onTimePct,
      openShare,
    };
  });
}

/** 汇总一批运行记录。records 里每种玩法的种子应当一致。 */
export function summarize(records: readonly RunRecord[], label: string): Summary {
  const days = records.length > 0 ? (records[0] as RunRecord).days : 0;
  const seeds = [...new Set(records.map((r) => r.seed))].sort((a, b) => a - b);
  const present = POLICY_IDS.filter((id) => records.some((r) => r.policy === id));
  const policies = present.map((id): PolicySummary => {
    const mine = records.filter((r) => r.policy === id).sort((a, b) => a.seed - b.seed);
    const nodes = {} as Record<NodeId, NodeStat>;
    for (const info of NODE_INFO) nodes[info.id] = nodeStat(mine, info.id);
    const horizonDays = Math.min(days, 6);
    return {
      id,
      name: POLICIES[id].name,
      runs: mine.length,
      nodes,
      starByDay: {
        oldStreet2: shareReaching(mine, 'oldStreet2', horizonDays),
        oldStreet3: shareReaching(mine, 'oldStreet3', horizonDays),
        office3: shareReaching(mine, 'office3', days),
      },
      day1Star2: shareReaching(mine, 'oldStreet2', 1)[0] as number,
      crossRiver: crossRiverStat(mine),
      saving: savingStat(mine),
      purchaseTypes: purchaseTypeStats(mine),
      fixed: fixedStat(mine, days),
      ending: endingStat(mine),
      shares: { twoDistricts: shareRow(mine, 'twoDistricts'), campus: shareRow(mine, 'campus'), after: shareRow(mine, 'after') },
      daily: dailyStats(mine, days),
    };
  });
  return { label, seeds, days, policies };
}

// ---- 校准目标的核对 ----

function inRange(v: number | null, range: readonly [number, number]): boolean {
  return v !== null && v >= range[0] && v <= range[1];
}

/** 占比最大的片区的名称和比例，没有订单时为 null。 */
function topDistrict(counts: readonly number[]): { name: string; share: number } | null {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum === 0) return null;
  const names = ['老街', '写字楼区', '大学城'];
  let best = 0;
  counts.forEach((n, k) => {
    if (n > (counts[best] as number)) best = k;
  });
  return { name: names[best] as string, share: (counts[best] as number) / sum };
}

/**
 * 按校准目标逐条核对，只核对汇总里有的玩法。核对的是这一批数据本身，前期节点「不变坏」要拿另一批数据对照，这里只核对它们在目标区间内。
 * 目标写在 GOALS 里：均衡玩法结局的中位数和四分位，四种不需要判断的玩法在 180 分钟内到达结局的比例，攒钱时间，前期节点，订单占比。
 */
export function goalChecks(summary: Summary): GoalCheck[] {
  const checks: GoalCheck[] = [];
  const [lo, hi] = GOALS.endingMinutes;
  const balanced = summary.policies.find((p) => p.id === 'balanced');
  if (balanced !== undefined) {
    const e = balanced.ending;
    checks.push({
      goal: `均衡玩法的结局中位数在 ${lo} 到 ${hi} 分钟`,
      value: `${fm(e.p50)}，局内到达 ${fp(e.reached / Math.max(1, e.runs))}`,
      pass: inRange(e.p50, GOALS.endingMinutes),
    });
    checks.push({
      goal: `均衡玩法的结局四分位也在 ${lo} 到 ${hi} 分钟`,
      value: `${fm(e.p25)} 到 ${fm(e.p75)}`,
      pass: inRange(e.p25, GOALS.endingMinutes) && inRange(e.p75, GOALS.endingMinutes),
    });
    checks.push({
      goal: `均衡玩法在 ${GOALS.endingWithin} 分钟内到达结局的比例不低于 ${fp(GOALS.endingShare)}`,
      value: fp(e.within240),
      pass: e.within240 >= GOALS.endingShare,
    });
    checks.push({
      goal: `均衡玩法第一天升到二星的比例不低于 ${fp(GOALS.dayOneStar2)}`,
      value: fp(balanced.day1Star2),
      pass: balanced.day1Star2 >= GOALS.dayOneStar2,
    });
  }
  const four = STARS_V1.rules.find((r) => r.star === 4);
  checks.push({
    goal: `四星的准时率线不超过 ${GOALS.fourStarLine}%`,
    value: four === undefined ? '-' : `${four.onTimeMin}%`,
    pass: four !== undefined && four.onTimeMin <= GOALS.fourStarLine,
  });
  for (const id of WEAK_POLICIES) {
    const p = summary.policies.find((x) => x.id === id);
    if (p === undefined) continue;
    checks.push({
      goal: `${p.name}在 ${GOALS.weakWithin} 分钟内到达结局的比例不超过 ${fp(GOALS.weakShare)}`,
      value: fp(p.ending.within180),
      pass: p.ending.within180 <= GOALS.weakShare,
    });
  }
  for (const p of summary.policies) {
    checks.push({
      goal: `${p.name}的每一次购买，攒钱时间不超过 ${GOALS.savingDays} 个游戏日`,
      value: `最长 ${fm(p.saving.savingDaysMax, 2)} 天，${fp(p.saving.savingWithinTwoDays)} 的局达到`,
      pass: (p.saving.savingDaysMax ?? 0) <= GOALS.savingDays,
    });
  }
  if (balanced !== undefined) {
    const early = NODE_INFO.filter((i) => (MAIN_NODES as readonly string[]).includes(i.id) && i.target !== null && i.id !== 'ending');
    const out = early.filter((i) => !inRange(balanced.nodes[i.id].p50, i.target as readonly [number, number]));
    checks.push({
      goal: '均衡玩法的前期节点都在目标内',
      value: out.length === 0 ? `${early.length} 个节点` : `不在目标内：${out.map((i) => `${i.label} ${fm(balanced.nodes[i.id].p50)}`).join('，')}`,
      pass: out.length === 0,
    });
    const campus = balanced.shares.campus;
    if (campus.days > 0) {
      const noon = topDistrict(campus.noon);
      const evening = topDistrict(campus.evening);
      const noonSum = campus.noon.reduce((a, b) => a + b, 0);
      const eveningSum = campus.evening.reduce((a, b) => a + b, 0);
      const noonOffice = noonSum > 0 ? (campus.noon[1] as number) / noonSum : 0;
      const eveningRest = eveningSum > 0 ? ((campus.evening[0] as number) + (campus.evening[2] as number)) / eveningSum : 0;
      checks.push({
        goal: `大学城开通之后，均衡玩法的午高峰主要是写字楼区的订单（占 ${fp(GOALS.peakLead)} 以上），晚高峰主要是老街和大学城的订单（合起来占 ${fp(GOALS.peakLead)} 以上）`,
        value: `午高峰写字楼区 ${fp(noonOffice)}（最大的片区 ${noon === null ? '-' : noon.name}），晚高峰老街加大学城 ${fp(eveningRest)}（最大的片区 ${evening === null ? '-' : evening.name}）`,
        pass: noonOffice >= GOALS.peakLead && eveningRest >= GOALS.peakLead,
      });
    }
  }
  return checks;
}

// ---- Markdown ----

const TYPE_NAMES: Readonly<Record<string, string>> = {
  buyDrone: '添飞机',
  buyBay: '加停机位',
  buildStation: '建站',
  upgradeGate: '升级起降口',
  buyDoubleBox: '双层货箱',
  buyNearestLanding: '就近降落',
  openDistrict: '开通片区',
};

function fm(v: number | null, digits = 1): string {
  return v === null ? '-' : v.toFixed(digits);
}

function fp(v: number | null, digits = 0): string {
  return v === null ? '-' : `${(v * 100).toFixed(digits)}%`;
}

function nodeCell(stat: NodeStat): string {
  return `${fm(stat.p50)} (${fm(stat.p25)}~${fm(stat.p75)}) ${fp(stat.reached / Math.max(1, stat.runs))}`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
}

function inTarget(info: (typeof NODE_INFO)[number], p50: number | null): string {
  if (info.target === null) return '';
  if (p50 === null) return '未达到';
  return p50 >= info.target[0] && p50 <= info.target[1] ? '是' : p50 < info.target[0] ? '偏早' : '偏晚';
}

/** 汇总表的 Markdown。 */
export function renderMarkdown(summary: Summary): string {
  const out: string[] = [];
  out.push(`# 节奏表：${summary.label}`, '');
  out.push(
    `订单种子 ${summary.seeds[0]} 到 ${summary.seeds[summary.seeds.length - 1]}（${summary.seeds.length} 个），每局 ${summary.days} 个游戏日（${summary.days * 6} 分钟，一倍速）。` +
      `时间都是一倍速的游戏内分钟。分位数按最近秩法取，没有达到的局当作无穷大，所以「-」表示这个分位数上的局没有在局内达到。`,
    '',
  );

  out.push('## 一 节点的时间', '', '每格是「中位数 (下四分位~上四分位) 达到的比例」。', '');
  const mainInfo = NODE_INFO.filter((i) => (MAIN_NODES as readonly string[]).includes(i.id));
  out.push(...table(['节点', '目标', ...summary.policies.map((p) => p.name)], mainInfo.map((info) => [info.label, info.targetText, ...summary.policies.map((p) => nodeCell(p.nodes[info.id]))])), '');
  const extraInfo = NODE_INFO.filter((i) => !(MAIN_NODES as readonly string[]).includes(i.id));
  out.push('附加节点：', '');
  out.push(...table(['节点', '', ...summary.policies.map((p) => p.name)], extraInfo.map((info) => [info.label, '', ...summary.policies.map((p) => nodeCell(p.nodes[info.id]))])), '');

  const balanced = summary.policies.find((p) => p.id === 'balanced');
  if (balanced !== undefined) {
    out.push('## 二 均衡玩法对照目标', '');
    out.push(
      ...table(
        ['节点', '目标（分钟）', '中位数', '下四分位~上四分位', '达到', '在目标内'],
        mainInfo.map((info) => {
          const s = balanced.nodes[info.id];
          return [info.label, info.targetText, fm(s.p50), `${fm(s.p25)}~${fm(s.p75)}`, fp(s.reached / Math.max(1, s.runs)), inTarget(info, s.p50)];
        }),
      ),
      '',
    );
  }

  out.push('## 三 第一天升二星和星级随天数的累计比例', '');
  out.push('第一天日结（第 6 分钟）时老街升到二星的比例，以及到每一天结束时已经达到的累计比例。', '');
  out.push(
    ...table(
      ['玩法', '第一天升二星', '老街二星：到第 1/2/3 天', '老街三星：到第 2/3/4 天', '写字楼区三星：到第 8/10/12 天'],
      summary.policies.map((p) => [
        p.name,
        fp(p.day1Star2),
        [0, 1, 2].map((d) => fp(p.starByDay.oldStreet2[d] ?? null)).join(' / '),
        [1, 2, 3].map((d) => fp(p.starByDay.oldStreet3[d] ?? null)).join(' / '),
        [7, 9, 11].map((d) => fp(p.starByDay.office3[d] ?? null)).join(' / '),
      ]),
    ),
    '',
  );

  out.push('## 四 写字楼区的过河单', '');
  out.push('开通写字楼区之后头几天，送往写字楼区的订单里来自老街的店的比例。全部种子合并算，另给每个种子前 3 天的分位数。目标四成到六成。', '');
  out.push(
    ...table(
      ['玩法', '开通了的局', '前 1 天', '前 2 天', '前 3 天', '前 3 天订单数', '每个种子前 3 天（下四分位 / 中位数 / 上四分位）'],
      summary.policies.map((p) => {
        const c = p.crossRiver;
        return [p.name, `${c.runs}`, fp(c.pooled.days1, 1), fp(c.pooled.days2, 1), fp(c.pooled.days3, 1), `${c.orders3}`, `${fp(c.perRun3.p25)} / ${fp(c.perRun3.p50)} / ${fp(c.perRun3.p75)}`];
      }),
    ),
    '',
  );

  out.push('## 五 攒钱时间', '');
  out.push(
    '间隔是从上一次购买到这一次购买的时间（第一次购买从开局算起），攒钱是这段间隔里清单上第一个可以买的东西买不起的时间。单位是游戏日（360 秒）。每局取最长的一次，再看各局的分布。',
    '',
  );
  out.push(
    ...table(
      ['玩法', '购买总数', '最长间隔：中位数 / 最大', '最长间隔不超过 2 天的局', '最长攒钱：中位数 / 最大', '最长攒钱不超过 2 天的局', '间隔超过 2 天的购买'],
      summary.policies.map((p) => {
        const s = p.saving;
        return [
          p.name,
          `${s.purchases}`,
          `${fm(s.gapDaysMedian, 2)} / ${fm(s.gapDaysMax, 2)}`,
          fp(s.gapWithinTwoDays),
          `${fm(s.savingDaysMedian, 2)} / ${fm(s.savingDaysMax, 2)}`,
          fp(s.savingWithinTwoDays),
          s.overTwoDays.length === 0 ? '无' : s.overTwoDays.map((o) => `${TYPE_NAMES[o.type] ?? o.type} ${o.count}`).join('，'),
        ];
      }),
    ),
    '',
  );
  if (balanced !== undefined) {
    out.push('均衡玩法按购买种类：', '');
    out.push(
      ...table(
        ['种类', '次数', '价格中位数', '间隔中位数（天）', '间隔最大（天）', '攒钱最大（天）'],
        balanced.purchaseTypes.map((t) => [TYPE_NAMES[t.type] ?? t.type, `${t.count}`, fm(t.priceMedian, 0), fm(t.gapDaysMedian, 2), fm(t.gapDaysMax, 2), fm(t.savingDaysMax, 2)]),
      ),
      '',
    );
  }

  out.push('## 六 固定玩法能不能在目标时间内把老街和写字楼区都做到三星', '');
  out.push('目标时间是写字楼区三星的 45 到 60 分钟。表里是两个片区都到过三星的局占的比例（到某个时间之前），以及两个片区都到过三星的时间的分位数。', '');
  out.push(
    ...table(
      ['玩法', '60 分钟前', '72 分钟前', `${summary.days * 6} 分钟前（局内）`, '时间：中位数 (下四分位~上四分位)', `局末写字楼区星级（局数）`],
      summary.policies.map((p) => {
        const f = p.fixed;
        return [
          p.name,
          fp(f.within60),
          fp(f.within72),
          fp(f.withinHorizon),
          `${fm(f.bothThree.p50)} (${fm(f.bothThree.p25)}~${fm(f.bothThree.p75)})`,
          Object.entries(f.finalOfficeStars)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}:${v}`)
            .join(' '),
        ];
      }),
    ),
    '',
  );

  if (balanced !== undefined) {
    out.push('## 七 均衡玩法逐天（各局的中位数）', '');
    const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '-' : `${v}%`);
    const starOf = (d: DailyStat, k: number): string => ((d.openShare[k] ?? 0) >= 0.5 ? fm(d.stars[k] ?? null, 0) : '-');
    out.push(
      ...table(
        ['天', '日结前余额', '进账', '花费', '站数', '飞机数', '老街星', '老街准时率', '写字楼区开通', '写字楼区星', '写字楼区准时率', '大学城开通', '大学城星', '大学城准时率'],
        balanced.daily.map((d) => [
          `${d.day}`,
          fm(d.balance, 0),
          fm(d.income, 0),
          fm(d.spent, 0),
          fm(d.stations, 0),
          fm(d.drones, 0),
          fm(d.stars[0] ?? null, 0),
          pct(d.onTimePct[0]),
          fp(d.openShare[1] ?? null),
          starOf(d, 1),
          pct(d.onTimePct[1]),
          fp(d.openShare[2] ?? null),
          starOf(d, 2),
          pct(d.onTimePct[2]),
        ]),
      ),
      '',
    );
  }

  out.push('## 八 结局', '');
  out.push(
    `三个片区全部四星的时间（一倍速，分钟）和到达的比例。目标是均衡玩法的中位数在 ${GOALS.endingMinutes[0]} 到 ${GOALS.endingMinutes[1]} 分钟，` +
      `四种不需要判断的玩法在 ${GOALS.weakWithin} 分钟内到达的比例都不超过 ${fp(GOALS.weakShare)}。局内没有到达的当作无穷大，所以「-」表示这个分位数上的局没有到达。`,
    '',
  );
  out.push(
    ...table(
      ['玩法', '局内到达', '中位数 (下四分位~上四分位)', '120 分钟前', '150 分钟前', `${GOALS.weakWithin} 分钟前`],
      summary.policies.map((p) => {
        const e = p.ending;
        return [p.name, `${e.reached}/${e.runs}（${fp(e.reached / Math.max(1, e.runs))}）`, `${fm(e.p50)} (${fm(e.p25)}~${fm(e.p75)})`, fp(e.within120), fp(e.within150), fp(e.within180)];
      }),
    ),
    '',
  );

  out.push('## 九 各片区在两场高峰里的订单占比', '');
  out.push(
    '每个时期从一件事发生之后的第一个整天算起，订单按下单时间落在午高峰还是晚高峰的时段分，按送往的片区合并全部种子。' +
      '「写字楼区开通后」到大学城开通之前为止，「大学城开通后」到结局那一天为止（没到结局的局到局末），「结局之后」到局末。' +
      '最后四列是每个（局、天）里单场高峰订单最多的片区占的比例。',
    '',
  );
  const shareCells = (counts: readonly number[]): string => {
    const sum = counts.reduce((a, b) => a + b, 0);
    return sum === 0 ? '-' : counts.map((n) => `${((n / sum) * 100).toFixed(0)}`).join(' / ');
  };
  const shareRows: string[][] = [];
  for (const p of summary.policies) {
    const phases: [string, ShareRow][] = [
      ['写字楼区开通后', p.shares.twoDistricts],
      ['大学城开通后', p.shares.campus],
      ['结局之后', p.shares.after],
    ];
    for (const [name, row] of phases) {
      if (row.days === 0) continue;
      shareRows.push([
        p.name,
        name,
        `${row.runs}`,
        shareCells(row.noon),
        shareCells(row.evening),
        `${fp(row.topNoon.p50)} / ${fp(row.topNoon.p75)}`,
        `${fp(row.topEvening.p50)} / ${fp(row.topEvening.p75)}`,
      ]);
    }
  }
  out.push(...table(['玩法', '时期', '局数', '午高峰 老街 / 写字楼区 / 大学城（%）', '晚高峰 老街 / 写字楼区 / 大学城（%）', '午高峰最大片区：中位数 / 上四分位', '晚高峰最大片区：中位数 / 上四分位'], shareRows), '');

  out.push('## 十 校准目标的核对', '');
  out.push(...table(['目标', '这一批的数值', '达到'], goalChecks(summary).map((c) => [c.goal, c.value, c.pass ? '是' : '否'])), '');
  return out.join('\n') + '\n';
}

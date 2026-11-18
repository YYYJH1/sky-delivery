// 推演：购买前的对照计算。给定一个经营模式的状态和一个选项（核心的一条命令），
// 用若干套订单序列分别运行「带选项」和「不带选项」两份状态，比较接下来两场高峰的小结，说明这个选项是更好、更差还是差别不明显。
// 全部是纯函数，只读输入的状态，不写存档，不属于游戏状态，不进状态哈希。界面通过 forecast-client.ts 在后台线程里调用。
//
// 做法：对每一套订单序列 r，把状态复制成两份，两份的订单随机数流（state.rng.orders）都换成同一套新序列，
// 其中一份先执行选项，然后两份都推进到接下来第二场高峰的小结生成之后。订单随机数流只管来什么订单，
// 派单的随机数流不动，所以两份状态里的订单完全相同，两个结果是同一批订单上的配对比较，差别只来自选项。
//
// 比较的量：推进期间新生成的小结记录里，准时单数的合计和收入的合计，带选项的减去不带选项的。
//
// 订单序列的种子：由状态里的 config.seed 和 step，再加上序列编号 r 和盐 salt，经整数混合得到（见 sequenceSeed）。
// 同一个状态、同一个 r、同一个盐，种子相同，同一个局面推演两次的结果相同。盐不同，序列互不相关：推演用 0，
// 核对方向用的「真值」用另一个盐，序列与推演的不同。种子不含购买记录，同一步上先后推演不同的选项时用的是同一批序列。
//
// 结论按符号检验：更好的次数不少于门槛时为「更好」，更差的次数不少于门槛时为「更差」，其余为「差别不明显」。
// 门槛是双侧 5% 水平下的最小次数（见 signTestThreshold），16 套时为 13。
//
// 复制要快：已经送达或退单的订单不会再变，两份状态和输入的状态共用这些订单对象，只复制尚无结果的订单和状态的其余部分。
// 整局的订单占状态的大头，第 30 天的局面有七千多张订单，其中绝大多数已有结果。
// 核心不得往已有结果的订单里写。tests/forecast.test.ts 用完整的 structuredClone 对照每一步的状态哈希，并把共用的订单冻结后整段推演，核对这一点。
//
// 推进要快：两份副本都用轻量的一步（核心的 stepLight）。它只比 step 少算派单里「按下单顺序的比较名单」和「提前派出」的记录，
// 这些记录只进统计和小结的文字。推演只读小结记录里的准时单数和收入，派给哪架飞机、起降、进账都与 step 逐位相同，所以结果不变。
// ForecastParams.light 设为 false 时改用 step，测试和耗时对照用。
import { OrderStatus, applyCommand, createRng, dayOf, quoteCommand, step, stepLight, summaryStep } from '../core/index.ts';
import type { Command, CommandFailure, Order, PeakName, SimState } from '../core/index.ts';

/** 订单序列数的默认值。以后从内容表读，现在由调用方传入。 */
export const DEFAULT_SEQUENCES = 16;

/** 推进到接下来第几场高峰的小结生成之后。当前正在进行的高峰算作第一场。 */
export const HORIZON_PEAKS = 2;

/** 符号检验的显著性水平，双侧。 */
export const SIGN_TEST_LEVEL = 0.05;

const PEAKS: readonly PeakName[] = ['noon', 'evening'];

export type ForecastVerdict = 'better' | 'worse' | 'unclear';

/**
 * 推演用时的累计，给耗时测量用。调用方用 emptyTiming 建一个全零的对象传进来，推演把用时加进去。单位是毫秒。
 * src/app 里的文件不读系统时钟，时钟由调用方给（工具里传 performance.now）。
 */
export interface ForecastTiming {
  /** 读时钟，返回毫秒 */
  clock: () => number;
  /** 复制状态、换订单随机数流、执行选项的用时 */
  copyMs: number;
  /** 推进两份状态的用时 */
  advanceMs: number;
  /** 复制了几次状态 */
  copies: number;
  /** 推进了多少步，两份状态各算 */
  steps: number;
}

export function emptyTiming(clock: () => number): ForecastTiming {
  return { clock, copyMs: 0, advanceMs: 0, copies: 0, steps: 0 };
}

export interface ForecastParams {
  /** 订单序列数，默认 DEFAULT_SEQUENCES */
  sequences?: number;
  /** 订单序列的盐，默认 0。盐不同，序列互不相关 */
  salt?: number;
  /** 只算序列编号在 [from, to) 里的几套，默认全部。分给几个线程各算一段时用，见 forecastPartRuns */
  range?: { from: number; to: number };
  /** 状态的复制方式，默认共用已有结果的订单。测试和耗时对照用 */
  copy?: StateCopier;
  /** 两份副本是否用轻量的一步推进（核心的 stepLight），默认是。结果与不轻量时逐位相同，false 只给测试和耗时对照用 */
  light?: boolean;
  /** 给了就把用时累加进去 */
  timing?: ForecastTiming;
}

/** 一个选项在一段序列上的原始结果。几段合起来由 mergeForecast 得出 ForecastResult。 */
export interface ForecastPart {
  ok: true;
  /** 这一段第一套序列的编号：onTimeDiffs 和 revenueDiffs 的第 0 项就是这一套 */
  from: number;
  onTimeDiffs: number[];
  revenueDiffs: number[];
  startStep: number;
  endStep: number;
  price: number;
}

/** 一次推演的结果。 */
export interface ForecastDone {
  ok: true;
  /** 订单序列数 */
  sequences: number;
  /** 每套订单序列上的准时单数差：带选项的减去不带选项的，按序列编号排 */
  onTimeDiffs: number[];
  /** 每套订单序列上的收入差，次序相同 */
  revenueDiffs: number[];
  /** 准时单数差大于 0 的套数 */
  better: number;
  /** 准时单数差小于 0 的套数 */
  worse: number;
  /** 准时单数差等于 0 的套数 */
  tied: number;
  /** 准时单数差的平均值 */
  meanOnTime: number;
  /** 收入差的平均值 */
  meanRevenue: number;
  verdict: ForecastVerdict;
  /** 判「更好」或「更差」所需的最少套数，即这个序列数下符号检验的门槛 */
  threshold: number;
  /** 推演开始时的步 */
  startStep: number;
  /** 两份状态推进到的步：第二场高峰的小结生成之后，也就是小结时刻加一 */
  endStep: number;
  /** 每份状态推进的步数，等于 endStep 减 startStep */
  steps: number;
  /** 选项现在的价格，不收费的命令为 0。资金不足时也给出价格 */
  price: number;
}

/** 无法推演：选项在这个状态下不能执行，reason 是核心给的失败原因代码。资金不足不算，资金不足的项目照样推演。 */
export interface ForecastUnavailable {
  ok: false;
  reason: CommandFailure;
}

export type ForecastResult = ForecastDone | ForecastUnavailable;

// ---- 复制 ----

/** 复制状态的方式。 */
export type StateCopier = (state: SimState) => SimState;

/** 完整复制：整个状态用 structuredClone 深复制。 */
export const copyFull: StateCopier = (state) => structuredClone(state);

/** 订单已经有结果：送达或退单。之后核心不再改它。 */
function resolved(order: Order): boolean {
  return order.status === OrderStatus.Delivered || order.status === OrderStatus.Cancelled;
}

/**
 * 共用复制：已有结果的订单在输入的状态和副本之间共用同一个对象，尚无结果的订单和状态的其余部分都是深复制。
 * 订单数组本身是新的，副本里新增的订单不会出现在输入的状态里。订单只有数字和布尔字段，展开一层就是深复制。
 * 统计里按秒累计的三张表（等降落架数、空停机位数、停机位总数）每个站一行，行里只有数字，用 slice 复制，比 structuredClone 快得多。
 * 键的顺序与输入的状态相同，副本的对象形状和完整复制一致。
 */
export const copyShared: StateCopier = (state) => {
  const { stats } = state;
  const none: number[][] = [];
  const copy = structuredClone({ ...state, orders: [] as Order[], stats: { ...stats, landWait: none, bayEmpty: none, bayTotal: none } });
  const orders = state.orders.slice();
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i] as Order;
    if (!resolved(order)) orders[i] = { ...order };
  }
  copy.orders = orders;
  copy.stats.landWait = stats.landWait.map((row) => row.slice());
  copy.stats.bayEmpty = stats.bayEmpty.map((row) => row.slice());
  copy.stats.bayTotal = stats.bayTotal.map((row) => row.slice());
  return copy;
};

// ---- 订单序列的种子 ----

/** 把一个 32 位整数折进哈希，一步里高低位互相影响。 */
function mix(hash: number, value: number): number {
  let h = Math.imul(hash ^ (value | 0), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  return h | 0;
}

/**
 * 第 index 套订单序列的种子：把 config.seed、step、盐和 index 依次混合。
 * 只由这四个数决定，所以同一个状态、同一个 index 和盐，种子相同。给 createRng 展开成订单随机数流。
 */
export function sequenceSeed(state: SimState, index: number, salt = 0): number {
  let h = 0x2545f491;
  h = mix(h, state.config.seed);
  h = mix(h, state.step);
  h = mix(h, salt);
  h = mix(h, index);
  return h;
}

// ---- 推进的终点 ----

/**
 * 推演推进到的步：从 from 起往后数第二个小结时刻，再加一。小结在那一步的日程阶段生成，所以推进到 at + 1 步之前才算生成之后。
 * 小结时刻等于 from 时算第一个，因为那一步还没有执行，小结还没有生成。当前正在进行的高峰（下单时段第一步到小结时刻之间）因此算第一场。
 */
export function forecastEndStep(from: number): number {
  let found = 0;
  const firstDay = dayOf(from);
  for (let day = firstDay; day <= firstDay + HORIZON_PEAKS; day++) {
    for (const peak of PEAKS) {
      const at = summaryStep(day, peak);
      if (at < from) continue;
      found += 1;
      if (found === HORIZON_PEAKS) return at + 1;
    }
  }
  throw new Error('no summary step found');
}

// ---- 结论的门槛 ----

/**
 * 符号检验的门槛：序列数为 sequences 时，双侧 5% 水平下，判定「更好」或「更差」所需的最少套数。
 * 零假设是每一套里更好和更差的机会各占一半，次数服从二项分布 B(n, 1/2)。门槛是最小的 k，使得 2 × P(X ≥ k) 不大于 5%。
 * 16 套时 P(X ≥ 13) = 697 / 65536 = 1.06%，双侧 2.13%，P(X ≥ 12) = 3.84%，双侧 7.68%，所以门槛是 13。
 * 序列数不超过 5 时任何次数都达不到 5%，返回 sequences + 1，表示怎么都判不出来。
 */
export function signTestThreshold(sequences: number): number {
  const n = sequences;
  // 二项分布的概率质量，在对数域里递推，序列数大时也不下溢
  const pmf: number[] = [];
  let logChoose = 0;
  for (let j = 0; j <= n; j++) {
    pmf.push(Math.exp(logChoose - n * Math.LN2));
    if (j < n) logChoose += Math.log(n - j) - Math.log(j + 1);
  }
  let tail = 0;
  let threshold = n + 1;
  for (let k = n; k >= 1; k--) {
    tail += pmf[k] as number;
    if (2 * tail > SIGN_TEST_LEVEL) break;
    threshold = k;
  }
  return threshold;
}

/** 结论。更好和更差的次数都不到门槛时为差别不明显。 */
export function verdictOf(better: number, worse: number, sequences: number): ForecastVerdict {
  const need = signTestThreshold(sequences);
  if (better >= need) return 'better';
  if (worse >= need) return 'worse';
  return 'unclear';
}

// ---- 汇总 ----

/** 由每套序列上的差得出结果。eval 工具也用它，从更多套序列里取前几套看较少序列数的结果。 */
export function summarizeForecast(
  onTimeDiffs: readonly number[],
  revenueDiffs: readonly number[],
  where: { startStep: number; endStep: number; price: number },
): ForecastDone {
  const sequences = onTimeDiffs.length;
  let better = 0;
  let worse = 0;
  let onTimeSum = 0;
  let revenueSum = 0;
  for (let i = 0; i < sequences; i++) {
    const d = onTimeDiffs[i] as number;
    if (d > 0) better += 1;
    else if (d < 0) worse += 1;
    onTimeSum += d;
    revenueSum += revenueDiffs[i] as number;
  }
  return {
    ok: true,
    sequences,
    onTimeDiffs: onTimeDiffs.slice(),
    revenueDiffs: revenueDiffs.slice(),
    better,
    worse,
    tied: sequences - better - worse,
    meanOnTime: onTimeSum / sequences,
    meanRevenue: revenueSum / sequences,
    verdict: verdictOf(better, worse, sequences),
    threshold: signTestThreshold(sequences),
    startStep: where.startStep,
    endStep: where.endStep,
    steps: where.endStep - where.startStep,
    price: where.price,
  };
}

// ---- 一套订单序列上的两份状态 ----

/** 复制状态，订单随机数流换成 seed 展开的新序列。 */
export function openCopy(state: SimState, seed: number, copier: StateCopier = copyShared): SimState {
  const copy = copier(state);
  copy.rng.orders = createRng(seed);
  return copy;
}

/**
 * 在副本上执行选项。资金不足时先把余额补到刚好够，价签的开放不用补：副本复制自输入的状态，开放的情况相同，
 * 价签没开放的状态本来就买不了，推演之前的报价已经把它拦下了（见 forecastRuns）。
 * 返回 null 表示执行了，否则是失败原因。
 */
export function applyOption(copy: SimState, option: Command, price: number, short: boolean): CommandFailure | null {
  if (short && copy.campaign !== null) copy.campaign.money = price;
  const result = applyCommand(copy, option);
  return result.ok ? null : result.reason;
}

/** 推进到第 endStep 步之前，也就是 step 等于 endStep 时停下。light 为真时每一步用轻量的 stepLight，缺省用 step。 */
export function advanceTo(copy: SimState, endStep: number, light = false): void {
  if (light) while (copy.step < endStep) stepLight(copy);
  else while (copy.step < endStep) step(copy);
}

interface Outcome {
  onTime: number;
  revenue: number;
}

/** 推进期间新生成的小结记录里，准时单数和收入的合计。from 是推进之前已有的记录数。 */
function outcomeOf(state: SimState, from: number): Outcome {
  const peaks = state.campaign?.peaks ?? [];
  let onTime = 0;
  let revenue = 0;
  for (let i = from; i < peaks.length; i++) {
    const record = peaks[i];
    if (record === undefined) continue;
    onTime += record.onTime;
    revenue += record.revenue;
  }
  return { onTime, revenue };
}

/** 推演中还在算的一个选项。 */
interface Live {
  index: number;
  option: Command;
  price: number;
  short: boolean;
  onTime: number[];
  revenue: number[];
}

/**
 * 对一个或几个选项逐套订单序列推演，只算序列编号在 params.range 里的几套（默认全部），返回每个选项在这一段上的原始结果。
 * 每算完一套序列让出一次，值是这一段里已经算完的套数，调用方可以在两套之间停下，后台线程靠这个在两套之间处理取消。
 * 几个选项放在一起算时，同一套序列上不带选项的那一份只运行一次，几个选项共用。
 * sequences 是总序列数，种子和结论的门槛都按它算，与 range 无关，所以分成几段分别算再合并，结果与一次算完的完全相同。
 */
export function* forecastPartRuns(
  state: SimState,
  options: readonly Command[],
  params: ForecastParams = {},
): Generator<number, (ForecastPart | ForecastUnavailable)[], undefined> {
  const sequences = params.sequences ?? DEFAULT_SEQUENCES;
  if (!Number.isInteger(sequences) || sequences < 1) throw new RangeError('sequences must be a positive integer');
  const from = params.range?.from ?? 0;
  const to = params.range?.to ?? sequences;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > sequences) throw new RangeError('range must lie within the sequences');
  const salt = params.salt ?? 0;
  const copier = params.copy ?? copyShared;
  const light = params.light ?? true;
  const timing = params.timing;

  // 先用只读的报价筛一遍：条件不满足的选项直接无法推演，资金不足的照样推演
  const results: (ForecastPart | ForecastUnavailable | null)[] = options.map(() => null);
  let live: Live[] = [];
  options.forEach((option, index) => {
    const quote = quoteCommand(state, option);
    if (!quote.ok && quote.reason !== 'notEnoughMoney') {
      results[index] = { ok: false, reason: quote.reason ?? 'unknownCommand' };
      return;
    }
    live.push({ index, option, price: quote.price, short: !quote.ok, onTime: [], revenue: [] });
  });

  const startStep = state.step;
  const endStep = forecastEndStep(startStep);
  const firstRecord = state.campaign?.peaks.length ?? 0;
  /** 距上一次调用的毫秒数，没有计时时为 0 */
  let mark = 0;
  const lap = (): number => {
    if (timing === undefined) return 0;
    const now = timing.clock();
    const elapsed = now - mark;
    mark = now;
    return elapsed;
  };

  for (let r = from; r < to && live.length > 0; r++) {
    const seed = sequenceSeed(state, r, salt);

    lap();
    const base = openCopy(state, seed, copier);
    if (timing !== undefined) {
      timing.copyMs += lap();
      timing.copies += 1;
    }
    advanceTo(base, endStep, light);
    if (timing !== undefined) {
      timing.advanceMs += lap();
      timing.steps += endStep - startStep;
    }
    const baseOutcome = outcomeOf(base, firstRecord);

    const failed: Live[] = [];
    for (const item of live) {
      lap();
      const copy = openCopy(state, seed, copier);
      const reason = applyOption(copy, item.option, item.price, item.short);
      if (timing !== undefined) {
        timing.copyMs += lap();
        timing.copies += 1;
      }
      if (reason !== null) {
        // 报价通过而执行失败：副本复制自输入的状态，不应出现。出现了就当作无法推演，不再算这个选项
        results[item.index] = { ok: false, reason };
        failed.push(item);
        continue;
      }
      advanceTo(copy, endStep, light);
      if (timing !== undefined) {
        timing.advanceMs += lap();
        timing.steps += endStep - startStep;
      }
      const outcome = outcomeOf(copy, firstRecord);
      item.onTime.push(outcome.onTime - baseOutcome.onTime);
      item.revenue.push(outcome.revenue - baseOutcome.revenue);
    }
    if (failed.length > 0) live = live.filter((item) => !failed.includes(item));
    yield r - from + 1;
  }

  for (const item of live) {
    results[item.index] = { ok: true, from, onTimeDiffs: item.onTime, revenueDiffs: item.revenue, startStep, endStep, price: item.price };
  }
  return results as (ForecastPart | ForecastUnavailable)[];
}

/**
 * 把各段的原始结果合成最终的结果。各段要连续地盖住 [0, sequences)，次序不限。任何一段是无法推演，结果就是无法推演。
 * 合成之后与一次算完的完全相同，后台线程分段并行靠这个。
 */
export function mergeForecast(sequences: number, parts: readonly (ForecastPart | ForecastUnavailable)[]): ForecastResult {
  const unavailable = parts.find((p): p is ForecastUnavailable => !p.ok);
  if (unavailable !== undefined) return unavailable;
  const ok = (parts as readonly ForecastPart[]).slice().sort((a, b) => a.from - b.from);
  const head = ok[0];
  if (head === undefined) throw new RangeError('no parts to merge');
  const onTime: number[] = [];
  const revenue: number[] = [];
  for (const p of ok) {
    if (p.from !== onTime.length) throw new RangeError('parts must cover the sequences without gaps or overlaps');
    onTime.push(...p.onTimeDiffs);
    revenue.push(...p.revenueDiffs);
  }
  if (onTime.length !== sequences) throw new RangeError('parts must cover all sequences');
  return summarizeForecast(onTime, revenue, { startStep: head.startStep, endStep: head.endStep, price: head.price });
}

/**
 * 对一个或几个选项逐套订单序列推演，算全部序列。每算完一套序列让出一次，值是已经算完的套数。返回值是每个选项的结果，次序与 options 相同。
 * 几个选项放在一起算时，同一套序列上不带选项的那一份只运行一次，几个选项共用，结果与逐个推演的完全相同。
 */
export function* forecastRuns(state: SimState, options: readonly Command[], params: ForecastParams = {}): Generator<number, ForecastResult[], undefined> {
  if (params.range !== undefined) throw new RangeError('forecastRuns computes every sequence, use forecastPartRuns for a range');
  const sequences = params.sequences ?? DEFAULT_SEQUENCES;
  const parts = yield* forecastPartRuns(state, options, params);
  return parts.map((part) => mergeForecast(sequences, [part]));
}

/** 几个选项一起推演，同一套序列上不带选项的那一份只运行一次。结果与逐个调用 forecast 的相同。 */
export function forecastBatch(state: SimState, options: readonly Command[], params: ForecastParams = {}): ForecastResult[] {
  const run = forecastRuns(state, options, params);
  for (;;) {
    const next = run.next();
    if (next.done === true) return next.value;
  }
}

/**
 * 推演一个选项。输入的状态不修改。选项在这个状态下不能执行时返回无法推演和失败原因，资金不足的选项照样推演。
 * 在后台线程里调用时用 forecast-client.ts。
 */
export function forecast(state: SimState, option: Command, params: ForecastParams = {}): ForecastResult {
  return forecastBatch(state, [option], params)[0] as ForecastResult;
}

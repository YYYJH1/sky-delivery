// 从游戏状态得出要播的声音。全部是只读的纯函数：不改状态，不读时钟，不碰浏览器。
// 做法分两步：takeSnapshot 把状态里和声音有关的事实抄成一个很小的快照，soundsBetween 比较上一次和这一次的快照，
// 给出这段时间里发生了哪些值得出声的事。限频在 limiter.ts，播放在 player.ts。
import { DAY_STEPS, DroneState, PROMISE_STEPS, TAKEOFF_STEPS, peakAt, resultStep, ruleSetInForce } from '../core/index.ts';
import type { Order, SimState } from '../core/index.ts';
import { SOUND_IDS, SOUND_INFO } from './catalog.ts';
import type { SoundId } from './catalog.ts';

/** 夜间从一天里的第几步开始。游戏的一天从 9:30 到 21:30，每个游戏分钟 5 步，第 2850 步是 19:00。 */
export const NIGHT_FROM_TICK = 2850;

/** 两次观察之间隔了这么多步以上，当作状态被换掉了（读档、导入），只记下新的快照，不出声。正常运行时每帧最多推进几十步。 */
export const MAX_GAP_STEPS = 120;

/** 快照里保留最近这么多步内完成的订单，不能小于 MAX_GAP_STEPS。 */
export const RECENT_STEPS = 120;

/** 订单从下单到有结果最多隔多久：不到 90 秒没人取就退单，取走之后飞到楼不过几十秒。订单按下单的先后编号，往回找到比这更早的就可以停。 */
const MAX_ORDER_LIFE = DAY_STEPS;

/** 一张订单的结果。 */
export interface OrderResult {
  /** 结果产生的步。 */
  readonly step: number;
  /** onTime 在承诺时间内送达，late 超时送达，cancel 退单。 */
  readonly kind: 'onTime' | 'late' | 'cancel';
  /** 大单（份量不止一份）。 */
  readonly big: boolean;
}

/** 状态里和声音有关的事实。是普通对象，不引用状态本身，之后状态怎么变都不影响它。 */
export interface AudioSnapshot {
  /** 状态所在的步。 */
  readonly step: number;
  /** 这一步是不是在夜间。 */
  readonly night: boolean;
  /** 这一步落在哪个高峰（PeakId），不在高峰里为 -1。 */
  readonly peak: number;
  /** 正在起飞的飞机里，最近一次起飞开始的步，没有为 -1。 */
  readonly takeoffStep: number;
  /** 最近 RECENT_STEPS 步内完成的订单，按结果产生的先后。 */
  readonly results: readonly OrderResult[];
  /** 玩家换策略卡的累计次数（核心只记现在生效的那一套）。 */
  readonly ruleChanges: number;
  /** 午、晚两套策略的内容。没有分成两套时为 null。 */
  readonly ruleSets: readonly [string, string] | null;
  /** 现在生效的是哪一套：0 午，1 晚。没有分成两套时为 -1。 */
  readonly ruleSetInForce: number;
  /** 高峰小结的数量。 */
  readonly peaks: number;
  /** 各片区的星级。 */
  readonly stars: readonly number[];
  /** 已读的便签数。 */
  readonly tipsRead: number;
}

/** 这一步是不是在夜间。 */
export function isNight(step: number): boolean {
  return step % DAY_STEPS >= NIGHT_FROM_TICK;
}

/** 把状态里和声音有关的事实抄成快照。只读状态。沙盒模式没有经营模式的那些字段，对应的项是 0、空或 null。 */
export function takeSnapshot(state: SimState): AudioSnapshot {
  const step = state.step;
  let takeoffStep = -1;
  for (const drone of state.drones) {
    if (drone.removed || drone.state !== DroneState.Takeoff) continue;
    const started = drone.tEnd - TAKEOFF_STEPS;
    if (started > takeoffStep) takeoffStep = started;
  }
  const results: OrderResult[] = [];
  const orders = state.orders;
  for (let i = orders.length - 1; i >= 0; i--) {
    const order = orders[i] as Order;
    if (order.tOrder < step - MAX_ORDER_LIFE) break;
    const at = resultStep(order);
    if (at < 0 || at < step - RECENT_STEPS) continue;
    const kind = order.tDeliver < 0 ? 'cancel' : order.tDeliver - order.tOrder <= PROMISE_STEPS ? 'onTime' : 'late';
    results.push({ step: at, kind, big: order.portion >= 2 });
  }
  results.sort((a, b) => a.step - b.step);
  const campaign = state.campaign;
  const sets = campaign?.ruleSets ?? null;
  return {
    step,
    night: isNight(step),
    peak: peakAt(step),
    takeoffStep,
    results,
    ruleChanges: state.stats.ruleChanges.length,
    ruleSets: sets === null ? null : [ruleKey(sets.noon), ruleKey(sets.evening)],
    ruleSetInForce: sets === null ? -1 : ruleSetInForce(state) === 'noon' ? 0 : 1,
    peaks: campaign?.peaks.length ?? 0,
    stars: campaign?.districts.map((d) => d.star) ?? [],
    tipsRead: campaign?.tips.reduce((n, tip) => n + (tip.read ? 1 : 0), 0) ?? 0,
  };
}

function ruleKey(rules: { select: string; zone: string; pool: string }): string {
  return `${rules.select}|${rules.zone}|${rules.pool}`;
}

/** 还没有生效的那一套策略被改了。两次快照里它都不是现在生效的那一套，所以午晚切换本身不算。 */
function otherSetChanged(prev: AudioSnapshot, cur: AudioSnapshot): boolean {
  if (prev.ruleSets === null || cur.ruleSets === null) return false;
  for (const set of [0, 1] as const) {
    if (prev.ruleSets[set] !== cur.ruleSets[set] && prev.ruleSetInForce !== set && cur.ruleSetInForce !== set) return true;
  }
  return false;
}

/**
 * 上一次到这一次之间发生了哪些值得出声的事。每种声音最多出现一次，优先级高的在前。没有上一次快照时为空。
 *
 * 世界里的声音（起飞、送达、退单、高峰开始、高峰小结、升星）只在游戏的步前进了才会有，
 * 所以游戏暂停时不会出新的声音。玩家自己的操作带来的两种声音（换策略卡、便签读过收起）不受暂停影响。
 * 步退回去了，或者隔了 MAX_GAP_STEPS 步以上，说明状态被换掉了，这时什么也不出。
 */
export function soundsBetween(prev: AudioSnapshot | null, cur: AudioSnapshot): SoundId[] {
  if (prev === null) return [];
  const gap = cur.step - prev.step;
  if (gap < 0 || gap > MAX_GAP_STEPS) return [];
  const found = new Set<SoundId>();
  if (gap > 0) {
    if (cur.takeoffStep >= prev.step) found.add('takeoff');
    for (const result of cur.results) {
      if (result.step < prev.step || result.step >= cur.step) continue;
      if (result.kind === 'cancel') found.add('cancel');
      else if (result.big) found.add('bigOrder');
      else if (result.kind === 'onTime') found.add('onTime');
    }
    if (cur.peak >= 0 && cur.peak !== prev.peak) found.add('peakStart');
    if (cur.peaks > prev.peaks) found.add('summary');
    if (cur.stars.length === prev.stars.length && cur.stars.some((star, i) => star > (prev.stars[i] as number))) found.add('starUp');
  }
  if (cur.ruleChanges > prev.ruleChanges || otherSetChanged(prev, cur)) found.add('rule');
  if (cur.tipsRead > prev.tipsRead) found.add('noteRead');
  return SOUND_IDS.filter((id) => found.has(id)).sort((a, b) => SOUND_INFO[b].priority - SOUND_INFO[a].priority);
}

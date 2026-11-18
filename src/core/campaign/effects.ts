// 效果记录：购买改装之后的几次日结里（内容表 FORECAST_V1.effectDays，值为 3），写出这项改装直接对应的指标，现在的数和不购买时的数。
// 三种改装各有一个指标，都取自高峰小结的记录，不另行模拟，也不影响派单和任何决定：
// - 起降口升级：这座站的起降排队秒数，取小结记录里这座站的一行（PeakStationRow.gateWait）
// - 双层货箱：全场每趟单数，已送达的订单数除以各站放行起飞的架次合计
// - 就近降落：全场回站飞行占机队时间的百分数（PeakRecord.fleetBack）。只算送完单飞回站的这一段，不含去店铺取餐的飞行。
//   就近降落缩短的是回站这一段，空载飞行里去取餐的一段受订单分布影响，把它算进来，对照的方向不稳
// 就近降落的开关、买无人机、加停机位和建站不记。
// 「不购买时」的数来自副本：会话层（src/app/twins.ts）在购买之前复制一份状态，之后与主状态逐步同推，玩家的其他命令也做给它。
// 主状态和副本在同一步生成同一场高峰的小结之后，会话层用副本的小结记录调用 recordTwin，把副本这一场的指标记进跟踪。
// 核心不持有副本，也不推进它。不拿购买前的数当对照：购买前后相隔几天，订单量随升星增长，每天的订单又有随机波动，这些盖过了改装的作用。
// 购买成功时记一条跟踪（watchPurchase），购买前的数值取购买时最近一场小结记录，同时记下那一场是午高峰还是晚高峰。
// 日结时（settleEffects）每条跟踪写一行，现在的数值取最近一场与购买前那一场同类、并且晚于它的小结记录，不购买时的数取副本在同一场的数。
// 写满 effectDays 行后删掉。
import { FORECAST_V1 } from '../../content/forecast_v1.ts';
import { dayOf } from '../systems/schedule.ts';
import type { EffectKind, EffectLine, EffectWatch, PeakRecord, SimState } from '../types.ts';

/**
 * 一场小结记录里一项改装对应的指标，记录里没有这项数据时为 null。
 * 存档格式 3 以前的记录没有各站的一行、机队时间构成和回站飞行占比，所以三种指标都为 null。
 * 返回的是原始的数，不取整：起降排队是秒，每趟单数是小数，回站飞行是下取整的百分数。
 */
export function effectValue(kind: EffectKind, station: number | null, record: PeakRecord): number | null {
  switch (kind) {
    case 'gate':
      // 这座站在这一场里没有已送达的订单，或者这一场还没有这座站（后来才建的），都没有数
      return record.stations.find((row) => row.station === station)?.gateWait ?? null;
    case 'doubleBox': {
      let sorties = 0;
      for (const row of record.stations) sorties += row.sorties;
      return sorties === 0 ? null : (record.onTime + record.late - record.lateOpen) / sorties;
    }
    case 'nearest':
      // 没有无人机时为 null，与机队时间构成同时为 null
      return record.fleetBack;
  }
}

/**
 * 购买成功时记一条效果跟踪。购买前的数值取最近一场小结记录，没有小结记录时都记为 null。
 * 在命令改完状态之后调用。只读 campaign.peaks，只往 campaign.effectWatches 里加一条，副本的数（twins）一开始是空的。
 */
export function watchPurchase(state: SimState, kind: EffectKind, station: number | null = null, level: number | null = null): void {
  const campaign = state.campaign;
  if (campaign === null) return;
  const last = campaign.peaks[campaign.peaks.length - 1];
  campaign.effectWatches.push({
    kind,
    step: state.step,
    station,
    level,
    peak: last === undefined ? null : last.peak,
    beforeDay: last === undefined ? null : last.day,
    before: last === undefined ? null : effectValue(kind, station, last),
    left: FORECAST_V1.effectDays,
    twins: [],
  });
}

/**
 * 会话层调用：副本在某一场高峰里生成了小结记录 record，把这项改装在副本里的指标记进跟踪（watch.twins）。
 * 只记与跟踪同类（午高峰或晚高峰）、并且晚于购买前那一场的高峰，日结里用不到的别的场不记。
 * 副本这一场没有这项数据（指标为 null），或者这一场已经记过，也不记。返回有没有记下。
 * 只写这一条跟踪的 twins，不读也不改状态里别的东西，不影响任何决定。
 */
export function recordTwin(watch: EffectWatch, record: PeakRecord): boolean {
  if (watch.peak === null || watch.beforeDay === null || record.peak !== watch.peak || record.day <= watch.beforeDay) return false;
  if (watch.twins.some((t) => t.day === record.day && t.peak === record.peak)) return false;
  const value = effectValue(watch.kind, watch.station, record);
  if (value === null) return false;
  watch.twins.push({ day: record.day, peak: record.peak, value });
  return true;
}

/**
 * 一条跟踪今天要写的一行。购买前、现在或副本的数值没有的时候为 null：这一天不写。
 * 现在的数值取最近一场与购买前那一场同类的小结记录，并且这场必须晚于购买前的那一场：
 * 购买发生在某一场的小结之后，如果日结时最近的同类记录还是这一场，它是购买之前的数，不能当作购买之后的数。
 * 晚于它的同类记录至少隔了一场另一类的高峰，下单时段在购买之后才开始，所以数里没有购买之前的部分。
 * 不购买时的数取副本在同一场的数。读档之后副本已经不在，或者副本作废、被挤掉，这一场没有副本的数，不写，也不占行数。
 */
function lineOf(peaks: readonly PeakRecord[], watch: EffectWatch): EffectLine | null {
  if (watch.peak === null || watch.beforeDay === null || watch.before === null) return null;
  let latest: PeakRecord | undefined;
  for (let i = peaks.length - 1; i >= 0; i--) {
    const record = peaks[i] as PeakRecord;
    if (record.peak === watch.peak) {
      latest = record;
      break;
    }
  }
  if (latest === undefined || latest.day <= watch.beforeDay) return null;
  const after = effectValue(watch.kind, watch.station, latest);
  if (after === null) return null;
  const afterDay = latest.day;
  const twin = watch.twins.find((t) => t.day === afterDay && t.peak === watch.peak);
  if (twin === undefined) return null;
  return {
    kind: watch.kind,
    station: watch.station,
    level: watch.level,
    peak: watch.peak,
    beforeDay: watch.beforeDay,
    afterDay,
    before: watch.before,
    after,
    twin: twin.value,
  };
}

/**
 * 一条跟踪最多等这么多次日结。在高峰小结之后购买时，购买当天的日结还没有更晚的同类记录，第一行从第二次日结起写，
 * 所以写满 effectDays 行要 effectDays + 1 次日结。再留一次余量，期间某一天没有数也能写满。
 */
const WATCH_DAY_ENDS = FORECAST_V1.effectDays + 2;

/**
 * 日结时调用：给每条跟踪写一行，返回这些行，按购买的先后排列。在这一天的小结都生成之后调用，settleDay 里写日结记录时用。
 * 跟踪的剩余次数（left）是还要写几行，只在真的写出一行时减 1，所以不论在一天的什么时候购买，都写满 effectDays 行。
 * 以下三种跟踪删掉：行数写满，购买前没有数（之后也不会有），购买之后已经过了 WATCH_DAY_ENDS 次日结。
 */
export function settleEffects(state: SimState): EffectLine[] {
  const campaign = state.campaign;
  if (campaign === null) return [];
  const lines: EffectLine[] = [];
  for (const watch of campaign.effectWatches) {
    const line = lineOf(campaign.peaks, watch);
    if (line !== null) {
      lines.push(line);
      watch.left -= 1;
    }
  }
  const today = dayOf(state.step);
  campaign.effectWatches = campaign.effectWatches.filter(
    (watch) => watch.left > 0 && watch.before !== null && today - dayOf(watch.step) < WATCH_DAY_ENDS,
  );
  return lines;
}

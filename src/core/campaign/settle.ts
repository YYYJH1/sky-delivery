// 日结：每个游戏日结束时算一次。第 d 天的日结在第 (d + 1) × 3600 步开始时、产生订单之前做，
// 所以新一天的订单量用的是新的星级，升星后新开张的店也从新的一天起能抽到。
// 日结做的事：
// 1 统计今天下单、今天有结果、还没完成的订单数，今天的进账
// 2 口碑：每个开通的片区按最近两天的统计升星或掉星，星级变了就重算开张的店
// 3 记录，包括每个片区的一行、当天各时刻的运力占用和购买改装之后的效果
// 4 靠日结判断的开放项：「调度策略」一栏最晚在第二天的日结时开放，片区的显示，「短程优先」，「{片区}优先」，价签
// 5 结局：三个片区都到了四星
import { MAP_V1 } from '../../content/map_v1.ts';
import { STARS_V1 } from '../../content/stars_v1.ts';
import { UNLOCKS_V1 } from '../../content/unlocks_v1.ts';
import { DAY_STEPS, PROMISE_STEPS } from '../constants.ts';
import type { DayDistrictRecord, DayRecord, Order, SimState } from '../types.ts';
import { settleEffects } from './effects.ts';
import { takeDayBusy } from './fleet.ts';
import { refreshShops } from './map.ts';
import { newShopAt } from './places.ts';
import { MAX_ORDER_LIFE, decideStar, emptyCounts, pct, resultStep, tallyResults, windowOfDay } from './rating.ts';
import type { ResultCounts } from './rating.ts';
import { refreshUnlocks, showKeyOf, unlock } from './unlocks.ts';

/** 今天下单的数量、今天有结果的数量（分准时送达、超时送达、退单）、还没有结果的数量。 */
function countDay(state: SimState, day: number): Pick<DayRecord, 'ordered' | 'resolved' | 'onTime' | 'late' | 'cancelled' | 'pending'> {
  const from = day * DAY_STEPS;
  const to = from + DAY_STEPS;
  let ordered = 0;
  let onTime = 0;
  let late = 0;
  let cancelled = 0;
  let pending = 0;
  const orders = state.orders;
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i] as Order;
    if (o.tOrder < from - MAX_ORDER_LIFE) break;
    if (o.tOrder >= from && o.tOrder < to) ordered += 1;
    const r = resultStep(o);
    if (r < 0) {
      pending += 1;
    } else if (r >= from && r < to) {
      if (o.tDeliver < 0) cancelled += 1;
      else if (o.tDeliver - o.tOrder <= PROMISE_STEPS) onTime += 1;
      else late += 1;
    }
  }
  return { ordered, resolved: onTime + late + cancelled, onTime, late, cancelled, pending };
}

/** 做第 day 天的日结，返回并存下这一天的记录。state.step 应当是 (day + 1) × 3600，日程阶段保证了这一点。 */
export function settleDay(state: SimState, day: number): DayRecord {
  const campaign = state.campaign;
  if (campaign === null) throw new Error('settlement is only for the campaign mode');
  const counts = countDay(state, day);
  const span = windowOfDay(day);
  const byDistrict = tallyResults(state, span.from, span.to);
  const shopsBefore = campaign.shopOpen.slice();

  // 口碑：每个开通的片区按最近两天的统计决定。各片区互不影响
  let changed = false;
  const lines: DayDistrictRecord[] = [];
  campaign.districts.forEach((info, k) => {
    if (!info.open) return;
    const rating = campaign.rating[k] as { misses: number; noUpgrade: number };
    const c = byDistrict[k] ?? emptyCounts();
    const d = decideStar(info.star, rating.misses, rating.noUpgrade, c);
    lines.push({
      district: k,
      kind: d.kind,
      fromStar: info.star,
      star: d.star,
      n: c.n,
      onTime: c.onTime,
      cancelled: c.cancelled,
      onTimePct: pct(c.onTime, c.n),
      cancelPct: pct(c.cancelled, c.n),
      needOnTimePct: d.needOnTimePct,
      needCancelPct: d.needCancelPct,
      newShops: [],
    });
    if (d.star !== info.star) changed = true;
    info.star = d.star;
    rating.misses = d.misses;
    rating.noUpgrade = d.noUpgrade;
  });
  if (changed) {
    // 升星的片区里到了开张星级的店开张，掉星时已经开张的店不关。订单量的倍数从这一刻起（新的一天）用新的星级
    refreshShops(state);
    for (const line of lines) {
      if (line.kind !== 'starUp') continue;
      MAP_V1.shops.forEach((shop, i) => {
        if (shop.district === line.district && !shopsBefore[i] && campaign.shopOpen[i] === true) line.newShops.push(newShopAt(i));
      });
    }
  }

  // 今天的高峰里判过目标的场数，和其中全部达标的场数
  const peaksOfDay = campaign.peaks.filter((p) => p.day === day);
  const record: DayRecord = {
    day,
    step: state.step,
    ...counts,
    income: campaign.income[day] ?? 0,
    districts: lines,
    peaksJudged: peaksOfDay.filter((p) => p.cleared !== null).length,
    peaksCleared: peaksOfDay.filter((p) => p.cleared === true).length,
    busy: takeDayBusy(state), // 读出当天各时刻的占用，并把当天的计数清零
    effects: settleEffects(state), // 购买改装之后的几次日结里，写这项改装对应的指标现在的数值和不购买时的数值
  };
  campaign.days.push(record);

  // 靠日结判断的开放项。便签随开放项一起放出，顺序是：调度台、价签、写字楼区
  if (day >= UNLOCKS_V1.selectLatestDay) unlock(state, 'selectColumn');
  refreshUnlocks(state);
  for (const rule of UNLOCKS_V1.show) {
    const from = campaign.districts[rule.after];
    const key = showKeyOf(rule.district);
    if (from !== undefined && key !== null && from.open && from.star >= rule.star) unlock(state, key);
  }
  const roundtrip = campaign.districts[UNLOCKS_V1.roundtripDistrict];
  if (roundtrip !== undefined && roundtrip.open && roundtrip.star >= UNLOCKS_V1.roundtripStar) unlock(state, 'roundtrip');
  if (prioDistrictOpens(state, byDistrict)) unlock(state, 'prioDistrict');

  if (campaign.ending === null && campaign.districts.every((d) => d.open && d.star >= STARS_V1.endingStar)) {
    campaign.ending = { step: state.step, days: day + 1, orders: campaign.delivered };
  }
  return record;
}

/**
 * 「{片区}优先」的条件：写字楼区连续两次日结没有升星，并且它最近两天的准时率比其他开通片区合在一起的最近两天准时率低 20 个百分点以上。
 * 「以上」按不小于算。写字楼区或其他片区最近两天没有完成的订单时，没法比，不算。
 */
function prioDistrictOpens(state: SimState, byDistrict: readonly ResultCounts[]): boolean {
  const campaign = state.campaign;
  if (campaign === null) return false;
  const k = UNLOCKS_V1.prioDistrict;
  const info = campaign.districts[k];
  const rating = campaign.rating[k];
  if (info === undefined || rating === undefined || !info.open || rating.noUpgrade < UNLOCKS_V1.prioNoUpgrade) return false;
  const office = byDistrict[k] ?? emptyCounts();
  const others = emptyCounts();
  campaign.districts.forEach((d, j) => {
    if (j === k || !d.open) return;
    const c = byDistrict[j] ?? emptyCounts();
    others.n += c.n;
    others.onTime += c.onTime;
  });
  if (office.n === 0 || others.n === 0) return false;
  // 其他片区的准时率 others.onTime / others.n 减去写字楼区的 office.onTime / office.n，不小于 gap / 100
  return 100 * (others.onTime * office.n - office.onTime * others.n) >= UNLOCKS_V1.prioGapPoints * others.n * office.n;
}

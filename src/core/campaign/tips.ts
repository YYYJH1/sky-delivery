// 引导便签：七个时机，每条最多出现一次。
// 核心在时机到来时把一条便签（编号、出现的步、参数）放进 campaign.tips，界面读出来显示，再用 readTip 命令标记已读。
// 已读的便签留在队列里，所以「出现过」永远查得到。编号就是词表 tips 里的键。
import { NOTES_V1 } from '../../content/notes_v1.ts';
import { STEPS_PER_SECOND } from '../constants.ts';
import type { CampaignState, Order, SimState, TipId, TipRecord } from '../types.ts';

/** 七条便签，顺序与词表 tips 里的一致。 */
export const TIP_IDS: readonly TipId[] = [
  'firstOrder',
  'autoDispatchOn',
  'firstRedOrder',
  'boardReady',
  'canAddBay',
  'gateBusy',
  'openOffice',
];

export function hasTip(campaign: CampaignState, id: TipId): boolean {
  return campaign.tips.some((tip) => tip.id === id);
}

/** 放进一条便签，出现的步取现在的步。已经出现过的不再放，返回是不是这次放的。 */
export function pushTip(state: SimState, id: TipId, station: number | null = null): boolean {
  const campaign = state.campaign;
  if (campaign === null || hasTip(campaign, id)) return false;
  campaign.tips.push({ id, step: state.step, station, read: false });
  return true;
}

/** 还没标记已读的便签，按出现的先后。 */
export function unreadTips(state: SimState): TipRecord[] {
  return state.campaign === null ? [] : state.campaign.tips.filter((tip) => !tip.read);
}

/** 标记已读。队列里没有这条便签时返回 false，已经读过的再标一次也算成功。 */
export function markTipRead(state: SimState, id: TipId): boolean {
  const campaign = state.campaign;
  const tip = campaign?.tips.find((t) => t.id === id);
  if (tip === undefined) return false;
  tip.read = true;
  return true;
}

/** 有没有还没送到的订单，下单已经超过 steps 步。还没送到的订单要么在待派队列里，要么在某架飞机的路线上。 */
function hasUnresolvedOlderThan(state: SimState, steps: number): boolean {
  const now = state.step;
  const first = state.pending[0];
  if (first !== undefined && now - (state.orders[first] as Order).tOrder > steps) return true;
  for (const d of state.drones) {
    if (d.removed) continue;
    for (const stop of d.route) {
      if (now - (state.orders[stop.order] as Order).tOrder > steps) return true;
    }
  }
  return false;
}

/**
 * 便签阶段，每步最后调用，只在经营模式里做事。这一阶段负责靠订单状态触发的三条：
 * 开局第一张订单、第五张订单送达（自动派单打开）、自动派单后第一次有还没送到的订单下单超过 22 秒（画面上第一次出现红色）。
 * 另外四条由各自的事件触发，见 unlocks.ts（价签、调度台、写字楼区）和 summary.ts（站点的起降口）。
 */
export function tipsPhase(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null) return;
  if (campaign.opening.orders.length > 0) pushTip(state, 'firstOrder');
  if (!campaign.opening.done) return;
  pushTip(state, 'autoDispatchOn');
  if (!hasTip(campaign, 'firstRedOrder') && hasUnresolvedOlderThan(state, NOTES_V1.redOrderSeconds * STEPS_PER_SECOND)) {
    pushTip(state, 'firstRedOrder');
  }
}

// 解锁：栏、卡、价签和片区什么时候开放。条件在内容表 unlocks_v1.ts 里。
// 每一项在 campaign.unlocks 里记下开放的那一步，-1 表示还没开放。已经开放的不会再锁上，掉星之后也不锁。
// 靠状态本身判断的几项（站数、载量、片区开通、价签）由 refreshUnlocks 在每步开始时和每个命令之后检查。
// 靠统计判断的几项在各自的时刻检查：日结（settle.ts）和高峰小结（summary.ts）。
import { ECONOMY_V1 } from '../../content/economy_v1.ts';
import { CAMPAIGN_RULES_V1 } from '../../content/rules_v1.ts';
import { UNLOCKS_V1 } from '../../content/unlocks_v1.ts';
import { stationCount } from '../systems/stations.ts';
import type { RuleColumn, SimState, TipId, UnlockKey, Unlocks } from '../types.ts';
import { splitRuleSets } from './rulesets.ts';
import { pushTip } from './tips.ts';

/** 全部开放项，按定义的顺序。哈希和打印都按这个顺序。 */
export const UNLOCK_KEYS: readonly UnlockKey[] = [
  'selectColumn',
  'priceTags',
  'doubleBox',
  'poolColumn',
  'zoneColumn',
  'nearestLanding',
  'ruleSets',
  'prioDistrict',
  'roundtrip',
  'showOffice',
  'showCampus',
];

/** 开放的同时出现的便签。 */
const UNLOCK_TIPS: Readonly<Partial<Record<UnlockKey, TipId>>> = {
  selectColumn: 'boardReady',
  priceTags: 'canAddBay',
  showOffice: 'openOffice',
};

/** 开局的状态：全部没开放。 */
export function lockedUnlocks(): Unlocks {
  return {
    selectColumn: -1,
    priceTags: -1,
    doubleBox: -1,
    poolColumn: -1,
    zoneColumn: -1,
    nearestLanding: -1,
    ruleSets: -1,
    prioDistrict: -1,
    roundtrip: -1,
    showOffice: -1,
    showCampus: -1,
  };
}

/** 显示一个片区对应的开放项：写字楼区是 showOffice，大学城是 showCampus。老街开局就显示，没有对应项。 */
export function showKeyOf(district: number): UnlockKey | null {
  return district === 1 ? 'showOffice' : district === 2 ? 'showCampus' : null;
}

/** 沙盒模式没有解锁这回事，一律当作开放。 */
export function isUnlocked(state: SimState, key: UnlockKey): boolean {
  return state.campaign === null || state.campaign.unlocks[key] >= 0;
}

/** 开放一项，记下现在的步，有对应的便签就同时放出。已经开放的不动。返回是不是这次开放的。 */
export function unlock(state: SimState, key: UnlockKey): boolean {
  const campaign = state.campaign;
  if (campaign === null || campaign.unlocks[key] >= 0) return false;
  campaign.unlocks[key] = state.step;
  const tip = UNLOCK_TIPS[key];
  if (tip !== undefined) pushTip(state, tip);
  return true;
}

/**
 * 检查靠状态本身判断的开放项。每步开始时调用，每个命令执行之后也调用，所以命令的效果马上看得到。
 * - 有两座以上没退回的站：「协同策略」一栏（三张卡同时开放）和就近降落
 * - 载量不小于双层货箱的载量，也就是买了双层货箱：「合单策略」一栏
 * - 开通写字楼区：午晚两套策略，同时把现在的策略分成两套
 * - 开通内容表 UNLOCKS_V1.prioOpensWith 指定的片区（写字楼区）：「{片区}优先」。内容表里这一项是 null 时不在这里开放，由日结判断
 * - 第一次日结之后余额达到内容表 UNLOCKS_V1.priceTagsBalance：价签
 */
export function refreshUnlocks(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null) return;
  const stations = stationCount(state);
  if (stations >= UNLOCKS_V1.zoneStations) unlock(state, 'zoneColumn');
  if (stations >= ECONOMY_V1.nearestLandingMinStations) unlock(state, 'nearestLanding');
  if (state.capacity >= ECONOMY_V1.doubleBoxCapacity) unlock(state, 'poolColumn');
  if (campaign.districts[UNLOCKS_V1.ruleSetsDistrict]?.open === true) {
    splitRuleSets(state);
    unlock(state, 'ruleSets');
  }
  if (UNLOCKS_V1.prioOpensWith !== null && campaign.districts[UNLOCKS_V1.prioOpensWith]?.open === true) unlock(state, 'prioDistrict');
  if (campaign.days.length >= 1 && campaign.money >= UNLOCKS_V1.priceTagsBalance) unlock(state, 'priceTags');
}

/**
 * 一张策略卡现在是哪一项锁着的，没锁时为 null。界面按它写「未开放」的条件。经营模式的调度台里没有的卡不在这里管，见 ruleOffered。
 * 「调度策略」一栏没开放时整栏都锁着，包括「先到先送」。栏开放之后，「时限优先」随栏开放，
 * 「短程优先」和三张「{片区}优先」各自有自己的条件。「协同策略」和「合单策略」整栏一起开放。
 */
export function ruleLock(state: SimState, column: RuleColumn, id: string): UnlockKey | null {
  if (state.campaign === null) return null;
  if (column === 'pool') return isUnlocked(state, 'poolColumn') ? null : 'poolColumn';
  if (column === 'zone') return isUnlocked(state, 'zoneColumn') ? null : 'zoneColumn';
  if (!isUnlocked(state, 'selectColumn')) return 'selectColumn';
  if (id === 'roundtrip') return isUnlocked(state, 'roundtrip') ? null : 'roundtrip';
  if (id === 'prioOld' || id === 'prioOffice' || id === 'prioCampus') return isUnlocked(state, 'prioDistrict') ? null : 'prioDistrict';
  return null;
}

/**
 * 这张策略卡在这一局里是不是玩家能选的卡。沙盒模式的卡都能选。
 * 经营模式只有内容表 CAMPAIGN_RULES_V1 列出的，注册表里别的卡（例如「单独配送」）玩家选不到，也不会开放。
 */
export function ruleOffered(state: SimState, column: RuleColumn, id: string): boolean {
  return state.campaign === null || CAMPAIGN_RULES_V1[column].includes(id);
}

/** 这张策略卡能不能选：经营模式里要在内容表里，并且它所在的栏和它自己的开放条件都满足。 */
export function ruleOpen(state: SimState, column: RuleColumn, id: string): boolean {
  return ruleOffered(state, column, id) && ruleLock(state, column, id) === null;
}

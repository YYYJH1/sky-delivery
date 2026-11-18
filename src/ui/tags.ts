// 价签和改装列表的状态：价格、能不能买、为什么不能买。价格和条件都由核心的 quoteCommand 给出，这里不另算。
// 纯函数，不碰 DOM。
import { gatePrice, isUnlocked, quoteCommand, showKeyOf, stationBasePrice, stationCount } from '../core/index.ts';
import type { Command, CommandFailure, CommandQuote, SimState } from '../core/index.ts';
import { ECONOMY_V1 } from '../content/economy_v1.ts';
import { STR, districtName, fmt } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import type { UiHint } from './reasons.ts';
import type { CandidateRoof } from './roofs.ts';

/**
 * 点击之后做什么：执行一个命令，只显示一条提示，或者什么也不做。
 * 执行命令成功之后，done 有值就再显示这一条系统提示，例如切换就近降落的开关。
 */
export type ClickAction =
  | { readonly kind: 'run'; readonly command: Command; readonly done?: string }
  | { readonly kind: 'hint'; readonly hint: CommandFailure | UiHint }
  | { readonly kind: 'none' };

export interface TagState {
  /** 价签上写的价格。 */
  readonly price: number;
  /** 现在能买。 */
  readonly ok: boolean;
  /** 余额不够，价签的文字变淡。只看余额：钱够而别的原因不能买时文字不变淡，点击时给出提示。 */
  readonly dim: boolean;
  /** 不能买的原因，能买时为 null。 */
  readonly reason: CommandFailure | null;
}

/**
 * 由核心给出的报价做成价签的状态。文字变淡只看余额够不够，不看别的原因：
 * 没有空停机位的站，钱不够时添飞机的价签也是淡的，钱够时不淡，点击时再说没有空停机位。
 */
export function tagFromQuote(quote: CommandQuote, money: number): TagState {
  return { price: quote.price, ok: quote.ok, dim: quote.kind === 'buy' && money < quote.price, reason: quote.reason };
}

/** 一座站上「加停机位」和「添飞机」两张价签。 */
export interface StationTags {
  readonly addBay: TagState;
  readonly addDrone: TagState;
}

export function stationTags(state: SimState, station: number): StationTags {
  const money = state.campaign?.money ?? 0;
  return {
    addBay: tagFromQuote(quoteCommand(state, { type: 'buyBay', station }), money),
    addDrone: tagFromQuote(quoteCommand(state, { type: 'buyDrone', station }), money),
  };
}

/**
 * 「建新站」价签：价格取候选屋顶里最便宜的一块，各块屋顶自己的价格在地图上标出。
 * 站数到了上限，或者没有空着的候选屋顶时不能建，价格按下一座站的基准价写。
 */
export function buildTag(state: SimState, candidates: readonly CandidateRoof[]): TagState {
  const money = state.campaign?.money ?? 0;
  if (stationCount(state) >= ECONOMY_V1.maxStations) {
    const price = stationBasePrice(stationCount(state));
    return { price, ok: false, dim: money < price, reason: 'stationLimit' };
  }
  const cheapest = candidates.reduce<CandidateRoof | null>((best, c) => (best === null || c.price < best.price ? c : best), null);
  if (cheapest === null) {
    const price = stationBasePrice(stationCount(state));
    return { price, ok: false, dim: money < price, reason: 'roofTaken' };
  }
  return { price: cheapest.price, ok: cheapest.ok, dim: money < cheapest.price, reason: cheapest.reason };
}

// ---- 改装 ----

/** 改装单的四个节点，键就是词表 STR.upgrades 里的键。起降口 2 级和 3 级各占一行。 */
export type UpgradeKey = 'doubleBox' | 'gate2' | 'gate3' | 'nearbyLanding';

/**
 * 第二行写什么：
 * desc 能买，写说明。owned 已经买过。locked 没开放，写开放的条件（就近降落要有第二座站，起降口 3 级要先到 2 级）。
 * needStation 没选中站点，起降口两行都要先选一座站。
 * toggle 就近降落买下之后变成开关，写现在开着还是关着，旁边是切换的按钮。
 */
export type UpgradeNote = 'desc' | 'owned' | 'locked' | 'needStation' | 'toggle';

export interface UpgradeItem {
  readonly key: UpgradeKey;
  readonly price: number;
  readonly note: UpgradeNote;
  /** 余额不够，文字变淡。 */
  readonly dim: boolean;
  readonly click: ClickAction;
  /** 只有 note 是 toggle 时有：就近降落现在开着。 */
  readonly on?: boolean;
}

function quoted(key: UpgradeKey, quote: CommandQuote, command: Command, money: number): UpgradeItem {
  if (quote.reason === 'alreadyOwned') return { key, price: quote.price, note: 'owned', dim: false, click: { kind: 'hint', hint: 'alreadyOwned' } };
  if (quote.reason === 'needTwoStations') return { key, price: quote.price, note: 'locked', dim: false, click: { kind: 'hint', hint: 'needTwoStations' } };
  return { key, price: quote.price, note: 'desc', dim: money < quote.price, click: { kind: 'run', command } };
}

export function doubleBoxItem(state: SimState): UpgradeItem {
  const command: Command = { type: 'buyDoubleBox' };
  return quoted('doubleBox', quoteCommand(state, command), command, state.campaign?.money ?? 0);
}

/**
 * 就近降落。只有一座站时没开放，有两座以上能买。买下之后变成开关：点击发出 setNearestLanding，免费，
 * 开着（state.returnRule 是 nearest）时点一下关，关着时点一下开，成功之后给一条系统提示。
 */
export function nearbyLandingItem(state: SimState): UpgradeItem {
  const campaign = state.campaign;
  if (campaign !== null && campaign.nearestOwned) {
    const on = state.returnRule === 'nearest';
    return {
      key: 'nearbyLanding',
      price: ECONOMY_V1.nearestLandingPrice,
      note: 'toggle',
      dim: false,
      click: { kind: 'run', command: { type: 'setNearestLanding', on: !on }, done: on ? STR.system.nearestOff : STR.system.nearestOn },
      on,
    };
  }
  const command: Command = { type: 'buyNearestLanding' };
  return quoted('nearbyLanding', quoteCommand(state, command), command, campaign?.money ?? 0);
}

/**
 * 起降口升级，只列下一级，给站点小卡用。没有选中站点时列出 2 级，点击提示先选一座站。
 * 选中的站已经是 3 级时列出 3 级，标为已经买过。
 */
export function gateItem(state: SimState, station: number | null): UpgradeItem {
  const campaign = state.campaign;
  const money = campaign?.money ?? 0;
  if (station === null) {
    const price = gatePrice(2);
    return { key: 'gate2', price, note: 'needStation', dim: money < price, click: { kind: 'hint', hint: 'noStationSelected' } };
  }
  const info = campaign?.stations[station];
  const level = info === undefined ? 1 : info.gateLevel;
  if (level >= ECONOMY_V1.gateSeconds.length) {
    return { key: 'gate3', price: gatePrice(3), note: 'owned', dim: false, click: { kind: 'hint', hint: 'alreadyOwned' } };
  }
  const command: Command = { type: 'upgradeGate', station };
  const quote = quoteCommand(state, command);
  const next = level + 1;
  return quoted(next === 2 ? 'gate2' : 'gate3', { ...quote, price: gatePrice(next) }, command, money);
}

/**
 * 改装单里起降口的两行，2 级在前，3 级在后。
 * 没有选中站点：两行都写请先选择站点。选中一座站：已经买过的写已购买，下一级照常能买，
 * 这座站还没到 2 级时 3 级一行写需要先升级至起降口 2 级，不能点。
 */
export function gateRows(state: SimState, station: number | null): readonly [UpgradeItem, UpgradeItem] {
  const campaign = state.campaign;
  const money = campaign?.money ?? 0;
  const owned = (key: 'gate2' | 'gate3', price: number): UpgradeItem => ({ key, price, note: 'owned', dim: false, click: { kind: 'hint', hint: 'alreadyOwned' } });
  if (station === null) {
    const price = gatePrice(3);
    return [gateItem(state, null), { key: 'gate3', price, note: 'needStation', dim: money < price, click: { kind: 'hint', hint: 'noStationSelected' } }];
  }
  const level = campaign?.stations[station]?.gateLevel ?? 1;
  const next = gateItem(state, station);
  const second: UpgradeItem = level >= 2 ? owned('gate2', gatePrice(2)) : next;
  let third: UpgradeItem;
  if (level >= 3) third = owned('gate3', gatePrice(3));
  else if (level === 2) third = next;
  else third = { key: 'gate3', price: gatePrice(3), note: 'locked', dim: false, click: { kind: 'none' } };
  return [second, third];
}

// ---- 开通片区 ----

/** 地图上已经显示出来、还没有开通的片区，带一张价签。 */
export interface OpenDistrictTag {
  readonly district: number;
  /** 开通的价格，取自核心。 */
  readonly price: number;
  /** 现在能开通：上一个片区到了三星，余额够。 */
  readonly ok: boolean;
  /** 余额不够，文字变淡。只看余额，别的原因不能开通时点击再给提示。 */
  readonly dim: boolean;
  readonly reason: CommandFailure | null;
  readonly command: Command;
}

/**
 * 要在地图上标出开通价签的片区：上一个片区到过三星、因此已经显示出来（showOffice、showCampus），并且还没有开通。
 * 显示之前不画片区，也没有价签。
 */
export function openDistrictTags(state: SimState): OpenDistrictTag[] {
  const campaign = state.campaign;
  if (campaign === null) return [];
  const money = campaign.money;
  const out: OpenDistrictTag[] = [];
  campaign.districts.forEach((d, district) => {
    const key = showKeyOf(district);
    if (d.open || key === null || !isUnlocked(state, key)) return;
    const command: Command = { type: 'openDistrict', district };
    const quote = quoteCommand(state, command);
    out.push({ district, price: quote.price, ok: quote.ok, dim: money < quote.price, reason: quote.reason, command });
  });
  return out;
}

/** 开通价签上的字，词表 hud.price.openDistrict 的「开通{片区} ¥{价格}」。 */
export function openDistrictLabel(district: number, price: number): string {
  return fmt(STR.hud.price.openDistrict, { district: districtName(district as DistrictIndex), price });
}

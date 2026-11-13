// 命令失败的原因代码到词表的对照。核心返回英文的原因代码，界面按这张表去词表 STR.reasons 里取提示。
// 正常操作碰不到的代码统一对到词表的 generic，见 REASON_KEYS 里的注释。
// 纯函数，不碰 DOM 和状态。
import { MAP_V1 } from '../content/map_v1.ts';
import { ECONOMY_V1 } from '../content/economy_v1.ts';
import { UNLOCKS_V1 } from '../content/unlocks_v1.ts';
import { DISTRICTS, districtName, reasonText, starNumeral } from '../content/strings.zh.ts';
import type { DistrictIndex, ReasonKey } from '../content/strings.zh.ts';
import { bayCap, quoteCommand } from '../core/index.ts';
import type { Command, CommandFailure, SimState } from '../core/index.ts';

/** 词表里正常操作碰不到的原因共用的一条。 */
export const GENERIC_REASON = 'generic';

/**
 * 核心的每个原因代码对应词表的哪一条。键的类型是 CommandFailure，核心加了新的代码，这里不补就会类型报错。
 * noFreeBay 和 fleetFull 对应两条文字，按屋顶是否已经放满选，见 failureText。
 * 最后一组是正常操作碰不到的代码：界面只会发出核心认得的命令，它们出现说明界面有错，统一显示 generic。
 */
export const REASON_KEYS: Readonly<Record<CommandFailure, ReasonKey>> = {
  notEnoughMoney: 'notEnoughMoney',
  noFreeBay: 'noFreeBay',
  fleetFull: 'noFreeBay',
  bayLimit: 'bayLimitReached',
  stationLimit: 'stationLimitReached',
  roofTaken: 'rooftopTaken',
  districtClosed: 'districtClosed',
  needStars: 'needThreeStars',
  needTwoStations: 'needTwoStations',
  alreadyOwned: 'alreadyOwned',
  notBoughtToday: 'refundOnlyToday',
  droneBusy: 'droneBusy',
  baysInUse: 'bayInUse',
  stationNotEmpty: 'stationDronesAway',
  priceTagsLocked: 'priceTagsLocked',
  doubleBoxLocked: 'doubleBoxLocked',
  districtHidden: 'districtHidden',
  ruleLocked: 'ruleLocked',
  orderNotWaiting: 'orderNotWaiting',
  gateMax: 'gateMax',
  alreadyOpen: 'alreadyOpen',
  noRuleSets: GENERIC_REASON,
  alreadyRefunded: GENERIC_REASON,
  unknownTarget: GENERIC_REASON,
  unknownCommand: GENERIC_REASON,
  notCampaign: GENERIC_REASON,
  unknownRule: GENERIC_REASON,
};

/** 取提示文字时要用到的数。 */
export interface FailureContext {
  /** 还差多少钱，余额不够时用。 */
  readonly shortfall?: number;
  /** 屋顶的停机位上限，或者站数上限。 */
  readonly limit?: number;
  /** 这座站的屋顶是不是已经放满了停机位：没有空停机位时选哪一条文字。 */
  readonly roofFull?: boolean;
  /** 片区序号，片区没开通时用。 */
  readonly district?: number;
  /** 一笔钱的数，价签还没开放时写要攒到多少，取自内容表。 */
  readonly amount?: number;
}

function need(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`ui: failure text needs ${name}`);
  return value;
}

/** 一个失败原因给玩家看的提示。 */
export function failureText(code: CommandFailure, context: FailureContext = {}): string {
  switch (code) {
    case 'notEnoughMoney':
      return reasonText('notEnoughMoney', { shortfall: need(context.shortfall, 'shortfall') });
    case 'noFreeBay':
    case 'fleetFull':
      // 两条提示：屋顶还能加停机位时让玩家先加，屋顶已经放满时让玩家去别的站
      return context.roofFull === true
        ? reasonText('bayLimitReached', { limit: need(context.limit, 'limit') })
        : reasonText('noFreeBay');
    case 'bayLimit':
      return reasonText('bayLimitReached', { limit: need(context.limit, 'limit') });
    case 'stationLimit':
      return reasonText('stationLimitReached', { limit: need(context.limit, 'limit') });
    case 'districtClosed':
      return reasonText('districtClosed', { district: districtName(need(context.district, 'district') as DistrictIndex) });
    case 'needStars': {
      const district = need(context.district, 'district');
      const previous = DISTRICTS[district - 1];
      if (previous === undefined) throw new RangeError(`ui: district ${String(district)} has no previous district`);
      return reasonText('needThreeStars', { previous });
    }
    case 'roofTaken':
      return reasonText('rooftopTaken');
    case 'needTwoStations':
      return reasonText('needTwoStations');
    case 'alreadyOwned':
      return reasonText('alreadyOwned');
    case 'notBoughtToday':
      return reasonText('refundOnlyToday');
    case 'droneBusy':
      return reasonText('droneBusy');
    case 'baysInUse':
      return reasonText('bayInUse');
    case 'stationNotEmpty':
      return reasonText('stationDronesAway');
    case 'priceTagsLocked':
      return reasonText('priceTagsLocked', { amount: need(context.amount, 'amount') });
    case 'doubleBoxLocked':
      return reasonText('doubleBoxLocked');
    case 'districtHidden': {
      const district = need(context.district, 'district');
      const show = UNLOCKS_V1.show.find((s) => s.district === district);
      if (show === undefined) throw new RangeError(`ui: district ${String(district)} has no show condition`);
      return reasonText('districtHidden', { previous: districtName(show.after as DistrictIndex), star: starNumeral(show.star) });
    }
    case 'ruleLocked':
      return reasonText('ruleLocked');
    case 'orderNotWaiting':
      return reasonText('orderNotWaiting');
    case 'gateMax':
      return reasonText('gateMax');
    case 'alreadyOpen':
      return reasonText('alreadyOpen');
    case 'noRuleSets':
    case 'alreadyRefunded':
    case 'unknownTarget':
    case 'unknownCommand':
    case 'notCampaign':
    case 'unknownRule':
      return reasonText('generic');
  }
}

/** 界面自己检查出来的提示，不是核心返回的原因。目前只有没选中站点一条。 */
export type UiHint = 'noStationSelected';

/** 一条提示的文字：核心的失败原因，或者界面自己的提示。 */
export function hintText(hint: CommandFailure | UiHint, context: FailureContext = {}): string {
  return hint === 'noStationSelected' ? reasonText('noStationSelected') : failureText(hint, context);
}

/** 命令失败之后，从状态里取出提示文字要用的数。命令没有执行，状态没有变。 */
export function failureContext(state: SimState, command: Command, code: CommandFailure): FailureContext {
  const campaign = state.campaign;
  switch (code) {
    case 'notEnoughMoney': {
      const quote = quoteCommand(state, command);
      const money = campaign?.money ?? 0;
      // 余额带小数，向上取整：显示还差 ¥1 就是再有 ¥1 就够了
      return { shortfall: Math.max(1, Math.ceil(quote.price - money)) };
    }
    case 'noFreeBay':
    case 'fleetFull':
    case 'bayLimit': {
      if (command.type !== 'buyDrone' && command.type !== 'buyBay') return {};
      const info = campaign?.stations[command.station];
      const station = state.stations[command.station];
      if (info === undefined || station === undefined) return {};
      const roof = MAP_V1.roofs[info.roof];
      if (roof === undefined) return {};
      const limit = bayCap(roof.size);
      return { limit, roofFull: station.bays >= limit };
    }
    case 'stationLimit':
      return { limit: ECONOMY_V1.maxStations };
    case 'districtClosed': {
      if (command.type !== 'buildStation') return {};
      const roof = MAP_V1.roofs[command.roof];
      return roof === undefined ? {} : { district: roof.district };
    }
    case 'needStars':
    case 'districtHidden':
      return command.type === 'openDistrict' ? { district: command.district } : {};
    case 'priceTagsLocked':
      return { amount: UNLOCKS_V1.priceTagsBalance };
    default:
      return {};
  }
}

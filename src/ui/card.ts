// 站点小卡里新增的两块：最近一场高峰里这座站的一行，以及本站可购买的几项。
// 数字取自核心记录好的 campaign.peaks（每场高峰一条，里面每座没退回的站一行），这里只排版：每一行写什么，没有记录时写什么，
// 不能买的项写什么原因。价格和原因取自 tags.ts 已经算好的价签和改装，原因的文字照命令失败时的提示取，不另外写。
// 纯函数，不碰 DOM 和状态。
import { STR, fmt, peakName, reasonText } from '../content/strings.zh.ts';
import type { Command, PeakStationRow, SimState } from '../core/index.ts';
import { upgradeForecast } from './forecast.ts';
import type { ForecastOption } from './forecast.ts';
import { failureContext, failureText } from './reasons.ts';
import type { StationTags, TagState, UpgradeItem } from './tags.ts';
import { fleetBlock, oneDecimal } from './tickets.ts';
import type { FleetBlock } from './tickets.ts';

/**
 * 小卡里「最近一场高峰」那一块。
 * none：还没有高峰记录，或者最近一场的记录里没有这座站（新建的站，旧存档迁移来的记录），这一块只写一句 text。
 * row：标题「最近一场午高峰」，起降排队的秒数，等待降落的平均架数，派出的架次，和本站的机队时间构成。
 */
export type StationRecent =
  | { readonly kind: 'none'; readonly text: string }
  | {
      readonly kind: 'row';
      readonly title: string;
      readonly gateWait: string;
      readonly landWait: string;
      readonly sorties: string;
      /** 这座站没有无人机时为 null，不写这一行。 */
      readonly fleet: FleetBlock | null;
    };

/** 起降排队一行：没有从这座站起飞、已经送达的订单时没有数，写无数据。 */
function gateWaitText(row: PeakStationRow): string {
  return row.gateWait === null ? STR.hud.card.gateWaitNone : fmt(STR.hud.card.gateWait, { seconds: oneDecimal(row.gateWait) });
}

/**
 * 这座站（核心里的站编号，从 0 起）在最近一场高峰小结记录里的一行。取 campaign.peaks 里最后一条，不管是哪一天。
 * 最近一场的记录里没有这座站时写暂无高峰记录，不去翻更早的记录。
 */
export function stationRecent(state: SimState, station: number): StationRecent {
  const peaks = state.campaign?.peaks ?? [];
  const record = peaks[peaks.length - 1];
  const row = record?.stations.find((r) => r.station === station);
  if (record === undefined || row === undefined) return { kind: 'none', text: STR.hud.card.none };
  return {
    kind: 'row',
    title: fmt(STR.hud.card.recent, { peak: peakName(record.peak) }),
    gateWait: gateWaitText(row),
    landWait: fmt(STR.hud.card.landWait, { count: oneDecimal(row.landWaitAvg) }),
    sorties: fmt(STR.hud.card.sorties, { count: row.sorties }),
    fleet: fleetBlock(row.fleet),
  };
}

/**
 * 小卡里「本站可购买」的一项：名称和价格照价签的写法，钱不够时文字变淡（dim），
 * 不是钱的原因不能买（停机位已达上限，没有空闲停机位，起降口已经是 3 级）时，在下面一行写原因。
 */
export interface BuyLine {
  /** 点击的效果：新增停机位、购买无人机，或者升级起降口，与地图上的价签和改装单相同。 */
  readonly key: 'bay' | 'drone' | 'gate';
  /** 价签上的文字，例如「新增停机位 ¥120」。 */
  readonly text: string;
  readonly dim: boolean;
  /** 不是钱的原因，写在名称下面一行。能买，或者只是钱不够时为 null。 */
  readonly reason: string | null;
  /**
   * 这一项旁边的「推演」按钮推演什么。不是钱的原因买不了的项（没有空闲停机位，停机位已达上限，起降口已是最高等级），推演也没有意义，
   * 没有按钮，为 null。只是钱不够的项照常有，推演不受资金限制。
   */
  readonly forecast: ForecastOption | null;
}

/** 价签的状态里，不是钱的原因：钱不够只变淡，不写原因。 */
function tagReason(state: SimState, command: Command, tag: TagState): string | null {
  if (tag.ok || tag.reason === null || tag.reason === 'notEnoughMoney') return null;
  return failureText(tag.reason, failureContext(state, command, tag.reason));
}

/**
 * 这座站现在的三项购买：新增停机位、购买无人机、起降口的下一级。
 * 价格和能不能买取自价签（stationTags）和改装（gateItem），不重算。起降口已经是 3 级时仍列 3 级，写已购买。
 * 「推演」按钮只给能买的项：不是钱的原因买不了的，有原因写在名称下面，没有按钮。
 */
export function buyLines(state: SimState, station: number, tags: StationTags, gate: UpgradeItem): BuyLine[] {
  const bayReason = tagReason(state, { type: 'buyBay', station }, tags.addBay);
  const droneReason = tagReason(state, { type: 'buyDrone', station }, tags.addDrone);
  return [
    {
      key: 'bay',
      text: fmt(STR.hud.price.addBay, { price: tags.addBay.price }),
      dim: tags.addBay.dim,
      reason: bayReason,
      forecast: bayReason === null ? { kind: 'addBay', station } : null,
    },
    {
      key: 'drone',
      text: fmt(STR.hud.price.addDrone, { price: tags.addDrone.price }),
      dim: tags.addDrone.dim,
      reason: droneReason,
      forecast: droneReason === null ? { kind: 'addDrone', station } : null,
    },
    {
      key: 'gate',
      text: fmt(STR.upgrades[gate.key].name, { price: gate.price }),
      dim: gate.dim,
      reason: gate.note === 'owned' ? reasonText('alreadyOwned') : null,
      forecast: upgradeForecast(gate),
    },
  ];
}

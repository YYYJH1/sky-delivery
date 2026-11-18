// 从状态算出界面数据：小票、日程纸条、价签、改装列表、每座站的小卡、候选屋顶，
// 以及片区纸条、调度台、高峰小结和日结的长小票、便签、结局。
// 界面里读游戏状态的地方都集中在这几个纯函数模块里（本文件、board.ts、note.ts、live.ts、tickets.ts、tips.ts、tags.ts、card.ts）。
// 界面的部件只拿到这里算好的数据，不直接读状态。
// 纯函数，不改状态，不碰 DOM，不读系统时钟。界面每秒最多算十次，所以要保持便宜。
import { ECONOMY_V1 } from '../content/economy_v1.ts';
import { MAP_V1 } from '../content/map_v1.ts';
import { DAY_STEPS, DroneState, bayCap, fleetOf, isUnlocked, quoteCommand, stationCount } from '../core/index.ts';
import type { Command, SimState } from '../core/index.ts';
import { computeBoard } from './board.ts';
import type { BoardView } from './board.ts';
import { buyLines, stationRecent } from './card.ts';
import type { BuyLine, StationRecent } from './card.ts';
import { forecastInfo } from './forecast.ts';
import type { ForecastInfo } from './forecast.ts';
import { liveView } from './live.ts';
import type { LiveView } from './live.ts';
import { wholeMoney } from './money.ts';
import { noteDistrictFor, noteView, openDistricts } from './note.ts';
import type { NoteView } from './note.ts';
import { candidateRoofs } from './roofs.ts';
import type { CandidateRoof } from './roofs.ts';
import { activePeak, busyCells, clockText, dayFraction, dayNumber } from './schedule.ts';
import type { BusyCell, PeakKey } from './schedule.ts';
import { buildTag, doubleBoxItem, gateItem, gateRows, nearbyLandingItem, openDistrictTags, stationTags } from './tags.ts';
import type { OpenDistrictTag, StationTags, TagState, UpgradeItem } from './tags.ts';
import { latestDayEnd, latestSummary } from './tickets.ts';
import type { DayEndView, SummaryView } from './tickets.ts';
import { currentTip, endingText } from './tips.ts';
import type { TipView } from './tips.ts';

export { wholeMoney };

/** 选中一座站时，小卡里「退回」按钮要做的事。 */
export interface RefundOption {
  readonly what: 'drone' | 'bay' | 'station';
  readonly command: Command;
  /** 退回的钱，取自核心。 */
  readonly amount: number;
}

/** 一座站的小卡，以及对它操作的价签。 */
export interface StationCard {
  readonly id: number;
  /** 站的编号，从 1 起，画在屋顶上。站可以退回再建，编号不回收，所以会超过站的个数。 */
  readonly number: number;
  readonly bays: number;
  readonly bayLimit: number;
  readonly drones: number;
  readonly gateLevel: number;
  /** 在站点上空等降落的飞机数。 */
  readonly holding: number;
  /** 已接单、在起降口排队等放行起飞的无人机数。口径与地图上这座站旁边的「等待起飞」相同：在起降口的队列里，或者停在停机位上已经有了路线。 */
  readonly takeoffWaiting: number;
  readonly tags: StationTags;
  /** 起降口的下一级，站点小卡的购买列表用。 */
  readonly gate: UpgradeItem;
  /** 改装单里起降口的两行，2 级和 3 级。 */
  readonly gates: readonly [UpgradeItem, UpgradeItem];
  /** 最近一场高峰里这座站的一行，没有记录时只有一句话。 */
  readonly recent: StationRecent;
  /** 本站可购买的三项：新增停机位、购买无人机、起降口的下一级。 */
  readonly buy: readonly BuyLine[];
  readonly refund: RefundOption | null;
}

export interface BuildInfo {
  readonly tag: TagState;
  /** 能不能进入选屋顶的状态：站数没到上限，并且有空着的候选屋顶。 */
  readonly canEnter: boolean;
  readonly candidates: readonly CandidateRoof[];
}

export interface UiData {
  readonly step: number;
  /** 第几天，从 1 起。 */
  readonly day: number;
  /** 游戏内的时刻，如 12:05。 */
  readonly clock: string;
  /** 当前时刻在一天里的位置，0 到 1。 */
  readonly dayFraction: number;
  readonly peak: PeakKey | null;
  /** 高峰进行中各片区已有的结果和这一场的目标，不在高峰里为 null。 */
  readonly live: LiveView | null;
  /** 余额，向下取整：显示的数够买什么，就真的能买。 */
  readonly balance: number;
  /** 今天的进账，按送达的那一天算。 */
  readonly earned: number;
  readonly build: BuildInfo;
  /** 还在用的站，按编号从小到大。 */
  readonly stations: readonly StationCard[];
  /** 没有选中站点时，「加停机位」和「添飞机」价签参照哪座站：编号最小的站，没有站时为 null。 */
  readonly fallbackStation: number | null;
  /** 没有选中站点时，改装单里起降口的两行：都写请先选择站点。 */
  readonly gatesWithoutStation: readonly [UpgradeItem, UpgradeItem];
  readonly doubleBox: UpgradeItem;
  /** 就近降落：没开放，能买，或者买下之后的开关。 */
  readonly nearbyLanding: UpgradeItem;
  /** 价签和改装面板要不要显示：第一次日结之后余额达到内容表里的数才开放，开放之前整排价签都不出现。 */
  readonly tagsShown: boolean;
  /**
   * 核心里双层货箱的开放项是否已经打开。它随价签一起开放，价签出现之后改装单总是列出双层货箱，不再看这一项，
   * 留在这里只反映开放项的状态。
   */
  readonly doubleBoxShown: boolean;
  /** 日程纸条上的运力占用带：最近一次日结记录里的 24 格。没有日结记录，或者是存档格式 3 以前的记录时为 null，不画这条带。 */
  readonly busy: readonly BusyCell[] | null;
  /** 数据员的推演次数。数据员没到岗时为 null，改装单、站点小卡和调度台上都没有「推演」按钮，推演次数也不写。 */
  readonly forecast: ForecastInfo | null;
  /** 已经显示、还没开通的片区，各带一张开通价签。 */
  readonly openTags: readonly OpenDistrictTag[];
  /** 片区纸条：当前显示的片区。 */
  readonly note: NoteView;
  /** 已经开通的片区，点纸条上的片区名在它们之间轮换。 */
  readonly noteChoices: readonly number[];
  /** 调度台，「调度策略」一栏开放之前为 null。 */
  readonly board: BoardView | null;
  /** 最近的高峰小结，今天还没有小结时为 null。 */
  readonly summary: SummaryView | null;
  /** 最近一次日结，只在日结小票开着时才算。 */
  readonly dayEnd: DayEndView | null;
  /** 现在贴出来的便签。 */
  readonly tip: TipView | null;
  /** 到了结局时的文字。 */
  readonly ending: string | null;
}

/** 界面自己的选择，不是游戏状态：片区纸条看哪个片区，调度台展开后看哪一套，日结小票开着没有。 */
export interface UiView {
  readonly noteDistrict: number;
  /** 页签选的那一套，null 是跟着现在生效的那一套。 */
  readonly boardPeak: PeakKey | null;
  readonly dayEndOpen: boolean;
}

export const DEFAULT_VIEW: UiView = { noteDistrict: 0, boardPeak: null, dayEndOpen: false };

/** 今天买的东西可以退回时，给小卡的退回按钮。先退飞机，再退停机位，最后退站，也就是买的顺序倒过来。 */
export function refundOption(state: SimState, station: number): RefundOption | null {
  for (let i = state.drones.length - 1; i >= 0; i--) {
    const drone = state.drones[i];
    if (drone === undefined || drone.removed || drone.home !== station) continue;
    const command: Command = { type: 'refundDrone', drone: drone.id };
    const quote = quoteCommand(state, command);
    if (quote.ok) return { what: 'drone', command, amount: quote.price };
  }
  const bay: Command = { type: 'refundBay', station };
  const bayQuote = quoteCommand(state, bay);
  if (bayQuote.ok) return { what: 'bay', command: bay, amount: bayQuote.price };
  const whole: Command = { type: 'refundStation', station };
  const wholeQuote = quoteCommand(state, whole);
  if (wholeQuote.ok) return { what: 'station', command: whole, amount: wholeQuote.price };
  return null;
}

function holdingAt(state: SimState, station: number): number {
  let n = 0;
  for (const d of state.drones) if (!d.removed && d.state === DroneState.LandQueue && d.station === station) n++;
  return n;
}

/** 在这座站里等待起飞的无人机数：在起降口的队列里，或者停在停机位上已经接了单、路线不空。与地图上的画法同一个口径，这里不引用渲染模块，自己数。 */
function takeoffAt(state: SimState, station: number): number {
  let n = 0;
  for (const d of state.drones) {
    if (d.removed || d.station !== station) continue;
    if (d.state === DroneState.TakeoffQueue || (d.state === DroneState.Dock && d.route.length > 0)) n++;
  }
  return n;
}

function stationCard(state: SimState, id: number): StationCard | null {
  const campaign = state.campaign;
  const station = state.stations[id];
  const info = campaign?.stations[id];
  if (station === undefined || info === undefined || station.removed) return null;
  const roof = MAP_V1.roofs[info.roof];
  const tags = stationTags(state, id);
  const gate = gateItem(state, id);
  return {
    id,
    number: id + 1,
    bays: station.bays,
    bayLimit: roof === undefined ? station.bays : bayCap(roof.size),
    drones: fleetOf(state, id),
    gateLevel: info.gateLevel,
    holding: holdingAt(state, id),
    takeoffWaiting: takeoffAt(state, id),
    tags,
    gate,
    gates: gateRows(state, id),
    recent: stationRecent(state, id),
    buy: buyLines(state, id, tags, gate),
    refund: refundOption(state, id),
  };
}

/**
 * 改装单的四行，按顺序：双层货箱，起降口 2 级，起降口 3 级，就近降落。
 * 价签出现之后双层货箱总是列出，它随价签开放。起降口看选中的站（selected 是站的编号）：
 * 没选站，或者选中的站已经退回时，两行都写请先选择站点。
 */
export function upgradeRows(d: UiData, selected: number | null): readonly UpgradeItem[] {
  const card = selected === null ? undefined : d.stations.find((s) => s.id === selected);
  const gates = card === undefined ? d.gatesWithoutStation : card.gates;
  return [d.doubleBox, gates[0], gates[1], d.nearbyLanding];
}

/** 一个游戏状态在界面上要显示的全部内容。经营模式以外的状态没有余额和站点，返回 null。 */
export function computeUiData(state: SimState, view: UiView = DEFAULT_VIEW): UiData | null {
  const campaign = state.campaign;
  if (campaign === null) return null;
  const stations: StationCard[] = [];
  for (const s of state.stations) {
    const card = stationCard(state, s.id);
    if (card !== null) stations.push(card);
  }
  const candidates = candidateRoofs(state);
  const build = buildTag(state, candidates);
  const board = computeBoard(state, view.boardPeak);
  return {
    step: state.step,
    day: dayNumber(state.step),
    clock: clockText(state.step),
    dayFraction: dayFraction(state.step),
    peak: activePeak(state.step),
    live: liveView(state),
    balance: wholeMoney(campaign.money),
    earned: wholeMoney(campaign.income[Math.floor(state.step / DAY_STEPS)] ?? 0),
    build: { tag: build, canEnter: candidates.length > 0 && stationCount(state) < ECONOMY_V1.maxStations, candidates },
    stations,
    fallbackStation: stations[0]?.id ?? null,
    gatesWithoutStation: gateRows(state, null),
    doubleBox: doubleBoxItem(state),
    nearbyLanding: nearbyLandingItem(state),
    tagsShown: isUnlocked(state, 'priceTags'),
    doubleBoxShown: isUnlocked(state, 'doubleBox'),
    busy: busyCells(campaign.days[campaign.days.length - 1]?.busy ?? null),
    forecast: forecastInfo(state),
    openTags: openDistrictTags(state),
    note: noteView(state, noteDistrictFor(state, view.noteDistrict)),
    noteChoices: openDistricts(state),
    board,
    summary: latestSummary(state, board !== null),
    dayEnd: view.dayEndOpen ? latestDayEnd(state) : null,
    tip: currentTip(state),
    ending: endingText(state),
  };
}

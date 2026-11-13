// 从状态算出界面数据：小票、日程纸条、价签、改装列表、每座站的小卡、候选屋顶，
// 以及片区纸条、调度台、高峰小结和日结的长小票、便签、结局。
// 界面里读游戏状态的地方都集中在这几个纯函数模块里（本文件、board.ts、note.ts、tickets.ts、tips.ts、tags.ts）。
// 界面的部件只拿到这里算好的数据，不直接读状态。
// 纯函数，不改状态，不碰 DOM，不读系统时钟。界面每秒最多算十次，所以要保持便宜。
import { ECONOMY_V1 } from '../content/economy_v1.ts';
import { MAP_V1 } from '../content/map_v1.ts';
import { DAY_STEPS, DroneState, bayCap, fleetOf, isUnlocked, quoteCommand, stationCount } from '../core/index.ts';
import type { Command, SimState } from '../core/index.ts';
import { computeBoard } from './board.ts';
import type { BoardView } from './board.ts';
import { wholeMoney } from './money.ts';
import { noteDistrictFor, noteView, openDistricts } from './note.ts';
import type { NoteView } from './note.ts';
import { candidateRoofs } from './roofs.ts';
import type { CandidateRoof } from './roofs.ts';
import { activePeak, clockText, dayFraction, dayNumber } from './schedule.ts';
import type { PeakKey } from './schedule.ts';
import { buildTag, doubleBoxItem, gateItem, nearbyLandingItem, openDistrictTags, stationTags } from './tags.ts';
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
  readonly tags: StationTags;
  readonly gate: UpgradeItem;
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
  /** 余额，向下取整：显示的数够买什么，就真的能买。 */
  readonly balance: number;
  /** 今天的进账，按送达的那一天算。 */
  readonly earned: number;
  readonly build: BuildInfo;
  /** 还在用的站，按编号从小到大。 */
  readonly stations: readonly StationCard[];
  /** 没有选中站点时，「加停机位」和「添飞机」价签参照哪座站：编号最小的站，没有站时为 null。 */
  readonly fallbackStation: number | null;
  /** 没有选中站点时，改装里的起降口一行。 */
  readonly gateWithoutStation: UpgradeItem;
  readonly doubleBox: UpgradeItem;
  readonly nearbyLanding: UpgradeItem;
  /** 价签和改装面板要不要显示：第一次日结之后余额达到内容表里的数才开放，开放之前整排价签都不出现。 */
  readonly tagsShown: boolean;
  /** 改装列表里要不要列双层货箱：停机位放满、等飞机成了主要问题之后才开放。 */
  readonly doubleBoxShown: boolean;
  /** 已经显示、还没开通的片区，各带一张开通价签。 */
  readonly openTags: readonly OpenDistrictTag[];
  /** 片区纸条：当前显示的片区。 */
  readonly note: NoteView;
  /** 已经开通的片区，点纸条上的片区名在它们之间轮换。 */
  readonly noteChoices: readonly number[];
  /** 调度台，「先送哪张单」一栏开放之前为 null。 */
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

function stationCard(state: SimState, id: number): StationCard | null {
  const campaign = state.campaign;
  const station = state.stations[id];
  const info = campaign?.stations[id];
  if (station === undefined || info === undefined || station.removed) return null;
  const roof = MAP_V1.roofs[info.roof];
  return {
    id,
    number: id + 1,
    bays: station.bays,
    bayLimit: roof === undefined ? station.bays : bayCap(roof.size),
    drones: fleetOf(state, id),
    gateLevel: info.gateLevel,
    holding: holdingAt(state, id),
    tags: stationTags(state, id),
    gate: gateItem(state, id),
    refund: refundOption(state, id),
  };
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
    balance: wholeMoney(campaign.money),
    earned: wholeMoney(campaign.income[Math.floor(state.step / DAY_STEPS)] ?? 0),
    build: { tag: build, canEnter: candidates.length > 0 && stationCount(state) < ECONOMY_V1.maxStations, candidates },
    stations,
    fallbackStation: stations[0]?.id ?? null,
    gateWithoutStation: gateItem(state, null),
    doubleBox: doubleBoxItem(state),
    nearbyLanding: nearbyLandingItem(state),
    tagsShown: isUnlocked(state, 'priceTags'),
    doubleBoxShown: isUnlocked(state, 'doubleBox'),
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

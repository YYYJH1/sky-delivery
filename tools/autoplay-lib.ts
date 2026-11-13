// 自动购买脚本的主体：五种固定的玩法，一局的运行，节奏节点的提取。
// 它只用核心的命令，像玩家一样操作：开局点击五张订单，调度台开放后换卡，有钱就买东西，建站，开通片区。
// 没有随机数，也不读时钟，一局的结果完全由订单种子和玩法决定。汇总表在 autoplay-summary.ts，命令行和线程池在 autoplay.ts。
//
// 一局的流程：每一步先替玩家点击开局的订单（出现一秒之后，与 tools/campaign.ts 相同），
// 每隔一秒（10 步）做一次决定：先换卡，再买东西。决定都在两步之间做，不改变核心的任何规则。
//
// 买东西的办法是一张按优先级排好的购物清单，每次决定只看清单上第一个「现在可以买」的东西。
// 可以买是指除了钱之外的条件都满足（价签开放、片区开通、屋顶有空、没到上限）。钱够就买，钱不够就等着攒，
// 不去买清单后面更便宜的东西。这和一个盯着下一个目标的玩家一样。每次买东西记下和上一次购买的间隔，
// 以及这段间隔里有多少时间是在等钱（第一个可以买的东西买不起）。
//
// ---- 五种玩法 ----
//
// 1 均衡（balanced）。一个合理的玩家。
//   换卡：「先送哪张单」一栏开放后换成「快超时的先送」。有两座以上的站之后，「别的站帮不帮」换成「等 10 秒再帮」。
//   开通写字楼区之后分成午晚两套，「某一片的先送」开放后，午高峰那套的「先送哪张单」换成「写字楼区的先送」，晚高峰那套保持「快超时的先送」。
//   买东西，按下面的优先级：
//   甲 开通写字楼区：老街三星之后显示，价格取内容表。新片区是眼前的目标，排在扩建之前，所以攒钱的时候不买别的。
//   乙 写字楼区开通后，在写字楼区建第一座站。选址取到本片区已开张的店和本片区的楼平均距离之和最小的一块，不选小屋顶（有中、大屋顶时）。
//   丙 添飞机和停机位：有空停机位的站里，飞机最少的那一座添飞机（并列取编号小的）。所有站的停机位都占满了，
//      而且没到屋顶的上限，就在飞机最少的站加一个停机位，下一次决定再添飞机。
//   丁 屋顶放满之后，在双层货箱、起降口升级、建新站之间选，看最近一场高峰小结的主句：
//      「订单主要在等飞机」先买双层货箱，再建新站，再升起降口。
//      「订单主要在等起降口」先升起降口（小结点名的站，没有点名取飞机最多的站），再建新站，再买双层货箱。
//      「订单主要花在路上」先建新站，再买双层货箱，再升起降口。其余的主句按双层货箱、新站、起降口的顺序。
//      新站建在已开通的片区里，优先选还没有站的片区，其次站最少的片区，选址办法同乙。
//   不买就近降落。它是可以买的改装之一，但这五种玩法的目标是看扩建和换卡的节奏，所以所有玩法都不买它。
// 2 只扩建一座站（singleStation）。只在第一座站上买飞机、停机位、起降口升级和双层货箱，从不建第二座站，会开通写字楼区。
//   换卡和均衡相同，只是只有一座站，所以「别的站帮不帮」不会开放。
// 3 全程不换规矩卡（noCards）。从不下换卡的命令，规矩卡一直是开局的「先下单的先送」「哪座站都能送」「一趟送一单」，其余同均衡。
//   买下双层货箱时，核心会自动把「一趟送几单」从「一趟送一单」换成「顺路的一起送」，这不算玩家换卡（见 campaign/rulesets.ts），所以这一栏会变。
// 4 只买飞机（dronesOnly）。只买飞机和放下这些飞机必须的停机位，不建站，不升起降口，不买货箱，换卡和均衡相同。
//   开通写字楼区不算「买其他」：它是一个片区的开通，不是对运力的投入，不开通就无法继续往前走。
// 5 不操作（idle）。点完开局的五张订单之后什么也不做，作为参照。
import { MAP_V1 } from '../src/content/map_v1.ts';
import { applyCommand, bayCap, createState, fleetOf, hashState, isUnlocked, quoteCommand, step, DAY_STEPS } from '../src/core/index.ts';
import type { CampaignState, Command, PeakRecord, RuleColumn, RuleSet, SimState, Station } from '../src/core/index.ts';

// ---- 常量 ----

/** 每局默认运行的游戏日数。设计要求至少 12 天（72 分钟），多留一些，固定玩法在目标时间之后才做到时也能看见。 */
export const DEFAULT_DAYS = 16;
/** 开局订单出现之后脚本隔多少步点击，与 tools/campaign.ts 的默认值相同（1 秒）。 */
export const CLICK_DELAY = 10;
/** 每隔多少步做一次决定（1 秒）。 */
export const DECIDE_EVERY = 10;
/** 一次决定里最多连买几样（添一个停机位之后马上添飞机）。 */
const MAX_BUYS_PER_DECISION = 12;

const OLD = 0;
const OFFICE = 1;

export type PolicyId = 'balanced' | 'singleStation' | 'noCards' | 'dronesOnly' | 'idle';
export const POLICY_IDS: readonly PolicyId[] = ['balanced', 'singleStation', 'noCards', 'dronesOnly', 'idle'];

interface BuyFlags {
  drone: boolean;
  bay: boolean;
  station: boolean;
  gate: boolean;
  box: boolean;
  district: boolean;
}

export interface PolicySpec {
  id: PolicyId;
  name: string; // 汇总表里的名称
  cards: boolean; // 会不会换规矩卡
  buys: BuyFlags;
}

const ALL_BUYS: BuyFlags = { drone: true, bay: true, station: true, gate: true, box: true, district: true };

export const POLICIES: Readonly<Record<PolicyId, PolicySpec>> = {
  balanced: { id: 'balanced', name: '均衡', cards: true, buys: ALL_BUYS },
  singleStation: { id: 'singleStation', name: '只扩建一座站', cards: true, buys: { ...ALL_BUYS, station: false } },
  noCards: { id: 'noCards', name: '全程不换卡', cards: false, buys: ALL_BUYS },
  dronesOnly: { id: 'dronesOnly', name: '只买飞机', cards: true, buys: { drone: true, bay: true, station: false, gate: false, box: false, district: true } },
  idle: { id: 'idle', name: '不操作', cards: false, buys: { drone: false, bay: false, station: false, gate: false, box: false, district: false } },
};

// ---- 节点 ----

/** 节奏目标里要记录的节点，加上几个帮助看懂的附加节点。值是第一次发生的步，一局里没有发生为 null。 */
export const MAIN_NODES = ['firstPurchase', 'oldStreet2', 'oldStreet3', 'officeShown', 'secondStation', 'firstChoice', 'office3', 'campusShown'] as const;
export const EXTRA_NODES = ['selectOpen', 'selectSet', 'officeOpened', 'doubleBoxOpen', 'firstGate'] as const;
export type MainNodeId = (typeof MAIN_NODES)[number];
export type ExtraNodeId = (typeof EXTRA_NODES)[number];
export type NodeId = MainNodeId | ExtraNodeId;

export interface NodeInfo {
  id: NodeId;
  label: string;
  /** 目标区间，一倍速的分钟。附加节点没有目标 */
  target: readonly [number, number] | null;
  targetText: string;
}

export const NODE_INFO: readonly NodeInfo[] = [
  { id: 'firstPurchase', label: '第一次购买', target: [6, 8], targetText: '6 到 8' },
  { id: 'oldStreet2', label: '老街二星', target: [5.5, 6.5], targetText: '约 6' },
  { id: 'oldStreet3', label: '老街三星', target: [11.5, 12.5], targetText: '约 12' },
  { id: 'officeShown', label: '写字楼区显示', target: [11.5, 12.5], targetText: '约 12' },
  { id: 'secondStation', label: '第二座站建成', target: [15, 20], targetText: '15 到 20' },
  { id: 'firstChoice', label: '第一个需要比较的购买选择', target: [15, 25], targetText: '15 到 25' },
  { id: 'office3', label: '写字楼区三星', target: [45, 60], targetText: '45 到 60' },
  { id: 'campusShown', label: '大学城显示', target: [45, 60], targetText: '45 到 60' },
  { id: 'selectOpen', label: '（附）「先送哪张单」一栏开放', target: null, targetText: '' },
  { id: 'selectSet', label: '（附）第一次换卡', target: null, targetText: '' },
  { id: 'officeOpened', label: '（附）开通写字楼区', target: null, targetText: '' },
  { id: 'doubleBoxOpen', label: '（附）双层货箱开放', target: null, targetText: '' },
  { id: 'firstGate', label: '（附）第一次买起降口升级', target: null, targetText: '' },
];

/** 一步对应的一倍速分钟数：一步 0.1 秒。 */
export function stepsToMinutes(steps: number): number {
  return steps / 600;
}

// ---- 一局的记录 ----

export interface PurchaseRecord {
  step: number;
  type: string;
  /** 站的编号（添飞机、加停机位、升级起降口），屋顶的下标（建站），片区编号（开通），其余为 null */
  target: number | null;
  price: number;
  /** 与上一次购买相隔的步数，第一次购买从第 0 步算起 */
  gap: number;
  /** 这段间隔里，清单上第一个可以买的东西买不起的步数，也就是在攒钱的时间 */
  saving: number;
  balance: number; // 买完之后的余额
}

export interface DayLine {
  district: number;
  star: number; // 日结之后
  n: number; // 最近两天有结果的订单数
  onTimePct: number | null;
  cancelPct: number | null;
  kind: string;
}

export interface DayOut {
  day: number; // 从 1 数起
  balance: number; // 这一天最后一步结束时的余额（日结之前）
  income: number; // 这一天送达的订单进账
  spent: number; // 这一天买东西花的钱
  lines: DayLine[]; // 日结之后各开通片区的星级、最近两天的准时率和退单率
  stations: number; // 日结时没退回的站数
  drones: number; // 日结时的飞机数
  bays: number; // 日结时的停机位总数
}

export interface CrossRiver {
  /** 开通写字楼区的步 */
  openStep: number;
  /** 开通之后第 1 到 5 个 3600 步里，送往写字楼区的订单数，和其中来自老街的店的订单数 */
  orders: number[];
  fromOld: number[];
}

export interface RunRecord {
  policy: PolicyId;
  seed: number;
  days: number;
  nodes: Record<NodeId, number | null>;
  daily: DayOut[];
  purchases: PurchaseRecord[];
  /** 换卡的命令成功了几次（核心自动换的不算） */
  cardChanges: number;
  maxGap: number; // 最长的购买间隔，步，没有购买为 0
  maxSaving: number; // 最长的攒钱时间，步
  crossRiver: CrossRiver | null;
  final: { money: number; spent: number; stars: number[]; open: boolean[]; stations: number; drones: number; bays: number; rules: { select: string; zone: string; pool: string } };
  hash: string;
}

export interface PlayOptions {
  days?: number;
  clickDelay?: number;
  decideEvery?: number;
  /** 测试用：开局多给的钱，缺省 0 */
  startMoney?: number;
}

export interface PlayOutcome {
  record: RunRecord;
  state: SimState;
}

// ---- 读状态的小函数 ----

function campaignOf(state: SimState): CampaignState {
  if (state.campaign === null) throw new Error('autoplay needs the campaign mode');
  return state.campaign;
}

function liveStations(state: SimState): Station[] {
  return state.stations.filter((s) => !s.removed);
}

function stationDistrict(state: SimState, id: number): number {
  const roof = (campaignOf(state).stations[id] as { roof: number }).roof;
  return (MAP_V1.roofs[roof] as { district: number }).district;
}

function stationCap(state: SimState, id: number): number {
  const roof = (campaignOf(state).stations[id] as { roof: number }).roof;
  return bayCap((MAP_V1.roofs[roof] as { size: 'small' | 'medium' | 'large' }).size);
}

function gateLevel(state: SimState, id: number): number {
  return (campaignOf(state).stations[id] as { gateLevel: number }).gateLevel;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function meanDistance(from: { x: number; y: number }, points: readonly { x: number; y: number }[]): number {
  if (points.length === 0) return 0;
  let sum = 0;
  for (const p of points) sum += distance(from, p);
  return sum / points.length;
}

/**
 * 在一个片区里选一块屋顶建站：没有站的屋顶里，到本片区已开张的店和到本片区的楼的平均距离之和最小的一块。
 * 有中、大屋顶时不选小屋顶。距离相同取下标小的。没有空屋顶时返回 -1。
 */
export function chooseRoof(state: SimState, district: number): number {
  const campaign = campaignOf(state);
  const free: number[] = [];
  MAP_V1.roofs.forEach((roof, i) => {
    if (roof.district === district && campaign.roofStation[i] === -1) free.push(i);
  });
  if (free.length === 0) return -1;
  const roomy = free.filter((i) => (MAP_V1.roofs[i] as { size: string }).size !== 'small');
  const pool = roomy.length > 0 ? roomy : free;
  const shops = MAP_V1.shops.filter((s, i) => s.district === district && campaign.shopOpen[i] === true);
  const buildings = MAP_V1.buildings.filter((b) => b.district === district);
  let best = -1;
  let bestScore = Infinity;
  for (const i of pool) {
    const roof = MAP_V1.roofs[i] as { x: number; y: number };
    const score = meanDistance(roof, shops) + meanDistance(roof, buildings);
    if (score < bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** 飞机最少的站，并列取编号小的。 */
function fewestDrones(state: SimState, stations: readonly Station[]): Station | null {
  let best: Station | null = null;
  let bestFleet = Infinity;
  for (const s of stations) {
    const fleet = fleetOf(state, s.id);
    if (fleet < bestFleet) {
      best = s;
      bestFleet = fleet;
    }
  }
  return best;
}

/** 添飞机或加停机位：有空停机位的站里飞机最少的添飞机，没有空停机位而且没到屋顶上限的站里飞机最少的加停机位。都没有返回 null。 */
function growthCommand(state: SimState, spec: PolicySpec): Command | null {
  const live = liveStations(state);
  if (spec.buys.drone) {
    const withFree = live.filter((s) => fleetOf(state, s.id) < s.bays);
    const pick = fewestDrones(state, withFree);
    if (pick !== null) return { type: 'buyDrone', station: pick.id };
  }
  if (spec.buys.bay) {
    const growable = live.filter((s) => fleetOf(state, s.id) >= s.bays && s.bays < stationCap(state, s.id));
    const pick = fewestDrones(state, growable);
    if (pick !== null) return { type: 'buyBay', station: pick.id };
  }
  return null;
}

/** 升起降口的站：小结点名等降落的站优先，否则飞机最多的站，都要没到 3 级。 */
function gateCommand(state: SimState, last: PeakRecord | undefined): Command | null {
  const live = liveStations(state).filter((s) => gateLevel(state, s.id) < 3);
  if (live.length === 0) return null;
  const extra = last?.extra ?? null;
  const named = extra !== null && extra.id === 'landQueue' ? live.find((s) => s.id === extra.station) : undefined;
  if (named !== undefined) return { type: 'upgradeGate', station: named.id };
  let best = live[0] as Station;
  for (const s of live) if (fleetOf(state, s.id) > fleetOf(state, best.id)) best = s;
  return { type: 'upgradeGate', station: best.id };
}

/** 建新站：已开通的片区里，优先选还没有站的片区，其次站最少的片区，片区编号小的优先，片区里选址见 chooseRoof。 */
function stationCommand(state: SimState): Command | null {
  const campaign = campaignOf(state);
  const live = liveStations(state);
  const open = campaign.districts.map((d, k) => ({ k, open: d.open })).filter((d) => d.open);
  const ranked = open
    .map((d) => ({ k: d.k, count: live.filter((s) => stationDistrict(state, s.id) === d.k).length }))
    .sort((a, b) => a.count - b.count || a.k - b.k);
  for (const d of ranked) {
    const roof = chooseRoof(state, d.k);
    if (roof >= 0) return { type: 'buildStation', roof };
  }
  return null;
}

/** 屋顶放满之后在双层货箱、起降口升级、建新站之间选，按最近一场高峰小结的主句排顺序。 */
function fullRoofChoices(state: SimState, spec: PolicySpec): Command[] {
  const peaks = campaignOf(state).peaks;
  const last = peaks.length > 0 ? (peaks[peaks.length - 1] as PeakRecord) : undefined;
  const box: Command | null = spec.buys.box ? { type: 'buyDoubleBox' } : null;
  const gate = spec.buys.gate ? gateCommand(state, last) : null;
  const station = spec.buys.station ? stationCommand(state) : null;
  const main = last?.main.id;
  let order: (Command | null)[];
  if (main === 'waitGate') order = [gate, station, box];
  else if (main === 'road') order = [station, box, gate];
  else order = [box, station, gate]; // 等飞机，以及不需要处理的情形
  return order.filter((c): c is Command => c !== null);
}

/** 购物清单，按优先级。每个命令的开放条件由核心的报价判断，这里不重复。 */
export function shoppingList(state: SimState, spec: PolicySpec): Command[] {
  const campaign = campaignOf(state);
  const list: Command[] = [];
  const office = campaign.districts[OFFICE] as { open: boolean };
  if (spec.buys.district && !office.open) list.push({ type: 'openDistrict', district: OFFICE });
  if (spec.buys.station && office.open && !liveStations(state).some((s) => stationDistrict(state, s.id) === OFFICE)) {
    const roof = chooseRoof(state, OFFICE);
    if (roof >= 0) list.push({ type: 'buildStation', roof });
  }
  const growth = growthCommand(state, spec);
  if (growth !== null) list.push(growth);
  else list.push(...fullRoofChoices(state, spec));
  return list;
}

// ---- 换卡 ----

type PeakName = 'noon' | 'evening';

/** 某一套规矩里各栏现在该选哪张卡。栏还没开放时不写，由核心的开放条件决定。 */
function wantedRules(state: SimState, peak: PeakName | null): Partial<Record<RuleColumn, string>> {
  const want: Partial<Record<RuleColumn, string>> = {};
  if (isUnlocked(state, 'selectColumn')) {
    want.select = peak === 'noon' && isUnlocked(state, 'prioDistrict') ? 'prioOffice' : 'deadline';
  }
  if (isUnlocked(state, 'zoneColumn')) want.zone = 'hybrid';
  return want;
}

/** 要换的卡，一栏一条命令。还没分成两套时改现在的一套，分成两套之后午晚各改各的。 */
export function ruleCommands(state: SimState, spec: PolicySpec): Command[] {
  if (!spec.cards) return [];
  const sets = campaignOf(state).ruleSets;
  const commands: Command[] = [];
  const consider = (peak: PeakName | null, current: Record<RuleColumn, string>): void => {
    const want = wantedRules(state, peak);
    for (const column of ['select', 'zone'] as const) {
      const id = want[column];
      if (id === undefined || current[column] === id) continue;
      const rules: Partial<RuleSet> = {};
      rules[column] = id;
      commands.push(peak === null ? { type: 'setRules', rules } : { type: 'setRules', rules, peak });
    }
  };
  if (sets === null) consider(null, state.rules);
  else {
    consider('noon', sets.noon);
    consider('evening', sets.evening);
  }
  return commands;
}

// ---- 一局 ----

function targetOf(command: Command): number | null {
  switch (command.type) {
    case 'buyDrone':
    case 'buyBay':
    case 'upgradeGate':
      return command.station;
    case 'buildStation':
      return command.roof;
    case 'openDistrict':
      return command.district;
    default:
      return null;
  }
}

/** 开局的五张订单：出现 clickDelay 步之后点击。 */
function clickOpening(state: SimState, clickDelay: number): void {
  const campaign = campaignOf(state);
  if (campaign.opening.done) return;
  for (const id of campaign.opening.orders) {
    const order = state.orders[id];
    if (order !== undefined && order.manualAt < 0 && state.step >= order.tOrder + clickDelay) {
      applyCommand(state, { type: 'prioritizeOrder', order: id });
    }
  }
}

/** 从日结记录和购买记录里提取节点。 */
export function extractNodes(state: SimState, purchases: readonly PurchaseRecord[], cardStep: number | null): Record<NodeId, number | null> {
  const campaign = campaignOf(state);
  const starAt = (district: number, star: number): number | null => {
    for (const record of campaign.days) {
      const line = record.districts.find((l) => l.district === district);
      if (line !== undefined && line.star >= star) return record.step;
    }
    return null;
  };
  const unlockAt = (step: number): number | null => (step >= 0 ? step : null);
  const first = (type: string, target?: number): number | null =>
    purchases.find((p) => p.type === type && (target === undefined || p.target === target))?.step ?? null;
  const secondStation = first('buildStation');
  const doubleBoxOpen = unlockAt(campaign.unlocks.doubleBox);
  const firstGate = first('upgradeGate');
  const choices = [secondStation, doubleBoxOpen, firstGate].filter((v): v is number => v !== null);
  return {
    firstPurchase: purchases.length > 0 ? (purchases[0] as PurchaseRecord).step : null,
    oldStreet2: starAt(OLD, 2),
    oldStreet3: starAt(OLD, 3),
    officeShown: unlockAt(campaign.unlocks.showOffice),
    secondStation,
    firstChoice: choices.length > 0 ? Math.min(...choices) : null,
    office3: starAt(OFFICE, 3),
    campusShown: unlockAt(campaign.unlocks.showCampus),
    selectOpen: unlockAt(campaign.unlocks.selectColumn),
    selectSet: cardStep,
    officeOpened: first('openDistrict', OFFICE),
    doubleBoxOpen,
    firstGate,
  };
}

/** 写字楼区开通之后头几天，送往写字楼区的订单有多少来自老街的店。没开通写字楼区时为 null。 */
function crossRiverOf(state: SimState, purchases: readonly PurchaseRecord[]): CrossRiver | null {
  const open = purchases.find((p) => p.type === 'openDistrict' && p.target === OFFICE);
  if (open === undefined) return null;
  const orders = [0, 0, 0, 0, 0];
  const fromOld = [0, 0, 0, 0, 0];
  for (const o of state.orders) {
    if (o.district !== OFFICE || o.tOrder < open.step) continue;
    const k = Math.floor((o.tOrder - open.step) / DAY_STEPS);
    if (k >= orders.length) continue;
    orders[k] = (orders[k] as number) + 1;
    if ((state.world.merchants[o.merchant] as { district: number }).district === OLD) fromOld[k] = (fromOld[k] as number) + 1;
  }
  return { openStep: open.step, orders, fromOld };
}

/**
 * 按一种玩法从开局玩 days 个游戏日。最后一天的日结在第 days × 3600 步开始时才做，所以多走一步，让它进记录。
 * 返回这一局的记录和结束时的状态（测试要看状态）。
 */
export function playGame(policyId: PolicyId, seed: number, options: PlayOptions = {}): PlayOutcome {
  const days = options.days ?? DEFAULT_DAYS;
  const clickDelay = options.clickDelay ?? CLICK_DELAY;
  const decideEvery = options.decideEvery ?? DECIDE_EVERY;
  const spec = POLICIES[policyId];
  const state = createState({ mode: 'campaign', seed });
  const campaign = campaignOf(state);
  campaign.money += options.startMoney ?? 0;

  const purchases: PurchaseRecord[] = [];
  const snapshots: { balance: number; stations: number; drones: number; bays: number }[] = [];
  let lastPurchase = 0;
  let saving = 0;
  let cardChanges = 0;
  let cardStep: number | null = null;

  /** 清单上第一个可以买的东西：钱够就买，钱不够就等着攒。买了返回 true。 */
  const buyNext = (): boolean => {
    for (const command of shoppingList(state, spec)) {
      const quote = quoteCommand(state, command);
      if (quote.ok) {
        const result = applyCommand(state, command);
        if (!result.ok) return false;
        const at = state.step;
        purchases.push({ step: at, type: command.type, target: targetOf(command), price: quote.price, gap: at - lastPurchase, saving, balance: campaign.money });
        lastPurchase = at;
        saving = 0;
        return true;
      }
      if (quote.reason === 'notEnoughMoney') {
        saving += decideEvery;
        return false;
      }
    }
    return false;
  };

  const total = days * DAY_STEPS + 1;
  for (let i = 0; i < total; i++) {
    clickOpening(state, clickDelay);
    if (state.step % decideEvery === 0) {
      for (const command of ruleCommands(state, spec)) {
        if (applyCommand(state, command).ok) {
          cardChanges += 1;
          if (cardStep === null) cardStep = state.step;
        }
      }
      for (let n = 0; n < MAX_BUYS_PER_DECISION; n++) if (!buyNext()) break;
    }
    step(state);
    if (state.step % DAY_STEPS === 0) {
      // 一天最后一步结束，日结之前
      const live = liveStations(state);
      snapshots.push({
        balance: campaign.money,
        stations: live.length,
        drones: state.drones.filter((d) => !d.removed).length,
        bays: live.reduce((sum, s) => sum + s.bays, 0),
      });
    }
  }

  const daily: DayOut[] = Array.from({ length: days }, (_, d) => {
    const record = campaign.days[d];
    const from = d * DAY_STEPS;
    const snapshot = snapshots[d] as (typeof snapshots)[number];
    return {
      day: d + 1,
      balance: snapshot.balance,
      income: campaign.income[d] ?? 0,
      spent: purchases.filter((p) => p.step >= from && p.step < from + DAY_STEPS).reduce((sum, p) => sum + p.price, 0),
      lines: (record?.districts ?? []).map((l) => ({ district: l.district, star: l.star, n: l.n, onTimePct: l.onTimePct, cancelPct: l.cancelPct, kind: l.kind })),
      stations: snapshot.stations,
      drones: snapshot.drones,
      bays: snapshot.bays,
    };
  });

  const live = liveStations(state);
  const record: RunRecord = {
    policy: policyId,
    seed,
    days,
    nodes: extractNodes(state, purchases, cardStep),
    daily,
    purchases,
    cardChanges,
    maxGap: purchases.reduce((m, p) => Math.max(m, p.gap), 0),
    maxSaving: purchases.reduce((m, p) => Math.max(m, p.saving), 0),
    crossRiver: crossRiverOf(state, purchases),
    final: {
      money: campaign.money,
      spent: campaign.spent,
      stars: campaign.districts.map((d) => d.star),
      open: campaign.districts.map((d) => d.open),
      stations: live.length,
      drones: state.drones.filter((d) => !d.removed).length,
      bays: live.reduce((sum, s) => sum + s.bays, 0),
      rules: { ...state.rules },
    },
    hash: hashState(state),
  };
  return { record, state };
}

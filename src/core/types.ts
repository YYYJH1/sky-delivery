// 模拟状态的类型。状态是一个可以直接 JSON 序列化的普通对象：
// 没有类实例、函数、Infinity、NaN 和 undefined。
import type { RngState } from './rng.ts';
import type { PeakName } from './systems/schedule.ts';

export type ScenarioId = 'oldStreet' | 'threeDistricts' | 'sparseOffice';
export type LayoutId = 'default' | 'single' | 'three' | 'edge';
/** 沙盒模式是核心的基本行为，经营模式在它之外加地图 v1、金钱和玩家的命令。 */
export type GameMode = 'sandbox' | 'campaign';
/** 飞完回哪：回原站，或者降落到最近的、停机位没满的站（就近降落）。 */
export type ReturnRule = 'home' | 'nearest';

/** 调度台上三栏各选中的一张卡（规则编号）。 */
export interface RuleSet {
  select: string; // 先送哪张单
  zone: string; // 别的站帮不帮
  pool: string; // 一趟送几单
}

export type RuleColumn = keyof RuleSet;

export interface SimConfig {
  scenario: ScenarioId;
  layout: LayoutId;
  mapSeed: number; // 决定店和楼的位置与店铺热度
  seed: number; // 决定订单序列
  drones: number; // 飞机总数，在各站之间尽量平分
  extraBays: number; // 每座站在初始飞机数之外多出的停机位
  peakRate: number; // 到达曲线取 1 时每分钟来单数
  gateInterval: number; // 秒，起降口两次动作开始之间的最小间隔
  chargeTime: number; // 秒，从空电充满
  capacity: number; // 载量（份）
  constantRate: boolean; // 来单率恒定：每步的来单率不随一天里的时刻变化，容量标定用
  noonDestinations: boolean; // 目的片区一律按午间的比例，容量标定用
  rules: RuleSet; // 开局的规则
  orderEndStep: number | null; // 这一步及之后不再产生订单，null 表示一直产生
  mode: GameMode; // 经营模式用地图 v1 和内容表，场景、布局、地图种子、飞机数、来单率、起降间隔都不起作用
  returnRule: ReturnRule; // 开局的飞完回哪的规则，经营模式里买了就近降落之后改变
}

// ---- 地图 ----
export interface DistrictRect {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Merchant {
  x: number;
  y: number;
  district: number;
  rank: number; // 热度名次，1 最热
  weight: number; // 抽取权重
}

export interface Building {
  x: number;
  y: number;
  district: number;
}

/** 静态地图。创建之后不再改变。 */
export interface World {
  width: number;
  height: number;
  districts: DistrictRect[];
  merchants: Merchant[];
  buildings: Building[];
  buildingsByDistrict: number[][];
  // 每栋楼对各店的累计抽取权重，用于按楼抽店
  cumWeights: number[][];
  digest: string;
}

// ---- 站点、飞机、订单 ----
export interface Station {
  id: number;
  x: number;
  y: number;
  bays: number; // 停机位数
  occupied: number; // 占着停机位的飞机数（停着、等起飞、起飞中、降落中）
  queue: number[]; // 起降口的队列（飞机编号），起飞和降落共用
  gateFree: number; // 起降口下一次可以开始动作的步
  gateInterval: number; // 两次动作开始之间的最小间隔（步）
  removed: boolean; // 已退回：编号不回收，不参与派单，不产生统计，不画出来
}

export interface RouteStop {
  kind: number; // StopKind
  order: number;
}

export interface Drone {
  id: number;
  x: number;
  y: number;
  battery: number;
  home: number; // 归属站
  state: number; // DroneState
  station: number; // 占用停机位或在上空等降落的站，其余时候为 -1
  route: RouteStop[];
  onboard: number[];
  load: number; // 机上份量
  tx: number; // 当前飞行目标
  ty: number;
  tEnd: number; // 定时动作的结束步
  returning: boolean; // 手上没有任务，正在回站
  target: number; // 回站的目标站，不在回站时为 -1
  queuedAt: number; // 进入起降口队列的步
  stranded: boolean; // 电量已经耗尽（只记一次）
  departed: number; // 这一趟从哪座站的停机位起飞，落地后为 -1
  removed: boolean; // 已退回：编号不回收，不参与派单，不产生统计，不画出来
}

export interface Order {
  id: number;
  tOrder: number;
  merchant: number;
  building: number;
  district: number; // 送达片区
  portion: number; // 订单份量，大单为 2
  units: number; // 机上份量，派单时取份量和载量的较小值
  amount: number;
  dMB: number; // 店到楼的距离
  prepDone: number; // 出餐完成的步
  home: number; // 离这家店最近的站
  status: number; // OrderStatus
  tAssign: number; // 以下时刻为 -1 表示尚未发生
  tArrive: number;
  tPick: number;
  tDeliver: number;
  tCancel: number;
  drone: number;
  departed: number; // 接这张单的飞机从哪座站起飞
  gateWait: number; // 从派单到起飞开始的步数
  rev: number;
  tip: number;
  early: boolean; // 已记为「提前派出」
  manualAt: number; // 玩家点击插队的步，没有为 -1
  shared: boolean; // 取餐之后，机上同时有别的订单（同乘）
}

// ---- 统计 ----
export interface EarlyEvent {
  step: number; // 派出的步
  order: number;
  rule: string; // 当时生效的「先送哪张单」
  day: number; // 订单下单所属的游戏日
  peak: number; // 订单下单所属的高峰（PeakId），不在高峰内为 -1
}

export interface RuleChange {
  step: number;
  column: RuleColumn;
  from: string;
  to: string;
}

export interface Stats {
  stranded: number; // 电量耗尽的次数
  // 按站、按秒累计：每步的等降落架数、空停机位数、停机位总数
  landWait: number[][];
  bayEmpty: number[][];
  bayTotal: number[][];
  early: EarlyEvent[];
  ruleChanges: RuleChange[];
  // 按游戏日累计的飞行距离：全部飞机的飞行距离，以及其中载货飞行的距离。下标是游戏日
  flightTotal: number[];
  flightLoaded: number[];
}

// ---- 经营模式 ----
/** 一笔可以当天原价退回的购买。day 是买的那一天，开局自带的东西 day 为 -1，不能退。 */
export interface Purchase {
  day: number;
  paid: number;
}

export interface CampaignDistrict {
  open: boolean; // 是否已开通。开通之后这个片区的楼和开局就开张的店开始使用，候选屋顶可以建站
  star: number; // 口碑星级 1 到 5。开通的那一步不变，由日结改变
}

export interface CampaignStation {
  roof: number; // 建在哪块候选屋顶上（地图 v1 里 roofs 的下标）
  gateLevel: number; // 起降口等级 1 到 3
  built: Purchase; // 建站
  bays: Purchase[]; // 在新站自带的停机位之外买的，按买的先后
}

export interface CampaignOpening {
  orders: number[]; // 已经出现的开局订单的编号，按出现的先后。下一张的序号就是它的长度
  done: boolean; // 五张开局订单都有了结果：自动派单打开，随机订单开始产生
}

// ---- 经营模式：口碑、解锁、两套规矩、日结和小结的记录、便签、结局 ----
// 这些字段都在 state.campaign 里，进状态哈希，随存档保存。记录一经生成不再修改。
// 没有 NaN 和 Infinity：没有订单时的比率写 null，百分数是下取整的整数。

/** 一个片区的口碑计数，与 districts 一一对应。 */
export interface DistrictRating {
  misses: number; // 三星及以上：连续没有达到当前星级下面一档的日结次数。达到、掉星或升星之后清零
  noUpgrade: number; // 片区开通之后，连续没有升星的日结次数。升星之后清零
}

/**
 * 会逐步开放的东西。每一项在 campaign.unlocks 里记下开放的那一步，-1 表示还没开放。已经开放的不会再锁上。
 * selectColumn：「先送哪张单」一栏，带「快超时的先送」。priceTags：价签，也就是建站、添飞机、加停机位、起降口升级、双层货箱、就近降落。
 * doubleBox：双层货箱出现在改装里。poolColumn：「一趟送几单」一栏，买下双层货箱时开放。zoneColumn：「别的站帮不帮」一栏，三张卡同时开放。
 * nearestLanding：就近降落，要有两座以上的站。ruleSets：午晚两套规矩，开通写字楼区时开放。
 * prioDistrict：三张「某一片的先送」。roundtrip：「来回快的先送」。showOffice、showCampus：显示写字楼区、大学城和它们的开通价格。
 */
export type UnlockKey =
  | 'selectColumn'
  | 'priceTags'
  | 'doubleBox'
  | 'poolColumn'
  | 'zoneColumn'
  | 'nearestLanding'
  | 'ruleSets'
  | 'prioDistrict'
  | 'roundtrip'
  | 'showOffice'
  | 'showCampus';

export type Unlocks = Record<UnlockKey, number>;

/** 午高峰和晚高峰各一套规矩。 */
export interface RuleSets {
  noon: RuleSet;
  evening: RuleSet;
}

/** 新店相对片区中心的方位。 */
export type PlaceDirection = 'east' | 'south' | 'west' | 'north' | 'middle';

export interface NewShop {
  shop: number; // 地图 v1 里店的下标，也是它在词表店名列表里的序号
  direction: PlaceDirection; // 相对所在片区中心的方位
}

/**
 * 日结里一个片区的一行。kind 对应词表 dayEnd 里的一条：
 * starUp 升星（带 newShops），starDown 掉星，starKept 星级不变，noOrders 最近两天没有订单，
 * tooFewOrders 最近两天有结果的订单少于下限（STARS_V1.minSample），星级和计数都不变，n 和准时率照常记录，
 * dropByOnTime 和 dropByCancel 是三星及以上这一次日结没有达到当前星级下面一档的条件、计数为 1 的情形。
 */
export type DayLineKind = 'starUp' | 'starDown' | 'starKept' | 'noOrders' | 'tooFewOrders' | 'dropByOnTime' | 'dropByCancel';

export interface DayDistrictRecord {
  district: number;
  kind: DayLineKind;
  fromStar: number; // 日结之前的星级
  star: number; // 日结之后的星级
  n: number; // 最近两天有结果的、送往这个片区的订单数
  onTime: number; // 其中准时送达的
  cancelled: number; // 其中退单的
  onTimePct: number | null; // 准时率，下取整的百分数，n 为 0 时为 null
  cancelPct: number | null; // 退单率，下取整的百分数
  needOnTimePct: number | null; // dropByOnTime 要保持的准时率，其余为 null
  needCancelPct: number | null; // dropByCancel 要低于的退单率，其余为 null
  newShops: NewShop[]; // 升星时新开张的店，其余为空
}

/** 一次日结的记录。第 n 天的日结在第 (n + 1) × 3600 步开始时、产生订单之前做。 */
export interface DayRecord {
  day: number; // 游戏日，从 0 数起
  step: number; // 做日结的那一步
  ordered: number; // 今天下单的订单数
  resolved: number; // 今天有结果的订单数，按结果产生的那一步归日，等于 onTime + late + cancelled
  onTime: number; // 准时送达
  late: number; // 超时送达
  cancelled: number; // 退单
  pending: number; // 做日结时还没有结果的订单数，包括没派出的和已派出还没送到的
  income: number; // 今天的进账，按送达那一天计
  districts: DayDistrictRecord[]; // 每个开通的片区一行，按片区编号
}

/** 高峰小结说明的主句。id 对应词表 summary.main 的键，参数名与词表一致。 */
export type MainSentence =
  | { id: 'noOrders' }
  | { id: 'noDelivered' }
  | { id: 'onTimeHigh'; onTime: number }
  | { id: 'waitDrone' }
  | { id: 'waitGate' }
  | { id: 'road' }
  | { id: 'waitPrep' };

/** 高峰小结说明的附加句。id 对应词表 summary.extra 的键。station 是站的编号（n 号站是编号加一），district 是片区编号。 */
export type ExtraSentence =
  | { id: 'landQueue'; station: number; count: number }
  | { id: 'bayIdle'; station: number; percent: number }
  | { id: 'notNearest'; percent: number }
  | { id: 'districtLow'; district: number; onTime: number };

export interface PeakDistrictRow {
  district: number;
  n: number; // 这一场里送往这个片区的订单数
  onTime: number; // 其中准时送达的
  pct: number | null; // 准时率，下取整的百分数，没有订单为 null
  delta: number | null; // 与前一天同一场高峰相比的变化，单位是百分点，没有可比的（第一天、前一天没有订单）为 null
}

/** 一张订单的四段时间各占的百分数，四个数加起来是 100。 */
export interface PeakSegments {
  waitDrone: number;
  waitGate: number;
  waitPrep: number;
  road: number;
}

/** 一场高峰小结的记录，在小结时刻（summaryStep）生成。 */
export interface PeakRecord {
  day: number;
  peak: PeakName;
  step: number; // 生成的步
  orders: number; // 来单
  onTime: number; // 准时
  late: number; // 超时：超时送达的，加上到这一步还没送到的
  lateOpen: number; // 其中还没送到的
  cancelled: number; // 退单，只算到这一步为止
  revenue: number; // 进账
  districts: PeakDistrictRow[]; // 生成时开通的片区，按片区编号
  segments: PeakSegments | null; // 只统计已经送达的订单，没有送达的订单时为 null
  select: string; // 生成时「先送哪张单」的卡。是「先下单的先送」时界面不显示「提前派出」那一段
  early: number | null; // 提前派出的订单数。这一场中途换过「先送哪张单」时为 null
  changedMidPeak: boolean; // 这一场中途换过「先送哪张单」
  main: MainSentence;
  extra: ExtraSentence | null;
}

export type TipId =
  | 'firstOrder'
  | 'autoDispatchOn'
  | 'firstRedOrder'
  | 'boardReady'
  | 'canAddBay'
  | 'gateBusy'
  | 'openOffice';

/** 一条便签。id 对应词表 tips 的键，每条最多出现一次。界面显示之后用 readTip 命令标记已读。 */
export interface TipRecord {
  id: TipId;
  step: number; // 出现的步
  station: number | null; // gateBusy 的站编号（n 号站是编号加一），其余为 null
  read: boolean;
}

/** 结局：三个片区都到了四星。只记一次，之后照常运行。 */
export interface Ending {
  step: number; // 做日结的那一步
  days: number; // 用了几天，等于做日结的游戏日的序号加一
  orders: number; // 一共送达了多少单
}

/**
 * 一次离开结算的记录：关闭游戏，或网页不可见超过一分钟，回来时按最近的进账速度结算的一笔钱。
 * 记录一经生成不再修改。游戏内时间在离开期间不前进，所以 step 记的是回来时状态所在的步。
 */
export interface AwayRecord {
  step: number; // 结算时状态所在的步
  seconds: number; // 离开的秒数，没有按上限截断
  amount: number; // 加进余额的钱，向下取整的整数
}

export interface CampaignState {
  contentVersion: number; // 内容表的版本号，存档只记它，不记内容本身
  money: number; // 余额
  spent: number; // 全部购买的合计
  refunded: number; // 全部退回的合计
  income: number[]; // 每个游戏日的订单进账，按送达那一天计，下标是游戏日
  districts: CampaignDistrict[]; // 与 world.districts 一一对应
  shopOpen: boolean[]; // 每家店是否已开张，与 world.merchants 一一对应。开张之后不会关，掉星也不关
  cumWeights: number[][]; // 每栋楼对各店的累计抽取权重，没开张的店权重为 0，开店时重算
  roofStation: number[]; // 每块候选屋顶上的站，空着为 -1
  stations: CampaignStation[]; // 与 state.stations 一一对应
  drones: Purchase[]; // 与 state.drones 一一对应
  opening: CampaignOpening;
  // 以下是口碑、解锁、规矩、日结和小结、便签、结局的字段
  rating: DistrictRating[]; // 与 districts 一一对应
  unlocks: Unlocks;
  ruleSets: RuleSets | null; // 开通写字楼区之前为 null，只有 state.rules 一套。分开之后 state.rules 是现在生效的那一套
  days: DayRecord[]; // 日结记录，下标是游戏日
  peaks: PeakRecord[]; // 高峰小结记录，按生成的先后
  tips: TipRecord[]; // 便签队列，按出现的先后，已读的也留着
  delivered: number; // 到现在一共送达的订单数
  ending: Ending | null;
  // 以下是离开结算的字段
  away: AwayRecord[]; // 离开结算的记录，按结算的先后，最多留最近的 100 条
}

export interface SimState {
  config: SimConfig;
  world: World;
  step: number;
  rng: { orders: RngState; dispatch: RngState };
  rules: RuleSet;
  capacity: number; // 载量（份）。沙盒取配置的值，经营模式里买了双层货箱之后改变
  returnRule: ReturnRule; // 飞完回哪。沙盒取配置的值，经营模式里买了就近降落之后改变
  stations: Station[];
  drones: Drone[];
  orders: Order[];
  pending: number[]; // 尚未派出的订单，按下单顺序
  openQueue: number[]; // 尚未取走的订单，按下单顺序，用于退单检查
  stats: Stats;
  campaign: CampaignState | null; // 沙盒模式为 null
}

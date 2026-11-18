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
  select: string; // 调度策略
  zone: string; // 协同策略
  pool: string; // 合单策略
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
  returnRule: ReturnRule; // 开局的飞完回哪的规则，经营模式里买了就近降落或切换开关之后，现在的规则在 state.returnRule 里
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
  rule: string; // 当时生效的「调度策略」
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

// ---- 经营模式：口碑、解锁、两套策略、日结和小结的记录、便签、结局 ----
// 这些字段都在 state.campaign 里，进状态哈希，随存档保存。记录一经生成不再修改。
// 没有 NaN 和 Infinity：没有订单时的比率写 null，百分数是下取整的整数。

/** 一个片区的口碑计数，与 districts 一一对应。 */
export interface DistrictRating {
  misses: number; // 三星及以上：连续没有达到当前星级下面一档的日结次数。达到、掉星或升星之后清零
  noUpgrade: number; // 片区开通之后，连续没有升星的日结次数。升星之后清零
}

/**
 * 会逐步开放的东西。每一项在 campaign.unlocks 里记下开放的那一步，-1 表示还没开放。已经开放的不会再锁上。
 * selectColumn：「调度策略」一栏，带「时限优先」。priceTags：价签，也就是建站、添飞机、加停机位、起降口升级、双层货箱、就近降落。
 * doubleBox：双层货箱出现在改装里，随价签一起开放。dataClerk：数据员到岗，提供推演，也随价签一起开放。
 * poolColumn：「合单策略」一栏，买下双层货箱时开放。zoneColumn：「协同策略」一栏，三张卡同时开放。
 * nearestLanding：就近降落，要有两座以上的站。ruleSets：午晚两套策略，开通写字楼区时开放。
 * prioDistrict：三张「片区优先」。roundtrip：「短程优先」。showOffice、showCampus：显示写字楼区、大学城和它们的开通价格。
 */
export type UnlockKey =
  | 'selectColumn'
  | 'priceTags'
  | 'doubleBox'
  | 'dataClerk'
  | 'poolColumn'
  | 'zoneColumn'
  | 'nearestLanding'
  | 'ruleSets'
  | 'prioDistrict'
  | 'roundtrip'
  | 'showOffice'
  | 'showCampus';

export type Unlocks = Record<UnlockKey, number>;

/** 午高峰和晚高峰各一套策略。 */
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
 * tooFewOrders 最近两天完成的订单少于下限（STARS_V1.minSample），星级和计数都不变，n 和准时率照常记录，
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
  resolved: number; // 今天完成的订单数，按结果产生的那一步归日，等于 onTime + late + cancelled
  onTime: number; // 准时送达
  late: number; // 超时送达
  cancelled: number; // 退单
  pending: number; // 做日结时还没完成的订单数，包括没派出的和已派出还没送到的
  income: number; // 今天的进账，按送达那一天计
  districts: DayDistrictRecord[]; // 每个开通的片区一行，按片区编号
  peaksJudged: number; // 今天的高峰里判过目标的场数：至少有一个片区设了线，并且这个片区的订单够判的下限
  peaksCleared: number; // 其中全部达标、并且没有退单的场数
  /**
   * 运力占用：一天按时刻分 24 段，每段 150 步（15 秒），共 24 个整数。第 i 段是占用的无人机占全部无人机的百分数，下取整，
   * 占用指不是停放，或者停放但电量没有充满、正在充电。这一段没有无人机时为 0。存档格式 3 以前的记录为 null
   */
  busy: number[] | null;
  /**
   * 效果：购买改装之后的几次日结里，每笔购买一行，写这项改装对应的指标现在的数值和不购买时的数值（见 effects.ts）。
   * 购买前的数值、现在的数值或副本的数值没有的那一天不写这一行。存档格式 3 以前的记录为空
   */
  effects: EffectLine[];
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

/**
 * 高峰小结说明的附加句。id 对应词表 summary.extra 的键，顺序就是选句的条件表的顺序（见 summary.ts 的 pickExtra）。
 * station 是站的编号（n 号站是编号加一），district 是片区编号，percent 是下取整的百分数。
 */
export type ExtraSentence =
  | { id: 'takeoffWait'; station: number; percent: number }
  | { id: 'landQueue'; station: number; count: number }
  | { id: 'bayIdle'; station: number; percent: number }
  | { id: 'emptyFlight'; percent: number }
  | { id: 'notNearest'; percent: number }
  | { id: 'districtLow'; district: number; onTime: number };

export interface PeakDistrictRow {
  district: number;
  n: number; // 这一场里送往这个片区的订单数
  onTime: number; // 其中准时送达的
  pct: number | null; // 准时率，下取整的百分数，没有订单为 null
  delta: number | null; // 与前一天同一场高峰相比的变化，单位是百分点，没有可比的（第一天、前一天没有订单）为 null
  line: number | null; // 这一场的目标线：准时率，整数百分点。没有设线为 null
  met: boolean | null; // 准时率达到了目标线。没有设线，或这一场送往这个片区的订单不够判的下限，为 null
}

/** 小结对照里一个片区的一行：同一批订单按开局策略的结果。 */
export interface PeakBaselineRow {
  district: number;
  n: number; // 这一场里送往这个片区的订单数
  onTime: number;
  pct: number | null; // 准时率，下取整的百分数，没有订单为 null
}

/**
 * 同一批订单、同样的购买，只把「调度策略」和「协同策略」换成开局的卡，算出的这一场的结果。
 * 各项的含义与 PeakRecord 里同名的项相同。
 */
export interface PeakBaseline {
  orders: number;
  onTime: number;
  late: number;
  lateOpen: number;
  cancelled: number;
  revenue: number;
  districts: PeakBaselineRow[];
  lowLoad: boolean; // 这一场订单不多于运力：两种策略下订单平均等飞机的时间都低于内容表里的数
}

/** 一张订单的四段时间各占的百分数，四个数加起来是 100。 */
export interface PeakSegments {
  waitDrone: number;
  waitGate: number;
  waitPrep: number;
  road: number;
}

/** 机队时间构成：一场高峰里无人机的时间在五段之间的分配，五个整数加起来是 100。work 包括等待出餐。 */
export interface PeakFleet { loaded: number; empty: number; work: number; queue: number; parked: number }

/** 小结里一座站点的一行。 */
export interface PeakStationRow {
  station: number;
  gateWait: number | null; // 这一场已送达、从这座站起飞的订单的平均起降排队秒数（order.gateWait 换成秒），没有这样的订单为 null
  landWaitAvg: number; // 平均等待降落的架数，口径与现在 peakSummary 里的 landWaitAvg 相同
  takeoffWaitPct: number; // 至少有 1 架无人机等待起飞的时间占这一场的百分数，下取整
  queuePct: number; // 至少有 1 架无人机排队的时间占这一场的百分数，下取整
  sorties: number; // 这一场从这座站放行起飞的架次
  fleet: PeakFleet | null; // 归属这座站的无人机的机队时间构成，没有无人机时为 null
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
  select: string; // 生成时「调度策略」的卡。是「先到先送」时界面不显示「提前派出」那一段
  early: number | null; // 提前派出的订单数。这一场中途换过「调度策略」时为 null
  changedMidPeak: boolean; // 这一场中途换过「调度策略」
  main: MainSentence;
  extra: ExtraSentence | null;
  cleared: boolean | null; // 判过的片区全部达标，并且这一场没有退单。没有判过的片区为 null
  baseline: PeakBaseline | null; // 小结的对照。这一场没有对照（整场用的是开局的卡，或者开局时没有复制状态）为 null
  fleet: PeakFleet | null; // 全部没有退回的站合计的机队时间构成，没有无人机时为 null。存档格式 3 以前的记录为 null
  /**
   * 全部没有退回的站合计，回站飞行（飞行并且在回站）占全部无人机「架·步」数的百分数，下取整。分母与 fleet 的五段相同。
   * 回站飞行是空载飞行的一部分，不含去店铺取餐的飞行，所以不大于 fleet.empty。没有无人机时为 null，与 fleet 同时为 null。
   * 存档格式 3 以前的记录为 null。就近降落的效果记录取这一项。
   */
  fleetBack: number | null;
  stations: PeakStationRow[]; // 没有退回的站，一站一行，按编号排。存档格式 3 以前的记录为空
}

/**
 * 一场高峰里一个片区的目标线的种类：
 * line 这一场要达到 line 的准时率，
 * capped 按公式要求超过 100%，改用星级线本身，今晚的日结做不到，
 * enough 这一场一单也不准时，日结时的准时率也已经达到星级线，不设线。
 */
export type GoalKind = 'line' | 'capped' | 'enough';

/** 目标线按哪条星级线反推：升到下一星的线，或保住现在星级的线（五星和可能掉星的片区）。 */
export type GoalBasis = 'next' | 'keep';

export interface DistrictGoal {
  district: number;
  kind: GoalKind;
  line: number | null; // 准时率，整数百分点。enough 时为 null
  basis: GoalBasis;
}

/** 一场高峰开始时给各个开通的片区算出的目标，没有设线的片区不在里面。 */
export interface PeakGoals {
  day: number;
  peak: PeakName;
  step: number; // 算出的步，也就是这一场高峰的第一步
  goals: DistrictGoal[];
}

export type TipId =
  | 'firstOrder'
  | 'autoDispatchOn'
  | 'firstRedOrder'
  | 'boardReady'
  | 'canAddBay'
  | 'dataClerk'
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

// ---- 经营模式：机队时间和排队的计数 ----
// 只在经营模式里累计，进状态哈希，随存档保存。只保留当场高峰和当天的累计，不按秒存历史：
// 小结时刻读出当场高峰的计数写进小结记录，日结时读出当天的计数写进日结记录，读完清零。

/**
 * 当场高峰的计数。在高峰窗口（peakWindow，午、晚两场的下单时段）内每一步累加。
 * 数组按站的编号下标，新建的站从建成之后的第一步起补上，已退回的站的计数留着，写小结时不读。
 */
export interface PeakTally {
  steps: number; // 计数覆盖的步数，也就是这一场高峰里已经累加过的步数
  /** 按无人机的归属站（home）累计各类的「架·步」数。每座站一行，五项依次是：载货飞行、空载飞行、作业（含等待出餐）、排队、停放。 */
  fleet: number[][];
  /** 按无人机的归属站（home）累计回站飞行（飞行并且在回站）的「架·步」数，每座站一项。已经算在 fleet 的空载飞行里，这里另计一份，五类的数不变。 */
  back: number[];
  takeoffWait: number[]; // 按无人机所在的站（station）：至少有 1 架无人机等待起飞的步数
  queue: number[]; // 按无人机所在的站：至少有 1 架无人机排队的步数，排队包括等待起飞和等待降落
  sorties: number[]; // 从这座站放行起飞的架次
}

/** 当天的计数：一天按时刻分 24 段，每段 150 步（15 秒），第 i 段是天内的第 150i 到 150i + 149 步。 */
export interface DayTally {
  drones: number[]; // 每段里全部没有退回的无人机的「架·步」数
  used: number[]; // 其中占用的：不是停放，或者停放但电量没有充满、正在充电
}

export interface FleetTally {
  peak: PeakTally;
  day: DayTally;
}

// ---- 经营模式：推演次数和效果记录 ----
// 都在 state.campaign 里，进状态哈希，随存档保存。两项都只记录，不影响派单和任何决定。

/** 数据员的推演次数。推演本身（复制状态、换订单序列、运行）在应用层，结果不写进状态。 */
export interface ForecastState {
  /** 还剩几次。每场高峰的小结生成时加内容表 FORECAST_V1.chargesPerPeak 次，最多到 FORECAST_V1.maxCharges，用 useForecast 命令扣 1 次 */
  charges: number;
}

/**
 * 购买后写效果的三种改装，各自对应一个指标：
 * gate 起降口升级：这座站的起降排队秒数（PeakStationRow.gateWait）；
 * doubleBox 双层货箱：全场每趟单数，即这一场已送达的订单数（onTime 加 late 减 lateOpen）除以各站 sorties 的合计，合计为 0 时没有这项数据；
 * nearest 就近降落：全场回站飞行占机队时间的百分数（PeakRecord.fleetBack），只算送完单回站的飞行，不含去店铺取餐的飞行。
 * 就近降落的开关、买无人机、加停机位和建站不记。
 */
export type EffectKind = 'gate' | 'doubleBox' | 'nearest';

/**
 * 副本（不购买的一份）在某一场高峰里这项改装的指标。副本由会话层持有（src/app/twins.ts），不在状态里；
 * 这里只记它每场高峰算出的数，由会话层在主状态和副本都生成了这一场的小结之后记下（effects.ts 的 recordTwin）。
 */
export interface EffectTwin {
  day: number; // 这一场高峰的游戏日
  peak: PeakName; // 午高峰还是晚高峰
  value: number; // 副本这一场的指标，原始的数，单位与 EffectLine.after 相同
}

/**
 * 一笔购买的效果跟踪：购买成功时记下，购买之后的 FORECAST_V1.effectDays 次日结里各写一行（DayRecord.effects），写完之后删掉。
 * 购买前的数值取购买时最近一场小结记录，同时记下那一场是午高峰还是晚高峰：之后「现在的数值」取日结时最近一场同类的小结记录，
 * 必须晚于购买前的那一场。每一行还要有「不购买时」的数：它取自副本在同一场高峰里的数（twins）。
 */
export interface EffectWatch {
  kind: EffectKind;
  step: number; // 购买成功的步
  station: number | null; // gate 的站编号，其余为 null
  level: number | null; // gate 升到的等级，其余为 null
  peak: PeakName | null; // 购买前取数的那一场是午高峰还是晚高峰，购买时还没有小结记录为 null
  beforeDay: number | null; // 那一场的游戏日，购买时还没有小结记录为 null
  before: number | null; // 购买前的数值：原始的数，没有小结记录或者记录里没有这项数据为 null
  left: number; // 还要经过几次日结。每次日结减 1，减到 0 时这条记录删掉
  /** 副本记下的数，按先后排。没有副本（读档之后，副本作废或被挤掉）时不再增加，这一天就写不出这一行 */
  twins: EffectTwin[];
}

/**
 * 日结里的一行效果：这项改装对应的指标，现在的数和不购买时的数。两个数都有才写，所以都不是 null。
 * 数是原始的数，界面里秒数和单数保留一位小数，百分数取整数。购买前的数 before 留在记录里，界面不显示：购买前后相隔几天，订单量和随机波动盖过了改装的作用。
 */
export interface EffectLine {
  kind: EffectKind;
  station: number | null; // gate 的站编号（n 号站是编号加一），其余为 null
  level: number | null; // gate 升到的等级，其余为 null
  peak: PeakName; // 现在的数取自哪一类高峰
  beforeDay: number; // 购买前的数值取自哪一天的这场高峰
  afterDay: number; // 现在的数值取自哪一天的这场高峰，晚于 beforeDay。副本的数取自同一场
  before: number; // 购买前的数值。gate 是秒，doubleBox 是单数，nearest 是百分数
  after: number; // 现在的数值，单位同上
  twin: number; // 不购买时同一场的数值，单位同上
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
  // 以下是口碑、解锁、策略、日结和小结、便签、结局的字段
  rating: DistrictRating[]; // 与 districts 一一对应
  unlocks: Unlocks;
  ruleSets: RuleSets | null; // 开通写字楼区之前为 null，只有 state.rules 一套。分开之后 state.rules 是现在生效的那一套
  days: DayRecord[]; // 日结记录，下标是游戏日
  peaks: PeakRecord[]; // 高峰小结记录，按生成的先后
  tips: TipRecord[]; // 便签队列，按出现的先后，已读的也留着
  delivered: number; // 到现在一共送达的订单数
  ending: Ending | null;
  goals: PeakGoals | null; // 最近一场高峰的目标，还没有过高峰时为 null。小结生成时按它给各片区一行写达没达标
  // 以下是离开结算的字段
  away: AwayRecord[]; // 离开结算的记录，按结算的先后，最多留最近的 100 条
  // 以下是存档格式 4 加的字段
  nearestOwned: boolean; // 买下了就近降落。买下之后可以随时免费开关，开关的结果在 state.returnRule 里。开局的配置里已经是 nearest 时从一开始就是 true
  tally: FleetTally; // 机队时间和排队的计数，只读状态累计，不影响任何决定
  forecast: ForecastState; // 推演次数，只记录，推演本身在应用层算
  effectWatches: EffectWatch[]; // 购买改装之后还在跟踪效果的记录，只读小结记录和会话层交来的副本的数，不影响任何决定
}

export interface SimState {
  config: SimConfig;
  world: World;
  step: number;
  rng: { orders: RngState; dispatch: RngState };
  rules: RuleSet;
  capacity: number; // 载量（份）。沙盒取配置的值，经营模式里买了双层货箱之后改变
  returnRule: ReturnRule; // 飞完回哪。沙盒取配置的值，经营模式里买下就近降落时变成 nearest，之后用 setNearestLanding 命令在 nearest 和 home 之间切换
  stations: Station[];
  drones: Drone[];
  orders: Order[];
  pending: number[]; // 尚未派出的订单，按下单顺序
  openQueue: number[]; // 尚未取走的订单，按下单顺序，用于退单检查
  stats: Stats;
  campaign: CampaignState | null; // 沙盒模式为 null
}

// 内容表的类型。只有类型，没有逻辑，也没有中文字符串。
// 内容表只允许用 import type 引用核心，核心可以引用内容表。

export type RoofSize = 'small' | 'medium' | 'large';
export type BuildingKind = 'residence' | 'office' | 'dorm';

/** 片区的矩形范围，下标就是片区编号：0 老街，1 写字楼区，2 大学城。 */
export interface MapDistrictV1 {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface MapShopV1 {
  nameIndex: number; // 店名在词表店名列表里的序号，与这家店在 shops 里的下标相同
  x: number;
  y: number;
  district: number;
  rank: number; // 热度名次，1 最热，三个片区的店一起排
  opensAtStar: number; // 片区达到几星时开张，1 表示片区开通时就开
}

export interface MapBuildingV1 {
  x: number;
  y: number;
  district: number;
  kind: BuildingKind;
}

export interface MapRoofV1 {
  x: number;
  y: number;
  district: number;
  size: RoofSize;
  priceCoef: number; // 建站价 = 基准价 × 这个系数，取整
  opening: boolean; // 开局时已经建了站
}

export interface MapPointV1 {
  x: number;
  y: number;
}

export interface MapV1 {
  version: number;
  mapSeed: number; // 店和楼取自哪张随机地图
  width: number;
  height: number;
  districts: MapDistrictV1[];
  shops: MapShopV1[];
  buildings: MapBuildingV1[];
  roofs: MapRoofV1[];
  river: MapPointV1[]; // 一条折线，只供画面用
}

export interface EconomyV1 {
  startMoney: number;
  droneBase: number; // 第 1、2 架的价格，第 n 架（n 不小于 3）为 round(droneBase × droneGrowth^(n-3))
  droneGrowth: number;
  bayBase: number; // 第 3 个停机位的价格，第 n 个为 round(bayBase × bayGrowth^(n-3))
  bayGrowth: number;
  baysAtBuild: number; // 新站自带的停机位数
  stationBase: number[]; // 第 2、3、4 座站的基准价，建站价 = round(基准价 × 屋顶的价格系数)
  maxStations: number;
  gateSeconds: number[]; // 起降口 1、2、3 级的起降间隔（秒）
  gatePrice: number[]; // 升到 1、2、3 级的价格，1 级是开局，价格为 0
  bayCap: Record<RoofSize, number>; // 屋顶大小对应的停机位上限
  doubleBoxPrice: number;
  doubleBoxCapacity: number;
  nearestLandingPrice: number;
  nearestLandingMinStations: number;
  districtOpenPrice: number[]; // 开通各片区的价格，下标是片区编号，老街开局就开通
  districtOpenStars: number; // 开通一个片区需要上一个片区达到的星级
  openingDrones: number; // 开局的站有几架飞机
}

/**
 * 一个片区的订单规律：高峰每分钟单数，以及天内的订单量曲线（控制点，高峰处取 1）。
 * opening 是开业期的来单倍数：片区开通的那一天用第一项，之后每过一个游戏日用下一项，用完之后恢复 1。
 * 空表示没有开业期（开局就开通的片区）。
 */
export interface DistrictRateV1 {
  id: string;
  baseRate: number;
  curveSeconds: number[];
  curveRate: number[];
  opening: number[];
}

/** 开局固定出现的一张订单。店和楼都是地图 v1 里的下标。 */
export interface OpeningOrderV1 {
  step: number;
  merchant: number;
  building: number;
  portion: number;
  prepSteps: number;
}

/**
 * 升到某一星的条件。准时率和退单率都是百分数，统计的是最近两个游戏日里完成的订单。
 * 准时率不小于 onTimeMin 才算达到。退单率低于 cancelBelow 才算达到，null 表示不限。
 */
export interface StarRuleV1 {
  star: number;
  onTimeMin: number;
  cancelBelow: number | null;
}

/** 口碑：星级条件、统计范围、掉星的办法，以及结局。 */
export interface StarsV1 {
  maxStar: number;
  windowDays: number; // 统计最近几个游戏日，第一天只有当天
  rules: StarRuleV1[]; // 升到二星、三星、四星、五星的条件，按星级从低到高
  minSample: number; // 最近两天完成的订单少于这个数时，这次日结星级不变，连续未达到的计数也不变（与没有订单同样处理）
  dropFromStar: number; // 这一星及以上才会掉星，低于它不会掉
  dropAfterMisses: number; // 连续几次日结没有达到当前星级下面一档的条件，掉一星
  endingStar: number; // 三个片区都到这一星，记下结局
  patienceSeconds: number[]; // 顾客的耐心：送往一个片区的订单，下单后等这么多秒仍没有被取走就退单，下标是这个片区的星级减一
}

/** 栏、卡和价签的开放条件。星级和片区都用核心里的编号。 */
export interface UnlocksV1 {
  zoneStations: number; // 有这么多座没退回的站时，「协同策略」一栏开放，三张卡同时开放
  ruleSetsDistrict: number; // 开通这个片区时，午晚两套策略开放
  priceTagsBalance: number; // 第一次日结之后余额达到这个数，价签开放
  selectLateAbove: number; // 某场高峰的小结里超时的订单（含还没送到的）超过来单的这个百分数，「调度策略」一栏开放
  selectLatestDay: number; // 最晚在这一天（从 0 数起）的日结时开放
  prioDistrict: number; // 「{片区}优先」看哪个片区的口碑
  prioOpensWith: number | null; // 这个片区开通时，「{片区}优先」同时开放。null 表示不随片区开通开放，改按下面两项在日结时判断
  prioNoUpgrade: number; // prioOpensWith 为 null 时：prioDistrict 这个片区连续几次日结没有升星
  prioGapPoints: number; // 并且它最近两天的准时率比其他开通片区合在一起低这么多个百分点以上
  roundtripDistrict: number; // 「短程优先」看哪个片区
  roundtripStar: number; // 它达到几星时开放
  show: { district: number; after: number; star: number }[]; // 片区 district 在片区 after 达到 star 星时显示
}

/**
 * 经营模式里玩家在调度台上每一栏能选的卡，规则编号按调度台上的顺序排。
 * 核心的规则注册表里的卡更多：沙盒模式和对照测试都用。经营模式的 setRules 命令只认这张表里的卡，调度台也只列它们。
 */
export interface CampaignRulesV1 {
  select: readonly string[]; // 调度策略
  pool: readonly string[]; // 合单策略
  zone: readonly string[]; // 协同策略
}

/** 高峰小结的说明句和便签用到的数。 */
export interface NotesV1 {
  onTimeHigh: number; // 主句：准时率不小于这个百分数时写准时率
  takeoffWaitPct: number; // 附加句：某座站至少有 1 架无人机等待起飞的时间不少于这一场的这个百分数。单位是百分点。
  landQueueMin: number; // 附加句：某座站平均不少于这么多架飞机等降落
  bayIdleShare: number; // 附加句：某座站的停机位空着的时间不少于这个百分数
  emptyFlightPct: number; // 附加句：全部无人机空载飞行的时间不少于机队时间的这个百分数。单位是百分点。
  notNearestShare: number; // 附加句：不是离店最近的站配送的订单不少于这个百分数
  districtLowGap: number; // 附加句：某个片区的准时率比全城低这么多个百分点以上
  gateBusyPct: number; // 便签「起降口忙不过来」：某座站至少有 1 架无人机排队（等待起飞或等待降落）的时间大于这一场的这个百分数。单位是百分点。
  redOrderSeconds: number; // 便签：还没送到的订单下单超过这么多秒，画面上出现红色
  middleRadius: number; // 新店位置：离片区中心不超过半边长的这个比例时写「中间」
}

/** 推演次数、推演的订单序列数和效果记录的天数。数据员提供推演，效果记录在购买改装之后的日结里写。 */
export interface ForecastV1 {
  maxCharges: number; // 推演次数的上限。每场高峰的小结生成时加次数，攒到这个数为止。
  chargesPerPeak: number; // 每场高峰的小结生成时加几次。
  sequences: number; // 一次推演用的订单序列数，每套序列分别运行带选项和不带选项的两种情况。应用层读取。
  effectDays: number; // 购买改装之后，在接下来的几次日结里写这项改装的效果。
}

/** 每场高峰的目标线、过线标记和小结对照用到的数。 */
export interface GoalsV1 {
  minJudgedOrders: number; // 一场高峰里送往某个片区的订单不少于这个数，才判这个片区达没达标
  minLiveOrders: number; // 高峰进行中，一个片区已完成的订单不少于这个数，才会因为离目标线最远而突出
  lowLoadWaitSeconds: number; // 小结对照里，两种策略下订单平均等飞机的时间都低于这么多秒，算订单不多于运力
  compareUnclearK: number; // 小结对照里，准时单数的差不为 0，并且绝对值小于 ⌈这个数 × √这一场的来单数⌉ 时，照写差几单，句末加「差别不明显」。取自多套订单序列的模拟。
}

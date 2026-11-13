// 中文词表：游戏内全部给玩家看的文字都放在这里，别处的代码里不写中文字符串。
// 一样东西只有一个名称，以这里的写法为准。文字按出现的位置分组：常驻界面、调度台、改装、高峰小结、日结、
// 引导便签、系统提示、命令失败的原因、目标与对照（metrics）、店名与订单备注。
//
// 占位符写成 {name}，用 fmt() 填入。参数缺失、多余或不是有限数时 fmt() 抛错，类型检查也会指出。
//
// 几处写法的约定：
// - 一行里有几件各自摆放的东西（速度纸条、价签、菜单、日程纸条），拆成一条一个键，不写进同一个字符串。
// - 高峰小结和日结的长小票逐行拆开，只放文字，对齐和分隔线由界面排。
// - 小结的标题和时段里的高峰名、起止时刻是参数 {peak}、{start}、{end}。
// - common.money 和 common.percent 是金额和百分数的通用写法。
// - 文字里写死的数字（秒数、起降口间隔、增减的百分比）要和内容表、核心里的数值一致，改数值时要同步改这里。
//   改装名称里的价格是 {price} 参数，价格由界面从核心取，不写在这里。
// - 栏目名、卡名、价签是不带标点的名词或动宾短语，卡面说明动词开头且不加句号，
//   教程便签和系统提示是句号收尾的完整句，命令失败的原因是不加句号的短语。
//
// 用法：
//   fmt(STR.hud.ticket, { balance: 120, earned: 35 })    文字写成 STR 里的字面量，类型检查核对参数名
//   reasonText('notEnoughMoney', { shortfall: 30 })      命令失败的提示，按核心返回的原因取
//   ruleCard('prioOffice')                               规则编号对应的名称、说明、代价，名称里带片区
//   districtName(1)  peakName('noon')  stationNumeral(2) 片区、高峰、站号的写法
//   SHOPS[0]  notesFor(kind, building)                   店名与菜名，订单备注
//
// 常用的参数名：
//   amount 金额  balance 资金  earned 今日收入  revenue 收入  price 价格  refund 退还的钱
//   shortfall 还差多少钱  cost 费用  district 片区  previous 上一片区  station 站号（汉字，用 stationNumeral）
//   count 数量  seconds 秒数  day 第几天  time 时刻  peak 高峰名  star 星级  limit 上限
//   onTime 准时率  cancelRate 取消率  needOnTime 要求的准时率  needCancelRate 要求的取消率
//   marginText needText 片区纸条补充行的两段文字（已经填好的句子）
//
// 这里的文字不用分号和破折号，不出现程序内部的名称。

// ---- 占位符的类型和填入函数 ----

/** 从模板里取出花括号里的参数名：'资金 ¥{balance}' 得到 'balance'。 */
export type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | ParamNames<Rest> : never;

export type ParamValue = string | number;

/** 模板需要的参数：每个占位符一项，多一项或少一项都是类型错误。 */
export type FmtParams<S extends string> = { readonly [K in ParamNames<S>]: ParamValue };

/** 没有占位符的模板不带参数，有占位符的模板带一个参数对象。 */
export type FmtArgs<S extends string> = [ParamNames<S>] extends [never] ? [] : [params: FmtParams<S>];

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function formatTemplate(template: string, params: Readonly<Record<string, ParamValue>> | undefined): string {
  const given = params ?? {};
  const used = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = Object.hasOwn(given, name) ? given[name] : undefined;
    if (value === undefined) throw new Error(`strings: missing param "${name}" for template "${template}"`);
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`strings: param "${name}" is not a finite number for template "${template}"`);
    }
    used.add(name);
    return String(value);
  });
  for (const key of Object.keys(given)) {
    if (!used.has(key)) throw new Error(`strings: unexpected param "${key}" for template "${template}"`);
  }
  if (/[{}]/.test(text)) throw new Error(`strings: malformed placeholder in template "${template}"`);
  return text;
}

/**
 * 把参数填进模板：fmt(STR.hud.ticket, { balance: 120, earned: 35 })。
 * 参数缺失、多余或不是有限数时抛错。模板用 STR 里的字面量，类型检查会核对参数名。
 */
export function fmt<S extends string>(template: S, ...args: FmtArgs<S>): string {
  return formatTemplate(template, args[0] as Readonly<Record<string, ParamValue>> | undefined);
}

// ---- 名称：片区、高峰、站 ----

/** 三个片区的名称，下标是核心里的片区序号。 */
export const DISTRICTS = ['老街', '写字楼区', '大学城'] as const;
export type DistrictIndex = 0 | 1 | 2;

export function districtName(index: DistrictIndex): string {
  const name = DISTRICTS[index];
  if (name === undefined) throw new RangeError(`strings: no district ${String(index)}`);
  return name;
}

/** 两个订单高峰。 */
export const PEAKS = { noon: '午高峰', evening: '晚高峰' } as const;
export type PeakKey = keyof typeof PEAKS;

export function peakName(peak: PeakKey): string {
  if (!Object.hasOwn(PEAKS, peak)) throw new RangeError(`strings: no peak ${String(peak)}`);
  return PEAKS[peak];
}

const NUMERALS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'] as const;

/** 站号的汉字写法：1 得到「一」，11 以上用数字。用在 {station}号站 里。 */
export function stationNumeral(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`strings: bad station number ${String(n)}`);
  return NUMERALS[n] ?? String(n);
}

/** 星级的汉字写法，与站号相同：3 得到「三」。用在「升{star}星」里。 */
export function starNumeral(n: number): string {
  return stationNumeral(n);
}

/** 新店位置里的方位词。核心给出方位的编号，见 placeDirection。 */
export const PLACE_WORDS = { east: '东边', south: '南边', west: '西边', north: '北边', middle: '中间' } as const;
export type PlaceWord = keyof typeof PLACE_WORDS;

/** 新店的位置：片区加方位，例如「老街北边」。用在日结的新店一行里。 */
export function placeName(district: DistrictIndex, direction: PlaceWord): string {
  if (!Object.hasOwn(PLACE_WORDS, direction)) throw new RangeError(`strings: no direction ${String(direction)}`);
  return `${districtName(district)}${PLACE_WORDS[direction]}`;
}

// 要在几处出现的文案只写一次。
const NEED_DOUBLE_BOX = '需要先购买双层货箱';
const NEED_TWO_STATIONS = '需要先建成第二个站点';

// ---- 界面文字 ----

export const STR = {
  /** 常驻界面 */
  hud: {
    // 左上小票
    ticket: '资金　¥{balance}　今日收入 ¥{earned}',
    // 日程纸条。午高峰、晚高峰两个标签用 PEAKS
    schedule: { dayTime: '第 {day} 天　{time}' },
    // 速度纸条
    speed: { pause: '暂停', x1: '1×', x2: '2×', x3: '3×', menu: '菜单' },
    // 价签
    price: {
      buildStation: '新建站点 ¥{price}',
      addBay: '新增停机位 ¥{price}',
      addDrone: '购买无人机 ¥{price}',
      upgrades: '改装',
      // 地图上显示了、还没开通的片区中间的价签
      openDistrict: '开通{district} ¥{price}',
    },
    // 片区纸条
    districtNote: {
      // 二星的准时率线由内容表给出（{needOnTime}），现在是 55%
      firstDay: '{district}　升二星需准时率不低于 {needOnTime}%　今日 {onTime}%',
      toTwoStars: '{district}　升二星需准时率不低于 {needOnTime}%　近两日 {onTime}%',
      // 还没有订单完成时，纸条不写准时率
      noData: '{district}　暂无完成订单',
      // 近两日完成的订单少于内容表的下限（{min}）时，日结不改星级
      tooFew: '{district}　近两日完成订单不足 {min} 单，日结星级不变',
      toThreeStarsUp: '{district}　升{star}星需准时率不低于 {needOnTime}%，取消率低于 {needCancelRate}%　近两日准时率 {onTime}%，取消率 {cancelRate}%',
      maxStars: '{district}　已达五星　近两日准时率 {onTime}%，取消率 {cancelRate}%',
      // 纸条在白天显示，下一次日结就在当晚，所以写「今日日结」。日结小票上的同一句写「明日日结」
      dropByOnTime: '{district}　保星需准时率不低于 {needOnTime}%　近两日 {onTime}%，今日日结仍未达标将降一星',
      dropByCancel: '{district}　保星需取消率低于 {needCancelRate}%　近两日 {cancelRate}%，今日日结仍未达标将降一星',
    },
    // 站点上空
    holding: '{count} 架等待降落',
    // 票杆旁
    overflow: '+{count}',
    // 订单悬停
    orderHover: '{building}　{dish}　已等待 {seconds} 秒',
    // 菜单
    menu: { resume: '继续', exportSave: '导出存档', importSave: '导入存档', importHint: '在此粘贴导出码', soundOn: '声音：开', soundOff: '声音：关', quit: '保存并暂停' },
    // 候选屋顶，选择建站时
    roof: {
      size: { small: '小', medium: '中', large: '大' },
      line: '{size}屋顶　停机位上限 {limit}　¥{price}',
      distance: '至本片区店铺平均 {shops} 秒，至本片区楼宇平均 {buildings} 秒',
      // 地图上屋顶旁边的文字块要窄，上面那一句拆成两行写
      distanceShops: '至本片区店铺平均 {seconds} 秒',
      distanceBuildings: '至本片区楼宇平均 {seconds} 秒',
    },
    // 楼名，按楼的种类生成，编号在各片区内从 1 或 A 开始。订单悬停时写成「{片区} {楼名}」，例如「老街 7 号院」。
    // 片区和楼名之间隔一个空格
    buildingName: {
      residence: '{index} 号院',
      office: '{letter} 座',
      dorm: '{index} 号宿舍楼',
      place: '{district} {name}',
    },
    // 选中一座站时旁边的小卡。
    // 站号写成「{station}号站」，{station} 用 stationNumeral，等降落的架数用上面的 holding
    card: {
      title: '{station}号站',
      bays: '停机位 {count}/{limit}',
      drones: '无人机 {count} 架',
      gate: '起降口 {level} 级',
    },
  },

  /** 各处共用的金额和百分数的写法 */
  common: {
    money: '¥{amount}',
    percent: '{value}%',
  },

  /**
   * 调度台。三栏的标题、未开放时的提示、白板底部的小票条，以及十张卡的文案。
   * 卡的文案按核心的规则编号放：三张「{片区}优先」在界面上合成一张，名称带片区，用 ruleCard() 取。
   */
  board: {
    title: '调度台',
    // 收起时标题下的小字。展开后的两个页签用 PEAKS
    collapsed: { noon: '午高峰策略', evening: '晚高峰策略', all: '全天策略' },
    columns: { select: '调度策略', pool: '合单策略', zone: '协同策略' },
    // 栏未开放时显示的条件
    locked: {
      pool: NEED_DOUBLE_BOX,
      zone: NEED_TWO_STATIONS,
      // 随内容表 UNLOCKS_V1.prioOpensWith 指定的片区开通一起开放
      prioDistrict: '开通写字楼区后解锁',
      roundtrip: '写字楼区达到三星后解锁',
    },
    // 选「{片区}优先」时
    pickDistrict: '选择优先配送的片区',
    // 白板底部的小票条
    lastPeak: '昨日{peak}　准时率 {onTime}%　取消 {cancelled}　收入 ¥{revenue}',
    lastPeakNone: '暂无昨日同场高峰记录',
    cards: {
      // 调度策略
      fifo: { name: '先到先送', desc: '按下单时间依次派出', cost: '订单积压时，临近时限的订单也需排队' },
      deadline: { name: '时限优先', desc: '优先派出临近时限、仍可准时送达的订单', cost: '已无法准时的订单等待更久' },
      roundtrip: { name: '短程优先', desc: '优先派出往返用时最短的订单', cost: '往返用时长的订单排在后面' },
      prioDistrict: { name: '{district}优先', desc: '优先派出送往该片区的订单', cost: '送往其他片区的订单排在后面' },
      // 合单策略。「单独配送」经营模式不用：内容表 rules_v1 没有它，调度台、改装列表和小结里都不会出现。
      // 这张卡的文字留着，沙盒模式还在用
      single: { name: '单独配送', desc: '每趟只配送一单', cost: '每单占用一架无人机一个往返' },
      same: { name: '同店合并', desc: '同一店铺的订单合并配送，每趟最多两单', cost: '不同店铺的订单不能合并' },
      any: { name: '顺路合并', desc: '顺路的订单合并配送，每趟最多两单', cost: '为合并另一单，原订单最多多等 6 秒' },
      // 协同策略
      global: { name: '全站协同', desc: '所有站点均可接单，派出用时最短的无人机', cost: '无人机可能跨片区飞行' },
      hybrid: { name: '延迟支援', desc: '先由最近站点接单，10 秒后其他站点支援', cost: '前 10 秒只等最近站点，即使其他站点有空闲无人机' },
      strict: { name: '仅限最近站点', desc: '仅由离店铺最近的站点接单', cost: '最近站点无空闲无人机时，订单只能等待' },
    },
  },

  /** 改装 */
  upgrades: {
    // 名称里的价格是 {price} 参数，由界面从核心取
    doubleBox: { name: '双层货箱 ¥{price}', desc: '每趟可携带两单，大单占满两层' },
    gate2: { name: '起降口 2 级 ¥{price}', desc: '起降间隔从 1.2 秒缩短至 0.8 秒' },
    gate3: { name: '起降口 3 级 ¥{price}', desc: '起降间隔缩短至 0.4 秒，可两架同时起降' },
    nearbyLanding: { name: '就近降落 ¥{price}', desc: '无人机送达后降落在最近的有空闲停机位的站点', locked: NEED_TWO_STATIONS },
  },

  /** 高峰小结。一张长小票，数字各占一行，这里只放文字，对齐由界面排。 */
  summary: {
    title: '{peak}小结',
    period: '第 {day} 天  {start}-{end}',
    rows: { orders: '订单', onTime: '准时', late: '超时', lateOpen: '其中未送达', cancelled: '取消', revenue: '收入' },
    districtHeader: '各片区准时率',
    // 这个片区这一场没有订单，写在准时率那一列
    districtNoOrders: '无订单',
    deltaHeader: '较昨日（百分点）',
    timeHeader: '单均耗时构成',
    segments: { waitDrone: '等待无人机 {share}%', waitGate: '起降排队 {share}%', waitPrep: '等待出餐 {share}%', road: '在途 {share}%' },
    // 这一段先写当前策略卡的名称，再写下面两行。一场高峰里换过策略时只写 switched
    early: { count: '{count} 单', suffix: '较按下单顺序提前派出', switched: '本场中途调整过策略' },
    // 说明的主句，取第一个满足条件的
    main: {
      noOrders: '本场无订单。',
      noDelivered: '本场无已送达订单。',
      onTimeHigh: '本场准时率 {onTime}%。',
      waitDrone: '订单耗时主要在等待无人机。',
      waitGate: '订单耗时主要在起降排队。',
      road: '订单耗时主要在途中。',
      waitPrep: '订单耗时主要在等待出餐。',
    },
    // 说明的附加句，最多一句
    extra: {
      landQueue: '{station}号站平均有 {count} 架无人机等待降落。',
      bayIdle: '{station}号站的停机位有 {percent}% 的时间空闲。',
      notNearest: '{percent}% 的订单由非最近站点配送。',
      districtLow: '{district}准时率 {onTime}%。',
    },
    actions: { openBoard: '打开调度台', next: '继续' },
  },

  /** 日结 */
  dayEnd: {
    title: '日结',
    day: '第 {day} 天',
    rows: {
      ordered: '今日订单',
      resolved: '今日完成',
      onTime: '准时送达',
      late: '超时送达',
      cancelled: '取消',
      pending: '未完成',
      revenue: '收入',
    },
    starUp: '{district}升至{star}星，明日订单量增加 25%。',
    newShop: '{place}新店「{shop}」明日开业。',
    starKept: '{district}保持{star}星。',
    noOrders: '{district}近两日无订单，星级不变。',
    // 完成的订单少于内容表的下限
    tooFewOrders: '{district}近两日完成订单不足 {min} 单，星级不变。',
    dropByOnTime: '{district}近两日准时率 {onTime}%，低于保星线 {needOnTime}%，明日日结仍未达标将降一星。',
    dropByCancel: '{district}近两日取消率 {cancelRate}%，未低于保星要求的 {needCancelRate}%，明日日结仍未达标将降一星。',
    starDown: '{district}降至{star}星，明日订单量减少 20%。',
  },

  /** 引导便签。注释是出现的时机。 */
  tips: {
    // 开局第一张订单
    firstOrder: '点击订单，派出一架无人机。',
    // 第五张订单送达
    autoDispatchOn: '已开启自动派单。',
    // 自动派单后第一次有订单变红
    firstRedOrder: '点击订单可优先配送。',
    // 第一场午高峰小结之后
    boardReady: '调度台已解锁。',
    // 第一次日结之后，资金达到价签开放的数（内容表 UNLOCKS_V1.priceTagsBalance）
    canAddBay: '可新增停机位，再购买无人机。',
    // 第一次有站点在一场高峰里平均有不少于 1 架无人机等待降落
    gateBusy: '{station}号站起降拥堵，可在改装中升级起降口。',
    // 老街三星
    openOffice: '写字楼区已可开通。',
  },

  /** 系统提示里不是命令失败的几条。命令失败的原因在 reasons。 */
  system: {
    // 选中当天买的东西时
    refundAvailable: '当日购买可退，退还 ¥{refund}。',
    refunded: '已退还 ¥{refund}。',
    districtOpened: '{district}已开通。',
    saved: '已保存。',
    saveCorrupt: '存档已损坏，已恢复为 {savedAt} 的备份。',
    awayIncome: '获得离线收益 ¥{amount}。',
    ending: '三个片区均已达到四星。共送达 {orders} 单，用时 {days} 天。',
    // 同一个浏览器里另开了一个页面时，这个页面停止运行
    otherPage: '游戏已在其他页面打开。',
    // 四份存档都读不出来，开了新游戏。主存档读不出来、换成备份时见 saveCorrupt
    saveAllBad: '存档已损坏，已开始新游戏。',
    // 保存没有成功，例如浏览器的存储空间满了。导出存档是菜单里的一项
    saveFailed: '保存失败，可先导出存档。',
    // 导出码已经复制到剪贴板
    exportCopied: '导出码已复制。',
    // 导入存档时粘贴的文字不是导出码，或者是沙盒模式的状态，不是经营模式的存档
    importBad: '导出码无效，当前存档未改动。',
    // 浏览器没有 WebGL，地图画不出来。界面其余部分照常显示。词表里不写技术名词，浏览器里这一项通常叫「使用图形加速功能」
    noWebGl: '无法绘制地图，请在浏览器设置中开启图形加速。',
  },

  /**
   * 命令失败的原因。键是核心返回的原因代码，界面里的对照见 src/ui/reasons.ts。
   * 写成不加句号的短语，不附带建议。
   */
  reasons: {
    // 资金不足
    notEnoughMoney: '资金不足，还差 ¥{shortfall}',
    // 没有空停机位，屋顶还能加
    noFreeBay: '该站点没有空闲停机位',
    // 没有空停机位，屋顶已经放满
    bayLimitReached: '停机位已达上限（{limit} 个）',
    // 没有选中站点
    noStationSelected: '请先选择站点',
    // 片区未达到开通条件
    needThreeStars: '需要{previous}达到三星',
    // 「合单策略」未开放
    needDoubleBox: NEED_DOUBLE_BOX,
    // 「协同策略」和「就近降落」未开放
    needTwoStations: NEED_TWO_STATIONS,
    // 站的数量到了上限
    stationLimitReached: '站点已达上限（{limit} 个）',
    // 在已经有站的屋顶上建站
    rooftopTaken: '该屋顶已有站点',
    // 在还没有开通的片区建站
    districtClosed: '{district}尚未开通',
    // 退以前买的东西
    refundOnlyToday: '仅当日购买可退',
    // 退一架还在送单的无人机
    droneBusy: '无人机正在配送，返回后才能退',
    // 退一座还有无人机的站点。站点内不能有无人机，先把无人机退掉
    stationDronesAway: '需要先退还站点内的无人机',
    // 退停机位之后无人机数会超过停机位数
    bayInUse: '停机位不足以停放现有无人机',
    // 重复购买只能买一次的改装
    alreadyOwned: '已购买',
    // 价签还没开放时买东西。界面在开放前不显示价签，这条很少出现
    priceTagsLocked: '第一天日结后、资金达到 ¥{amount} 时解锁',
    // 双层货箱还没开放
    doubleBoxLocked: '停机位已满且无人机不足时解锁',
    // 片区还没在地图上出现。显示的条件在内容表 UNLOCKS_V1.show 里：{previous} 是要升星的片区，{star} 是星级的汉字
    districtHidden: '{previous}达到{star}星后显示',
    // 换到一张还没开放的卡
    ruleLocked: '尚未解锁',
    // 点了一张已经派出、或者已经点过的订单
    orderNotWaiting: '订单已在配送或已排在最前',
    // 起降口已经是最高级
    gateMax: '起降口已是最高等级',
    // 开通一个已经开通的片区
    alreadyOpen: '该片区已开通',
    // 其余正常操作不会碰到的原因
    generic: '暂时无法操作',
  },

  /**
   * 每场高峰的目标和达标，小结里与开局策略的对照，纪录，片区纸条上的余量和还差几单。
   * 开局策略是指调度策略和协同策略两栏用开局的卡，合单策略与玩家的选择相同。
   */
  metrics: {
    // 高峰进行中，日程纸条下面每个开通的片区一行：准时、超时、取消的订单数，和这一场的目标
    live: {
      row: '{district}　准时 {onTime}　超时 {late}　取消 {cancelled}',
      // 目标是这一场要达到的准时率
      goal: '本场目标 准时率 {line}%',
      // 这一场全部准时，最近两天的准时率也到不了星级线，目标改用星级线本身
      goalCappedUp: '本场目标 准时率 {line}%，预计仅靠本场无法升星',
      goalCappedKeep: '本场目标 准时率 {line}%，预计仅靠本场无法保星',
      // 这一场一单也不准时，最近两天的准时率也不低于星级线，不设目标
      enoughUp: '准时率已高于升星线，本场不设目标',
      enoughKeep: '准时率已高于保星线，本场不设目标',
    },
    // 小结里各片区一行的达标，和整张小结的标记
    summary: {
      goal: '目标 {line}%',
      met: '已达标',
      missed: '未达标',
      cleared: '本场全部达标且无取消',
      // 连续几场全部达标且无取消，现在的和最多的。没有设目标的场次不算断，没有全部达标或有取消才断
      streak: '连续全部达标 {now} 场，最多 {best} 场',
    },
    // 小结里与开局策略的对照
    compare: {
      header: '开局策略',
      // 开局策略用的两张卡：调度策略一张，协同策略一张
      cards: '{select}，{zone}',
      row: '准时 {onTime}　取消 {cancelled}　收入 ¥{revenue}',
      more: '准时订单较开局策略多 {count} 单',
      less: '准时订单较开局策略少 {count} 单',
      same: '准时订单与开局策略相同',
      // 订单不多于运力，两套策略的准时单数相同时写这一句，代替上面三句
      lowLoad: '本场订单未超出运力，两套策略结果接近',
    },
    // 纪录，写在数的后面
    record: {
      best: '纪录 {value}',
      bestMoney: '纪录 ¥{amount}',
      broken: '新纪录',
    },
    // 日结里今天达标的场数，和累计的对照
    dayEnd: {
      goals: '今日评定 {judged} 场高峰，{cleared} 场全部达标且无取消。',
      gainMore: '累计准时订单较开局策略多 {count} 单。',
      gainLess: '累计准时订单较开局策略少 {count} 单。',
    },
    // 片区纸条的补充，写在升星条件的后面
    note: {
      margin: '保星线 {need}%，当前高 {points} 个百分点',
      marginLow: '保星线 {need}%，当前低 {points} 个百分点',
      marginEven: '保星线 {need}%，当前持平',
      // 从现在起还要连续准时几单，最近两天的准时率才到升星线
      shortfall: '准时率达到升星线还需连续 {count} 单准时',
      // 两段都有时：余量在前，还要连续准时几单在后，中间空一个全角空格
      both: '{marginText}　{needText}',
    },
  },

} as const;

export type StringTable = typeof STR;
/** 命令失败的原因，界面按它取提示文字。 */
export type ReasonKey = keyof StringTable['reasons'];

/** 取一条命令失败的提示：reasonText('notEnoughMoney', { shortfall: 30 })。 */
export function reasonText<K extends ReasonKey>(key: K, ...args: FmtArgs<StringTable['reasons'][K]>): string {
  if (!Object.hasOwn(STR.reasons, key)) throw new RangeError(`strings: no reason ${String(key)}`);
  return formatTemplate(STR.reasons[key], args[0] as Readonly<Record<string, ParamValue>> | undefined);
}

// ---- 策略卡 ----

/** 核心里的规则编号，一张卡一个。 */
export const RULE_IDS = [
  'fifo',
  'deadline',
  'roundtrip',
  'prioOld',
  'prioOffice',
  'prioCampus',
  'single',
  'same',
  'any',
  'global',
  'hybrid',
  'strict',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type RuleColumnKey = keyof StringTable['board']['columns'];

/**
 * 每一栏有哪几张卡，按调度台上的顺序。这是核心规则注册表里的全部卡，沙盒模式用。
 * 经营模式的调度台只列内容表 rules_v1 里的卡，其中「合单策略」一栏没有「单独配送」。
 */
export const COLUMN_RULES: Readonly<Record<RuleColumnKey, readonly RuleId[]>> = {
  select: ['fifo', 'deadline', 'roundtrip', 'prioOld', 'prioOffice', 'prioCampus'],
  pool: ['single', 'same', 'any'],
  zone: ['global', 'hybrid', 'strict'],
};

/** 三张「{片区}优先」对应的片区序号。界面上它们合成一张，名称是「{片区}优先」。 */
const PRIO_DISTRICT = { prioOld: 0, prioOffice: 1, prioCampus: 2 } as const satisfies Record<string, DistrictIndex>;
type PrioId = keyof typeof PRIO_DISTRICT;

export interface RuleCardText {
  readonly name: string; // 卡名
  readonly desc: string; // 卡面的一句规则说明
  readonly cost: string; // 点开后显示的代价
}

function isPrio(id: string): id is PrioId {
  return Object.hasOwn(PRIO_DISTRICT, id);
}

/** 一张卡的名称、说明和代价。 */
export function ruleCard(id: RuleId): RuleCardText {
  if (isPrio(id)) {
    const card = STR.board.cards.prioDistrict;
    return { name: fmt(card.name, { district: districtName(PRIO_DISTRICT[id]) }), desc: card.desc, cost: card.cost };
  }
  if (!Object.hasOwn(STR.board.cards, id)) throw new RangeError(`strings: no rule card ${String(id)}`);
  return STR.board.cards[id];
}

export function ruleName(id: RuleId): string {
  return ruleCard(id).name;
}

// ---- 店名、菜名与订单备注 ----

/**
 * 菜品的类别，用来给订单备注挑适用的。括号里是中文的叫法。
 * noodle（面）riceNoodle（粉）riceBowl（盖饭）malatang（麻辣烫）dumpling（饺子）
 * friedRice（炒饭）coffee（咖啡）pancake（煎饼）grill（烧烤）sweetSoup（糖水）
 */
export type DishKind =
  | 'noodle'
  | 'riceNoodle'
  | 'riceBowl'
  | 'malatang'
  | 'dumpling'
  | 'friedRice'
  | 'coffee'
  | 'pancake'
  | 'grill'
  | 'sweetSoup';

/** 楼的类别：home（住宅）office（写字楼）dorm（宿舍）。 */
export type BuildingKind = 'home' | 'office' | 'dorm';

export interface ShopText {
  readonly name: string; // 店名
  readonly dish: string; // 菜名
  readonly kind: DishKind;
  readonly district: DistrictIndex;
}

/**
 * 地图上 28 家店的店名和菜名，下标是店的序号：0 到 13 老街，14 到 19 写字楼区，20 到 27 大学城。
 * 店名用常见的家庭小店式命名，不用现实中的连锁品牌名。
 */
export const SHOPS: readonly ShopText[] = [
  // 老街，14 家
  { name: '老陈面馆', dish: '牛肉面', kind: 'noodle', district: 0 },
  { name: '阿芬米粉', dish: '肉丝米粉', kind: 'riceNoodle', district: 0 },
  { name: '赵记盖浇饭', dish: '鱼香肉丝盖饭', kind: 'riceBowl', district: 0 },
  { name: '巷口麻辣烫', dish: '麻辣烫', kind: 'malatang', district: 0 },
  { name: '王姨饺子', dish: '韭菜鸡蛋水饺', kind: 'dumpling', district: 0 },
  { name: '小周炒饭', dish: '蛋炒饭', kind: 'friedRice', district: 0 },
  { name: '后门煎饼', dish: '煎饼加蛋', kind: 'pancake', district: 0 },
  { name: '河边糖水', dish: '绿豆沙', kind: 'sweetSoup', district: 0 },
  { name: '吴叔排骨面', dish: '排骨面', kind: 'noodle', district: 0 },
  { name: '拐角酸辣粉', dish: '酸辣粉', kind: 'riceNoodle', district: 0 },
  { name: '林姐锅贴', dish: '牛肉锅贴', kind: 'dumpling', district: 0 },
  { name: '小马盖饭', dish: '红烧肉盖饭', kind: 'riceBowl', district: 0 },
  { name: '天井茶铺', dish: '冰柠檬茶', kind: 'sweetSoup', district: 0 },
  { name: '东门鸡蛋灌饼', dish: '鸡蛋灌饼', kind: 'pancake', district: 0 },
  // 写字楼区，6 家
  { name: '二楼咖啡', dish: '冰美式', kind: 'coffee', district: 1 },
  { name: '转角咖啡', dish: '冰拿铁', kind: 'coffee', district: 1 },
  { name: '阿乐简餐', dish: '咖喱鸡排饭', kind: 'riceBowl', district: 1 },
  { name: '老魏小厨', dish: '青椒肉丝盖饭', kind: 'riceBowl', district: 1 },
  { name: '汪记面食', dish: '番茄鸡蛋面', kind: 'noodle', district: 1 },
  { name: '楼下炒饭', dish: '扬州炒饭', kind: 'friedRice', district: 1 },
  // 大学城，8 家
  { name: '大学路烧烤', dish: '烤串十串', kind: 'grill', district: 2 },
  { name: '校门口手抓饼', dish: '手抓饼加肠', kind: 'pancake', district: 2 },
  { name: '西门冒菜', dish: '牛肉冒菜', kind: 'malatang', district: 2 },
  { name: '后街烤串', dish: '烤鸡翅四串', kind: 'grill', district: 2 },
  { name: '北门肥肠粉', dish: '肥肠粉', kind: 'riceNoodle', district: 2 },
  { name: '老贺馄饨', dish: '鲜肉小馄饨', kind: 'dumpling', district: 2 },
  { name: '小夏冰粉', dish: '红糖冰粉', kind: 'sweetSoup', district: 2 },
  { name: '阿强夜宵', dish: '腊肠炒饭', kind: 'friedRice', district: 2 },
];

export interface OrderNote {
  readonly id: string;
  readonly text: string; // 顾客写在订单上的短句，每条不超过十五个字
  readonly dishes?: readonly DishKind[]; // 只出现在这些菜品的订单上，不写就是不限菜品
  readonly building?: BuildingKind; // 只出现在送往这类楼的订单上，不写就是不限
}

/**
 * 订单备注，显示在订单悬停信息里，出现概率约三成（概率在内容表里）。
 * 每条带适用条件，抽取时先按订单的菜品和送达的楼筛选，再从适用的里面抽。
 */
export const ORDER_NOTES: readonly OrderNote[] = [
  { id: 'noCilantro', text: '不要香菜', dishes: ['noodle', 'riceNoodle', 'malatang'] },
  { id: 'lessIceSugar', text: '少冰，三分糖', dishes: ['coffee', 'sweetSoup'] },
  { id: 'soupSeparate', text: '汤和面分开装', dishes: ['noodle', 'riceNoodle'] },
  { id: 'extraSpicy', text: '多放辣，谢谢', dishes: ['noodle', 'riceNoodle', 'riceBowl', 'malatang', 'grill'] },
  { id: 'noScallion', text: '不要葱，一点都不要', dishes: ['noodle', 'riceNoodle', 'friedRice', 'pancake'] },
  { id: 'moreRice', text: '米饭多一点', dishes: ['riceBowl'] },
  { id: 'wideNoodles', text: '粉要宽的', dishes: ['riceNoodle'] },
  { id: 'chiliSeparate', text: '辣椒单放', dishes: ['noodle', 'riceNoodle', 'dumpling', 'pancake'] },
  { id: 'extraEgg', text: '加个蛋，煎老一点', dishes: ['friedRice', 'riceBowl', 'noodle'] },
  { id: 'notSpicy', text: '别放辣，上次放了', dishes: ['noodle', 'riceNoodle', 'riceBowl', 'malatang'] },
  { id: 'moreVinegar', text: '多给点醋', dishes: ['dumpling', 'noodle'] },
  { id: 'twoChopsticks', text: '筷子要两双' },
  { id: 'roofCabinet', text: '放楼顶柜子就行，我自己上去拿' },
  { id: 'noNotice', text: '到了不用通知，我看得见' },
  { id: 'balconyBasket', text: '阳台有个筐，放筐里', building: 'home' },
  { id: 'childSleeping', text: '别从卧室那边飞，孩子在睡', building: 'home' },
  { id: 'dogChases', text: '我家狗会追飞机，放高一点', building: 'home' },
  { id: 'pantryWindow', text: '开会呢，放 12 楼茶水间窗台', building: 'office' },
  { id: 'redTowel', text: '宿舍六楼，窗外挂着红毛巾的那间', building: 'dorm' },
  { id: 'classAfternoon', text: '下午有课，麻烦快一点', building: 'dorm' },
];

/** 适用于这份菜品、送往这类楼的备注。 */
export function notesFor(kind: DishKind, building: BuildingKind): readonly OrderNote[] {
  return ORDER_NOTES.filter(
    (note) => (note.dishes === undefined || note.dishes.includes(kind)) && (note.building === undefined || note.building === building),
  );
}

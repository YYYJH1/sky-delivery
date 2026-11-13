// 中文词表：游戏内全部给玩家看的文字都放在这里，别处的代码里不写中文字符串。
// 一样东西只有一个名称，以这里的写法为准。文字按出现的位置分组：常驻界面、调度台、改装、高峰小结、日结、
// 引导便签、系统提示、命令失败的原因、店名与订单备注。
//
// 占位符写成 {name}，用 fmt() 填入。参数缺失、多余或不是有限数时 fmt() 抛错，类型检查也会指出。
//
// 几处写法的约定：
// - 一行里有几件各自摆放的东西（速度纸条、价签、菜单、日程纸条），拆成一条一个键，不写进同一个字符串。
// - 高峰小结和日结的长小票逐行拆开，只放文字，对齐和分隔线由界面排。
// - 小结的标题和时段里的高峰名、起止时刻是参数 {peak}、{start}、{end}。
// - common.money 和 common.percent 是金额和百分数的通用写法。
// - 文字里写死的数字（秒数、起降口间隔、增减的成数）要和内容表、核心里的数值一致，改数值时要同步改这里。
//   改装名称里的价格是 {price} 参数，价格由界面从核心取，不写在这里。
//
// 用法：
//   fmt(STR.hud.ticket, { balance: 120, earned: 35 })    文字写成 STR 里的字面量，类型检查核对参数名
//   reasonText('notEnoughMoney', { shortfall: 30 })      命令失败的提示，按核心返回的原因取
//   ruleCard('prioOffice')                               规则编号对应的名称、说明、代价，名称里带片区
//   districtName(1)  peakName('noon')  stationNumeral(2) 片区、高峰、站号的写法
//   SHOPS[0]  notesFor(kind, building)                   店名与菜名，订单备注
//
// 常用的参数名：
//   amount 金额  balance 余额  earned 今天进账  revenue 进账  price 价格  refund 退回的钱
//   shortfall 还差多少钱  cost 费用  district 片区  previous 上一片区  station 站号（汉字，用 stationNumeral）
//   count 数量  seconds 秒数  day 第几天  time 时刻  peak 高峰名  star 星级  limit 上限
//   onTime 准时率  cancelRate 退单率  needOnTime 要求的准时率  needCancelRate 要求的退单率
//
// 这里的文字不用分号和破折号，不出现程序内部的名称。

// ---- 占位符的类型和填入函数 ----

/** 从模板里取出花括号里的参数名：'余额 ¥{balance}' 得到 'balance'。 */
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
const NEED_DOUBLE_BOX = '要先买双层货箱。';
const NEED_TWO_STATIONS = '要有第二座站。';

// ---- 界面文字 ----

export const STR = {
  /** 常驻界面 */
  hud: {
    // 左上小票
    ticket: '余额　¥{balance}　今天进账 ¥{earned}',
    // 日程纸条。午高峰、晚高峰两个标签用 PEAKS
    schedule: { dayTime: '第 {day} 天　{time}' },
    // 速度纸条
    speed: { pause: '暂停', x1: '1×', x2: '2×', x3: '3×', menu: '菜单' },
    // 价签
    price: {
      buildStation: '建新站 ¥{price}',
      addBay: '加停机位 ¥{price}',
      addDrone: '添飞机 ¥{price}',
      upgrades: '改装',
      // 地图上显示了、还没开通的片区中间的价签
      openDistrict: '开通{district} ¥{price}',
    },
    // 片区纸条
    districtNote: {
      // 二星的准时率线由内容表给出（{needOnTime}），现在是 55%
      firstDay: '{district}　今天准时 {onTime}%。达到 {needOnTime}%，日结时升二星。',
      toTwoStars: '{district}　最近两天准时 {onTime}%。准时率达到 {needOnTime}%，升二星。',
      // 还没有订单有结果时，纸条不写准时率
      noData: '{district}　还没有订单送到。',
      // 最近两天有结果的订单少于内容表的下限（{min}）时，日结不改星级
      tooFew: '{district}　最近两天有结果的订单不到 {min} 张，日结时星级不变。',
      toThreeStarsUp: '{district}　最近两天准时 {onTime}%，退单 {cancelRate}%。准时率达到 {needOnTime}%，退单率低于 {needCancelRate}%，升{star}星。',
      maxStars: '{district}　最近两天准时 {onTime}%，退单 {cancelRate}%。已经是五星。',
      // 纸条在白天显示，下一次日结就在当晚，所以写「今天日结」。日结小票上的同一句写「明天日结」
      dropByOnTime: '{district}　最近两天准时率 {onTime}%，要保持在 {needOnTime}% 以上。今天日结仍未达到，会掉一星。',
      dropByCancel: '{district}　最近两天退单率 {cancelRate}%，要低于 {needCancelRate}%。今天日结仍未达到，会掉一星。',
    },
    // 站点上空
    holding: '{count} 架等降落',
    // 票杆旁
    overflow: '+{count}',
    // 订单悬停
    orderHover: '{building}，{dish}，等了 {seconds} 秒',
    // 菜单
    menu: { resume: '继续', exportSave: '导出存档', importSave: '导入存档', importHint: '在这里粘贴导出码。', quit: '退出' },
    // 候选屋顶，选择建站时
    roof: {
      size: { small: '小', medium: '中', large: '大' },
      line: '{size}屋顶　最多 {limit} 个停机位　¥{price}',
      distance: '飞到本片区的店平均 {shops} 秒，飞到本片区的楼平均 {buildings} 秒',
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
      bays: '停机位 {count} 个，最多 {limit} 个',
      drones: '飞机 {count} 架',
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
   * 卡的文案按核心的规则编号放：三张「某一片的先送」在界面上合成一张，名称带片区，用 ruleCard() 取。
   */
  board: {
    title: '调度台',
    // 收起时标题下的小字。展开后的两个页签用 PEAKS
    collapsed: { noon: '午高峰这一套', evening: '晚高峰这一套', all: '全天这一套' },
    columns: { select: '先送哪张单', pool: '一趟送几单', zone: '别的站帮不帮' },
    // 栏未开放时显示的条件
    locked: {
      pool: NEED_DOUBLE_BOX,
      zone: NEED_TWO_STATIONS,
      prioDistrict: '写字楼区连续两次日结没有升星，准时率又比别的片区低 20 个百分点以上时开放。',
      roundtrip: '写字楼区到三星时开放。',
    },
    // 选「{片区}的先送」时
    pickDistrict: '选一个片区。送到这一片的订单排最前。',
    // 白板底部的小票条
    lastPeak: '昨天{peak}　准时 {onTime}%　退单 {cancelled}　进账 ¥{revenue}',
    lastPeakNone: '还没有昨天这场高峰的记录',
    cards: {
      // 先送哪张单
      fifo: { name: '先下单的先送', desc: '按下单的先后送', cost: '订单积压时，快到时限的订单也要按顺序等' },
      deadline: { name: '快超时的先送', desc: '先送还赶得上的，赶不上的往后排', cost: '赶不上的订单等得更久' },
      roundtrip: { name: '来回快的先送', desc: '来回用时最短的订单先送', cost: '来回用时长的订单排在后面' },
      prioDistrict: { name: '{district}的先送', desc: '送到这一片的订单排最前', cost: '送到别的片区的订单排在后面' },
      // 一趟送几单。「一趟送一单」经营模式不用：内容表 rules_v1 没有它，调度台、改装列表和小结里都不会出现。
      // 这张卡的文字留着，沙盒模式还在用
      single: { name: '一趟送一单', desc: '每张订单单独送', cost: '每张订单都要占一架飞机一趟' },
      same: { name: '同一家店的一起送', desc: '同一家店的订单，一趟最多带两单', cost: '不同店的订单不能一起送' },
      any: { name: '顺路的一起送', desc: '顺路的订单，一趟最多带两单', cost: '为了带上另一单，原有订单最多多等 6 秒' },
      // 别的站帮不帮
      global: { name: '哪座站都能送', desc: '各站都能接单，派用时最短的飞机', cost: '飞机可能跨片区飞行' },
      hybrid: { name: '等 10 秒再帮', desc: '先等最近的站，10 秒后别的站也能接', cost: '前 10 秒只等最近的站，即使别的站有空飞机' },
      strict: { name: '只由最近的站送', desc: '只由离店最近的站接单', cost: '最近的站没有空飞机时，订单只能等' },
    },
  },

  /** 改装 */
  upgrades: {
    // 名称里的价格是 {price} 参数，由界面从核心取
    doubleBox: { name: '双层货箱 ¥{price}', desc: '一趟能带两单。大单占满两层。' },
    gate2: { name: '起降口 2 级 ¥{price}', desc: '这座站每 0.8 秒放行一架，原来是 1.2 秒。' },
    gate3: { name: '起降口 3 级 ¥{price}', desc: '这座站每 0.4 秒放行一架，两架可以同时起降。' },
    nearbyLanding: { name: '就近降落 ¥{price}', desc: '飞机送完落到最近的有空停机位的站。', locked: NEED_TWO_STATIONS },
  },

  /** 高峰小结。一张长小票，数字各占一行，这里只放文字，对齐由界面排。 */
  summary: {
    title: '{peak}小结',
    period: '第 {day} 天  {start}-{end}',
    rows: { orders: '来单', onTime: '准时', late: '超时', lateOpen: '其中还没送到', cancelled: '退单', revenue: '进账' },
    districtHeader: '各片区准时',
    // 这个片区这一场没有订单，写在准时率那一列
    districtNoOrders: '没有订单',
    deltaHeader: '比昨天（百分点）',
    timeHeader: '一张单的时间',
    segments: { waitDrone: '等飞机 {share}%', waitGate: '等起降 {share}%', waitPrep: '等出餐 {share}%', road: '路上 {share}%' },
    // 这一段先写当前规矩卡的名称，再写下面两行。一场高峰里换过规矩时只写 switched
    early: { count: '有 {count} 张订单', suffix: '比按下单顺序更早派出', switched: '这一场中途换过规矩' },
    // 说明的主句，取第一个满足条件的
    main: {
      noOrders: '这一场没有订单。',
      noDelivered: '这一场没有送达的订单。',
      onTimeHigh: '这一场有 {onTime}% 的订单准时送到。',
      waitDrone: '订单主要在等飞机。',
      waitGate: '订单主要在等起降。',
      road: '订单主要花在路上。',
      waitPrep: '订单主要在等出餐。',
    },
    // 说明的附加句，最多一句
    extra: {
      landQueue: '{station}号站平均有 {count} 架在等降落。',
      bayIdle: '{station}号站的停机位有 {percent}% 的时间是空的。',
      notNearest: '{percent}% 的订单不是最近的站送的。',
      districtLow: '{district}的准时率是 {onTime}%。',
    },
    actions: { openBoard: '打开调度台', next: '继续' },
  },

  /** 日结 */
  dayEnd: {
    title: '日结',
    day: '第 {day} 天',
    rows: {
      ordered: '今天下单',
      resolved: '今天有结果的',
      onTime: '准时送达',
      late: '超时送达',
      cancelled: '退单',
      pending: '还没有结果',
      revenue: '进账',
    },
    starUp: '{district}升{star}星。明天订单多两成半。',
    newShop: '{place}要新开一家{shop}，明天开张。',
    starKept: '{district}{star}星，没变。',
    noOrders: '{district}最近两天没有订单，星级不变。',
    // 有结果的订单少于内容表的下限
    tooFewOrders: '{district}最近两天有结果的订单不到 {min} 张，星级不变。',
    dropByOnTime: '{district}最近两天准时率 {onTime}%，要保持在 {needOnTime}% 以上。明天日结仍未达到，会掉一星。',
    dropByCancel: '{district}最近两天退单率 {cancelRate}%，要低于 {needCancelRate}%。明天日结仍未达到，会掉一星。',
    starDown: '{district}掉到{star}星。明天订单少两成。',
  },

  /** 引导便签。注释是出现的时机。 */
  tips: {
    // 开局第一张订单
    firstOrder: '点一下这张单，派一架飞机去。',
    // 第五张订单送达
    autoDispatchOn: '新订单会自动派出。',
    // 自动派单后第一次有订单变红
    firstRedOrder: '想先送哪张，点它一下。',
    // 第一场午高峰小结之后
    boardReady: '调度台可以用了。',
    // 第一次日结之后，余额达到价签开放的数（内容表 UNLOCKS_V1.priceTagsBalance）
    canAddBay: '可以加一个停机位，再添一架飞机。',
    // 第一次有站点在一场高峰里平均有不少于 1 架飞机等降落
    gateBusy: '{station}号站的起降口忙不过来。可以在改装里升级。',
    // 老街三星
    openOffice: '河对岸的写字楼区可以开通了。',
  },

  /** 系统提示里不是命令失败的几条。命令失败的原因在 reasons。 */
  system: {
    // 选中当天买的东西时
    refundAvailable: '今天买的今天能退，退回 ¥{refund}。',
    refunded: '已退，¥{refund} 回到余额。',
    districtOpened: '{district}开通了。',
    saved: '已存档。',
    saveCorrupt: '存档读不出来，已换成 {savedAt} 的备份。',
    awayIncome: '你不在的时候进账 ¥{amount}。',
    ending: '三个片区都到了四星。一共送了 {orders} 单，用了 {days} 天。',
    // 同一个浏览器里另开了一个页面时，这个页面停止运行
    otherPage: '已在别的页面打开。',
    // 四份存档都读不出来，开了新的一局。主存档读不出来、换成备份时见 saveCorrupt
    saveAllBad: '存档读不出来，已开始新的一局。',
    // 保存没有成功，例如浏览器的存储空间满了。导出存档是菜单里的一项
    saveFailed: '存档没有存上。可以先导出存档。',
    // 导出码已经复制到剪贴板
    exportCopied: '导出码已复制，可以粘贴保存。',
    // 导入存档时粘贴的文字不是导出码，或者是沙盒模式的状态，不是经营模式的存档
    importBad: '导出码读不出来，现在的存档没有动。',
  },

  /**
   * 命令失败的原因。键是核心返回的原因代码，界面里的对照见 src/ui/reasons.ts。
   */
  reasons: {
    // 余额不足
    notEnoughMoney: '钱不够，还差 ¥{shortfall}。',
    // 没有空停机位，屋顶还能加
    noFreeBay: '这座站没有空停机位。先加一个停机位，再添飞机。',
    // 没有空停机位，屋顶已经放满
    bayLimitReached: '这块屋顶最多放 {limit} 个停机位，已经放满。可以把飞机添到别的站，或者建新站。',
    // 没有选中站点
    noStationSelected: '先选一座站。',
    // 片区未达到开通条件
    needThreeStars: '{previous}到三星才能开通{district}。',
    // 「一趟送几单」未开放
    needDoubleBox: NEED_DOUBLE_BOX,
    // 「别的站帮不帮」和「就近降落」未开放
    needTwoStations: NEED_TWO_STATIONS,
    // 站的数量到了上限
    stationLimitReached: '最多建 {limit} 座站，已经建满。可以给现有的站添飞机，或者升级起降口。',
    // 在已经有站的屋顶上建站
    rooftopTaken: '这块屋顶已经有站了。换一块空着的屋顶。',
    // 在还没有开通的片区建站
    districtClosed: '{district}还没有开通。先开通，再建站。',
    // 退以前买的东西
    refundOnlyToday: '只有今天买的东西能退。',
    // 退一架还在送单的飞机
    droneBusy: '这架飞机还在送单。等它回站再退。',
    // 退一座还有飞机的站。站上不能有飞机，先把飞机退掉
    stationDronesAway: '这座站还有飞机。先把飞机退掉，再退这座站。',
    // 退停机位之后飞机数会超过停机位数
    bayInUse: '停机位不够放现有的飞机。先退一架飞机，再退停机位。',
    // 重复购买只能买一次的改装
    alreadyOwned: '这一项已经买过了。',
    // 价签还没开放时买东西。界面在开放前不显示价签，这条很少出现
    priceTagsLocked: '要等第一天日结之后、余额到 ¥{amount}，才能买东西。',
    // 双层货箱还没开放
    doubleBoxLocked: '停机位放满以后还缺飞机时，才能买双层货箱。',
    // 片区还没在地图上出现
    districtHidden: '上一个片区到三星之后，这一片才会出现在地图上。',
    // 换到一张还没开放的卡
    ruleLocked: '这张卡还没开放。',
    // 点了一张已经派出、或者已经点过的订单
    orderNotWaiting: '这张单已经在送，或者已经排到最前了。',
    // 起降口已经是最高级
    gateMax: '这座站的起降口已经是 3 级。',
    // 开通一个已经开通的片区
    alreadyOpen: '这个片区已经开通了。',
    // 其余正常操作不会碰到的原因
    generic: '这一步现在做不了。',
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

// ---- 规矩卡 ----

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
 * 经营模式的调度台只列内容表 rules_v1 里的卡，其中「一趟送几单」一栏没有「一趟送一单」。
 */
export const COLUMN_RULES: Readonly<Record<RuleColumnKey, readonly RuleId[]>> = {
  select: ['fifo', 'deadline', 'roundtrip', 'prioOld', 'prioOffice', 'prioCampus'],
  pool: ['single', 'same', 'any'],
  zone: ['global', 'hybrid', 'strict'],
};

/** 三张「某一片的先送」对应的片区序号。界面上它们合成一张，名称是「{片区}的先送」。 */
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
  { name: '老四烧烤', dish: '烤鸡翅四串', kind: 'grill', district: 2 },
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

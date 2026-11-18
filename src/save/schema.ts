// SimState 的字段表。核心给状态加字段或改字段时，改这里：
//   1. 新增的顶层字段，在 SIM_STATE_SHAPE 里加一行。
//   2. 某类记录（订单、飞机、站点、经营模式的各种记录）多了字段，在对应的 fields({...}) 里按类型加上字段名。
//   3. 字段表之外的字段不会让校验失败，所以忘了加也不会拒绝存档，只是那个字段没有被检查类型。
//   4. 字段的含义变了，或者必须有的字段多了，要升 SAVE_VERSION 并在迁移表里写旧版本到新版本的函数，
//      让旧存档在校验之前先变成新的样子。
// 这里只检查类型，不检查编号之间的对应关系：结束的订单会被清理，订单在数组里的下标不一定等于它的编号。
// 凡是由除法或取整算出来的数（百分数、四段时间的份额），这里一律按「数字」检查，不要求是整数：
// 多挡一种本来不会出现的损坏，不值得冒「合法的存档被拒绝」的风险，那样玩家就存不了档。
import { arr, bool, fields, int, natural, nullable, num, obj, recordOf, str } from './validate.ts';
import type { Check, Shape } from './validate.ts';

/**
 * 允许出现非有限数字（NaN、Infinity）的字段，按路径写，[*] 代表任意下标。
 * 核对过：SimState 里没有合法的非有限数字。核心里的 Infinity 只出现在派单时的临时变量，
 * NaN 只出现在按需计算的指标里，都不在状态里。所以这张表是空的。
 * 要注意 JSON 写不出非有限的数字，它们会变成 null。以后如果核心真的在状态里放了这样的数字，
 * 光在这里放行不够，序列化时还要给它们一个专门的写法，并升存档版本。
 */
export const NON_FINITE_ALLOWED: readonly string[] = [];

const RNG_STATE: Check = obj(fields({ int: 'a b c d' }));
const RULES: Check = obj(fields({ str: 'select zone pool' }));

const CONFIG: Check = obj({
  ...fields({
    str: 'scenario layout mode returnRule',
    int: 'mapSeed seed drones extraBays capacity',
    num: 'peakRate gateInterval chargeTime',
    bool: 'constantRate noonDestinations',
  }),
  rules: RULES,
  orderEndStep: nullable(int),
});

const WORLD: Check = obj({
  ...fields({ num: 'width height', str: 'digest' }),
  districts: arr(obj(fields({ str: 'id', num: 'x0 x1 y0 y1' }))),
  merchants: arr(obj(fields({ num: 'x y weight', int: 'district rank' }))),
  buildings: arr(obj(fields({ num: 'x y', int: 'district' }))),
  buildingsByDistrict: arr(arr(int)),
  cumWeights: arr(arr(num)),
});

const STATION: Check = obj({
  ...fields({ int: 'id bays occupied gateFree gateInterval', num: 'x y', bool: 'removed' }),
  queue: arr(int),
});

const DRONE: Check = obj({
  ...fields({
    int: 'id home state station load tEnd target queuedAt departed',
    num: 'x y battery tx ty',
    bool: 'returning stranded removed',
  }),
  route: arr(obj(fields({ int: 'kind order' }))),
  onboard: arr(int),
});

const ORDER: Check = obj(
  fields({
    int: 'id tOrder merchant building district portion units prepDone home status tAssign tArrive tPick tDeliver tCancel drone departed gateWait manualAt',
    num: 'amount dMB rev tip',
    bool: 'early shared',
  }),
);

const STATS: Check = obj({
  stranded: int,
  landWait: arr(arr(num)),
  bayEmpty: arr(arr(num)),
  bayTotal: arr(arr(num)),
  early: arr(obj(fields({ int: 'step order day peak', str: 'rule' }))),
  ruleChanges: arr(obj(fields({ int: 'step', str: 'column from to' }))),
  flightTotal: arr(num),
  flightLoaded: arr(num),
});

// ---- 经营模式（state.campaign）----

/** 一笔可以当天原价退回的购买。 */
const PURCHASE: Check = obj(fields({ int: 'day', num: 'paid' }));

const DAY_DISTRICT: Check = obj({
  ...fields({ int: 'district fromStar star n onTime cancelled', str: 'kind' }),
  onTimePct: nullable(num),
  cancelPct: nullable(num),
  needOnTimePct: nullable(num),
  needCancelPct: nullable(num),
  newShops: arr(obj(fields({ int: 'shop', str: 'direction' }))),
});

/** 日结里的一行效果：一项改装现在的指标数值和不购买时的数值，另有购买前的数值。数是除法算出来的，按数字检查。 */
const EFFECT_LINE: Check = obj({
  ...fields({ str: 'kind peak', int: 'beforeDay afterDay', num: 'before after twin' }),
  station: nullable(int),
  level: nullable(int),
});

const DAY_RECORD: Check = obj({
  ...fields({ int: 'day step ordered resolved onTime late cancelled pending peaksJudged peaksCleared', num: 'income' }),
  districts: arr(DAY_DISTRICT),
  busy: nullable(arr(num)),
  effects: arr(EFFECT_LINE),
});

/** 副本（不购买的一份）在一场高峰里的指标，数是除法算出来的，按数字检查。 */
const EFFECT_TWIN: Check = obj(fields({ int: 'day', str: 'peak', num: 'value' }));

/** 一笔购买的效果跟踪：购买前的数值，还要写几次日结，和副本记下的数。 */
const EFFECT_WATCH: Check = obj({
  ...fields({ str: 'kind', int: 'step', natural: 'left' }),
  station: nullable(int),
  level: nullable(int),
  peak: nullable(str),
  beforeDay: nullable(int),
  before: nullable(num),
  twins: arr(EFFECT_TWIN),
});

/** 数据员的推演次数。 */
const FORECAST: Check = obj(fields({ natural: 'charges' }));

/** 小结对照：同一批订单按开局策略的结果。 */
const PEAK_BASELINE: Check = obj({
  ...fields({ int: 'orders onTime late lateOpen cancelled', num: 'revenue', bool: 'lowLoad' }),
  districts: arr(obj({ ...fields({ int: 'district n onTime' }), pct: nullable(num) })),
});

/** 机队时间构成：五项是按最大余数分配出来的百分数，按数字检查。 */
const PEAK_FLEET: Check = obj(fields({ num: 'loaded empty work queue parked' }));

/** 小结里一座站的一行。 */
const PEAK_STATION_ROW: Check = obj({
  ...fields({ int: 'station sorties', num: 'landWaitAvg takeoffWaitPct queuePct' }),
  gateWait: nullable(num),
  fleet: nullable(PEAK_FLEET),
});

const PEAK_RECORD: Check = obj({
  ...fields({ int: 'day step orders onTime late lateOpen cancelled', num: 'revenue', str: 'peak select', bool: 'changedMidPeak' }),
  districts: arr(
    obj({
      ...fields({ int: 'district n onTime' }),
      pct: nullable(num),
      delta: nullable(num),
      line: nullable(num),
      met: nullable(bool),
    }),
  ),
  segments: nullable(obj(fields({ num: 'waitDrone waitGate waitPrep road' }))),
  early: nullable(int),
  main: obj(fields({ str: 'id' })),
  extra: nullable(obj(fields({ str: 'id' }))),
  cleared: nullable(bool),
  baseline: nullable(PEAK_BASELINE),
  fleet: nullable(PEAK_FLEET),
  fleetBack: nullable(num), // 回站飞行占比，下取整的百分数，按数字检查
  stations: arr(PEAK_STATION_ROW),
});

/** 最近一场高峰各片区的目标。 */
const PEAK_GOALS: Check = obj({
  ...fields({ int: 'day step', str: 'peak' }),
  goals: arr(obj({ ...fields({ int: 'district', str: 'kind basis' }), line: nullable(num) })),
});

/** 机队时间和排队的计数：当场高峰的，和当天各时刻的。back 是按归属站累计的回站飞行架·步数。 */
const PEAK_TALLY: Check = obj({
  ...fields({ natural: 'steps' }),
  fleet: arr(arr(natural)),
  back: arr(natural),
  takeoffWait: arr(natural),
  queue: arr(natural),
  sorties: arr(natural),
});

const DAY_TALLY: Check = obj({ drones: arr(natural), used: arr(natural) });

const TIP_RECORD: Check = obj({
  ...fields({ str: 'id', int: 'step', bool: 'read' }),
  station: nullable(int),
});

const CAMPAIGN: Check = obj({
  ...fields({ int: 'contentVersion delivered', num: 'money spent refunded', bool: 'nearestOwned' }),
  income: arr(num),
  districts: arr(obj(fields({ bool: 'open', int: 'star' }))),
  shopOpen: arr(bool),
  cumWeights: arr(arr(num)),
  roofStation: arr(int),
  stations: arr(obj({ ...fields({ int: 'roof gateLevel' }), built: PURCHASE, bays: arr(PURCHASE) })),
  drones: arr(PURCHASE),
  opening: obj({ orders: arr(int), done: bool }),
  rating: arr(obj(fields({ int: 'misses noUpgrade' }))),
  // 各项开放的键会随内容增减，所以不写死名单，只要求每一项都是整数（-1 表示还没开放）
  unlocks: recordOf(int),
  ruleSets: nullable(obj({ noon: RULES, evening: RULES })),
  days: arr(DAY_RECORD),
  peaks: arr(PEAK_RECORD),
  tips: arr(TIP_RECORD),
  ending: nullable(obj(fields({ int: 'step days orders' }))),
  goals: nullable(PEAK_GOALS),
  away: arr(obj(fields({ int: 'step', num: 'seconds amount' }))),
  tally: obj({ peak: PEAK_TALLY, day: DAY_TALLY }),
  forecast: FORECAST,
  effectWatches: arr(EFFECT_WATCH),
});

/** SimState 的顶层字段表。 */
export const SIM_STATE_SHAPE: Shape = {
  config: CONFIG,
  world: WORLD,
  step: natural,
  rng: obj({ orders: RNG_STATE, dispatch: RNG_STATE }),
  rules: RULES,
  capacity: int,
  returnRule: str,
  stations: arr(STATION),
  drones: arr(DRONE),
  orders: arr(ORDER),
  pending: arr(int),
  openQueue: arr(int),
  stats: STATS,
  campaign: nullable(CAMPAIGN),
};

/** 默认的状态检查。 */
export const STATE_CHECK: Check = obj(SIM_STATE_SHAPE);

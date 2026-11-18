// 存档版本迁移：一张从版本 n 迁到 n+1 的函数表。
// 读到旧版本的存档时，从它的版本起逐版往上迁，迁完再做校验，所以校验只需要认识最新的格式。
import { isRecord } from './validate.ts';

/** 解析后的存档对象，包括外层的 format、version 等字段和里面的 state。 */
export type SaveData = Record<string, unknown>;

/** 把版本 n 的存档改成版本 n+1 的样子。可以直接改传入的对象，也可以返回新对象。version 字段由迁移流程设置。 */
export type Migration = (data: SaveData) => SaveData;

/** 键是迁移前的版本号：表里的 [n] 把版本 n 迁到 n+1。 */
export type MigrationTable = Readonly<Record<number, Migration>>;

/**
 * 版本 1 到版本 2。版本 1 是存档模块最早的格式，经营模式的页面用它存过档。做两件事：
 *   外层的内容版本从字符串改成整数。版本 1 一律写成 'v1'，没有记下真正的内容版本，
 *   经营模式的状态里记着它（campaign.contentVersion），所以优先取它，沙盒模式的状态没有，就取字符串里的数字。
 *   状态补上版本 2 的字段表要求有的字段：经营模式的 campaign 加上 away（离开结算的记录），空数组。
 *   版本 1 的字段表没有检查 capacity、returnRule、mode、removed 和 campaign，版本 1 写出的最早一批存档里可能没有它们，
 *   缺的按沙盒模式的默认值补上，已经有的原样保留。
 * 不改任何已经有的值，所以迁移之后的状态和原来的状态玩起来完全一样。
 */
function migrateV1ToV2(data: SaveData): SaveData {
  const state = data.state;
  if (isRecord(state)) {
    const config = state.config;
    if (isRecord(config)) {
      if (config.mode === undefined) config.mode = 'sandbox';
      if (config.returnRule === undefined) config.returnRule = 'home';
      if (state.capacity === undefined && typeof config.capacity === 'number') state.capacity = config.capacity;
      if (state.returnRule === undefined && typeof config.returnRule === 'string') state.returnRule = config.returnRule;
    }
    if (state.campaign === undefined) state.campaign = null;
    for (const list of [state.stations, state.drones]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) if (isRecord(item) && item.removed === undefined) item.removed = false;
    }
    const campaign = state.campaign;
    if (isRecord(campaign) && campaign.away === undefined) campaign.away = [];
  }
  // 外层的内容版本不是字符串时原样留着，让校验去报告它
  const legacy = data.contentVersion;
  if (typeof legacy === 'string') {
    const campaign = isRecord(state) ? state.campaign : undefined;
    const real = isRecord(campaign) ? campaign.contentVersion : undefined;
    if (typeof real === 'number' && Number.isInteger(real)) {
      data.contentVersion = real;
    } else {
      const digits = /^v(\d+)$/.exec(legacy);
      data.contentVersion = digits === null ? 0 : Number(digits[1]);
    }
  }
  return data;
}

/** 对象里的数组字段，不是数组时当作空的。 */
function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * 版本 2 到版本 3。经营模式的记录多了几个字段，缺的补默认值，已经有的值一个不改：
 *   campaign.goals：最近一场高峰的目标，null。
 *   每场高峰小结：cleared（整张小结的达标标记）和 baseline（小结对照）为 null，各片区一行的 line 和 met 为 null。
 *   每次日结：peaksJudged 和 peaksCleared（判过目标的场数和其中达标的场数）为 0。
 * 旧存档里的高峰没有设过目标，所以这些默认值就是当时的实情，读进来的状态玩起来与原来完全一样。
 */
function migrateV2ToV3(data: SaveData): SaveData {
  const state = data.state;
  const campaign = isRecord(state) ? state.campaign : undefined;
  if (!isRecord(campaign)) return data;
  if (campaign.goals === undefined) campaign.goals = null;
  for (const peak of listOf(campaign.peaks)) {
    if (peak.cleared === undefined) peak.cleared = null;
    if (peak.baseline === undefined) peak.baseline = null;
    for (const row of listOf(peak.districts)) {
      if (row.line === undefined) row.line = null;
      if (row.met === undefined) row.met = null;
    }
  }
  for (const day of listOf(campaign.days)) {
    if (day.peaksJudged === undefined) day.peaksJudged = 0;
    if (day.peaksCleared === undefined) day.peaksCleared = 0;
  }
  return data;
}

/** 版本 4 的机队时间和排队的计数，全零。迁移里自己写出来，不引用核心，免得以后核心改了计数的样子，旧的迁移跟着变。 */
function zeroTally(stations: number): Record<string, unknown> {
  const zeros = (n: number): number[] => new Array<number>(n).fill(0);
  return {
    peak: {
      steps: 0,
      fleet: Array.from({ length: stations }, () => zeros(5)),
      back: zeros(stations),
      takeoffWait: zeros(stations),
      queue: zeros(stations),
      sorties: zeros(stations),
    },
    day: { drones: zeros(24), used: zeros(24) },
  };
}

/**
 * 版本 3 到版本 4。经营模式的状态多了几个字段，缺的补默认值，已经有的值一个不改，只有下面第 4 项例外：
 *   1 campaign.nearestOwned：买下了就近降落。原来的存档里 state.returnRule 是 nearest 就是买下了，按它补。
 *   2 campaign.tally：机队时间和排队的计数，补成全零，包括回站飞行的计数 back。旧存档没有记过，之后的第一场高峰和第一次日结从读档的那一步起累计。
 *   3 每场高峰小结：fleet（机队时间构成）和 fleetBack（回站飞行占比）为 null，stations（各站的一行）为空数组。每次日结：busy（运力占用）为 null。
 *     旧存档没有记过这些，记录一经生成不再修改，所以旧记录里就是没有。
 *   4 campaign.unlocks.doubleBox：双层货箱改为随价签一起开放。价签已经开放而双层货箱还没开放的存档，
 *     把双层货箱的开放步补成价签的开放步，与新规则下一局从头玩出来的记录一致。核心在下一次检查开放条件时也会补开，
 *     这里先补上，读档之后马上就是新规则下的样子。
 *   5 数据员和效果记录（它们和版本 4 的其余改动在 v0.3.0 一起首次发布，所以不另升版本，这几项补进同一次迁移）：
 *     campaign.forecast：推演次数，补成 0。旧存档没有记过，读档之后每场高峰的小结加一次。
 *     campaign.effectWatches：购买的效果跟踪，补成空数组。每次日结：effects（效果行）为空数组。旧存档没有记过，旧记录里就是没有。
 *       跟踪里副本记下的数（twins）和效果行里不购买时的数（twin）也在同一个版本里：旧存档里没有跟踪和效果行，所以没有它们要补，
 *       万一跟踪已经在，twins 补成空数组。
 *     campaign.unlocks.dataClerk：数据员随价签一起到岗。价签已经开放的存档，补成价签的开放步，与双层货箱同样处理，
 *     没有开放的补成 -1。补开的同时放出「数据员已到岗」的便签，步数取读档时的步，这是迁移对已有内容唯一的追加：
 *     升级上来的玩家价签早已开放，核心不会再放这张便签，不补的话玩家不知道有推演。
 */
function migrateV3ToV4(data: SaveData): SaveData {
  const state = data.state;
  const campaign = isRecord(state) ? state.campaign : undefined;
  if (!isRecord(state) || !isRecord(campaign)) return data;
  if (campaign.nearestOwned === undefined) campaign.nearestOwned = state.returnRule === 'nearest';
  if (campaign.tally === undefined) campaign.tally = zeroTally(Array.isArray(state.stations) ? state.stations.length : 0);
  for (const peak of listOf(campaign.peaks)) {
    if (peak.fleet === undefined) peak.fleet = null;
    if (peak.fleetBack === undefined) peak.fleetBack = null;
    if (peak.stations === undefined) peak.stations = [];
  }
  for (const day of listOf(campaign.days)) {
    if (day.busy === undefined) day.busy = null;
  }
  const unlocks = campaign.unlocks;
  if (isRecord(unlocks)) {
    const tags = unlocks.priceTags;
    const box = unlocks.doubleBox;
    if (typeof tags === 'number' && tags >= 0 && (box === undefined || (typeof box === 'number' && box < 0))) unlocks.doubleBox = tags;
    if (unlocks.dataClerk === undefined) {
      const open = typeof tags === 'number' && tags >= 0;
      unlocks.dataClerk = open ? tags : -1;
      // 价签已经开放的旧存档，数据员是读档时才到岗的：放出「数据员已到岗」的便签，步数取读档时的步，升级上来的玩家才知道有推演
      const tips = campaign.tips;
      if (open && Array.isArray(tips) && !tips.some((tip) => isRecord(tip) && tip.id === 'dataClerk')) {
        tips.push({ id: 'dataClerk', step: typeof state.step === 'number' ? state.step : 0, station: null, read: false });
      }
    }
  }
  if (campaign.forecast === undefined) campaign.forecast = { charges: 0 };
  if (campaign.effectWatches === undefined) campaign.effectWatches = [];
  for (const watch of listOf(campaign.effectWatches)) {
    if (watch.twins === undefined) watch.twins = [];
  }
  for (const day of listOf(campaign.days)) {
    if (day.effects === undefined) day.effects = [];
  }
  return data;
}

/** 正式的迁移表。键是迁移前的版本号：表里的 [n] 把版本 n 迁到 n+1。以后把存档版本升到 5 时，在这里加 [4]。 */
export const MIGRATIONS: MigrationTable = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
};

export type MigrateResult = { ok: true; data: SaveData } | { ok: false; message: string };

/** 把存档从版本 from 逐版迁到版本 to。缺少某一步，或某一步出错、没有返回对象，都返回失败，不抛出。 */
export function migrateSave(data: SaveData, from: number, to: number, table: MigrationTable = MIGRATIONS): MigrateResult {
  let current = data;
  for (let version = from; version < to; version++) {
    const step: Migration | undefined = table[version];
    if (step === undefined) return { ok: false, message: `no migration from version ${version} to ${version + 1}` };
    let next: unknown;
    try {
      next = step(current);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `migration from version ${version} to ${version + 1} failed: ${why}` };
    }
    if (!isRecord(next)) return { ok: false, message: `migration from version ${version} to ${version + 1} did not return an object` };
    next.version = version + 1;
    current = next;
  }
  return { ok: true, data: current };
}

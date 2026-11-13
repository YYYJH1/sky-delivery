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

/** 正式的迁移表。键是迁移前的版本号：表里的 [n] 把版本 n 迁到 n+1。以后把存档版本升到 3 时，在这里加 [2]。 */
export const MIGRATIONS: MigrationTable = {
  1: migrateV1ToV2,
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

// 存档的格式：一个对象，带格式标识、版本号、内容版本和保存时间，里面是完整的 SimState，序列化成 JSON 字符串。
// 写之前和读之后都做同一套校验：字段表、深度扫描，读旧版本时先做迁移。
// 模块里不读系统时钟，保存时间由调用方传入。
// 写进存储的文本有两种写法：这里的 JSON 原文（版本 1 的存档都是这样存的），或者压缩之后的导出码写法，见 code.ts。
import { CONTENT_VERSION } from '../core/index.ts';
import type { SimState } from '../core/index.ts';
import { MIGRATIONS, migrateSave } from './migrate.ts';
import type { MigrationTable, SaveData } from './migrate.ts';
import { NON_FINITE_ALLOWED, STATE_CHECK } from './schema.ts';
import { MAX_ISSUES, compileAllowList, describe, int, isRecord, newCtx, num, obj, scanValues, str } from './validate.ts';
import type { Check, Issue } from './validate.ts';

/** 格式标识：用来认出这是本游戏的存档，不是别的 JSON。 */
export const SAVE_FORMAT = 'sky-delivery-save';

/**
 * 存档版本号，整数。存档的结构有不兼容的改动时加一，并在迁移表里补上旧版本到新版本的函数。
 * 版本 2：外层的内容版本从字符串改成整数，和内容表的版本号 src/content/version.ts 是同一个数。
 * 状态里加了经营模式的 campaign，以及它的 away 字段，字段表据此扩充。迁移见 migrate.ts。
 * 版本 3：经营模式的高峰小结和日结多了目标线、达标标记、小结对照和每场的达标场数，campaign 多了最近一场高峰的目标 goals。
 * 这些字段都可以是 null 或 0，旧存档里没有的由迁移补上。
 * 版本 4：campaign 多了 nearestOwned（买下了就近降落，买下之后可以开关）和 tally（机队时间和排队的计数）。
 * 高峰小结多了 fleet（机队时间构成）、fleetBack（回站飞行占比）和 stations（各站的一行），日结多了 busy（各时刻的运力占用）。
 * 这些字段在旧存档的记录里可以是 null 或空数组，由迁移补上。
 * 双层货箱改为随价签开放，价签已开放而它还没开放的存档由迁移补开。
 * 同一个格式里还加了数据员和效果记录（它们和版本 4 的其余改动在 v0.3.0 一起首次发布，所以没有另升版本）：campaign 多了 forecast（推演次数）和
 * effectWatches（购买的效果跟踪，含副本记下的数 twins），日结多了 effects（效果行，含不购买时的数 twin），
 * 各项开放多了 dataClerk（数据员，随价签开放，价签已开放的存档由迁移补开）。
 * 效果记录改为与不购买的副本对照之前写出的格式 4 存档，跟踪里没有 twins，效果行里没有 twin，读档会被字段表拒绝。
 */
export const SAVE_VERSION = 4;

/**
 * 内容版本号，取自内容表的 src/content/version.ts。内容表（地图、价格、星级线等）改到会影响已有存档时，
 * 在那里把它加一。内容表不进存档，存档只记这个版本号。读到内容版本不同的存档时照常读，内容表按当前版本生效，
 * 读档的结果里标出 contentChanged。
 */
export { CONTENT_VERSION };

/** 存档文本的长度上限（字符数）。超过的直接拒绝，不去解析。 */
export const MAX_SAVE_CHARS = 64 * 1024 * 1024;

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: number;
  contentVersion: number;
  /** 保存时的墙上时间，毫秒，由调用方传入。 */
  savedAt: number;
  state: SimState;
}

/** 读档或写档没有通过的原因。 */
export type FailureCode =
  | 'parse' // 不是合法的 JSON，例如被截断
  | 'size' // 文本太长
  | 'format' // 不是对象，或格式标识不对
  | 'version' // 版本号缺失或不是非负整数
  | 'newer-version' // 版本号比这个游戏认识的新
  | 'migrate' // 缺少某一步迁移，或迁移出错
  | 'schema' // 缺少必要的字段，或字段类型不对
  | 'non-finite' // 数字是 NaN 或无穷（在 JSON 里表现为 null）
  | 'serialize' // 状态无法写成 JSON
  | 'code' // 导出码的写法不对
  | 'checksum' // 导出码的校验和对不上
  | 'inflate'; // 导出码解压失败

export interface FailureReason {
  code: FailureCode;
  message: string;
  /** 具体哪些字段有问题，最多 MAX_ISSUES 条。 */
  issues: Issue[];
}

export interface FormatOptions {
  /** 当前存档版本。默认 SAVE_VERSION。测试里用更高的版本号演示迁移。 */
  currentVersion?: number;
  /** 迁移表。默认 MIGRATIONS。 */
  migrations?: MigrationTable;
  /** 状态的字段表。默认 STATE_CHECK。核心给 SimState 加了字段、字段表也扩充之后，从这里换进去。 */
  stateCheck?: Check;
  /** 允许出现非有限数字的字段路径。默认 NON_FINITE_ALLOWED。 */
  allowNonFinite?: readonly string[];
  /** 当前内容版本。默认 CONTENT_VERSION。 */
  contentVersion?: number;
}

export function failure(code: FailureCode, message: string, issues: Issue[] = []): { ok: false; reason: FailureReason } {
  return { ok: false, reason: { code, message, issues } };
}

function summarize(issues: Issue[]): string {
  const first = issues[0];
  if (first === undefined) return 'invalid save';
  const where = first.path === '' ? '' : `${first.path}: `;
  // 记下的问题最多 MAX_ISSUES 条，到了这个数说明后面可能还有
  const more = issues.length > 1 ? ` (and ${issues.length - 1}${issues.length >= MAX_ISSUES ? '+' : ''} more)` : '';
  return `${where}${first.message}${more}`;
}

/** 整份存档的检查：外层字段加上里面的状态，再对全部内容做深度扫描。 */
export function validateSaveData(data: SaveData, options: FormatOptions = {}): Issue[] {
  const ctx = newCtx();
  obj({ format: str, version: int, contentVersion: int, savedAt: num, state: options.stateCheck ?? STATE_CHECK })(data, ctx);
  scanValues(data, ctx, compileAllowList(options.allowNonFinite ?? NON_FINITE_ALLOWED));
  return ctx.issues;
}

export type SerializeResult = { ok: true; text: string } | { ok: false; reason: FailureReason };

/**
 * 把状态写成存档文本。写之前先做同样的校验，状态里有 NaN、无穷或 JSON 存不下的东西时拒绝，
 * 免得把一份读不回来的存档写进去，顶掉好的备份。
 */
export function serializeSave(state: SimState, savedAtMs: number, options: FormatOptions = {}): SerializeResult {
  const file: SaveFile = {
    format: SAVE_FORMAT,
    version: options.currentVersion ?? SAVE_VERSION,
    contentVersion: options.contentVersion ?? CONTENT_VERSION,
    savedAt: savedAtMs,
    state,
  };
  const issues = validateSaveData(file as unknown as SaveData, options);
  if (issues.length > 0) {
    const code = issues.some((issue) => issue.kind === 'non-finite') ? 'non-finite' : 'schema';
    return failure(code, summarize(issues), issues);
  }
  try {
    return { ok: true, text: JSON.stringify(file) };
  } catch (error) {
    return failure('serialize', error instanceof Error ? error.message : String(error));
  }
}

export interface LoadedSave {
  ok: true;
  state: SimState;
  /** 存档里记的保存时间（墙上时间，毫秒）。 */
  savedAt: number;
  /** 迁移之后的版本，等于当前版本。 */
  version: number;
  contentVersion: number;
  /** 存档的内容版本与当前的内容版本不同。内容表按当前版本生效，读档照常进行，界面不需要提示。 */
  contentChanged: boolean;
  /** 存档文件原来的版本号，没有迁移时为 null。 */
  migratedFrom: number | null;
}

export type ParseResult = LoadedSave | { ok: false; reason: FailureReason };

/** 解析、迁移、校验一份已经 JSON.parse 过的存档对象。 */
export function parseSaveData(data: unknown, options: FormatOptions = {}): ParseResult {
  const current = options.currentVersion ?? SAVE_VERSION;
  if (!isRecord(data)) return failure('format', `a save must be a JSON object, got ${describe(data)}`);
  if (data.format !== SAVE_FORMAT) return failure('format', `unknown format ${describe(data.format)}`);
  const version = data.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return failure('version', `the save version must be a non-negative integer, got ${describe(version)}`);
  }
  if (version > current) {
    return failure('newer-version', `the save version ${version} is newer than the supported version ${current}`);
  }
  let work: SaveData = data;
  let migratedFrom: number | null = null;
  if (version < current) {
    const migrated = migrateSave(work, version, current, options.migrations ?? MIGRATIONS);
    if (!migrated.ok) return failure('migrate', migrated.message);
    work = migrated.data;
    migratedFrom = version;
  }
  const issues = validateSaveData(work, options);
  if (issues.length > 0) {
    const code = issues.some((issue) => issue.kind === 'non-finite') ? 'non-finite' : 'schema';
    return failure(code, summarize(issues), issues);
  }
  const contentVersion = work.contentVersion as number;
  return {
    ok: true,
    state: work.state as SimState,
    savedAt: work.savedAt as number,
    version: current,
    contentVersion,
    contentChanged: contentVersion !== (options.contentVersion ?? CONTENT_VERSION),
    migratedFrom,
  };
}

/** 解析一份存档文本。 */
export function parseSave(text: string, options: FormatOptions = {}): ParseResult {
  if (typeof text !== 'string') return failure('format', `a save must be text, got ${describe(text)}`);
  if (text.length > MAX_SAVE_CHARS) return failure('size', `the save text is longer than ${MAX_SAVE_CHARS} characters`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return failure('parse', `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSaveData(data, options);
}

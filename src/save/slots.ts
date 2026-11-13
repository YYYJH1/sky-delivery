// 主存档加三份滚动备份，以及读档时的回退。
//
// 保存：先把主存档挪成备份一，备份一挪成备份二，备份二挪成备份三，最后写新的主存档。
// 挪的时候从最老的一份开始，所以任何一步被打断，都至少还留着上一代存档：
//   打断在挪的途中，主存档没动，读档照常用它。
//   打断在写主存档的途中，上一代已经在备份一里，读档回退到它。
// 现有的主存档校验不通过时，不把它挪进备份，免得坏的存档顶掉好的备份：
// 先给它留一份带时间的副本，备份不动，直接写新的主存档。
// 挪备份时抛出了错误（和进程被打断不同，多半是 localStorage 空间不够）：不放弃保存，仍然写新的主存档，
// 备份少一代，结果里给出 rotation-failed 警告。玩家的最新进度比多留一代备份重要。
//
// 读档：先读主存档，不通过就依次试备份一到三。校验不通过的存档不删除、不覆盖，
// 另存一份带时间的副本，并在返回结果里说明原因，界面据此提示玩家。
//
// 同一个存储上的保存和读档排队执行，不会互相穿插。
//
// 保存时要先检查现有的主存档，通过了才挪进备份。主存档就是上一次保存写下、读回来核对过的那一份时，不再重新检查：
// 解压、解析、校验一份几兆的存档要占主线程几十毫秒，每隔 30 秒的自动保存都花这一笔不值得。
//
// 写进存储的存档文本默认先压缩（见 code.ts，和导出码是同一种写法），读档时压缩的和没有压缩的都能读。
// 压缩是异步的，所以放在排队执行的任务里做，不然先发出的保存可能后写入，把新的存档顶掉。
// 环境里没有压缩流（很旧的浏览器）时，退回写 JSON 原文，保存照常进行。
import type { SimState } from '../core/index.ts';
import { crc32, hex8, utf8Encode, utf8Length } from './bytes.ts';
import { encodeSaveText, parseStoredSave } from './code.ts';
import type { CodeOptions } from './code.ts';
import { serializeSave } from './format.ts';
import type { FailureReason } from './format.ts';
import { StoreError } from './store.ts';
import type { KeyValueStore, StoreErrorKind } from './store.ts';

/** 四份存档，按新到旧的顺序。 */
export const SLOTS = ['main', 'backup1', 'backup2', 'backup3'] as const;
export type SlotName = (typeof SLOTS)[number];

/** 键的前缀。同一个存储里放别的东西时不会混在一起。 */
export const DEFAULT_NAMESPACE = 'sky-delivery.';

export interface SlotOptions extends CodeOptions {
  namespace?: string;
  /** 写进存储之前先压缩，默认是。设为 false 写 JSON 原文，测试里要看存档原文时用。读档不受这个选项影响。 */
  compress?: boolean;
}

export function slotKey(slot: SlotName, namespace: string = DEFAULT_NAMESPACE): string {
  return `${namespace}${slot}`;
}

/** 校验不通过的存档的副本，键以它开头。 */
export function quarantinePrefix(namespace: string = DEFAULT_NAMESPACE): string {
  return `${namespace}bad.`;
}

/** 列出已经留下的副本的键，按时间从早到晚。 */
export function listQuarantine(store: KeyValueStore, namespace: string = DEFAULT_NAMESPACE): Promise<string[]> {
  return store.keys(quarantinePrefix(namespace));
}

// ---- 排队 ----
const queues = new WeakMap<object, Promise<void>>();

function exclusive<T>(store: KeyValueStore, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(store) ?? Promise.resolve();
  const run = previous.then(task);
  queues.set(
    store,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ---- 隔离副本 ----
export interface QuarantineEntry {
  /** 这份副本来自哪一份存档。 */
  slot: SlotName;
  /** 副本的键。 */
  key: string;
  /** 这次新写了副本为 true，已经有同样内容的副本、没有重复写为 false。 */
  created: boolean;
  reason: FailureReason;
}

/**
 * 给校验不通过的存档留一份副本，键里带保存时间和内容的长度与校验和：
 * 同样的内容只留一份，反复打开同一份坏档不会越存越多。已有的副本一律不覆盖。
 */
async function keepCopy(
  store: KeyValueStore,
  namespace: string,
  slot: SlotName,
  text: string,
  reason: FailureReason,
  nowMs: number,
): Promise<QuarantineEntry> {
  const id = `${utf8Length(text)}-${hex8(crc32(utf8Encode(text)))}`;
  const prefix = quarantinePrefix(namespace);
  for (const key of await store.keys(prefix)) {
    if (key.endsWith(`.${id}`) && (await store.get(key)) === text) return { slot, key, created: false, reason };
  }
  const stamp = String(Math.max(0, Math.trunc(Number.isFinite(nowMs) ? nowMs : 0))).padStart(13, '0');
  const base = `${prefix}${stamp}.${slot}.${id}`;
  let key = base;
  for (let n = 2; (await store.get(key)) !== null; n++) key = `${base}.${n}`;
  await store.set(key, text);
  return { slot, key, created: true, reason };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kindOf(error: unknown): StoreErrorKind {
  return error instanceof StoreError ? error.kind : 'other';
}

// ---- 保存 ----
export type SaveWarning =
  | 'rotation-failed' // 挪备份时出错（多半是空间不够），备份少了一代，新的主存档照常写了
  | 'quarantine-failed'; // 坏的存档没能留下副本

export type SaveOutcome =
  | {
      ok: true;
      /** 主存档写进存储的字节数（UTF-8），压缩之后的。 */
      bytes: number;
      /** 主存档的 JSON 原文的字节数（UTF-8），压缩之前的。 */
      rawBytes: number;
      /** 写进存储的是压缩的写法。 */
      packed: boolean;
      savedAt: number;
      /** 这次保存时发现主存档校验不通过，为它留下的副本。 */
      quarantined: QuarantineEntry[];
      warnings: SaveWarning[];
    }
  | {
      ok: false;
      /** invalid-state：状态没通过校验，没有动任何存档。store：存储出错。 */
      error: 'invalid-state' | 'store';
      message: string;
      reason?: FailureReason;
      storeKind?: StoreErrorKind;
      quarantined: QuarantineEntry[];
      warnings: SaveWarning[];
    };

// 最近一次写进主存档、读回来核对过的文本，按存储和键记着。下一次保存时主存档仍是这一份，就不必再检查：
// 它刚才是用同一套校验写出去的。主存档变过（别的程序写过，或者测试里被改坏）时文本对不上，照常检查。
// 只在用默认的字段表和迁移表时才信这条记录，换了校验的办法就每次都检查。
const verified = new WeakMap<KeyValueStore, Map<string, string>>();

function usesDefaultChecks(options: SlotOptions): boolean {
  return options.stateCheck === undefined && options.migrations === undefined && options.allowNonFinite === undefined && options.currentVersion === undefined;
}

/** 要写进存储的文本：压缩的写法，压缩不了时是 JSON 原文。 */
async function storedForm(json: string, options: SlotOptions): Promise<{ text: string; packed: boolean }> {
  if (options.compress === false) return { text: json, packed: false };
  try {
    return { text: await encodeSaveText(json), packed: true };
  } catch {
    return { text: json, packed: false };
  }
}

async function writeSlots(store: KeyValueStore, json: string, nowMs: number, options: SlotOptions): Promise<SaveOutcome> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const quarantined: QuarantineEntry[] = [];
  const warnings: SaveWarning[] = [];
  try {
    const { text, packed } = await storedForm(json, options);
    const mainKey = slotKey('main', namespace);
    const previous = await store.get(mainKey);
    let rotate = false;
    const trusted = usesDefaultChecks(options) ? verified.get(store)?.get(mainKey) : undefined;
    if (previous !== null) {
      const check = previous === trusted ? ({ ok: true } as const) : await parseStoredSave(previous, options);
      if (check.ok) {
        rotate = true;
      } else {
        try {
          quarantined.push(await keepCopy(store, namespace, 'main', previous, check.reason, nowMs));
        } catch {
          warnings.push('quarantine-failed');
        }
      }
    }
    if (rotate && previous !== null) {
      try {
        for (let i = SLOTS.length - 1; i >= 1; i--) {
          const from = i === 1 ? previous : await store.get(slotKey(SLOTS[i - 1] as SlotName, namespace));
          if (from !== null) await store.set(slotKey(SLOTS[i] as SlotName, namespace), from);
        }
      } catch {
        warnings.push('rotation-failed');
      }
    }
    await store.set(mainKey, text);
    if ((await store.get(mainKey)) !== text) {
      return { ok: false, error: 'store', message: 'the main save could not be read back after writing', quarantined, warnings };
    }
    if (usesDefaultChecks(options)) {
      const remembered = verified.get(store) ?? new Map<string, string>();
      remembered.set(mainKey, text);
      verified.set(store, remembered);
    }
    return { ok: true, bytes: utf8Length(text), rawBytes: utf8Length(json), packed, savedAt: nowMs, quarantined, warnings };
  } catch (error) {
    return { ok: false, error: 'store', message: describeError(error), storeKind: kindOf(error), quarantined, warnings };
  }
}

/**
 * 保存。状态在调用的这一刻就序列化好，之后状态再变也不影响这一份。
 * 状态没通过校验（有 NaN、无穷等）时不动任何存档，返回 invalid-state。
 * nowMs 是调用方传入的墙上时间，写进存档，也用于副本的键。
 */
export function saveGame(store: KeyValueStore, state: SimState, nowMs: number, options: SlotOptions = {}): Promise<SaveOutcome> {
  const serialized = serializeSave(state, nowMs, options);
  if (!serialized.ok) {
    return Promise.resolve({
      ok: false,
      error: 'invalid-state',
      message: serialized.reason.message,
      reason: serialized.reason,
      quarantined: [],
      warnings: [],
    });
  }
  const json = serialized.text;
  return exclusive(store, () => writeSlots(store, json, nowMs, options));
}

// ---- 读档 ----
export type SlotFailure = { slot: SlotName; kind: 'missing' } | { slot: SlotName; kind: 'invalid'; reason: FailureReason };

export type LoadStatus =
  | 'ok' // 主存档读到了
  | 'restored' // 主存档没读到，用了备份
  | 'empty' // 一份存档都没有，该开新档
  | 'corrupt' // 有存档，但每一份都没通过校验
  | 'unavailable'; // 存储用不了

export interface LoadedMeta {
  /** 存档里记的保存时间（墙上时间，毫秒）。 */
  savedAt: number;
  /** 存档文件原来的版本号，没有迁移时等于当前版本。 */
  fileVersion: number;
  contentVersion: number;
  /** 存档的内容版本与当前不同。内容表按当前版本生效，读档照常进行，界面不需要提示。 */
  contentChanged: boolean;
  /** 读档时从哪个版本迁移过来的，没有迁移时为 null。 */
  migratedFrom: number | null;
}

export interface LoadOutcome {
  status: LoadStatus;
  /** 读到的状态。status 是 ok 或 restored 时有值。 */
  state: SimState | null;
  /** 读到的那份存档的信息。 */
  save: LoadedMeta | null;
  /** 状态来自哪一份。 */
  source: SlotName | null;
  /** 排在读到的那份前面、没有读到的各份：内容缺失，或校验不通过和原因。没有读到任何一份时是全部四份。 */
  failures: SlotFailure[];
  /** 有存档的内容校验不通过。界面据此提示玩家：存档损坏，已经用备份恢复，或已经无法恢复。 */
  damaged: boolean;
  /** 因此另存的带时间的副本。 */
  quarantined: QuarantineEntry[];
  warnings: SaveWarning[];
  /** status 是 unavailable 时的原因。 */
  error?: string;
}

async function readSlots(store: KeyValueStore, nowMs: number, options: SlotOptions): Promise<LoadOutcome> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const failures: SlotFailure[] = [];
  const quarantined: QuarantineEntry[] = [];
  const warnings: SaveWarning[] = [];
  const damaged = (): boolean => failures.some((failed) => failed.kind === 'invalid');
  let sawContent = false;
  try {
    for (const slot of SLOTS) {
      const text = await store.get(slotKey(slot, namespace));
      if (text === null) {
        failures.push({ slot, kind: 'missing' });
        continue;
      }
      sawContent = true;
      const parsed = await parseStoredSave(text, options);
      if (parsed.ok) {
        return {
          status: slot === 'main' ? 'ok' : 'restored',
          state: parsed.state,
          save: {
            savedAt: parsed.savedAt,
            fileVersion: parsed.migratedFrom ?? parsed.version,
            contentVersion: parsed.contentVersion,
            contentChanged: parsed.contentChanged,
            migratedFrom: parsed.migratedFrom,
          },
          source: slot,
          failures,
          damaged: damaged(),
          quarantined,
          warnings,
        };
      }
      failures.push({ slot, kind: 'invalid', reason: parsed.reason });
      try {
        quarantined.push(await keepCopy(store, namespace, slot, text, parsed.reason, nowMs));
      } catch {
        warnings.push('quarantine-failed');
      }
    }
  } catch (error) {
    return {
      status: 'unavailable',
      state: null,
      save: null,
      source: null,
      failures,
      damaged: damaged(),
      quarantined,
      warnings,
      error: describeError(error),
    };
  }
  return {
    status: sawContent ? 'corrupt' : 'empty',
    state: null,
    save: null,
    source: null,
    failures,
    damaged: damaged(),
    quarantined,
    warnings,
  };
}

/** 读档：主存档，不通过就依次试备份一到三。坏的存档原样留着，另存一份带时间的副本。 */
export function loadGame(store: KeyValueStore, nowMs: number, options: SlotOptions = {}): Promise<LoadOutcome> {
  return exclusive(store, () => readSlots(store, nowMs, options));
}

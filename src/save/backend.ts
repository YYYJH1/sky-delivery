// 网页版用哪种存储：优先 IndexedDB，打不开时退回 localStorage。
// 第一次用 IndexedDB 时，把 localStorage 里已有的存档（主存档、备份、坏档的副本）原样复制过去，
// 复制成功之后给 IndexedDB 记一个已迁移的标记，原来的 localStorage 不删。
// 标记放在 IndexedDB 里，不放在 localStorage 里：IndexedDB 被浏览器清掉时，标记和存档一起没了，
// 下一次打开会再迁一次，玩家至少还能读到迁移之前的存档，不会什么也没有。
// 这个文件不碰全局对象：IndexedDB 的工厂对象和 localStorage 由调用方传进来。
import { IndexedDbStore } from './indexed-db.ts';
import type { IdbFactoryLike } from './indexed-db.ts';
import { LocalStorageStore } from './local-storage.ts';
import type { StorageLike } from './local-storage.ts';
import { DEFAULT_NAMESPACE } from './slots.ts';
import { StoreError } from './store.ts';
import type { KeyValueStore } from './store.ts';

/** 已迁移的标记的键，放在 IndexedDB 里。值是一小段 JSON，记着从哪里迁来、什么时候、复制了几份。 */
export const MIGRATED_KEY = `${DEFAULT_NAMESPACE}meta.migrated`;

export type MigrationStatus =
  | 'already' // IndexedDB 里已经有标记，之前迁过了
  | 'none' // localStorage 里没有存档，不用迁，只记了标记
  | 'migrated' // 这一次迁了
  | 'source-unavailable' // localStorage 读不了（被浏览器禁用），不知道有没有要迁的，不记标记，下次再试
  | 'failed'; // 写进 IndexedDB 时出错，没有记标记，下次再试

export interface MigrationReport {
  status: MigrationStatus;
  /** 这一次复制了几个键。 */
  copied: number;
  /** status 是 failed 或 source-unavailable 时的原因。 */
  error?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把 source 里以 prefix 开头的键复制到 target。
 * 不覆盖 target 里已经有的键，复制之后读回来核对。全部复制完才记已迁移的标记。
 * source 里的东西一律不动。读 source 出错和写 target 出错分开报告，调用方据此决定用哪个存储。
 */
export async function migrateLocalStorage(source: KeyValueStore, target: KeyValueStore, nowMs: number, prefix: string = DEFAULT_NAMESPACE): Promise<MigrationReport> {
  let copied = 0;
  try {
    if ((await target.get(MIGRATED_KEY)) !== null) return { status: 'already', copied };
  } catch (error) {
    return { status: 'failed', copied, error: describeError(error) };
  }
  let keys: string[];
  try {
    keys = (await source.keys(prefix)).filter((key) => key !== MIGRATED_KEY);
  } catch (error) {
    return { status: 'source-unavailable', copied, error: describeError(error) };
  }
  try {
    for (const key of keys) {
      const value = await source.get(key);
      if (value === null) continue;
      if ((await target.get(key)) !== null) continue;
      await target.set(key, value);
      if ((await target.get(key)) !== value) throw new StoreError('other', `${key} could not be read back after copying`);
      copied += 1;
    }
    await target.set(MIGRATED_KEY, JSON.stringify({ from: 'localStorage', at: nowMs, keys: keys.length, copied }));
  } catch (error) {
    return { status: 'failed', copied, error: describeError(error) };
  }
  return { status: keys.length === 0 ? 'none' : 'migrated', copied };
}

/** 浏览器禁用了本地存储，或者根本没有时用的：每一次读写都出错，读档报「用不了」，保存报失败，玩家照样能玩，也能导出存档。 */
export const DENIED_STORAGE: StorageLike = {
  length: 0,
  key: () => null,
  getItem: () => {
    throw new Error('localStorage is not available');
  },
  setItem: () => {
    throw new Error('localStorage is not available');
  },
  removeItem: () => {
    throw new Error('localStorage is not available');
  },
};

export interface StoreEnv {
  /** window.indexedDB。没有，或者读它就出错（浏览器禁用了存储）时不给。 */
  indexedDb?: IdbFactoryLike | undefined;
  /** window.localStorage。没有，或者读它就出错时不给。 */
  storage?: StorageLike | undefined;
  /** 墙上时间，毫秒，写进已迁移的标记。 */
  nowMs: number;
  /** IndexedDB 的数据库名，默认用 DEFAULT_DB_NAME。测试里用。 */
  dbName?: string;
}

export type StoreKind = 'indexeddb' | 'localstorage' | 'none';

export interface OpenedStore {
  store: KeyValueStore;
  /** 实际用的是哪一种。none 是两种都用不了，读写都会出错。 */
  kind: StoreKind;
  /** 从 localStorage 迁移的结果。没有用 IndexedDB，或者没有 localStorage 时为 null。 */
  migration: MigrationReport | null;
  /** 没有用 IndexedDB 的原因，给开发者看。 */
  fallback?: string;
}

/**
 * 打开存档用的存储。
 *   IndexedDB 能打开：用它，并把 localStorage 里已有的存档迁过来。迁移在写 IndexedDB 时出错，说明它实际上用不了
 *   （例如某些浏览器的隐私模式能打开、不能写），这一次退回 localStorage，下一次再试。
 *   IndexedDB 打不开：退回 localStorage，已有的存档照常读。
 *   两种都没有：返回一个读写都出错的存储，页面照常运行，只是存不了档。
 */
export async function openGameStore(env: StoreEnv): Promise<OpenedStore> {
  const local = env.storage === undefined ? null : new LocalStorageStore(env.storage);
  let fallback: string | undefined;
  if (env.indexedDb !== undefined) {
    try {
      const idb = await IndexedDbStore.open(env.indexedDb, env.dbName === undefined ? {} : { name: env.dbName });
      if (local === null) return { store: idb, kind: 'indexeddb', migration: null };
      const migration = await migrateLocalStorage(local, idb, env.nowMs);
      if (migration.status !== 'failed') return { store: idb, kind: 'indexeddb', migration };
      idb.close();
      fallback = `migration failed: ${migration.error ?? 'unknown'}`;
      return { store: local, kind: 'localstorage', migration, fallback };
    } catch (error) {
      fallback = describeError(error);
    }
  }
  if (local !== null) return { store: local, kind: 'localstorage', migration: null, ...(fallback === undefined ? {} : { fallback }) };
  return { store: new LocalStorageStore(DENIED_STORAGE), kind: 'none', migration: null, ...(fallback === undefined ? {} : { fallback }) };
}

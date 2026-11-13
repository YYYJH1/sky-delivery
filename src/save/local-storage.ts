// 浏览器的 localStorage 版存储。
// 这个文件不碰全局的 localStorage：由调用方把 window.localStorage 传进来，这样测试里可以传一个假的，
// 也不会在不能用本地存储的环境里一加载就出错。
import { StoreError } from './store.ts';
import type { KeyValueStore } from './store.ts';

/** localStorage 用到的那几个方法。浏览器的 Storage 满足这个形状。 */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 各浏览器报告空间不够的写法。IndexedDB 的存储也用它。 */
export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  // 各浏览器的写法不同：标准的 QuotaExceededError，旧版 Firefox 的 NS_ERROR_DOM_QUOTA_REACHED，以及错误码 22 和 1014
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014;
}

function wrap(error: unknown, what: string): StoreError {
  const why = error instanceof Error ? error.message : String(error);
  return new StoreError(isQuotaError(error) ? 'quota' : 'unavailable', `${what} failed: ${why}`, { cause: error });
}

export class LocalStorageStore implements KeyValueStore {
  private readonly storage: StorageLike;

  constructor(storage: StorageLike) {
    this.storage = storage;
  }

  get(key: string): Promise<string | null> {
    try {
      return Promise.resolve(this.storage.getItem(key));
    } catch (error) {
      return Promise.reject(wrap(error, `reading ${key}`));
    }
  }

  /** setItem 要么写成功，要么抛错并保持原值，所以满足接口要求的原子性。 */
  set(key: string, value: string): Promise<void> {
    try {
      this.storage.setItem(key, value);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(wrap(error, `writing ${key}`));
    }
  }

  remove(key: string): Promise<void> {
    try {
      this.storage.removeItem(key);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(wrap(error, `removing ${key}`));
    }
  }

  keys(prefix = ''): Promise<string[]> {
    try {
      const out: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key !== null && key.startsWith(prefix)) out.push(key);
      }
      return Promise.resolve(out.sort());
    } catch (error) {
      return Promise.reject(wrap(error, 'listing keys'));
    }
  }
}

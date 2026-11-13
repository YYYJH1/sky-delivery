// 浏览器的 IndexedDB 版存储。容量比 localStorage 大得多，存档长大之后也放得下。
// localStorage 的上限是 5M 个字符左右，四份存档加起来很容易超过，IndexedDB 的上限按磁盘算。
//
// 和 local-storage.ts 一样，这个文件不碰全局的 IndexedDB：由调用方把 window 上的工厂对象传进来，
// 测试里可以传一个假的，也不会在不能用 IndexedDB 的环境里一加载就出错。
// 只写下面几个接口里用到的方法，这样在浏览器的类型和 Node 的类型下都能通过类型检查。
//
// 一个数据库，一个对象仓库，键是存档的键，值是存档的文本。键值存储的接口要求 set 是原子的：
// 每次 set 是一个单独的读写事务，等事务完成才返回，所以读到的要么是旧值，要么是完整的新值。
import { isQuotaError } from './local-storage.ts';
import { StoreError } from './store.ts';
import type { KeyValueStore } from './store.ts';

// 事件处理函数的参数写成 never：浏览器自己的类型带着具体的事件类型，这样浏览器的对象能直接当作下面的接口用，
// 我们自己写的处理函数不取参数，所以并不受影响。
type Handler = ((event: never) => void) | null;

export interface IdbRequestLike {
  readonly result?: unknown;
  readonly error?: unknown;
  onsuccess: Handler;
  onerror: Handler;
}

export interface IdbOpenRequestLike extends IdbRequestLike {
  onupgradeneeded: Handler;
  onblocked: Handler;
}

export interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike;
  put(value: string, key: string): IdbRequestLike;
  delete(key: string): IdbRequestLike;
  getAllKeys(): IdbRequestLike;
}

export interface IdbTransactionLike {
  readonly error?: unknown;
  oncomplete: Handler;
  onerror: Handler;
  onabort: Handler;
  objectStore(name: string): IdbObjectStoreLike;
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  onversionchange: Handler;
  onclose: Handler;
  createObjectStore(name: string): unknown;
  transaction(storeName: string, mode: 'readonly' | 'readwrite', options?: { durability?: 'strict' | 'relaxed' | 'default' }): IdbTransactionLike;
  close(): void;
}

/** window.indexedDB 里用到的那一个方法。浏览器的 IDBFactory 满足这个形状。 */
export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

/** 数据库和对象仓库的默认名字。 */
export const DEFAULT_DB_NAME = 'sky-delivery';
export const DEFAULT_STORE_NAME = 'saves';

export interface IndexedDbOptions {
  /** 数据库的名字，默认 DEFAULT_DB_NAME。 */
  name?: string;
  /** 对象仓库的名字，默认 DEFAULT_STORE_NAME。 */
  storeName?: string;
}

function wrap(error: unknown, what: string): StoreError {
  if (error instanceof StoreError) return error;
  const why = error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : String(error);
  return new StoreError(isQuotaError(error) ? 'quota' : 'unavailable', `${what} failed: ${why}`, { cause: error });
}

export class IndexedDbStore implements KeyValueStore {
  private readonly factory: IdbFactoryLike;
  private readonly name: string;
  private readonly storeName: string;
  private handle: IdbDatabaseLike | null = null;
  private opening: Promise<IdbDatabaseLike> | null = null;

  private constructor(factory: IdbFactoryLike, name: string, storeName: string) {
    this.factory = factory;
    this.name = name;
    this.storeName = storeName;
  }

  /** 打开数据库，没有就建。打不开时抛出 StoreError，种类是 unavailable，调用方据此退回 localStorage。 */
  static async open(factory: IdbFactoryLike, options: IndexedDbOptions = {}): Promise<IndexedDbStore> {
    const store = new IndexedDbStore(factory, options.name ?? DEFAULT_DB_NAME, options.storeName ?? DEFAULT_STORE_NAME);
    await store.connection();
    return store;
  }

  /** 放掉数据库连接。之后再读写，会重新打开。 */
  close(): void {
    const db = this.handle;
    this.handle = null;
    if (db !== null) {
      try {
        db.close();
      } catch {
        // 已经关了
      }
    }
  }

  /** 连接被浏览器关了，或者别的页面要升级数据库：忘掉它，下一次操作重新打开。 */
  private forget(db: IdbDatabaseLike): void {
    if (this.handle === db) this.handle = null;
  }

  private connection(): Promise<IdbDatabaseLike> {
    if (this.handle !== null) return Promise.resolve(this.handle);
    if (this.opening !== null) return this.opening;
    const attempt = new Promise<IdbDatabaseLike>((resolve, reject) => {
      let request: IdbOpenRequestLike;
      try {
        request = this.factory.open(this.name, 1);
      } catch (error) {
        reject(wrap(error, 'opening the database'));
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result as IdbDatabaseLike;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
      };
      request.onsuccess = () => {
        const db = request.result as IdbDatabaseLike;
        db.onversionchange = () => {
          this.forget(db);
          db.close();
        };
        db.onclose = () => this.forget(db);
        this.handle = db;
        resolve(db);
      };
      request.onerror = () => reject(wrap(request.error, 'opening the database'));
      request.onblocked = () => reject(new StoreError('unavailable', 'opening the database is blocked by another connection'));
    });
    const tracked = attempt.finally(() => {
      this.opening = null;
    });
    this.opening = tracked;
    return tracked;
  }

  /** 做一个事务，等它完成。work 在事务里发出请求，返回要取结果的那个请求。 */
  private async run<T>(mode: 'readonly' | 'readwrite', what: string, work: (store: IdbObjectStoreLike) => IdbRequestLike): Promise<T> {
    const db = await this.connection();
    return new Promise<T>((resolve, reject) => {
      let tx: IdbTransactionLike;
      let request: IdbRequestLike;
      try {
        // 写入用 strict：事务完成时数据已经刷到磁盘，浏览器之后崩溃也不会丢这一次保存
        tx = mode === 'readwrite' ? db.transaction(this.storeName, mode, { durability: 'strict' }) : db.transaction(this.storeName, mode);
        request = work(tx.objectStore(this.storeName));
      } catch (error) {
        // 连接已经被浏览器关了，或者对象仓库不见了
        this.forget(db);
        reject(wrap(error, what));
        return;
      }
      tx.oncomplete = () => resolve(request.result as T);
      // 请求出错时事务随后会中止，在 onabort 里统一报告
      tx.onabort = () => reject(wrap(tx.error ?? request.error, what));
    });
  }

  async get(key: string): Promise<string | null> {
    const value = await this.run<unknown>('readonly', `reading ${key}`, (store) => store.get(key));
    return typeof value === 'string' ? value : null;
  }

  /** 一个读写事务，要么写成功，要么中止并保持原值，所以满足接口要求的原子性。空间不够时抛出 StoreError，种类是 quota。 */
  async set(key: string, value: string): Promise<void> {
    await this.run<unknown>('readwrite', `writing ${key}`, (store) => store.put(value, key));
  }

  async remove(key: string): Promise<void> {
    await this.run<unknown>('readwrite', `removing ${key}`, (store) => store.delete(key));
  }

  async keys(prefix = ''): Promise<string[]> {
    const all = await this.run<unknown>('readonly', 'listing keys', (store) => store.getAllKeys());
    if (!Array.isArray(all)) return [];
    return all.filter((key): key is string => typeof key === 'string' && key.startsWith(prefix)).sort();
  }
}

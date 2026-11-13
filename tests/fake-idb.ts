// 假的 IndexedDB，给存档测试用。只实现 IndexedDbStore 用到的那一小部分，行为按真实浏览器的规矩：
//   请求和事务的回调都是异步的，一个宏任务一次，不会在调用的当场就回调。
//   读写事务在所有请求做完之后才算完成，完成时才把写进去的东西提交。事务中止时，这个事务里写的东西全部作废。
//   同一个数据库上的事务一个接一个做，按创建的先后。
//   容量按所有键和值的字符数合计，超过时请求出错，错误名是 QuotaExceededError，随后事务中止。
// 数据放在工厂对象里，所以「关闭再打开」就是用同一个工厂再打开一个连接：连接对象是新的，数据还在。
import type { IdbDatabaseLike, IdbFactoryLike, IdbObjectStoreLike, IdbOpenRequestLike, IdbRequestLike, IdbTransactionLike } from '../src/save/index.ts';

type Fn = ((event: never) => void) | null;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function domError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

class FakeRequest implements IdbRequestLike {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: Fn = null;
  onerror: Fn = null;
  readonly work: () => unknown;

  constructor(work: () => unknown) {
    this.work = work;
  }
}

class FakeOpenRequest extends FakeRequest implements IdbOpenRequestLike {
  onupgradeneeded: Fn = null;
  onblocked: Fn = null;
}

interface Data {
  stores: Map<string, Map<string, string>>;
}

class FakeTransaction implements IdbTransactionLike {
  error: unknown = null;
  oncomplete: Fn = null;
  onerror: Fn = null;
  onabort: Fn = null;
  readonly requests: FakeRequest[] = [];
  readonly mode: 'readonly' | 'readwrite';
  readonly storeName: string;
  /** 事务里写的东西先放在这里，完成时才提交。 */
  staged: Map<string, string> | null = null;
  readonly owner: FakeConnection;

  constructor(owner: FakeConnection, storeName: string, mode: 'readonly' | 'readwrite') {
    this.owner = owner;
    this.storeName = storeName;
    this.mode = mode;
  }

  objectStore(name: string): IdbObjectStoreLike {
    if (name !== this.storeName) throw domError('NotFoundError', `no object store ${name} in this transaction`);
    const tx = this;
    const add = (work: () => unknown): IdbRequestLike => {
      const request = new FakeRequest(work);
      tx.requests.push(request);
      return request;
    };
    return {
      get: (key) => add(() => tx.view().get(key)),
      put: (value, key) => add(() => tx.write(key, value)),
      delete: (key) => add(() => tx.remove(key)),
      getAllKeys: () => add(() => [...tx.view().keys()].sort()),
    };
  }

  /** 事务里看到的内容：写过的话是写过之后的。 */
  view(): Map<string, string> {
    return this.staged ?? (this.owner.data.stores.get(this.storeName) as Map<string, string>);
  }

  private stage(): Map<string, string> {
    if (this.mode !== 'readwrite') throw domError('ReadOnlyError', 'the transaction is read-only');
    if (this.staged === null) this.staged = new Map(this.owner.data.stores.get(this.storeName) as Map<string, string>);
    return this.staged;
  }

  write(key: string, value: string): string {
    const map = this.stage();
    const faults = this.owner.factory;
    if (faults.failNextWrite !== null) {
      const error = faults.failNextWrite;
      faults.failNextWrite = null;
      throw error;
    }
    map.set(key, value);
    let used = 0;
    for (const [k, v] of map) used += k.length + v.length;
    if (used > faults.quotaChars) throw domError('QuotaExceededError', 'The quota has been exceeded.');
    return key;
  }

  remove(key: string): undefined {
    this.stage().delete(key);
    return undefined;
  }
}

class FakeConnection implements IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  onversionchange: Fn = null;
  onclose: Fn = null;
  closed = false;
  readonly data: Data;
  readonly factory: FakeIdbFactory;

  constructor(factory: FakeIdbFactory, data: Data) {
    this.factory = factory;
    this.data = data;
    this.objectStoreNames = { contains: (name) => data.stores.has(name) };
  }

  createObjectStore(name: string): unknown {
    if (!this.data.stores.has(name)) this.data.stores.set(name, new Map());
    return {};
  }

  transaction(storeName: string, mode: 'readonly' | 'readwrite', options?: { durability?: string }): IdbTransactionLike {
    if (this.closed) throw domError('InvalidStateError', 'the database connection is closing');
    if (!this.data.stores.has(storeName)) throw domError('NotFoundError', `no object store ${storeName}`);
    const tx = new FakeTransaction(this, storeName, mode);
    this.factory.transactions.push({ mode, storeName, durability: options?.durability });
    this.factory.enqueue(tx);
    return tx;
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeIdbFactory implements IdbFactoryLike {
  /** 数据库的内容，按库名。关闭连接不影响它。 */
  readonly databases = new Map<string, Data>();
  /** 打开数据库时的故障：throw 是 open 本身抛出，error 是打开请求报错，blocked 是被别的连接挡住。 */
  failOpen: 'throw' | 'error' | 'blocked' | null = null;
  /** 容量，所有键和值的字符数合计。 */
  quotaChars = Number.POSITIVE_INFINITY;
  /** 下一次写入时抛出的错误，抛出之后清掉。 */
  failNextWrite: Error | null = null;
  /** 做过的事务，按创建的先后。 */
  readonly transactions: { mode: string; storeName: string; durability: string | undefined }[] = [];
  openCount = 0;
  private readonly queue: FakeTransaction[] = [];
  private running = false;
  readonly connections: FakeConnection[] = [];

  open(name: string, _version?: number): IdbOpenRequestLike {
    this.openCount += 1;
    if (this.failOpen === 'throw') throw domError('SecurityError', 'the operation is insecure');
    const request = new FakeOpenRequest(() => undefined);
    void (async () => {
      await tick();
      if (this.failOpen === 'error') {
        request.error = domError('InvalidStateError', 'a mutation operation was attempted on a database that did not allow mutations');
        request.onerror?.({} as never);
        return;
      }
      if (this.failOpen === 'blocked') {
        request.onblocked?.({} as never);
        return;
      }
      let data = this.databases.get(name);
      const connection = (): FakeConnection => {
        const created = new FakeConnection(this, data as Data);
        this.connections.push(created);
        return created;
      };
      if (data === undefined) {
        data = { stores: new Map() };
        this.databases.set(name, data);
        request.result = connection();
        request.onupgradeneeded?.({} as never);
      } else {
        request.result = connection();
      }
      request.onsuccess?.({} as never);
    })();
    return request;
  }

  /** 模拟浏览器把所有连接关了（例如用户清除了站点数据之前）。 */
  dropConnections(): void {
    for (const c of this.connections) {
      if (c.closed) continue;
      c.closed = true;
      c.onclose?.({} as never);
    }
  }

  enqueue(tx: FakeTransaction): void {
    this.queue.push(tx);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const tx = this.queue.shift() as FakeTransaction;
        await tick();
        await this.execute(tx);
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(tx: FakeTransaction): Promise<void> {
    let done = 0;
    for (;;) {
      while (done < tx.requests.length) {
        const request = tx.requests[done++] as FakeRequest;
        await tick();
        try {
          request.result = request.work();
        } catch (error) {
          request.error = error;
          request.onerror?.({} as never);
          tx.error = error;
          tx.staged = null; // 中止：这个事务里写的东西全部作废
          tx.onabort?.({} as never);
          return;
        }
        request.onsuccess?.({} as never);
      }
      await tick();
      if (done >= tx.requests.length) break;
    }
    if (tx.staged !== null) tx.owner.data.stores.set(tx.storeName, tx.staged);
    tx.oncomplete?.({} as never);
  }

  /** 数据库里一个键的内容，测试直接看。 */
  peek(name: string, storeName: string, key: string): string | null {
    return this.databases.get(name)?.stores.get(storeName)?.get(key) ?? null;
  }

  /** 数据库里全部的键。 */
  peekKeys(name: string, storeName: string): string[] {
    return [...(this.databases.get(name)?.stores.get(storeName)?.keys() ?? [])].sort();
  }

  /** 直接往数据库里放一个键，不经过事务，测试造数据用。 */
  poke(name: string, storeName: string, key: string, value: string): void {
    let data = this.databases.get(name);
    if (data === undefined) {
      data = { stores: new Map() };
      this.databases.set(name, data);
    }
    if (!data.stores.has(storeName)) data.stores.set(storeName, new Map());
    (data.stores.get(storeName) as Map<string, string>).set(key, value);
  }
}

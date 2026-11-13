// 键值存储的接口，以及内存版的实现（测试用）。浏览器的 localStorage 版在 local-storage.ts。
// 存档模块只通过这个接口读写，不知道数据放在哪里，换一种存储时存档模块不需要改。

export type StoreErrorKind =
  | 'quota' // 空间不够
  | 'unavailable' // 存储用不了，例如浏览器禁用了本地存储
  | 'other';

/** 存储层出错。种类写在 kind 里，界面据此提示。 */
export class StoreError extends Error {
  readonly kind: StoreErrorKind;

  constructor(kind: StoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
    this.kind = kind;
  }
}

/**
 * 键值存储。键是不含斜杠的短字符串（字母、数字、点和连字符），值是字符串。
 * 全部方法都返回 Promise：IndexedDB 是异步的，localStorage 本身是同步的，包一层即可。
 *
 * set 必须是原子的：返回之前，读到的要么是写之前的完整旧值，要么是写之后的完整新值，
 * 不能读到写了一半的内容。localStorage 的 setItem 本来就是这样。
 * set 抛出错误时，这个键保持原来的值不变。
 */
export interface KeyValueStore {
  /** 读一个键。不存在时返回 null。 */
  get(key: string): Promise<string | null>;
  /** 写一个键，原子的，见上面的说明。空间不够时抛出 StoreError('quota')。 */
  set(key: string, value: string): Promise<void>;
  /** 删一个键。键不存在时什么也不做。 */
  remove(key: string): Promise<void>;
  /** 列出以 prefix 开头的全部键，按字典序。 */
  keys(prefix?: string): Promise<string[]>;
}

/** 内存版。测试用：数据只在这个对象里，对象没了数据也没了。 */
export class MemoryStore implements KeyValueStore {
  private readonly map: Map<string, string>;

  constructor(initial?: Readonly<Record<string, string>>) {
    this.map = new Map(Object.entries(initial ?? {}));
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }

  keys(prefix = ''): Promise<string[]> {
    return Promise.resolve([...this.map.keys()].filter((key) => key.startsWith(prefix)).sort());
  }

  /** 当前全部内容的副本。测试里用它模拟「关掉再打开」：用同样的内容新建一个 MemoryStore。 */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

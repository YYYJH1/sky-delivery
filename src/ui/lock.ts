// 同一个浏览器里只让一个页面运行和写存档，靠 Web Locks。
// 第一个页面拿到锁并一直持有到页面关闭，别的页面没有拿到就显示提示并停止运行。
// 锁管理器由调用方传入（真实的是 navigator.locks），测试里传一个假的。

/** navigator.locks 里用到的那一个方法。 */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<unknown> | undefined): Promise<unknown>;
}

export const RUN_LOCK_NAME = 'sky-delivery.run';

/**
 * 申请运行权。
 *   granted      拿到了，一直持有到页面关闭
 *   taken        已经有别的页面拿着，这个页面不能运行
 *   unsupported  浏览器没有 Web Locks，或者申请出了错，没有办法限制，按拿到处理
 */
export type RunLock = 'granted' | 'taken' | 'unsupported';

export function acquireRunLock(locks: LockManagerLike | undefined): Promise<RunLock> {
  if (locks === undefined) return Promise.resolve('unsupported');
  return new Promise<RunLock>((resolve) => {
    try {
      locks
        .request(RUN_LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (lock === null) {
            resolve('taken');
            return undefined;
          }
          resolve('granted');
          // 回调返回的承诺一直不结束，锁就一直持有，直到页面关闭
          return new Promise<never>(() => undefined);
        })
        .catch(() => resolve('unsupported'));
    } catch {
      resolve('unsupported');
    }
  });
}

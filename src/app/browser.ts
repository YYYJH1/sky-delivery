// 浏览器适配层：把 requestAnimationFrame、visibilitychange、pagehide 接到运行会话上。
// 这一层很薄，不含游戏逻辑，只负责转发事件并带上两种时间。
// 环境对象由调用方传入，测试里传一个假的。真实的环境由 browserEnv() 从全局取。
// 这个文件是 src/app 里唯一碰 DOM 和系统时钟的地方。
import type { Session } from './session.ts';

export interface BrowserEnv {
  document: {
    readonly visibilityState: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
  window: {
    addEventListener(type: 'pagehide', listener: () => void): void;
    removeEventListener(type: 'pagehide', listener: () => void): void;
  };
  /** 注册下一帧的回调。回调收到的是单调的帧时间戳（毫秒）。 */
  requestAnimationFrame(callback: (timestampMs: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  /** 系统时间，毫秒。 */
  wallNow(): number;
}

export interface Attached {
  /** 取消帧循环，移除事件监听。 */
  detach(): void;
}

/**
 * 真实浏览器的环境，从全局的 window 和 document 取。
 * 经过 globalThis 取，并且只用上面的几个结构类型，这样这个文件在没有 DOM 类型的配置下也能通过类型检查，
 * 测试里可以用假的全局对象替换它们。
 */
export function browserEnv(): BrowserEnv {
  const g = globalThis as unknown as {
    window: BrowserEnv['window'] & Pick<BrowserEnv, 'requestAnimationFrame' | 'cancelAnimationFrame'>;
    document: BrowserEnv['document'];
  };
  return {
    document: g.document,
    window: g.window,
    requestAnimationFrame: (callback) => g.window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => g.window.cancelAnimationFrame(handle),
    wallNow: () => Date.now(),
  };
}

/**
 * 接上浏览器事件：
 *   每个渲染帧调用 session.frame。浏览器在窗口不可见时不会触发渲染帧。
 *   visibilitychange 变为 hidden 调用 session.hide，变回 visible 调用 session.show。
 *   pagehide 调用 session.close。
 * 先登记下一帧，再处理这一帧，这样某一帧里出了错，循环也不会就此停下。
 */
export function attachBrowser(env: BrowserEnv, session: Session): Attached {
  let handle: number | null = null;

  const tick = (timestampMs: number): void => {
    handle = env.requestAnimationFrame(tick);
    session.frame(timestampMs, env.wallNow());
  };
  const onVisibility = (): void => {
    const visibility = env.document.visibilityState;
    if (visibility === 'hidden') session.hide(env.wallNow());
    else if (visibility === 'visible') session.show(env.wallNow());
  };
  const onPageHide = (): void => {
    session.close(env.wallNow());
  };

  env.document.addEventListener('visibilitychange', onVisibility);
  env.window.addEventListener('pagehide', onPageHide);
  handle = env.requestAnimationFrame(tick);

  return {
    detach(): void {
      if (handle !== null) env.cancelAnimationFrame(handle);
      handle = null;
      env.document.removeEventListener('visibilitychange', onVisibility);
      env.window.removeEventListener('pagehide', onPageHide);
    },
  };
}

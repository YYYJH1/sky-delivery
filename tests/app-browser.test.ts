// 浏览器适配层：用假的环境检查事件是不是都接对了。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advance, createState, hashState } from '../src/core/index.ts';
import { attachBrowser, browserEnv, createSession } from '../src/app/index.ts';
import type { BrowserEnv, Session, SessionHost } from '../src/app/index.ts';
import { MemoryStore, loadGame } from '../src/save/index.ts';
import { BUSY, WALL } from './save-helpers.ts';

type Listener = () => void;

/** 假的浏览器环境：手动触发渲染帧和事件。 */
function fakeBrowser() {
  const documentListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();
  const frames = new Map<number, (timestampMs: number) => void>();
  let nextHandle = 1;
  let visibility = 'visible';
  let wall = WALL;
  const cancelled: number[] = [];

  const register = (map: Map<string, Set<Listener>>, type: string, listener: Listener): void => {
    const set = map.get(type) ?? new Set<Listener>();
    set.add(listener);
    map.set(type, set);
  };
  const unregister = (map: Map<string, Set<Listener>>, type: string, listener: Listener): void => {
    map.get(type)?.delete(listener);
  };
  const fire = (map: Map<string, Set<Listener>>, type: string): void => {
    for (const listener of [...(map.get(type) ?? [])]) listener();
  };

  const env: BrowserEnv = {
    document: {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (type, listener) => register(documentListeners, type, listener),
      removeEventListener: (type, listener) => unregister(documentListeners, type, listener),
    },
    window: {
      addEventListener: (type, listener) => register(windowListeners, type, listener),
      removeEventListener: (type, listener) => unregister(windowListeners, type, listener),
    },
    requestAnimationFrame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle) => {
      cancelled.push(handle);
      frames.delete(handle);
    },
    wallNow: () => wall,
  };

  return {
    env,
    /** 浏览器调用已登记的帧回调，时间戳是 timestampMs。没有登记的回调时返回 false。 */
    frame(timestampMs: number): boolean {
      const entry = [...frames.entries()][0];
      if (entry === undefined) return false;
      frames.delete(entry[0]);
      entry[1](timestampMs);
      return true;
    },
    pending: () => frames.size,
    cancelled: () => cancelled,
    setWall(value: number) {
      wall = value;
    },
    setVisibility(value: string) {
      visibility = value;
      fire(documentListeners, 'visibilitychange');
    },
    pagehide() {
      fire(windowListeners, 'pagehide');
    },
    listenerCount: () => [...documentListeners.values(), ...windowListeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

/** 记录调用的假会话。 */
function recordingSession() {
  const calls: string[] = [];
  const session = {
    frame: (nowMs: number, wallMs: number) => {
      calls.push(`frame ${nowMs} ${wallMs}`);
      return { steps: 0, catchUpSteps: 0, alpha: 0, owedSteps: 0 };
    },
    hide: (wallMs: number) => calls.push(`hide ${wallMs}`),
    show: (wallMs: number) => {
      calls.push(`show ${wallMs}`);
      return { kind: 'resumed' as const, hiddenMs: 0, catchUpSteps: 0 };
    },
    close: (wallMs: number) => calls.push(`close ${wallMs}`),
  };
  return { calls, session: session as unknown as Session };
}

describe('浏览器适配层', () => {
  it('每个渲染帧调用 session.frame，带上帧时间戳和当时的系统时间，并登记下一帧', () => {
    const browser = fakeBrowser();
    const { calls, session } = recordingSession();
    attachBrowser(browser.env, session);
    expect(browser.pending()).toBe(1);
    browser.setWall(WALL + 10);
    expect(browser.frame(1000)).toBe(true);
    browser.setWall(WALL + 27);
    browser.frame(1016.7);
    expect(calls).toEqual([`frame 1000 ${WALL + 10}`, `frame 1016.7 ${WALL + 27}`]);
    expect(browser.pending()).toBe(1);
  });

  it('visibilitychange：变为 hidden 调用 hide，变回 visible 调用 show，都带系统时间', () => {
    const browser = fakeBrowser();
    const { calls, session } = recordingSession();
    attachBrowser(browser.env, session);
    browser.setWall(WALL + 500);
    browser.setVisibility('hidden');
    browser.setWall(WALL + 9500);
    browser.setVisibility('visible');
    expect(calls).toEqual([`hide ${WALL + 500}`, `show ${WALL + 9500}`]);
  });

  it('不认识的可见状态不处理', () => {
    const browser = fakeBrowser();
    const { calls, session } = recordingSession();
    attachBrowser(browser.env, session);
    browser.setVisibility('prerender');
    expect(calls).toEqual([]);
  });

  it('pagehide 调用 close，带系统时间', () => {
    const browser = fakeBrowser();
    const { calls, session } = recordingSession();
    attachBrowser(browser.env, session);
    browser.setWall(WALL + 42);
    browser.pagehide();
    expect(calls).toEqual([`close ${WALL + 42}`]);
  });

  it('先登记下一帧再处理这一帧：这一帧里出了错，帧循环也不会停', () => {
    const browser = fakeBrowser();
    let explode = true;
    const session = {
      frame: () => {
        if (explode) throw new Error('boom');
        return { steps: 0, catchUpSteps: 0, alpha: 0, owedSteps: 0 };
      },
    } as unknown as Session;
    attachBrowser(browser.env, session);
    expect(() => browser.frame(0)).toThrow('boom');
    expect(browser.pending()).toBe(1);
    explode = false;
    expect(() => browser.frame(16)).not.toThrow();
  });

  it('detach：取消待执行的帧，移除两个事件监听，之后的事件不再转发', () => {
    const browser = fakeBrowser();
    const { calls, session } = recordingSession();
    const attached = attachBrowser(browser.env, session);
    browser.frame(0);
    expect(browser.listenerCount()).toBe(2);
    attached.detach();
    expect(browser.listenerCount()).toBe(0);
    expect(browser.pending()).toBe(0);
    expect(browser.cancelled()).toHaveLength(1);
    browser.setVisibility('hidden');
    browser.pagehide();
    expect(browser.frame(100)).toBe(false);
    expect(calls).toEqual([`frame 0 ${WALL}`]);
  });

  it('接上真实的会话：窗口不可见 10 秒再回来，之后的帧把缺的步数补上；页面关闭时存档', async () => {
    const browser = fakeBrowser();
    const state = createState(BUSY);
    const store = new MemoryStore();
    const host: SessionHost = { state: () => state, advance: (steps) => advance(state, steps) };
    const session = createSession({ store, host, savedStep: 0 });
    attachBrowser(browser.env, session);

    // 前台 2 秒，每 20 毫秒一帧
    let now = 0;
    for (let i = 0; i <= 100; i++) {
      browser.setWall(WALL + now);
      browser.frame(now);
      now += 20;
    }
    const before = state.step;
    expect(before).toBe(20);

    // 不可见 10 秒：浏览器不触发渲染帧。回来之后一帧一帧补
    browser.setWall(WALL + now);
    browser.setVisibility('hidden');
    browser.setWall(WALL + now + 10_000);
    browser.setVisibility('visible');
    expect(session.loop.owedSteps()).toBe(100);
    now += 10_000;
    for (let i = 0; i < 10; i++) {
      browser.setWall(WALL + now);
      browser.frame(now);
      now += 20;
    }
    expect(session.loop.owedSteps()).toBe(0);
    expect(state.step - before).toBeGreaterThanOrEqual(100);

    browser.setWall(WALL + now);
    browser.pagehide();
    await session.flush();
    const loaded = await loadGame(store, WALL);
    expect(loaded.status).toBe('ok');
    expect(loaded.state && hashState(loaded.state)).toBe(hashState(state));
    expect(loaded.save?.savedAt).toBe(WALL + now);
  });
});

describe('真实环境的入口 browserEnv', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('从全局的 window 和 document 取，系统时间来自 Date.now，帧登记转给 window', () => {
    const requested: number[] = [];
    const cancelled: number[] = [];
    const fakeWindow = {
      requestAnimationFrame: (callback: (t: number) => void) => {
        callback(123);
        return 7;
      },
      cancelAnimationFrame: (handle: number) => cancelled.push(handle),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined };
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);
    vi.useFakeTimers();
    vi.setSystemTime(WALL + 5);
    try {
      const env = browserEnv();
      expect(env.document).toBe(fakeDocument);
      expect(env.window).toBe(fakeWindow);
      expect(env.wallNow()).toBe(WALL + 5);
      expect(env.requestAnimationFrame((t) => requested.push(t))).toBe(7);
      env.cancelAnimationFrame(7);
    } finally {
      vi.useRealTimers();
    }
    expect(requested).toEqual([123]);
    expect(cancelled).toEqual([7]);
  });
});

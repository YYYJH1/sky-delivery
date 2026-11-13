// 浏览器适配层：从全局的 window、document、AudioContext、localStorage 取出播放器要的环境。
// 经过 globalThis 取，并且只用 player.ts 里的结构类型，这样这个文件在没有 DOM 类型的配置下也能通过类型检查，
// 测试里可以用假的全局对象替换它们。这个文件是 src/audio 里唯一碰全局对象和系统时钟的地方。
import { createAudioPlayer } from './player.ts';
import type { AudioContextLike, AudioPlayer, PlayerEnv } from './player.ts';
import type { StorageLike } from './settings.ts';

type ContextConstructor = new (options?: { latencyHint?: string }) => AudioContextLike;

/** 真实浏览器的环境。读 localStorage 可能抛错（隐私模式、禁用了存储），按没有处理。 */
export function browserAudioEnv(): PlayerEnv {
  const g = globalThis as unknown as {
    window: PlayerEnv['window'] & { AudioContext?: ContextConstructor; webkitAudioContext?: ContextConstructor; localStorage?: StorageLike };
    document: PlayerEnv['document'];
    performance: { now(): number };
    setTimeout(callback: () => void, ms: number): number;
    clearTimeout(handle: number): void;
  };
  return {
    createContext(): AudioContextLike | null {
      const Context = g.window.AudioContext ?? g.window.webkitAudioContext;
      if (Context === undefined) return null;
      try {
        return new Context({ latencyHint: 'balanced' });
      } catch {
        // 个别浏览器不认选项，不带选项再试一次
        try {
          return new Context();
        } catch {
          return null;
        }
      }
    },
    get storage(): StorageLike | null {
      try {
        return g.window.localStorage ?? null;
      } catch {
        return null;
      }
    },
    now: () => g.performance.now(),
    document: g.document,
    window: g.window,
    setTimeout: (callback, ms) => g.setTimeout(callback, ms),
    clearTimeout: (handle) => g.clearTimeout(handle),
  };
}

/** 用真实浏览器的环境创建播放器。 */
export function createBrowserAudio(): AudioPlayer {
  return createAudioPlayer(browserAudioEnv());
}

// 限频。触发函数只管发生了什么，要不要真的出声由这里按真实时间（毫秒）决定，所以游戏高速运行时声音也不会连成一片。
// 规则：
//   同一个声音两次播放之间至少隔 gapMs 毫秒。
//   常有的四种声音（起飞、准时送达、大单送达、退单）共用一个预算：任何 BUSY_WINDOW_MS 毫秒里最多放 BUSY_MAX 个，
//   几十架飞机同时起飞，只响一次，也不会把送达的提示音挤掉太多。
//   很少出现的声音（高峰小结、高峰开始、升星）和玩家操作带来的声音只受自己的间隔限制，不占预算。
// 被拒掉的声音直接丢掉，不排队补播。
import { BUSY_MAX, BUSY_WINDOW_MS, SOUND_INFO } from './catalog.ts';
import type { SoundId } from './catalog.ts';

export interface Limiter {
  /** 在 nowMs 时刻，候选的声音里哪些可以播。按优先级先后处理，返回可以播的那些，同时记账。 */
  admit(candidates: readonly SoundId[], nowMs: number): SoundId[];
  /** 清掉全部记录。 */
  reset(): void;
}

export function createLimiter(): Limiter {
  const lastAt = new Map<SoundId, number>();
  let busy: number[] = [];
  return {
    admit(candidates: readonly SoundId[], nowMs: number): SoundId[] {
      // 时钟倒退时，比现在还晚的记录作废
      busy = busy.filter((at) => at <= nowMs && nowMs - at < BUSY_WINDOW_MS);
      const admitted: SoundId[] = [];
      const ordered = [...candidates].sort((a, b) => SOUND_INFO[b].priority - SOUND_INFO[a].priority);
      for (const id of ordered) {
        const info = SOUND_INFO[id];
        const last = lastAt.get(id);
        if (last !== undefined && nowMs >= last && nowMs - last < info.gapMs) continue;
        if (info.kind === 'frequent') {
          if (busy.length >= BUSY_MAX) continue;
          busy.push(nowMs);
        }
        lastAt.set(id, nowMs);
        admitted.push(id);
      }
      return admitted;
    },
    reset(): void {
      lastAt.clear();
      busy = [];
    },
  };
}

// 游戏里新出现的小结、日结和结局：界面记下已经见过的数量，每次推进之后比一下，多出来的就是新的。
// 读档的时候把已有的算作见过，不会一打开页面就把旧的小结和日结再弹一遍。
// 纯函数，不碰 DOM 和状态。
import type { SimState } from '../core/index.ts';

/** 界面已经见过的数量。 */
export interface Seen {
  readonly peaks: number;
  readonly days: number;
  readonly ending: boolean;
}

/** 新出现的数量。 */
export interface Fresh {
  readonly peaks: number;
  readonly days: number;
  readonly ending: boolean;
}

/** 现在状态里有的，当作都见过。 */
export function seenOf(state: SimState): Seen {
  const campaign = state.campaign;
  return { peaks: campaign?.peaks.length ?? 0, days: campaign?.days.length ?? 0, ending: campaign !== null && campaign.ending !== null };
}

/** 比已经见过的多出来的。 */
export function freshSince(seen: Seen, state: SimState): Fresh {
  const now = seenOf(state);
  return { peaks: Math.max(0, now.peaks - seen.peaks), days: Math.max(0, now.days - seen.days), ending: now.ending && !seen.ending };
}

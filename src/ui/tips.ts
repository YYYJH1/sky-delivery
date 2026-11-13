// 便签和结局的文字。
// 核心把便签放进 campaign.tips（编号、出现的步、参数），界面读出还没读的，同一时刻只贴最早的一张，其余排队。
// 点击便签发 readTip 命令，核心标成已读，下一张才出现。
// 纯函数，不碰 DOM 和状态。
import { STR, fmt, stationNumeral } from '../content/strings.zh.ts';
import { unreadTips } from '../core/index.ts';
import type { SimState, TipId, TipRecord } from '../core/index.ts';

export interface TipView {
  readonly id: TipId;
  readonly text: string;
  /** 排在它后面、还没读的便签有几张。 */
  readonly queued: number;
}

/** 一条便签的文字。「起降口忙不过来」带站号，站号是核心里的编号加一，写成汉字。 */
export function tipText(tip: TipRecord): string {
  switch (tip.id) {
    case 'firstOrder':
      return STR.tips.firstOrder;
    case 'autoDispatchOn':
      return STR.tips.autoDispatchOn;
    case 'firstRedOrder':
      return STR.tips.firstRedOrder;
    case 'boardReady':
      return STR.tips.boardReady;
    case 'canAddBay':
      return STR.tips.canAddBay;
    case 'gateBusy':
      return fmt(STR.tips.gateBusy, { station: stationNumeral((tip.station ?? 0) + 1) });
    case 'openOffice':
      return STR.tips.openOffice;
  }
}

/** 现在贴出来的那一张便签：还没读的里面出现得最早的。没有时为 null。 */
export function currentTip(state: SimState): TipView | null {
  const unread = unreadTips(state);
  const first = unread[0];
  return first === undefined ? null : { id: first.id, text: tipText(first), queued: unread.length - 1 };
}

/** 结局的文字按句分行：每个句号收一行，免得一句话在中间折成两行。句号写成转义，代码里不出现中文标点。 */
export function endingLines(text: string): string[] {
  return text.split(/(?<=\u3002)/u).filter((line) => line !== '');
}

/** 结局的文字，还没到结局时为 null。 */
export function endingText(state: SimState): string | null {
  const ending = state.campaign?.ending ?? null;
  return ending === null ? null : fmt(STR.system.ending, { orders: ending.orders, days: ending.days });
}

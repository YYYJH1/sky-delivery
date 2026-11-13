// 一局游戏的推进和玩家的命令，加上小结的对照用的副本。
// 每场高峰的第一步之前，复制一份状态当副本，副本的「调度策略」和「协同策略」是开局的卡。
// 之后主状态每走一步副本也走一步，玩家的建站、购买、退回命令在同一步也做给副本。
// 小结时刻之前副本停在同一步，用它算出这一场按开局的卡的结果，补进主状态刚生成的小结记录。
// 副本由这里持有，不属于游戏状态，不进状态哈希和存档。读档之后、或者主状态被外部改过之后，这一场没有副本。
// 复制状态用 structuredClone，副本里要做的事都是 core/campaign/shadow.ts 里的纯函数。
// 界面和命令行工具推进状态、执行命令都经过这里，游戏的结果不受副本影响。
import { applyCommand, attachBaseline, dayOf, finishShadow, forwardToShadow, openShadow, peakStartingAt, step, summaryStep } from '../core/index.ts';
import type { BaselineDraft, Command, CommandResult, PeakName, Shadow, SimState } from '../core/index.ts';

export interface PlayOptions {
  /**
   * 每场高峰在小结时刻副本算出结果之后调用，早于补进记录。draft 为 null 表示这一场没有副本，或者副本和主状态对不上。
   * 整场用的是开局的卡时 draft 不是 null，但不会补进记录。给测试和统计工具看副本的结果用，不得修改状态。
   */
  onDraft?(day: number, peak: PeakName, draft: BaselineDraft | null): void;
}

export interface Play {
  /** 主状态推进一步。高峰里副本同步推进一步，小结生成之后补进对照。 */
  step(): void;
  /** 执行玩家的命令。成功的建站、购买、退回、开通片区在同一步也做给副本。 */
  command(command: Command): CommandResult;
  /** 丢掉副本：主状态被外部改过（调试、读档之后接着玩）。这一场没有对照。 */
  drop(): void;
  /** 现在有没有副本。 */
  shadowActive(): boolean;
}

export function createPlay(state: SimState, options: PlayOptions = {}): Play {
  let shadow: Shadow | null = null;

  return {
    step(): void {
      if (state.campaign === null) {
        step(state);
        return;
      }
      const starting = peakStartingAt(state.step);
      if (starting !== null) shadow = openShadow(structuredClone(state), dayOf(state.step), starting);
      let draft: BaselineDraft | null = null;
      let finished: { day: number; peak: PeakName } | null = null;
      if (shadow !== null && state.step >= summaryStep(shadow.day, shadow.peak)) {
        // 主状态在这一步生成小结。副本停在同一步时才算得出结果，错过了就没有对照
        if (state.step === summaryStep(shadow.day, shadow.peak)) {
          draft = finishShadow(shadow);
          finished = { day: shadow.day, peak: shadow.peak };
        }
        shadow = null;
      }
      step(state);
      if (shadow !== null) step(shadow.state);
      if (finished !== null) {
        options.onDraft?.(finished.day, finished.peak, draft);
        if (draft !== null) attachBaseline(state, draft);
      }
    },

    command(command: Command): CommandResult {
      const result = applyCommand(state, command);
      if (result.ok && shadow !== null) forwardToShadow(shadow, state, command);
      return result;
    },

    drop(): void {
      shadow = null;
    },

    shadowActive(): boolean {
      return shadow !== null;
    },
  };
}

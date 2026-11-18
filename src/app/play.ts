// 一局游戏的推进和玩家的命令，加上两种对照用的副本。
// 小结的对照：每场高峰的第一步之前，复制一份状态当副本，副本的「调度策略」和「协同策略」是开局的卡。
// 之后主状态每走一步副本也走一步，玩家的建站、购买、退回命令在同一步也做给副本。
// 小结时刻之前副本停在同一步，用它算出这一场按开局的卡的结果，补进主状态刚生成的小结记录。
// 效果记录的对照：玩家购买起降口升级、双层货箱、就近降落时，复制一份尚未购买的状态当副本，之后与主状态逐步同推，
// 玩家的其他命令也做给它，小结生成之后把副本这一场的指标记进对应的效果跟踪（twins.ts）。
// 副本由这里持有，不属于游戏状态，不进状态哈希和存档。读档之后、或者主状态被外部改过之后，这一场没有副本。
// 复制状态用 structuredClone，副本里要做的事都是核心里的纯函数（core/campaign/shadow.ts、effects.ts）。
// 界面和命令行工具推进状态、执行命令都经过这里，游戏的结果不受副本影响。
// 两种副本都只读自己的小结记录里的几个数（准时、超时、取消、收入、各片区的数、等飞机的秒数、起降排队、每趟单数、回站飞行），推进它们用轻量的一步
// （核心的 stepLight）：不算派单里「提前派出」的比较名单，这些数与用 step 推进时逐位相同。主状态永远用 step。
import { applyCommand, attachBaseline, dayOf, finishShadow, forwardToShadow, openShadow, peakStartingAt, step, stepLight, summaryStep } from '../core/index.ts';
import type { BaselineDraft, Command, CommandResult, EffectWatch, PeakName, Shadow, SimState } from '../core/index.ts';
import { createTwins } from './twins.ts';

export interface PlayOptions {
  /**
   * 每场高峰在小结时刻副本算出结果之后调用，早于补进记录。draft 为 null 表示这一场没有副本，或者副本和主状态对不上。
   * 整场用的是开局的卡时 draft 不是 null，但不会补进记录。给测试和统计工具看副本的结果用，不得修改状态。
   */
  onDraft?(day: number, peak: PeakName, draft: BaselineDraft | null): void;
  /**
   * 要不要给效果记录开「不购买」的副本，缺省要。关掉之后购买照常记效果跟踪，但没有副本的数，日结里不写效果行，状态里也没有副本记下的数。
   * 只要小结对照的统计工具关掉它，免得每笔购买多推几份状态。
   */
  twins?: boolean;
  /** 两种副本是否用轻量的一步推进（stepLight），缺省是。副本读到的数与不轻量时逐位相同，false 只给测试和耗时对照用。主状态不受它影响 */
  light?: boolean;
}

export interface Play {
  /** 主状态推进一步。高峰里小结的副本同步推进一步，小结生成之后补进对照。不购买的副本也同步推进一步，小结生成之后记下它这一场的指标。 */
  step(): void;
  /**
   * 执行玩家的命令。成功的建站、购买、退回、开通片区在同一步也做给小结的副本。
   * 起降口升级、双层货箱、就近降落购买之前复制一份状态，成功之后开成不购买的副本。其他命令成功之后也做给已有的不购买的副本。
   */
  command(command: Command): CommandResult;
  /** 丢掉全部副本：主状态被外部改过（调试、读档之后接着玩）。这一场没有对照，效果跟踪里已经记下的数留着，之后不再记。 */
  drop(): void;
  /** 现在有没有小结的副本。 */
  shadowActive(): boolean;
  /** 现在有不购买的副本的效果跟踪，按购买的先后。 */
  twinWatches(): readonly EffectWatch[];
}

export function createPlay(state: SimState, options: PlayOptions = {}): Play {
  let shadow: Shadow | null = null;
  const light = options.light !== false;
  const twins = createTwins({ light });
  const useTwins = options.twins !== false;
  const advanceShadow = light ? stepLight : step;

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
      const peaksBefore = state.campaign.peaks.length;
      if (useTwins) twins.beforeStep(state);
      step(state);
      if (shadow !== null) advanceShadow(shadow.state);
      if (useTwins) twins.afterStep(state, peaksBefore);
      if (finished !== null) {
        options.onDraft?.(finished.day, finished.peak, draft);
        if (draft !== null) attachBaseline(state, draft);
      }
    },

    command(command: Command): CommandResult {
      // 会记效果跟踪的购买，要在主状态执行之前复制，副本里才没有这次购买
      const copy = useTwins ? twins.copyBefore(state, command) : null;
      const result = applyCommand(state, command);
      if (result.ok && shadow !== null) forwardToShadow(shadow, state, command);
      if (result.ok && useTwins) twins.afterCommand(state, command, copy);
      return result;
    },

    drop(): void {
      shadow = null;
      twins.drop();
    },

    shadowActive(): boolean {
      return shadow !== null;
    },

    twinWatches(): readonly EffectWatch[] {
      return twins.watches();
    },
  };
}

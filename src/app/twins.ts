// 效果记录里「不购买时」的副本。
// 起降口升级、双层货箱、就近降落三种购买成功之前，复制一份尚未购买的状态，作为这次购买的副本。
// 之后主状态每走一步，副本也走一步。玩家的其他命令在主状态里成功之后，也做给每个还在的副本。
// 主状态和副本在同一步生成同一场高峰的小结之后，用副本的小结记录算出这一场的指标，记进主状态里对应的效果跟踪（核心的 recordTwin）。
// 日结时核心从跟踪里取副本在同一场的数，写成效果行里「不购买时」的数。
// 副本由这里持有，不属于游戏状态，不进状态哈希和存档，副本里的模拟不影响主状态。读档之后副本不在，这些跟踪不再记副本的数，也就不再写出效果行。
// 与小结的对照（shadow.ts）一样，复制状态用 structuredClone，在副本上重做命令用核心的 replayOnCopy。
//
// 副本是这一局里没有这次购买的世界：
// - 引起这个副本的那次购买本身不做给它。
// - 没有这次购买就下不出来的命令也不做给它，副本里下不出来不算副本和主状态对不上：
//   就近降落的开关不做给就近降落的副本，合单策略一栏的换卡不做给双层货箱的副本（这一栏随双层货箱开放），
//   同一座站更高一级的起降口升级不做给低一级的副本（没有低一级就升不到高一级）。
// - 其余命令在副本里失败了，副本就和主状态对不上了，这个副本作废：丢掉，已经记下的数留在跟踪里，之后不再记。点击订单插队是例外，
//   这张订单在副本里可能已经派出，失败了不算对不上。
// 同时最多 MAX_TWINS 个，超过时丢掉最早的。跟踪被核心删掉（写满行数或过期）之后，对应的副本也丢掉。
// 副本只读起降排队、每趟单数、回站飞行占比（取自小结记录里的各站一行、准时和超时的单数、机队时间构成），所以推进它用轻量的一步（核心的 stepLight），
// 不算派单里「提前派出」的比较名单。这些指标与用 step 推进时逐位相同，副本里只有「提前派出」的记录不再更新。createTwins 的 light 选项设为 false 时改用 step。
import { peakRecord, quoteCommand, recordTwin, replayOnCopy, step, stepLight } from '../core/index.ts';
import type { Command, CommandType, EffectWatch, SimState } from '../core/index.ts';

/** 同时存在的副本最多这么多个。 */
export const MAX_TWINS = 4;

/** 购买成功时核心会记效果跟踪的三种命令。 */
const TRACKED: ReadonlySet<CommandType> = new Set<CommandType>(['upgradeGate', 'buyDoubleBox', 'buyNearestLanding']);

/**
 * 一条玩家的命令要不要做给某个副本，做给它时是哪一条。返回 null 表示不做给它。
 * 不做的有：便签标记已读和使用推演（不改变模拟），以及没有这项改装就下不出来的命令（见文件开头）。
 * 合单策略一栏的换卡不做给双层货箱的副本，同一条命令里别的栏照常做。
 * 命令的种类逐个列在 switch 里，核心以后加了新的命令，这里要先决定做不做给副本，否则编译不过。
 */
export function twinCommand(watch: Pick<EffectWatch, 'kind' | 'station'>, command: Command): Command | null {
  switch (command.type) {
    case 'readTip':
    case 'useForecast':
      return null;
    case 'upgradeGate':
      return watch.kind === 'gate' && watch.station === command.station ? null : command;
    case 'setNearestLanding':
      return watch.kind === 'nearest' ? null : command;
    case 'setRules': {
      if (watch.kind !== 'doubleBox' || command.rules.pool === undefined) return command;
      const rest = { ...command.rules };
      delete rest.pool;
      return Object.keys(rest).length === 0 ? null : { ...command, rules: rest };
    }
    case 'buildStation':
    case 'buyDrone':
    case 'buyBay':
    case 'buyDoubleBox':
    case 'buyNearestLanding':
    case 'openDistrict':
    case 'prioritizeOrder':
    case 'refundDrone':
    case 'refundBay':
    case 'refundStation':
      return command;
  }
}

/** 一个副本：对应主状态里的一条效果跟踪。 */
interface Twin {
  /** 主状态里的那条跟踪（同一个对象）。 */
  readonly watch: EffectWatch;
  /** 不购买的一份：购买之前复制，之后与主状态逐步同推。 */
  readonly state: SimState;
}

/** 购买之前复制出来的状态，购买成功之后交给 afterCommand 开成副本。 */
export interface TwinCopy {
  readonly state: SimState;
  /** 购买之前主状态里有几条效果跟踪：购买成功之后多出来的最后一条就是这次购买的。 */
  readonly watches: number;
}

export interface TwinSet {
  /**
   * 玩家的命令执行之前调用。这是一次会记效果跟踪的购买，并且现在能成功时，复制一份尚未购买的状态。其他命令返回 null。
   * 问价不改状态。资金不足的购买成功不了，不复制。
   */
  copyBefore(main: SimState, command: Command): TwinCopy | null;
  /**
   * 命令在主状态里成功之后调用：先把它做给已有的副本，在副本里失败了就丢掉那个副本，再用 copyBefore 的结果给这次购买开一个新副本。
   * 多于 MAX_TWINS 个时丢掉最早的。购买前没有数的跟踪（购买之后的第一次日结就会删掉，写不出一行）不开副本。
   */
  afterCommand(main: SimState, command: Command, copy: TwinCopy | null): void;
  /** 主状态推进一步之前调用：丢掉和主状态不在同一步的副本（主状态被会话层之外的代码推进过）。 */
  beforeStep(main: SimState): void;
  /**
   * 主状态推进了一步之后调用，peaksBefore 是这一步之前主状态里的小结记录数：
   * 丢掉跟踪已经不在的副本，其余的副本各走一步，主状态这一步生成了小结的话，把副本同一场的指标记进对应的跟踪。
   */
  afterStep(main: SimState, peaksBefore: number): void;
  /** 丢掉全部副本。已经记下的数留在跟踪里。 */
  drop(): void;
  /** 现在有副本的效果跟踪，按购买的先后。 */
  watches(): readonly EffectWatch[];
}

export interface TwinsOptions {
  /** 副本用轻量的一步推进，缺省是。false 时与主状态一样用 step，测试对照用 */
  light?: boolean;
}

export function createTwins(options: TwinsOptions = {}): TwinSet {
  let twins: Twin[] = [];
  const advance = options.light === false ? step : stepLight;

  /** 跟踪被核心删掉（写满行数或过期，或者状态被外部改过）的副本不再需要。 */
  function prune(main: SimState): void {
    if (twins.length === 0) return; // 没有副本的时候每一步都走到这里，什么也不做
    const live = new Set<EffectWatch>(main.campaign?.effectWatches ?? []);
    twins = twins.filter((twin) => live.has(twin.watch));
  }

  /** 把命令做给一个副本，返回这个副本还能不能用。 */
  function forward(twin: Twin, main: SimState, command: Command): boolean {
    const mine = twinCommand(twin.watch, command);
    if (mine === null || replayOnCopy(twin.state, main, mine)) return true;
    // 点击订单插队：这张订单在副本里可能已经派出，失败了不算副本和主状态对不上
    return mine.type === 'prioritizeOrder';
  }

  return {
    copyBefore(main: SimState, command: Command): TwinCopy | null {
      const campaign = main.campaign;
      if (campaign === null || !TRACKED.has(command.type) || !quoteCommand(main, command).ok) return null;
      return { state: structuredClone(main), watches: campaign.effectWatches.length };
    },

    afterCommand(main: SimState, command: Command, copy: TwinCopy | null): void {
      prune(main);
      twins = twins.filter((twin) => forward(twin, main, command));
      const watches = main.campaign?.effectWatches ?? [];
      if (copy === null || watches.length !== copy.watches + 1) return;
      const watch = watches[watches.length - 1] as EffectWatch;
      if (watch.before === null) return;
      twins.push({ watch, state: copy.state });
      if (twins.length > MAX_TWINS) twins = twins.slice(twins.length - MAX_TWINS);
    },

    beforeStep(main: SimState): void {
      twins = twins.filter((twin) => twin.state.step === main.step);
    },

    afterStep(main: SimState, peaksBefore: number): void {
      prune(main);
      for (const twin of twins) advance(twin.state);
      const peaks = main.campaign?.peaks ?? [];
      for (let i = peaksBefore; i < peaks.length; i++) {
        const record = peaks[i];
        if (record === undefined) continue;
        for (const twin of twins) {
          const own = peakRecord(twin.state, record.day, record.peak);
          if (own !== null) recordTwin(twin.watch, own);
        }
      }
    },

    drop(): void {
      twins = [];
    },

    watches(): readonly EffectWatch[] {
      return twins.map((twin) => twin.watch);
    },
  };
}

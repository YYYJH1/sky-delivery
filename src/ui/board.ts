// 调度台（右侧白板）的数据：三栏各有哪几张卡，哪张选中，哪张没开放，收起时的几行字，两套策略的页签，底部的小票条。
// 文字全部取自词表，规则编号和开放条件取自核心。点一张卡发的命令只带这一栏，见 ruleCommand。
// 每一栏列哪些卡由内容表 rules_v1 决定，调度台里没有「单独配送」：词表里它的文字还在，沙盒模式用。
// 纯函数，不碰 DOM 和状态。
import { CAMPAIGN_RULES_V1 } from '../content/rules_v1.ts';
import { UNLOCKS_V1 } from '../content/unlocks_v1.ts';
import { RULE_IDS, STR, districtName, fmt, peakName, ruleCard, ruleName } from '../content/strings.zh.ts';
import type { DistrictIndex, RuleColumnKey, RuleId } from '../content/strings.zh.ts';
import { isUnlocked, lastPeakTicket, ruleLock, ruleSetInForce } from '../core/index.ts';
import type { Command, RuleSet, SimState, UnlockKey } from '../core/index.ts';
import { wholeMoney } from './money.ts';
import type { PeakKey } from './schedule.ts';

/** 三栏在白板上的顺序。 */
export const COLUMN_ORDER: readonly RuleColumnKey[] = ['select', 'pool', 'zone'];

/** 三张「{片区}优先」，下标是片区编号。界面上它们合成一张卡，点了之后选片区。 */
export const PRIO_RULES: readonly RuleId[] = ['prioOld', 'prioOffice', 'prioCampus'];

/** 合成的那一张卡在界面里的键。 */
export const PRIO_KEY = 'prio';

export function isRuleId(id: string): id is RuleId {
  return (RULE_IDS as readonly string[]).includes(id);
}

/** 一栏里玩家能选的卡，按内容表 rules_v1 的顺序。 */
export function offeredRules(column: RuleColumnKey): RuleId[] {
  return CAMPAIGN_RULES_V1[column].filter(isRuleId);
}

/** 这一栏有没有这张卡。 */
function isOffered(column: RuleColumnKey, id: string): boolean {
  return CAMPAIGN_RULES_V1[column].includes(id);
}

function prioDistrictOf(id: string): number | null {
  const k = PRIO_RULES.indexOf(id as RuleId);
  return k < 0 ? null : k;
}

export interface BoardCard {
  /** 在界面里的键：规则编号，三张「{片区}优先」合成的那一张是 prio。 */
  readonly key: string;
  readonly column: RuleColumnKey;
  readonly name: string;
  /** 卡名下的一句说明。 */
  readonly desc: string;
  /** 代价，悬停时显示。 */
  readonly cost: string;
  readonly selected: boolean;
  readonly locked: boolean;
  /** 没开放时写的条件，开放了为 null。 */
  readonly lockText: string | null;
  /** 点了之后要先选片区，不直接换卡。 */
  readonly pick: boolean;
  /** 点了换成哪张卡。要选片区的卡为 null，没开放的卡也是 null。 */
  readonly rule: RuleId | null;
  /** 没开放的条件很长，这张卡占满一行。 */
  readonly wide: boolean;
  /** 在两列磁贴里排在左列还是右列。占满一行的卡在左列。悬停的代价按它放在白板左边。 */
  readonly col: 0 | 1;
}

export interface BoardColumn {
  readonly key: RuleColumnKey;
  /** 栏名，也就是这一栏回答的问题。 */
  readonly title: string;
  /** 整栏没开放：只写条件，不列卡。 */
  readonly locked: boolean;
  readonly lockText: string | null;
  readonly cards: readonly BoardCard[];
}

export interface PickerChoice {
  readonly district: number;
  readonly name: string;
  readonly rule: RuleId;
  readonly selected: boolean;
}

export interface BoardTab {
  readonly peak: PeakKey;
  readonly name: string;
  readonly on: boolean;
}

export interface BoardView {
  readonly title: string;
  /** 收起时标题下的小字，说的是现在生效的那一套。 */
  readonly sub: string;
  /** 收起时列出的卡名：现在生效的那一套里，已经开放的栏选中的卡。 */
  readonly picked: readonly string[];
  /** 分成两套之后才有页签。 */
  readonly tabs: readonly BoardTab[] | null;
  /** 展开时显示的是哪一套，没分成两套时为 null。发命令时作为 peak。 */
  readonly shownPeak: PeakKey | null;
  readonly columns: readonly BoardColumn[];
  /** 选「{片区}优先」时可以选的片区：已经开通的。 */
  readonly picker: readonly PickerChoice[];
  readonly pickPrompt: string;
  /** 白板底部的小票条。 */
  readonly ticket: string;
}

/** 没开放的卡和栏，各写哪一条条件。 */
function lockText(key: UnlockKey): string | null {
  switch (key) {
    case 'poolColumn':
      return STR.board.locked.pool;
    case 'zoneColumn':
      return STR.board.locked.zone;
    case 'prioDistrict':
      return STR.board.locked.prioDistrict;
    case 'roundtrip':
      return STR.board.locked.roundtrip;
    default:
      return null;
  }
}

/** 白板上现在看的那一套策略：分成两套之后取页签对应的那一套，没分开就是 state.rules。 */
function setShown(state: SimState, peak: PeakKey | null): RuleSet {
  const sets = state.campaign?.ruleSets ?? null;
  return sets === null || peak === null ? state.rules : sets[peak];
}

function cardOf(state: SimState, column: RuleColumnKey, id: RuleId, selectedId: string): BoardCard {
  const text = ruleCard(id);
  const lock = ruleLock(state, column, id);
  const locked = lock !== null;
  return {
    key: id,
    column,
    name: text.name,
    desc: text.desc,
    cost: text.cost,
    selected: !locked && selectedId === id,
    locked,
    lockText: lock === null ? null : lockText(lock),
    pick: false,
    rule: locked ? null : id,
    wide: false,
    col: 0,
  };
}

/** 三张「{片区}优先」合成的那一张。选中了其中一张时，名称是那个片区的，没选中时用默认的片区（写字楼区）。 */
function prioCardOf(state: SimState, selectedId: string): BoardCard {
  const chosen = prioDistrictOf(selectedId);
  const shownRule = PRIO_RULES[chosen ?? UNLOCKS_V1.prioDistrict] as RuleId;
  const text = ruleCard(shownRule);
  const lock = ruleLock(state, 'select', shownRule);
  const locked = lock !== null;
  return {
    key: PRIO_KEY,
    column: 'select',
    name: text.name,
    desc: text.desc,
    cost: text.cost,
    selected: !locked && chosen !== null,
    locked,
    lockText: lock === null ? null : lockText(lock),
    pick: !locked,
    rule: null,
    wide: false,
    col: 0,
  };
}

/** 没开放的条件超过这么多个字，卡占满一行，免得在半栏宽的磁贴下面折成好几行。 */
export const WIDE_LOCK_CHARS = 14;

/** 一栏的卡排成两列：一行两张，没开放的条件很长的卡占满一行。算出每张卡的列。 */
export function layoutCards(cards: readonly BoardCard[]): BoardCard[] {
  let next: 0 | 1 = 0;
  return cards.map((card) => {
    if (card.lockText !== null && card.lockText.length > WIDE_LOCK_CHARS) {
      next = 0;
      return { ...card, wide: true, col: 0 };
    }
    const placed: BoardCard = { ...card, wide: false, col: next };
    next = next === 0 ? 1 : 0;
    return placed;
  });
}

/** 「合单策略」和「协同策略」整栏一起开放，整栏锁着时返回锁它的那一项。「调度策略」的卡各有各的条件，没有整栏的锁。 */
function columnLockOf(state: SimState, column: RuleColumnKey): UnlockKey | null {
  const first = offeredRules(column)[0];
  return column === 'select' || first === undefined ? null : ruleLock(state, column, first);
}

function columnOf(state: SimState, column: RuleColumnKey, selectedId: string): BoardColumn {
  const title = STR.board.columns[column];
  // 没开放时整栏只写条件
  const columnLock = columnLockOf(state, column);
  if (columnLock !== null) return { key: column, title, locked: true, lockText: lockText(columnLock), cards: [] };
  const cards: BoardCard[] = [];
  let prioDone = false;
  for (const id of offeredRules(column)) {
    if (column === 'select' && PRIO_RULES.includes(id)) {
      if (!prioDone) cards.push(prioCardOf(state, selectedId));
      prioDone = true;
      continue;
    }
    cards.push(cardOf(state, column, id, selectedId));
  }
  return { key: column, title, locked: false, lockText: null, cards: layoutCards(cards) };
}

/** 选片区时的候选：已经开通的片区，每个对应一张「{片区}优先」。 */
export function pickerChoices(state: SimState, selectedId: string): PickerChoice[] {
  const out: PickerChoice[] = [];
  state.campaign?.districts.forEach((d, k) => {
    const rule = PRIO_RULES[k];
    if (!d.open || rule === undefined) return;
    out.push({ district: k, name: districtName(k as DistrictIndex), rule, selected: selectedId === rule });
  });
  return out;
}

/** 白板底部的小票条：前一天同一场高峰的准时率、退单数和进账，没有记录时写没有。进账向下取整。 */
export function ticketLine(state: SimState, peak: PeakKey): string {
  const t = lastPeakTicket(state, peak);
  if (t === null) return STR.board.lastPeakNone;
  return fmt(STR.board.lastPeak, {
    peak: peakName(peak),
    onTime: t.onTimePct ?? 0,
    cancelled: t.cancelled,
    revenue: wholeMoney(t.revenue),
  });
}

/**
 * 调度台现在的样子。「调度策略」一栏开放之前没有白板，返回 null。
 * boardPeak 是展开后页签选的那一套，null 表示跟着现在生效的那一套。
 */
export function computeBoard(state: SimState, boardPeak: PeakKey | null): BoardView | null {
  const campaign = state.campaign;
  if (campaign === null || !isUnlocked(state, 'selectColumn')) return null;
  const split = campaign.ruleSets !== null;
  const inForce = ruleSetInForce(state);
  const shownPeak: PeakKey | null = split ? (boardPeak ?? inForce) : null;
  const shown = setShown(state, shownPeak);
  const columns = COLUMN_ORDER.map((column) => columnOf(state, column, shown[column]));

  // 收起时列出现在生效的那一套，只列已经开放的栏，也只列调度台里有的卡：
  // 没买双层货箱时核心内部按单独配送运行，这一栏没开放，不写它
  const active = setShown(state, split ? inForce : null);
  const picked: string[] = [];
  for (const column of COLUMN_ORDER) {
    if (columnLockOf(state, column) !== null) continue;
    const id = active[column];
    if (isRuleId(id) && isOffered(column, id)) picked.push(ruleName(id));
  }
  const sub = !split ? STR.board.collapsed.all : inForce === 'noon' ? STR.board.collapsed.noon : STR.board.collapsed.evening;
  const tabs: BoardTab[] | null = split
    ? (['noon', 'evening'] as const).map((peak) => ({ peak, name: peakName(peak), on: peak === shownPeak }))
    : null;
  return {
    title: STR.board.title,
    sub,
    picked,
    tabs,
    shownPeak,
    columns,
    picker: pickerChoices(state, shown.select),
    pickPrompt: STR.board.pickDistrict,
    ticket: ticketLine(state, shownPeak ?? inForce),
  };
}

/**
 * 点一张卡发的命令。只放要换的这一栏：三栏整套发回去时，只要有一栏没开放，整条命令都会失败。
 * 分成两套之后带上 peak，改的是页签对应的那一套，没分成两套时不能带，核心会拒绝。
 */
export function ruleCommand(column: RuleColumnKey, rule: RuleId, peak: PeakKey | null): Command {
  const rules: Partial<RuleSet> = { [column]: rule };
  return peak === null ? { type: 'setRules', rules } : { type: 'setRules', rules, peak };
}

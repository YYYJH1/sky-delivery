// 界面自己的状态：选中了哪座站，是不是在选屋顶，改装、菜单、调度台开着没有，高峰小结和日结小票处在哪一步，提示，窗口的缩放。
// 这些都不是游戏状态，不进存档。用 signals 放着，部件读到值就会在值变化时刷新。
// 游戏状态算出来的界面数据（uiData）也放在这里，由 game.ts 每秒最多更新十次。
// 部件的点击通过 actions 交给 game.ts 去做，部件自己不碰游戏状态，也不引用核心。
import { signal } from '@preact/signals';
import type { RuleId } from '../content/strings.zh.ts';
import type { BoardCard } from './board.ts';
import type { ForecastOption, ForecastSheetState } from './forecast.ts';
import { CARD_HEIGHT } from './map-layout.ts';
import type { PlacedRoofLabel } from './map-layout.ts';
import type { PeakKey } from './schedule.ts';
import type { UpgradeItem } from './tags.ts';
import type { UiData } from './view-model.ts';

export type Speed = 1 | 2 | 3;

/** 窗口的大小和界面的缩放：以 1920×1080 为基准，按窗口等比缩放，最小 1280×720。 */
export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;
export const MIN_WIDTH = 1280;
export const MIN_HEIGHT = 720;

export interface WindowView {
  /** 窗口的 CSS 大小，不小于最小的 1280×720。 */
  readonly width: number;
  readonly height: number;
  /** 界面物件的缩放。 */
  readonly scale: number;
}

/** 窗口大小对应的界面缩放：宽高两个方向各算一个比例，取小的，不小于 1280×720 对应的比例。 */
export function windowViewFor(innerWidth: number, innerHeight: number): WindowView {
  const width = Math.max(MIN_WIDTH, innerWidth);
  const height = Math.max(MIN_HEIGHT, innerHeight);
  return { width, height, scale: Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT) };
}

export interface ToastInfo {
  readonly id: number;
  readonly text: string;
}

/** 选中的站在窗口里的位置，小卡摆在它旁边。 */
export interface StationAnchor {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 还没开通的片区在窗口里的矩形，左上角加宽高。开通价签摆在它的中间。 */
export interface DistrictAnchor {
  readonly district: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 高峰小结的长小票处在哪一步：
 * closed 没有露出来（今天有小结时，右边缘留一个小标签，可以再点开），
 * peek 刚送出来，露出标题和时段，十几秒后收起，
 * open 展开，游戏暂停。
 */
export type SummaryPhase = 'closed' | 'peek' | 'open';

export const uiData = signal<UiData | null>(null);
/**
 * 站点小卡现在排出来的高度，按 1920×1080 的尺寸算，不含窗口缩放。小卡里的块有的有、有的没有，高度每次不同，
 * 摆放时按它算才不会离站点太远，也不会超出窗口。小卡量过大小之后写进来，还没量过时是 CARD_HEIGHT。
 */
export const cardHeight = signal(CARD_HEIGHT);
export const run = signal<{ readonly paused: boolean; readonly speed: Speed }>({ paused: false, speed: 1 });
export const selected = signal<number | null>(null);
export const anchor = signal<StationAnchor | null>(null);
export const buildMode = signal(false);
export const upgradesOpen = signal(false);
export const menuOpen = signal(false);
export const toast = signal<ToastInfo | null>(null);
export const windowView = signal<WindowView>(windowViewFor(DESIGN_WIDTH, DESIGN_HEIGHT));
/** 同一个浏览器里已经有别的页面在运行，这个页面停止。 */
export const blocked = signal(false);
/** 地图画不出来（浏览器没有 WebGL）：页面上写一句话，界面其余部分照常显示。 */
export const mapFailed = signal(false);
/** 复制到剪贴板没成功时，把导出码放在菜单里，让玩家自己复制。 */
export const exportCode = signal<string | null>(null);
/** 菜单里的导入存档：展开了粘贴导出码的文本框。 */
export const importOpen = signal(false);
/** 声音开着没有，菜单里的开关按它写字。 */
export const soundOn = signal(true);
/** 调度台是展开的白板，不是收起的一小块。 */
export const boardOpen = signal(false);
/** 调度台展开后看哪一套，null 是跟着现在生效的那一套。只有分成午晚两套之后才有页签。 */
export const boardTab = signal<PeakKey | null>(null);
/** 点了「{片区}优先」，正在选片区。 */
export const pickingDistrict = signal(false);
/** 片区纸条显示哪个片区，不是已开通的片区时由 view-model 换成编号最小的已开通片区。 */
export const noteDistrict = signal(0);
export const summaryPhase = signal<SummaryPhase>('closed');
/** 日结小票开着：游戏暂停，点「继续」才接着走。 */
export const dayEndOpen = signal(false);
/** 结局的提示开着，点一下收起，游戏照常运行。 */
export const endingOpen = signal(false);
export const districtAnchors = signal<readonly DistrictAnchor[]>([]);
/** 开着的推演单，没有时为 null。推演进行中它写「推演中」，所有「推演」按钮也跟着写「推演中」。 */
export const forecastSheet = signal<ForecastSheetState | null>(null);
/** 选屋顶时每块候选屋顶旁边的文字，位置在窗口里。 */
export const roofLabels = signal<readonly PlacedRoofLabel[]>([]);

/** 鼠标停在票杆上的小票时，旁边显示的一行字。left 和 top 是左上角在窗口里的位置，px 是字号。 */
export interface TooltipInfo {
  readonly left: number;
  readonly top: number;
  readonly text: string;
  readonly px: number;
}

export const tooltip = signal<TooltipInfo | null>(null);

/** 部件的点击要做的事，由 game.ts 在启动时填上。 */
export interface Actions {
  clickBuild(): void;
  clickAddBay(): void;
  clickAddDrone(): void;
  clickUpgrades(): void;
  clickUpgrade(item: UpgradeItem): void;
  clickRefund(): void;
  togglePause(): void;
  setSpeed(speed: Speed): void;
  openMenu(): void;
  closeMenu(): void;
  exportSave(): void;
  /** 点菜单里的导入存档：展开或收起粘贴导出码的文本框。 */
  toggleImport(): void;
  /** 点菜单里的声音开关。 */
  toggleSound(): void;
  /** 玩家把导出码粘贴进了文本框：读进来，成为现在的存档，页面重新载入。读不出来时提示，现在的存档不受影响。 */
  importSave(code: string): void;
  quit(): void;
  /** 点调度台的标题：收起和展开。 */
  clickBoard(): void;
  /** 点调度台上的一张卡：换卡，或者要先选片区时打开选片区。 */
  clickCard(card: BoardCard): void;
  /** 选片区时点了一个片区，换成这个片区的「先送」。 */
  clickPickDistrict(rule: RuleId): void;
  clickBoardTab(peak: PeakKey): void;
  /** 点片区纸条上的片区名：换看下一个已开通的片区。 */
  clickNoteName(): void;
  clickOpenDistrict(district: number): void;
  /** 点便签：标成已读，下一张才贴出来。 */
  clickTip(): void;
  /** 点高峰小结的小票或小标签：展开，游戏暂停。 */
  clickSummary(): void;
  clickSummaryContinue(): void;
  clickSummaryBoard(): void;
  clickDayEndContinue(): void;
  clickEnding(): void;
  /** 点「推演」：推演这个选项。host 是按钮所在的物件（改装单、站点小卡、调度台的 data-part），推演单贴在它旁边。推演进行中不响应，次数用完时提示。 */
  clickForecast(option: ForecastOption, host: string | null): void;
  /** 关掉推演单。推演还在算时取消它，不扣次数。 */
  closeForecast(): void;
}

const none = (): void => undefined;

export const actions: Actions = {
  clickBuild: none,
  clickAddBay: none,
  clickAddDrone: none,
  clickUpgrades: none,
  clickUpgrade: none,
  clickRefund: none,
  togglePause: none,
  setSpeed: none,
  openMenu: none,
  closeMenu: none,
  exportSave: none,
  toggleImport: none,
  toggleSound: none,
  importSave: none,
  quit: none,
  clickBoard: none,
  clickCard: none,
  clickPickDistrict: none,
  clickBoardTab: none,
  clickNoteName: none,
  clickOpenDistrict: none,
  clickTip: none,
  clickSummary: none,
  clickSummaryContinue: none,
  clickSummaryBoard: none,
  clickDayEndContinue: none,
  clickEnding: none,
  clickForecast: none,
  closeForecast: none,
};

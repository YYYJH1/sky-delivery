// 游戏页面的运行：同一个浏览器只让一个页面运行，读档（优先用 IndexedDB，用不了退回 localStorage），
// 接上运行循环和自动保存，离开期间的进账，每帧画地图（PixiJS，见 map-view.ts），每秒最多十次从状态算出界面数据，处理鼠标和键盘，
// 把部件的点击变成核心的命令。
// 高峰小结和日结小票的出现、暂停和收起也在这里：核心生成记录，这里发现多了一条，就让界面送出小票。
// 游戏状态只在这里被读写。部件通过 state.ts 里的 signals 和 actions 与这里通信。
import { attachBrowser, browserEnv, createSession } from '../app/index.ts';
import type { Attached, BrowserEnv, SaveReport } from '../app/index.ts';
import { STR, districtName, fmt } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import { applyCommand, previewDispatch, quoteCommand, settleAway, step } from '../core/index.ts';
import type { Command, SimState } from '../core/index.ts';
import { boardToScreen, worldRectToScreen, worldToScreen } from '../render/camera.ts';
import type { Rect } from '../render/geometry.ts';
import { districtModes } from '../render/scene.ts';
import { encodeSaveCode, encodeSaveText, openGameStore, saveGame, unpackSaveText } from '../save/index.ts';
import type { IdbFactoryLike, KeyValueStore, SlotOptions, StorageLike } from '../save/index.ts';
import { ruleCommand } from './board.ts';
import { boot, formatSavedAt, randomSeed, readImport } from './boot.ts';
import type { BootNotice } from './boot.ts';
import { DEBUG_NAMESPACE, applyDebug, forceHolding, padDrones, parseGameParams } from './debug-params.ts';
import { acquireRunLock } from './lock.ts';
import type { LockManagerLike } from './lock.ts';
import { CARD_HEIGHT, CARD_WIDTH, cardPlacement, estimateWidth, layoutRoofLabels, roofLabelFontPx, tooltipPlacement } from './map-layout.ts';
import { hitTest, pickDistrict, ticketReach } from './map-hit.ts';
import type { Hit, MapTargets } from './map-hit.ts';
import { districtAnchor, districtBoxes, roofBoxes, stationAnchor, stationBoxes } from './map-state.ts';
import { createMapView } from './map-view.ts';
import type { MapView } from './map-view.ts';
import { orderHoverText } from './names.ts';
import { nextNoteDistrict, noteDistrictFor } from './note.ts';
import { freshSince, seenOf } from './notices.ts';
import { failureContext, failureText, hintText } from './reasons.ts';
import { roofLines } from './roofs.ts';
import {
  actions,
  anchor,
  blocked,
  boardOpen,
  boardTab,
  buildMode,
  dayEndOpen,
  districtAnchors,
  endingOpen,
  exportCode,
  importOpen,
  menuOpen,
  noteDistrict,
  pickingDistrict,
  roofLabels,
  run,
  selected,
  summaryPhase,
  toast,
  tooltip,
  uiData,
  upgradesOpen,
  windowView,
  windowViewFor,
} from './state.ts';
import type { DistrictAnchor, Speed, StationAnchor, TooltipInfo } from './state.ts';
import { computeUiData } from './view-model.ts';
import type { UiData, UiView } from './view-model.ts';

/** 界面数据最多这么久算一次，毫秒。每秒不超过十次。 */
export const UI_INTERVAL_MS = 100;
/** 系统提示显示多久，毫秒。 */
export const TOAST_MS = 3500;
/** 高峰小结的小票送出之后露出多久，毫秒，不点就收起。 */
export const PEEK_MS = 15_000;
/** 小票边上的派单名次只标前几位。 */
export const RANK_LIMIT = 5;

/** 给调试用的只读入口，只在带调试参数时挂到 window.__sky 上。 */
export interface SkyDebug {
  summary(): { step: number; day: number; money: number; stations: number; drones: number; orders: number; paused: boolean; speed: number };
  /** 站在窗口里的矩形，中心加宽高。 */
  station(id: number): { x: number; y: number; w: number; h: number } | null;
  /** 选屋顶时，候选屋顶在窗口里的矩形。 */
  roofs(): { roof: number; x: number; y: number; w: number; h: number }[];
  /** 等待中的订单的小票在窗口里的中心。 */
  dots(): { orderId: number; x: number; y: number }[];
  /** 世界里的一个点在窗口里的位置。 */
  toScreen(x: number, y: number): { x: number; y: number };
  /** 地图渲染器的统计：飞机、小票、站、航线的段数，上一帧更新花的毫秒，静态层烘焙了几次和花的毫秒，窗口大小和设备像素比。 */
  stats(): Record<string, number>;
  /** 把飞机补到 total 架，平分给各站，只给性能测试用。会改游戏状态。 */
  pad(total: number): number;
  /** 把游戏状态序列化成 JSON，给测试比对用。 */
  json(): string;
  /** 让第一座站上停着的 n 架飞机回到站点上空排队等降落，看等降落的画法用。会改游戏状态。 */
  hold(n: number): number;
  /** 存档用的是哪种存储：indexeddb、localstorage 或 none。 */
  storeKind(): string;
  /** 存储里键以 prefix 开头的全部键。读不了时返回空数组。 */
  storeKeys(prefix: string): Promise<string[]>;
  /** 读存储里一个键的原文，不存在为 null。压缩的存档是压缩之后的写法。 */
  storeGet(key: string): Promise<string | null>;
  /** 把原文写进存储里的一个键，用来造坏档。 */
  storeSet(key: string, text: string): Promise<void>;
  /** 存档原文还原成 JSON 文本，没有压缩的原样返回，读不了为 null。 */
  unpack(text: string): Promise<string | null>;
  /** JSON 文本压缩成存档里的压缩写法。 */
  pack(json: string): Promise<string>;
  /** 按页面现在的状态，假装已经离开了 seconds 秒，结算离开期间的进账，返回进账的金额，没有为 0。 */
  away(seconds: number): number;
}

declare global {
  interface Window {
    __sky?: SkyDebug;
  }
}

export interface GameElements {
  readonly canvas: HTMLCanvasElement;
  readonly hud: HTMLElement;
}

/** 取浏览器的 IndexedDB。浏览器禁用了存储时，读 window.indexedDB 就会抛错，按没有处理。 */
function pickIndexedDb(): IdbFactoryLike | undefined {
  try {
    return window.indexedDB ?? undefined;
  } catch {
    return undefined;
  }
}

/** 取浏览器的 localStorage，读不到时按没有处理。 */
function pickStorage(): StorageLike | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function noticeText(notice: BootNotice): string {
  return notice.kind === 'restored' ? fmt(STR.system.saveCorrupt, { savedAt: formatSavedAt(notice.savedAt) }) : STR.system.saveAllBad;
}

let toastSerial = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 在屏幕下方显示一条系统提示，几秒后消失。新的提示顶掉旧的。 */
export function showToast(text: string): void {
  toastSerial += 1;
  const id = toastSerial;
  toast.value = { id, text };
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toast.peek()?.id === id) toast.value = null;
  }, TOAST_MS);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 没有权限，或者页面不是安全环境。试旧办法，再不行就交给玩家自己复制
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const done = document.execCommand('copy');
    area.remove();
    return done;
  } catch {
    return false;
  }
}

export async function startGame(els: GameElements, search: string): Promise<void> {
  const { canvas, hud } = els;
  const params = parseGameParams(search);

  // ---- 窗口和镜头 ----
  // 地图整张放进窗口，没有平移和缩放的操作。窗口大小变了，镜头立刻换，静态层等大小定下来再重新烘焙一次（map-view.ts）
  let width = 0;
  let height = 0;
  let dpr = 1;
  let map: MapView | null = null;

  function fit(): void {
    const view = windowViewFor(window.innerWidth, window.innerHeight);
    windowView.value = view;
    hud.style.setProperty('--s', String(view.scale));
    width = view.width;
    height = view.height;
    dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    map?.resize({ width, height, dpr, uiScale: view.scale });
  }
  window.addEventListener('resize', () => {
    fit();
    if (state !== null && map !== null) {
      // 镜头变了，贴着地图上东西的界面物件跟着挪
      updateAnchor();
      updateDistrictAnchors(uiData.peek());
      updateRoofLabels();
      renderFrame();
    }
  });

  // ---- 同一个浏览器里只有一个页面运行 ----
  let state: SimState | null = null;
  const lock = await acquireRunLock((navigator as { locks?: LockManagerLike }).locks);
  if (lock === 'taken') {
    blocked.value = true;
    fit();
    return;
  }

  // ---- 读档 ----
  // 存档放在 IndexedDB 里，打不开时退回 localStorage。第一次用 IndexedDB 时，localStorage 里已有的存档会被复制过去
  const opened = await openGameStore({ indexedDb: pickIndexedDb(), storage: pickStorage(), nowMs: Date.now() });
  const store: KeyValueStore = opened.store;
  const save: SlotOptions | undefined = params.debug ? { namespace: DEBUG_NAMESPACE } : undefined;
  const booted = await boot(store, Date.now(), { seed: params.seed ?? randomSeed(Math.random), save });
  const game: SimState = booted.state;
  state = game;
  if (booted.savedStep === null) applyDebug(game, params);
  fit();
  // 地图：等字体载入完，生成城市，起 PixiJS，烘焙静态层。这一段要一两秒，界面在地图准备好之后才出现
  const mapView: MapView = await createMapView({ canvas, look: params.look ?? 'day', view: { width, height, dpr, uiScale: windowView.peek().scale } });
  map = mapView;
  // 载入期间窗口大小可能变过
  fit();
  // 读到备份的提示和离开期间的进账，各是一句话，同时有时接在一起显示
  const bootNotes: string[] = [];
  if (booted.notice !== null) bootNotes.push(noticeText(booted.notice));
  if (booted.away !== null) bootNotes.push(fmt(STR.system.awayIncome, { amount: booted.away.amount }));
  if (bootNotes.length > 0) showToast(bootNotes.join(''));

  // ---- 运行循环和自动保存 ----
  let prevX: number[] = game.drones.map((d) => d.x);
  let prevY: number[] = game.drones.map((d) => d.y);
  // 小票边上的派单名次：核心按现在的规矩算出等待中的订单的派单先后。状态变了（走了一步，玩家点了订单、换了规矩）才重新算
  let ranks: ReadonlyMap<number, number> = new Map();
  function refreshRanks(): void {
    ranks = new Map(previewDispatch(game).ids.map((id, i) => [id, i + 1]));
  }
  refreshRanks();
  mapView.recordStep(game);
  let lastSaveOk: boolean | null = null;
  let saveFailureShown = false;

  function onSaved(report: SaveReport): void {
    lastSaveOk = report.outcome.ok;
    if (report.outcome.ok) {
      saveFailureShown = false;
    } else if (!saveFailureShown) {
      saveFailureShown = true;
      showToast(STR.system.saveFailed);
    }
  }

  const session = createSession({
    store,
    savedStep: booted.savedStep,
    save,
    loop: { paused: params.pause },
    host: {
      state: () => game,
      advance(steps) {
        for (let i = 0; i < steps; i++) {
          // 只有最后一步的前后两个位置用来插值，前面的步不用记
          if (i === steps - 1) {
            prevX = game.drones.map((d) => d.x);
            prevY = game.drones.map((d) => d.y);
          }
          step(game);
          mapView.recordStep(game);
        }
        refreshRanks();
        checkNotices();
      },
      // 网页不可见超过一分钟，回来时结算离开期间的进账。核心只管算，界面这里提示
      away(seconds) {
        const record = settleAway(game, seconds);
        if (record !== null) showToast(fmt(STR.system.awayIncome, { amount: record.amount }));
      },
      saved: onSaved,
    },
  });
  const loop = session.loop;
  // 读档时结算过离开期间的进账，状态比存档里的多了这一笔，让会话记一次改变，过一小会儿就存
  if (booted.away !== null) session.noteChange();

  // 浏览器事件和帧循环的接线，导入存档时要摘掉，见 actions.importSave
  let attached: Attached | null = null;

  // ---- 暂停的几个来源：菜单、展开的高峰小结 ----
  // 玩家自己按的暂停不算在里面。第一个来源出现时记下游戏是不是本来就停着的，最后一个来源放开时按它恢复。
  type HoldReason = 'menu' | 'summary';
  const holds = new Set<HoldReason>();
  let pausedBeforeHolds = false;

  function hold(reason: HoldReason): void {
    if (holds.size === 0) pausedBeforeHolds = loop.paused();
    holds.add(reason);
    loop.setPaused(true);
    syncRun();
  }

  /** stayPaused 为真时，来源都放开之后游戏仍然停着，由玩家自己继续。 */
  function release(reason: HoldReason, stayPaused = false): void {
    holds.delete(reason);
    if (holds.size === 0 && !pausedBeforeHolds && !stayPaused) loop.setPaused(false);
    syncRun();
  }

  // ---- 新出现的小结、日结和结局 ----
  // 读档时已有的当作见过，不再弹出。小结从右边送出来，不打断游戏。日结一出现就展开，游戏照常走，点「继续」收起。
  let seen = seenOf(game);
  let peekTimer: ReturnType<typeof setTimeout> | null = null;

  function clearPeekTimer(): void {
    if (peekTimer !== null) clearTimeout(peekTimer);
    peekTimer = null;
  }

  function startPeek(): void {
    clearPeekTimer();
    summaryPhase.value = 'peek';
    peekTimer = setTimeout(() => {
      peekTimer = null;
      if (summaryPhase.peek() === 'peek') summaryPhase.value = 'closed';
    }, PEEK_MS);
  }

  function checkNotices(): void {
    const fresh = freshSince(seen, game);
    if (fresh.peaks === 0 && fresh.days === 0 && !fresh.ending) return;
    seen = seenOf(game);
    if (fresh.ending) endingOpen.value = true;
    if (fresh.days > 0) {
      // 日结出现之后，前面的小结并入日结，不再从小票的位置打开
      clearPeekTimer();
      summaryPhase.value = 'closed';
      dayEndOpen.value = true;
    } else if (fresh.peaks > 0 && summaryPhase.peek() !== 'open') {
      startPeek();
    }
  }

  // ---- 命令 ----
  function execute(command: Command): { ok: true; id: number } | { ok: false } {
    const result = applyCommand(game, command);
    if (!result.ok) {
      showToast(failureText(result.reason, failureContext(game, command, result.reason)));
      return { ok: false };
    }
    session.noteChange();
    refreshRanks();
    return result;
  }

  function cancelBuild(): void {
    buildMode.value = false;
    updateRoofLabels();
  }

  actions.clickBuild = () => {
    if (buildMode.peek()) {
      cancelBuild();
      return;
    }
    const d = uiData.peek();
    if (d === null) return;
    if (!d.build.canEnter) {
      const code = d.build.tag.reason ?? 'roofTaken';
      showToast(failureText(code, failureContext(game, { type: 'buildStation', roof: 0 }, code)));
      return;
    }
    buildMode.value = true;
    upgradesOpen.value = false;
    updateRoofLabels();
  };

  const stationCommand = (type: 'buyBay' | 'buyDrone'): void => {
    const station = selected.peek();
    if (station === null) {
      showToast(hintText('noStationSelected'));
      return;
    }
    execute({ type, station });
  };
  actions.clickAddBay = () => stationCommand('buyBay');
  actions.clickAddDrone = () => stationCommand('buyDrone');

  actions.clickUpgrades = () => {
    upgradesOpen.value = !upgradesOpen.peek();
    if (upgradesOpen.peek()) cancelBuild();
  };

  actions.clickUpgrade = (item) => {
    if (item.click.kind === 'hint') {
      showToast(hintText(item.click.hint));
      return;
    }
    execute(item.click.command);
  };

  actions.clickRefund = () => {
    const id = selected.peek();
    const card = id === null ? undefined : uiData.peek()?.stations.find((s) => s.id === id);
    if (card === undefined || card.refund === null) return;
    const command = card.refund.command;
    const quote = quoteCommand(game, command);
    const result = execute(command);
    if (!result.ok) return;
    showToast(fmt(STR.system.refunded, { refund: quote.price }));
    if (card.refund.what === 'station') selected.value = null;
  };

  // ---- 运行状态：暂停、速度、菜单 ----
  function syncRun(): void {
    const next = { paused: loop.paused(), speed: loop.speed() };
    const now = run.peek();
    if (now.paused !== next.paused || now.speed !== next.speed) run.value = next;
  }

  // 菜单和展开的小结开着的时候游戏是停着的，点「继续」才能接着走，所以暂停和速度不响应
  actions.togglePause = () => {
    if (holds.size > 0) return;
    loop.togglePause();
    syncRun();
  };
  actions.setSpeed = (speed: Speed) => {
    if (holds.size > 0) return;
    loop.setSpeed(speed);
    loop.setPaused(false);
    syncRun();
  };

  actions.openMenu = () => {
    hold('menu');
    menuOpen.value = true;
  };
  actions.closeMenu = () => {
    menuOpen.value = false;
    exportCode.value = null;
    importOpen.value = false;
    release('menu');
  };
  actions.exportSave = () => {
    void (async () => {
      const result = await encodeSaveCode(game, Date.now());
      if (!result.ok) {
        showToast(STR.system.saveFailed);
        return;
      }
      if (await copyText(result.code)) {
        exportCode.value = null;
        showToast(STR.system.exportCopied);
      } else {
        exportCode.value = result.code;
      }
    })();
  };
  actions.toggleImport = () => {
    importOpen.value = !importOpen.peek();
  };
  /**
   * 导入存档。导出码读得进来，才换掉现在的存档：读进来的状态成为主存档，原来的主存档挪进备份一，
   * 页面随后重新载入，从导入的存档接着玩。读不出来或者没存上时，现在的游戏和存档都不受影响。
   * 存档里的保存时间取现在，所以导入一份很早以前导出的存档不会得到离开期间的进账。
   */
  actions.importSave = (code) => {
    void (async () => {
      const parsed = await readImport(code);
      if (!parsed.ok) {
        // 导入的文字不是导出码，或者里面是别的模式的状态
        showToast(STR.system.importBad);
        return;
      }
      // 先把运行循环和浏览器事件摘掉：否则页面重新载入时会把现在的游戏存回去，盖掉导入的存档
      attached?.detach();
      attached = null;
      await session.flush();
      const saved = await saveGame(store, parsed.state, Date.now(), save);
      if (!saved.ok) {
        attached = attachBrowser(withDraw, session);
        showToast(STR.system.saveFailed);
        return;
      }
      window.location.reload();
    })();
  };
  actions.quit = () => {
    void (async () => {
      session.close(Date.now());
      await session.flush();
      // 保存失败时 onSaved 已经提示过，这里不再说「已存档」。退出之后游戏停着
      menuOpen.value = false;
      exportCode.value = null;
      importOpen.value = false;
      release('menu', true);
      if (lastSaveOk !== false) showToast(STR.system.saved);
    })();
  };

  // ---- 调度台、片区纸条、开通片区、便签 ----
  /** 现在命令该带哪一套：分成两套之后是页签选的那一套，没分成两套时为 null。 */
  const shownPeak = () => uiData.peek()?.board?.shownPeak ?? null;

  actions.clickBoard = () => {
    boardOpen.value = !boardOpen.peek();
    if (!boardOpen.peek()) pickingDistrict.value = false;
  };

  actions.clickCard = (card) => {
    if (card.locked) {
      showToast(failureText('ruleLocked'));
      return;
    }
    if (card.pick) {
      pickingDistrict.value = !pickingDistrict.peek();
      return;
    }
    if (card.rule === null) return;
    pickingDistrict.value = false;
    execute(ruleCommand(card.column, card.rule, shownPeak()));
  };

  actions.clickPickDistrict = (rule) => {
    pickingDistrict.value = false;
    execute(ruleCommand('select', rule, shownPeak()));
  };

  actions.clickBoardTab = (peak) => {
    boardTab.value = peak;
    pickingDistrict.value = false;
  };

  actions.clickNoteName = () => {
    noteDistrict.value = nextNoteDistrict(game, noteDistrictFor(game, noteDistrict.peek()));
  };

  actions.clickOpenDistrict = (district) => {
    const result = execute({ type: 'openDistrict', district });
    if (result.ok) showToast(fmt(STR.system.districtOpened, { district: districtName(district as DistrictIndex) }));
  };

  actions.clickTip = () => {
    const tip = uiData.peek()?.tip;
    if (tip === null || tip === undefined) return;
    execute({ type: 'readTip', tip: tip.id });
  };

  // ---- 高峰小结和日结小票 ----
  actions.clickSummary = () => {
    if (summaryPhase.peek() === 'open') return;
    clearPeekTimer();
    summaryPhase.value = 'open';
    hold('summary');
  };
  actions.clickSummaryContinue = () => {
    if (summaryPhase.peek() !== 'open') return;
    summaryPhase.value = 'closed';
    release('summary');
  };
  // 「打开调度台」：小票收起，白板展开。游戏仍然停着，玩家换完卡再自己继续
  actions.clickSummaryBoard = () => {
    if (summaryPhase.peek() !== 'open') return;
    summaryPhase.value = 'closed';
    boardOpen.value = true;
    release('summary', true);
  };
  actions.clickDayEndContinue = () => {
    if (!dayEndOpen.peek()) return;
    dayEndOpen.value = false;
  };
  actions.clickEnding = () => {
    endingOpen.value = false;
  };

  // ---- 界面数据：每秒最多算十次 ----
  let lastUiAt = Number.NEGATIVE_INFINITY;

  function sameAnchor(a: StationAnchor | null, b: StationAnchor | null): boolean {
    if (a === null || b === null) return a === b;
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }

  /** 选中的站在窗口里的位置，小卡摆在它旁边。 */
  function updateAnchor(): void {
    const id = selected.peek();
    const box = id === null ? undefined : stationBoxes(game, mapView.roofs).find((x) => x.id === id);
    const next: StationAnchor | null = box === undefined ? null : stationAnchor(mapView.board, mapView.camera(), box);
    if (!sameAnchor(anchor.peek(), next)) anchor.value = next;
  }

  function sameAnchors(a: readonly DistrictAnchor[], b: readonly DistrictAnchor[]): boolean {
    return a.length === b.length && a.every((x, i) => x.district === b[i]?.district && x.x === b[i]?.x && x.y === b[i]?.y && x.w === b[i]?.w && x.h === b[i]?.h);
  }

  /** 开通价签摆在还没开通的片区中间，位置是片区转了角之后的外接框。 */
  function updateDistrictAnchors(data: UiData | null): void {
    const next: DistrictAnchor[] = [];
    if (data !== null) {
      const boxes = districtBoxes(game);
      for (const tag of data.openTags) {
        const box = boxes.find((x) => x.index === tag.district);
        if (box !== undefined) next.push(districtAnchor(mapView.board, mapView.camera(), box));
      }
    }
    if (!sameAnchors(districtAnchors.peek(), next)) districtAnchors.value = next;
  }

  /** 候选屋顶的文字只放在这个范围里，不钻到界面物件下面去。 */
  function labelBounds(): Rect {
    const s = windowView.peek().scale;
    return { x: 8, y: 104 * s, w: width - 16, h: height - 104 * s - 96 * s };
  }

  function sameRoofLabels(a: typeof roofLabels.value, b: typeof roofLabels.value): boolean {
    return (
      a.length === b.length &&
      a.every((l, i) => {
        const o = b[i];
        return o !== undefined && l.roof === o.roof && l.x === o.x && l.y === o.y && l.ok === o.ok && l.px === o.px && l.lines.join('\n') === o.lines.join('\n');
      })
    );
  }

  /** 选屋顶时，每块候选屋顶旁边的两行字：摆在不压住别的屋顶和站的地方。屋顶的价格随余额变，所以每次界面数据更新时重排。 */
  function updateRoofLabels(): void {
    const candidates = buildMode.peek() ? (uiData.peek()?.build.candidates ?? []) : [];
    let next: typeof roofLabels.value = [];
    if (candidates.length > 0) {
      const board = mapView.board;
      const camera = mapView.camera();
      const boxes = roofBoxes(candidates, mapView.roofs);
      const inputs = boxes.flatMap((b) => {
        const c = candidates.find((x) => x.roof === b.roof);
        return c === undefined ? [] : [{ roof: b.roof, box: worldRectToScreen(board, camera, b.rect), lines: roofLines(c), ok: c.ok }];
      });
      const stations = stationBoxes(game, mapView.roofs).map((b) => worldRectToScreen(board, camera, b.rect));
      next = layoutRoofLabels(inputs, stations, labelBounds(), roofLabelFontPx(windowView.peek().scale));
    }
    if (!sameRoofLabels(roofLabels.peek(), next)) roofLabels.value = next;
  }

  function currentView(): UiView {
    return { noteDistrict: noteDistrict.peek(), boardPeak: boardTab.peek(), dayEndOpen: dayEndOpen.peek() };
  }

  function refreshUi(): void {
    const data = computeUiData(game, currentView());
    uiData.value = data;
    const id = selected.peek();
    if (id !== null && data !== null && !data.stations.some((s) => s.id === id)) selected.value = null; // 选中的站退回了
    syncRun();
    updateAnchor();
    updateDistrictAnchors(data);
    updateRoofLabels();
  }

  // ---- 地图 ----
  let pointer: { x: number; y: number } | null = null;
  let cursor = 'default';
  /** 点击和悬停要看的东西，每帧换新：站、选屋顶时的候选屋顶、票杆上的小票。 */
  let targets: MapTargets = { stations: [], roofs: [], tickets: [] };

  function sameTooltip(a: TooltipInfo | null, b: TooltipInfo | null): boolean {
    if (a === null || b === null) return a === b;
    return a.left === b.left && a.top === b.top && a.text === b.text && a.px === b.px;
  }

  function renderFrame(): void {
    const alpha = loop.alpha();
    const nowSteps = Math.max(0, game.step - 1) + alpha;
    const building = buildMode.peek();
    const candidates = building ? (uiData.peek()?.build.candidates ?? []) : [];
    targets = { stations: stationBoxes(game, mapView.roofs), roofs: roofBoxes(candidates, mapView.roofs), tickets: mapView.renderer.ticketPoints };
    const surface = mapView.surface();
    // 选中站的小卡盖着的地方：等降落的字不摆在那里
    const reserved: Rect[] = [];
    const at = anchor.peek();
    if (selected.peek() !== null && at !== null && !building) {
      const view = windowView.peek();
      const place = cardPlacement(at, view.width, view.height, view.scale);
      const w = CARD_WIDTH * view.scale;
      reserved.push({ x: place.flip ? place.left - w : place.left, y: place.top, w, h: CARD_HEIGHT * view.scale });
    }
    // 小票的位置是上一帧画出来的，鼠标和它差一帧，看不出来
    const hover: Hit | null = pointer === null ? null : hitTest(surface, targets, pointer.x, pointer.y, building, ticketReach(surface.camera));
    mapView.draw({
      state: game,
      alpha,
      prevX,
      prevY,
      nowSteps,
      ranks,
      rankLimit: RANK_LIMIT,
      districts: districtModes(game),
      selected: selected.peek(),
      roofs: candidates.map((c) => ({ roof: c.roof, hovered: hover !== null && hover.kind === 'roof' && hover.roof === c.roof, ok: c.ok })),
      reserved,
    });
    // 鼠标停在小票上：旁边显示「楼名，菜名，等了几秒」
    let tip: TooltipInfo | null = null;
    if (hover !== null && hover.kind === 'ticket' && pointer !== null) {
      const order = game.orders[hover.orderId];
      if (order !== undefined) {
        const text = orderHoverText(order, nowSteps);
        const px = Math.max(12, Math.min(16, 16 * windowView.peek().scale));
        const at = tooltipPlacement(pointer, width, height, estimateWidth(text, px) + 16, px * 1.4 + 10);
        tip = { left: at.left, top: at.top, text, px };
      }
    }
    if (!sameTooltip(tooltip.peek(), tip)) tooltip.value = tip;
    const wanted = hover === null ? 'default' : 'pointer';
    if (wanted !== cursor) {
      cursor = wanted;
      canvas.style.cursor = wanted;
    }
  }

  function onFrame(nowMs: number): void {
    if (nowMs - lastUiAt >= UI_INTERVAL_MS) {
      lastUiAt = nowMs;
      refreshUi();
    }
    renderFrame();
  }

  // ---- 鼠标 ----
  function canvasPoint(event: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  canvas.addEventListener('pointermove', (event) => {
    pointer = canvasPoint(event);
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
  });
  canvas.addEventListener('click', (event) => {
    // 点白板外面：先把展开的调度台收起，这一下点击不再做别的
    if (boardOpen.peek()) {
      boardOpen.value = false;
      pickingDistrict.value = false;
      return;
    }
    const at = canvasPoint(event);
    const surface = mapView.surface();
    const hit = hitTest(surface, targets, at.x, at.y, buildMode.peek(), ticketReach(surface.camera));
    if (hit === null) {
      // 点在已开通的片区里：片区纸条换成这个片区
      const district = buildMode.peek() ? null : pickDistrict(surface, districtBoxes(game), at.x, at.y);
      if (district !== null) noteDistrict.value = district;
      return;
    }
    if (hit.kind === 'roof') {
      const result = execute({ type: 'buildStation', roof: hit.roof });
      if (result.ok) {
        cancelBuild();
        selected.value = result.id; // 小卡在下一次算界面数据时出现，不为这一次点击多算一次
      }
    } else if (hit.kind === 'station') {
      selected.value = selected.peek() === hit.id ? null : hit.id;
      updateAnchor();
    } else {
      const result = execute({ type: 'prioritizeOrder', order: hit.orderId });
      // 玩家照着便签点了订单，便签说的事已经做了：标成已读，免得它一直挡在后面几张便签前面
      const tip = uiData.peek()?.tip;
      if (result.ok && tip !== undefined && tip !== null && (tip.id === 'firstOrder' || tip.id === 'firstRedOrder')) {
        execute({ type: 'readTip', tip: tip.id });
      }
    }
  });

  /** 右键和 Esc：一层一层取消，菜单，日结和小结（等于点「继续」），选片区，选屋顶，改装面板，调度台，选中的站。 */
  function cancelOne(): void {
    if (menuOpen.peek()) actions.closeMenu();
    else if (dayEndOpen.peek()) actions.clickDayEndContinue();
    else if (summaryPhase.peek() === 'open') actions.clickSummaryContinue();
    else if (pickingDistrict.peek()) pickingDistrict.value = false;
    else if (buildMode.peek()) cancelBuild();
    else if (upgradesOpen.peek()) upgradesOpen.value = false;
    else if (boardOpen.peek()) actions.clickBoard();
    else if (selected.peek() !== null) selected.value = null;
  }
  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    cancelOne();
  });

  // ---- 键盘：空格暂停，数字键 1、2、3 换速度，Esc 取消 ----
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    if (event.key === ' ') {
      event.preventDefault();
      if (!event.repeat) actions.togglePause();
    } else if (event.key === '1' || event.key === '2' || event.key === '3') {
      actions.setSpeed(Number(event.key) as Speed);
    } else if (event.key === 'Escape') {
      cancelOne();
    }
  });

  // ---- 接上浏览器的帧循环：每帧先推进，再画 ----
  const env = browserEnv();
  const withDraw: BrowserEnv = {
    ...env,
    requestAnimationFrame: (callback) =>
      env.requestAnimationFrame((timestampMs) => {
        try {
          callback(timestampMs);
        } finally {
          onFrame(timestampMs);
        }
      }),
  };
  syncRun();
  refreshUi();
  renderFrame();
  attached = attachBrowser(withDraw, session);

  if (params.debug) {
    /** 世界里的矩形在窗口里的外接框，中心加宽高。 */
    const centerBox = (rect: Rect): { x: number; y: number; w: number; h: number } => {
      const r = worldRectToScreen(mapView.board, mapView.camera(), rect);
      return { x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h };
    };
    window.__sky = {
      summary: () => ({
        step: game.step,
        day: Math.floor(game.step / 3600) + 1,
        money: game.campaign?.money ?? 0,
        stations: game.stations.filter((s) => !s.removed).length,
        drones: game.drones.filter((d) => !d.removed).length,
        orders: game.orders.length,
        paused: loop.paused(),
        speed: loop.speed(),
      }),
      station: (id) => {
        const s = stationBoxes(game, mapView.roofs).find((x) => x.id === id);
        return s === undefined ? null : centerBox(s.rect);
      },
      roofs: () => targets.roofs.map((r) => ({ roof: r.roof, ...centerBox(r.rect) })),
      dots: () =>
        mapView.renderer.ticketPoints.map((t) => {
          const p = boardToScreen(mapView.camera(), t.x, t.y);
          return { orderId: t.order, x: p.x, y: p.y };
        }),
      toScreen: (x, y) => worldToScreen(mapView.board, mapView.camera(), x, y),
      stats: () => ({ ...mapView.renderer.stats, width, height, dpr, scale: mapView.camera().scale, tiles: mapView.renderer.staticTiles, cityMs: mapView.boot.cityMs, createMs: mapView.boot.createMs }),
      pad: (total) => {
        const added = padDrones(game, total);
        session.noteChange();
        return added;
      },
      json: () => JSON.stringify(game),
      hold: (n) => {
        const done = forceHolding(game, n);
        session.noteChange();
        return done;
      },
      storeKind: () => opened.kind,
      storeKeys: (prefix) => store.keys(prefix).catch(() => []),
      storeGet: (key) => store.get(key),
      storeSet: (key, text) => store.set(key, text),
      unpack: async (text) => {
        const result = await unpackSaveText(text);
        return result.ok ? result.text : null;
      },
      pack: (json) => encodeSaveText(json),
      away: (seconds) => {
        const record = settleAway(game, seconds);
        if (record === null) return 0;
        showToast(fmt(STR.system.awayIncome, { amount: record.amount }));
        session.noteChange();
        return record.amount;
      },
    };
  }
}

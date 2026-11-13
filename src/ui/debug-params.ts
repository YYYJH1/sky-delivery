// 游戏页面的调试参数：写在网址里，开发时调试用，正常玩不会用到。
//   seed=42            订单种子，不给就随机
//   ff=100             开局后先快进到第 100 秒再开始（快进时替玩家点击开局的五张订单）
//   money=500          把余额改成 500
//   pause=1            开局时暂停
//   unlock=all         打开开放项：all 是全部（午晚两套规矩除外，它随开通写字楼区出现），或者写名字，用逗号隔开，如 priceTags,doubleBox
//   open=1,2           把这几个片区开通（0 老街，1 写字楼区，2 大学城），开通写字楼区会同时分成午晚两套规矩
//   stars=3,2,1        各片区的星级，按片区编号依次写，少写的不改
//   misses=1,0,0       各片区「连续没有达到当前星级下面一档」的日结次数，用来造出可能掉星的状态
//   readtips=1         把快进之后已经出现的便签都标成已读，只留之后新出现的
//   drones=80          把飞机补到 80 架，平分给各站，停机位跟着加（不受屋顶停机位上限的限制），性能测试用
//   look=day           地图的状态：day、dusk、night、rain，缺省 day。只改画面，不改游戏，所以不算调试开局，存档位置不变
// 快进之后的顺序是：开通片区，星级，开放项，日结的次数，便签，飞机，余额。
// 打开「一趟送几单」一栏（poolColumn，包括 unlock=all）时，这一栏同时从「一趟送一单」换成「顺路的一起送」，与买下双层货箱一样。
// 只要给了上面任何一个参数，就用单独的存档位置，不读也不写正常的存档。
// 纯函数，不碰 DOM。
import { DroneState, UNLOCK_KEYS, applyCommand, autoPoolAfterDoubleBox, isUnlocked, markTipRead, refreshShops, refreshUnlocks, step, unlock } from '../core/index.ts';
import type { SimState, UnlockKey } from '../core/index.ts';
import { LOOK_NAMES } from '../render/look.ts';
import type { Look } from '../render/look.ts';

export interface GameParams {
  readonly seed: number | null;
  /** 快进到第几秒，0 表示不快进。 */
  readonly ff: number;
  readonly money: number | null;
  readonly pause: boolean;
  /** 要打开的开放项。 */
  readonly unlock: readonly UnlockKey[];
  /** 要开通的片区。 */
  readonly open: readonly number[];
  /** 各片区的星级，下标是片区编号。 */
  readonly stars: readonly number[];
  /** 各片区连续没有达到当前星级下面一档的日结次数，下标是片区编号。 */
  readonly misses: readonly number[];
  /** 快进之后把已有的便签都标成已读。 */
  readonly readTips: boolean;
  /** 把飞机补到这么多架，0 表示不补。 */
  readonly drones: number;
  /** 地图的状态，没给为 null（白天）。 */
  readonly look: Look | null;
  /** 给了会改变开局的参数，存档用单独的位置。 */
  readonly debug: boolean;
  /** 写错的参数，页面照常运行，按没给处理。 */
  readonly errors: readonly string[];
}

/** 调试开局用的存档键前缀，和正常存档（sky-delivery.）分开。 */
export const DEBUG_NAMESPACE = 'sky-delivery.debug.';

const KNOWN = ['seed', 'ff', 'money', 'pause', 'unlock', 'open', 'stars', 'misses', 'readtips', 'drones', 'look'];

/** 午晚两套规矩不能直接打开：它在开通写字楼区时才出现，分成两套的同时开放。 */
const ALL_UNLOCKS: readonly UnlockKey[] = UNLOCK_KEYS.filter((key) => key !== 'ruleSets');

export function parseGameParams(search: string): GameParams {
  const query = new URLSearchParams(search);
  const errors: string[] = [];
  const read = (name: string, accept: (n: number) => boolean): number | null => {
    const text = query.get(name);
    if (text === null) return null;
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n) || !accept(n)) {
      errors.push(`bad ${name}: ${text}`);
      return null;
    }
    return n;
  };
  /** 逗号隔开的整数列表，有一项不合要求整个参数按没给处理。 */
  const readList = (name: string, accept: (n: number) => boolean): number[] => {
    const text = query.get(name);
    if (text === null) return [];
    const items = text.split(',').map((t) => (t.trim() === '' ? Number.NaN : Number(t)));
    if (items.length === 0 || items.some((n) => !Number.isInteger(n) || !accept(n))) {
      errors.push(`bad ${name}: ${text}`);
      return [];
    }
    return items;
  };
  for (const key of query.keys()) if (!KNOWN.includes(key)) errors.push(`unknown parameter ${key}`);
  const seed = read('seed', Number.isInteger);
  const ff = read('ff', (n) => n >= 0 && n <= 20 * 360) ?? 0;
  const money = read('money', (n) => n >= 0);
  const pause = query.get('pause') === '1';
  const open = readList('open', (n) => n >= 0 && n <= 2);
  const stars = readList('stars', (n) => n >= 1 && n <= 5);
  const misses = readList('misses', (n) => n >= 0 && n <= 9);
  const readTips = query.get('readtips') === '1';
  const drones = read('drones', (n) => Number.isInteger(n) && n >= 1 && n <= 200) ?? 0;
  let look: Look | null = null;
  const lookText = query.get('look');
  if (lookText !== null) {
    if ((LOOK_NAMES as readonly string[]).includes(lookText)) look = lookText as Look;
    else errors.push(`bad look: ${lookText}`);
  }
  let unlockKeys: UnlockKey[] = [];
  const unlockText = query.get('unlock');
  if (unlockText !== null) {
    const names = unlockText.split(',').map((t) => t.trim());
    if (unlockText === 'all') unlockKeys = [...ALL_UNLOCKS];
    else if (names.every((n) => (UNLOCK_KEYS as readonly string[]).includes(n) && n !== 'ruleSets')) unlockKeys = names as UnlockKey[];
    else errors.push(`bad unlock: ${unlockText}`);
  }
  const debug = seed !== null || ff > 0 || money !== null || unlockKeys.length > 0 || open.length > 0 || stars.length > 0 || misses.length > 0 || readTips || drones > 0;
  return { seed, ff, money, pause, unlock: unlockKeys, open, stars, misses, readTips, drones, look, debug, errors };
}

/** 开局的五张订单：出现一小会儿之后替玩家点击，让它们按玩家点击的路子被派出。 */
const CLICK_DELAY_STEPS = 10;

/** 快进到第 seconds 秒，开局的五张订单由这里替玩家点击。状态已经走过这一步时什么也不做。 */
export function fastForward(state: SimState, seconds: number): void {
  const target = Math.round(seconds * 10);
  while (state.step < target) {
    const campaign = state.campaign;
    if (campaign !== null && !campaign.opening.done) {
      for (const id of campaign.opening.orders) {
        const order = state.orders[id];
        if (order !== undefined && order.manualAt < 0 && state.step >= order.tOrder + CLICK_DELAY_STEPS) {
          applyCommand(state, { type: 'prioritizeOrder', order: id });
        }
      }
    }
    step(state);
  }
}

/** 按参数改开局的状态：先快进，再开通片区、改星级、打开开放项、改日结次数、标已读、补飞机，最后改余额。 */
export function applyDebug(state: SimState, params: GameParams): void {
  if (!params.debug) return; // 没带调试参数时什么也不改
  if (params.ff > 0) fastForward(state, params.ff);
  const campaign = state.campaign;
  if (campaign === null) return;
  for (const k of params.open) {
    const district = campaign.districts[k];
    if (district !== undefined) district.open = true;
  }
  params.stars.forEach((star, k) => {
    const district = campaign.districts[k];
    if (district !== undefined) district.star = star;
  });
  refreshShops(state);
  for (const key of params.unlock) unlock(state, key);
  refreshUnlocks(state); // 开通写字楼区时分成午晚两套规矩
  // 经营模式的调度台里没有「一趟送一单」。直接打开「一趟送几单」一栏，等于没买双层货箱就开放了这一栏，
  // 这时照买下双层货箱的做法，把这一栏从「一趟送一单」换成「顺路的一起送」，调度台才有选中的卡可写
  if (isUnlocked(state, 'poolColumn')) autoPoolAfterDoubleBox(state);
  params.misses.forEach((n, k) => {
    const rating = campaign.rating[k];
    if (rating !== undefined) rating.misses = n;
  });
  if (params.readTips) for (const tip of campaign.tips) markTipRead(state, tip.id);
  if (params.drones > 0) padDrones(state, params.drones);
  if (params.money !== null) campaign.money = params.money;
}

/**
 * 调试用：让第一座还在用的站上停着的 count 架飞机回到站点上空，排进起降口的队列等降落，用来看等降落的画法。
 * 每架的状态都按飞机回站时的样子改，模拟接着走会让它们一架一架降落。返回实际改了几架。
 */
export function forceHolding(state: SimState, count: number): number {
  const station = state.stations.find((s) => !s.removed);
  if (station === undefined) return 0;
  let n = 0;
  for (const d of state.drones) {
    if (n >= count) break;
    if (d.removed || d.state !== DroneState.Dock || d.route.length > 0 || d.station !== station.id) continue;
    station.occupied -= 1; // 离开了停机位，降落时再占回来
    d.state = DroneState.LandQueue;
    d.returning = true;
    d.target = station.id;
    d.queuedAt = state.step - 20 - 5 * n;
    station.queue.push(d.id);
    n += 1;
  }
  return n;
}

/**
 * 调试用：把飞机补到 total 架，平分给各个还在用的站，停机位也跟着加，直接改状态，不走命令，所以不受屋顶停机位上限和余额的限制。
 * 补的飞机满电停在站里，和开局的飞机一样。给性能测试放很多架飞机用。返回补了几架。
 */
export function padDrones(state: SimState, total: number): number {
  const live = state.stations.filter((s) => !s.removed);
  const template = state.drones.find((d) => !d.removed);
  const campaign = state.campaign;
  if (template === undefined || campaign === null || live.length === 0) return 0;
  const per = Math.ceil(total / live.length);
  for (const station of live) station.bays = Math.max(station.bays, per + 1);
  let added = 0;
  while (state.drones.filter((d) => !d.removed).length < total) {
    const station = live[state.drones.length % live.length] as (typeof live)[number];
    state.drones.push({
      ...template,
      id: state.drones.length,
      x: station.x,
      y: station.y,
      home: station.id,
      station: station.id,
      state: DroneState.Dock,
      route: [],
      onboard: [],
      load: 0,
      returning: false,
      target: -1,
      departed: -1,
      queuedAt: 0,
      tEnd: 0,
      stranded: false,
      removed: false,
    });
    campaign.drones.push({ day: -1, paid: 0 });
    station.occupied += 1;
    added += 1;
  }
  return added;
}

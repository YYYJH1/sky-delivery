// 经营模式里玩家的命令：建站、添飞机、加停机位、升级起降口、双层货箱、就近降落、开通片区、
// 换策略卡、点击订单插队、便签标记已读，以及当天原价退回。
// 命令在两步之间生效。每个命令先检查条件，不满足时不执行，状态一点不变，返回一个英文的原因代码，界面按代码查词表。
// 价签、双层货箱、片区的显示、调度台的栏和卡都有开放条件（见 unlocks.ts），没开放时命令失败。
// 经营模式的调度台只有内容表 rules_v1 列出的卡，换成表外的卡（例如「单独配送」）同样失败，原因也是 ruleLocked。
// quoteCommand 是只读的，返回某个命令现在的价格和能不能执行，给界面的价签用。
import { ECONOMY_V1 } from '../../content/economy_v1.ts';
import { MAP_V1 } from '../../content/map_v1.ts';
import { DAY_STEPS, DroneState, OrderStatus, RANGE, STEPS_PER_SECOND } from '../constants.ts';
import { hasRule } from '../dispatch/registry.ts';
import { prioritizeOrder, setRules } from '../state.ts';
import { nearestStation } from '../systems/orders.ts';
import { fleetOf, inboundTo, stationCount } from '../systems/stations.ts';
import type { PeakName } from '../systems/schedule.ts';
import type { CampaignState, Drone, Order, RuleColumn, RuleSet, SimState, Station, TipId } from '../types.ts';
import { refreshShops } from './map.ts';
import { bayCap, bayPrice, dronePrice, gatePrice, gateUpgradesTotal, stationPrice } from './prices.ts';
import { autoPoolAfterDoubleBox } from './rulesets.ts';
import { isUnlocked, refreshUnlocks, ruleOpen, showKeyOf } from './unlocks.ts';

export type Command =
  | { type: 'buildStation'; roof: number }
  | { type: 'buyDrone'; station: number }
  | { type: 'buyBay'; station: number }
  | { type: 'upgradeGate'; station: number }
  | { type: 'buyDoubleBox' }
  | { type: 'buyNearestLanding' }
  | { type: 'openDistrict'; district: number }
  | { type: 'setRules'; rules: Partial<RuleSet>; peak?: PeakName } // 开通写字楼区之后，peak 指定改午高峰还是晚高峰的一套，不写就改现在生效的那一套
  | { type: 'prioritizeOrder'; order: number }
  | { type: 'readTip'; tip: TipId }
  | { type: 'refundDrone'; drone: number }
  | { type: 'refundBay'; station: number }
  | { type: 'refundStation'; station: number };

export type CommandType = Command['type'];

/** 命令失败的原因代码。界面按代码查词表，核心里不写中文。 */
export type CommandFailure =
  | 'notCampaign' // 不是经营模式
  | 'unknownCommand' // 没有这种命令
  | 'unknownTarget' // 屋顶、站、飞机、片区、订单、便签或午晚两套里的一套不存在
  | 'districtClosed' // 屋顶所在的片区还没开通
  | 'roofTaken' // 屋顶上已经有站
  | 'stationLimit' // 站数已到上限
  | 'fleetFull' // 这座站的飞机数已等于停机位数
  | 'noFreeBay' // 这座站没有空着的停机位（占用的和预约降落的已经占满）
  | 'bayLimit' // 停机位数已到屋顶的上限
  | 'gateMax' // 起降口已是最高级
  | 'alreadyOwned' // 双层货箱或就近降落已经买过
  | 'needTwoStations' // 就近降落需要两座以上的站
  | 'alreadyOpen' // 片区已经开通
  | 'needStars' // 上一个片区还没达到三星
  | 'unknownRule' // 策略卡不存在
  | 'orderNotWaiting' // 订单不是等待派单的状态，或者已经点击过
  | 'alreadyRefunded' // 这架飞机或这座站已经退回
  | 'notBoughtToday' // 不是当天买的，或者是开局自带的，不能退
  | 'droneBusy' // 飞机不在停机位上，或手上有任务
  | 'baysInUse' // 退回之后停机位数会小于飞机数或占用数
  | 'stationNotEmpty' // 这座站还有飞机，先把飞机退掉
  | 'notEnoughMoney' // 余额不够
  | 'priceTagsLocked' // 价签还没开放：第一次日结之后余额达到内容表里的数才开放
  | 'doubleBoxLocked' // 双层货箱还没开放：停机位到了屋顶上限，并且之后的一场高峰小结说订单主要在等飞机
  | 'districtHidden' // 这个片区还没显示：内容表 UNLOCKS_V1.show 里显示它的条件还没达到过
  | 'ruleLocked' // 这一栏或这张策略卡还没开放，或者经营模式的调度台里没有这张卡
  | 'noRuleSets'; // 还没有分成午晚两套（开通写字楼区之前），不能指定改哪一套

export type CommandResult = { ok: true; id: number } | { ok: false; reason: CommandFailure };

export type PriceKind = 'buy' | 'refund' | 'free';

export interface CommandQuote {
  ok: boolean;
  reason: CommandFailure | null;
  kind: PriceKind; // 买、退回，或不收费
  price: number; // 买的价格，或退回的金额。不收费的命令为 0。条件不满足时也尽量给出价格，供价签显示
}

interface Plan {
  kind: PriceKind;
  price: number;
  /** 执行命令，返回新建的站或飞机的编号，没有则返回目标的编号，再没有则为 -1。 */
  run(): number;
}

type Evaluation = { ok: true; plan: Plan } | { ok: false; reason: CommandFailure; kind: PriceKind; price: number };

const COLUMNS: readonly RuleColumn[] = ['select', 'zone', 'pool'];

function fail(reason: CommandFailure, kind: PriceKind = 'free', price = 0): Evaluation {
  return { ok: false, reason, kind, price };
}

function plan(kind: PriceKind, price: number, run: () => number): Evaluation {
  return { ok: true, plan: { kind, price, run } };
}

function gateSteps(level: number): number {
  return Math.max(1, Math.round((ECONOMY_V1.gateSeconds[level - 1] as number) * STEPS_PER_SECOND));
}

function spend(campaign: CampaignState, amount: number): void {
  campaign.money -= amount;
  campaign.spent += amount;
}

function refund(campaign: CampaignState, amount: number): void {
  campaign.money += amount;
  campaign.refunded += amount;
}

/** 站的编号是整数，并且这座站存在、没有退回。 */
function liveStation(state: SimState, id: number): Station | null {
  const s = Number.isInteger(id) ? state.stations[id] : undefined;
  return s === undefined || s.removed ? null : s;
}

/** 站或飞机的编号是整数、存在，但已经退回。 */
function isRefunded(items: readonly { removed: boolean }[], id: number): boolean {
  const item = Number.isInteger(id) ? items[id] : undefined;
  return item !== undefined && item.removed;
}

/** 一座站退停机位之后，停机位数不能小于飞机数，也不能小于占用数加预约降落数。 */
function baysNeeded(state: SimState, s: Station): number {
  return Math.max(fleetOf(state, s.id), s.occupied + inboundTo(state, s.id));
}

/** 新建或退回一座站之后，还在等待派单的订单重新找离店最近的站。已派出的订单是历史，不改。 */
function reassignPendingHomes(state: SimState): void {
  for (const id of state.pending) {
    const order = state.orders[id] as Order;
    const shop = state.world.merchants[order.merchant] as { x: number; y: number };
    order.home = nearestStation(state, shop.x, shop.y);
  }
}

function evaluate(state: SimState, command: Command): Evaluation {
  const campaign = state.campaign;
  if (campaign === null) return fail('notCampaign');
  const today = Math.floor(state.step / DAY_STEPS);

  switch (command.type) {
    case 'buildStation': {
      const roof = Number.isInteger(command.roof) ? MAP_V1.roofs[command.roof] : undefined;
      if (roof === undefined) return fail('unknownTarget', 'buy');
      const count = stationCount(state);
      const price = stationPrice(count, command.roof);
      if (!isUnlocked(state, 'priceTags')) return fail('priceTagsLocked', 'buy', price);
      if (!(campaign.districts[roof.district] as { open: boolean }).open) return fail('districtClosed', 'buy', price);
      if (campaign.roofStation[command.roof] !== -1) return fail('roofTaken', 'buy', price);
      if (count >= ECONOMY_V1.maxStations) return fail('stationLimit', 'buy', price);
      if (campaign.money < price) return fail('notEnoughMoney', 'buy', price);
      return plan('buy', price, () => {
        const id = state.stations.length;
        state.stations.push({
          id,
          x: roof.x,
          y: roof.y,
          bays: ECONOMY_V1.baysAtBuild,
          occupied: 0,
          queue: [],
          gateFree: state.step,
          gateInterval: gateSteps(1),
          removed: false,
        });
        state.stats.landWait.push([]);
        state.stats.bayEmpty.push([]);
        state.stats.bayTotal.push([]);
        campaign.stations.push({ roof: command.roof, gateLevel: 1, built: { day: today, paid: price }, bays: [] });
        campaign.roofStation[command.roof] = id;
        spend(campaign, price);
        reassignPendingHomes(state);
        return id;
      });
    }

    case 'buyDrone': {
      const s = liveStation(state, command.station);
      if (s === null) return fail('unknownTarget', 'buy');
      const price = dronePrice(fleetOf(state, s.id) + 1);
      if (!isUnlocked(state, 'priceTags')) return fail('priceTagsLocked', 'buy', price);
      if (fleetOf(state, s.id) >= s.bays) return fail('fleetFull', 'buy', price);
      if (s.occupied + inboundTo(state, s.id) >= s.bays) return fail('noFreeBay', 'buy', price);
      if (campaign.money < price) return fail('notEnoughMoney', 'buy', price);
      return plan('buy', price, () => {
        const id = state.drones.length;
        state.drones.push({
          id,
          x: s.x,
          y: s.y,
          battery: RANGE,
          home: s.id,
          state: DroneState.Dock,
          station: s.id,
          route: [],
          onboard: [],
          load: 0,
          tx: 0,
          ty: 0,
          tEnd: 0,
          returning: false,
          target: -1,
          queuedAt: 0,
          stranded: false,
          departed: -1,
          removed: false,
        });
        s.occupied += 1;
        campaign.drones.push({ day: today, paid: price });
        spend(campaign, price);
        return id;
      });
    }

    case 'buyBay': {
      const s = liveStation(state, command.station);
      if (s === null) return fail('unknownTarget', 'buy');
      const price = bayPrice(s.bays + 1);
      const roof = MAP_V1.roofs[(campaign.stations[s.id] as { roof: number }).roof] as { size: 'small' | 'medium' | 'large' };
      if (!isUnlocked(state, 'priceTags')) return fail('priceTagsLocked', 'buy', price);
      if (s.bays >= bayCap(roof.size)) return fail('bayLimit', 'buy', price);
      if (campaign.money < price) return fail('notEnoughMoney', 'buy', price);
      return plan('buy', price, () => {
        s.bays += 1;
        (campaign.stations[s.id] as { bays: { day: number; paid: number }[] }).bays.push({ day: today, paid: price });
        spend(campaign, price);
        return s.id;
      });
    }

    case 'upgradeGate': {
      const s = liveStation(state, command.station);
      if (s === null) return fail('unknownTarget', 'buy');
      const info = campaign.stations[s.id] as { gateLevel: number };
      const maxed = info.gateLevel >= ECONOMY_V1.gateSeconds.length;
      if (!isUnlocked(state, 'priceTags')) return fail('priceTagsLocked', 'buy', maxed ? 0 : gatePrice(info.gateLevel + 1));
      if (maxed) return fail('gateMax', 'buy');
      const next = info.gateLevel + 1;
      const price = gatePrice(next);
      if (campaign.money < price) return fail('notEnoughMoney', 'buy', price);
      return plan('buy', price, () => {
        info.gateLevel = next;
        s.gateInterval = gateSteps(next); // 立即生效，下一次放行就按新的间隔
        spend(campaign, price);
        return s.id;
      });
    }

    case 'buyDoubleBox': {
      const price = ECONOMY_V1.doubleBoxPrice;
      if (state.capacity >= ECONOMY_V1.doubleBoxCapacity) return fail('alreadyOwned', 'buy', price);
      if (!isUnlocked(state, 'priceTags')) return fail('priceTagsLocked', 'buy', price);
      if (!isUnlocked(state, 'doubleBox')) return fail('doubleBoxLocked', 'buy', price);
      if (campaign.money < price) return fail('notEnoughMoney', 'buy', price);
      return plan('buy', price, () => {
        state.capacity = ECONOMY_V1.doubleBoxCapacity;
        spend(campaign, price);
        // 买下的同时「合单策略」一栏开放（refreshUnlocks），这一栏自动从「单独配送」换成「顺路合并」，
        // 否则买了货箱也不会一起送。这次自动换卡不算玩家换卡，不记进 stats.ruleChanges
        autoPoolAfterDoubleBox(state);
        return -1;
      });
    }

    case 'buyNearestLanding': {
      const price = ECONOMY_V1.nearestLandingPrice;
      if (state.returnRule === 'nearest') return fail('alreadyOwned', 'buy', price);
      if (!isUnlocked(state, 'priceTags')) return fail('priceTagsLocked', 'buy', price);
      if (stationCount(state) < ECONOMY_V1.nearestLandingMinStations) return fail('needTwoStations', 'buy', price);
      if (campaign.money < price) return fail('notEnoughMoney', 'buy', price);
      return plan('buy', price, () => {
        state.returnRule = 'nearest';
        spend(campaign, price);
        return -1;
      });
    }

    case 'openDistrict': {
      const k = command.district;
      const district = Number.isInteger(k) ? campaign.districts[k] : undefined;
      if (district === undefined) return fail('unknownTarget', 'buy');
      const price = ECONOMY_V1.districtOpenPrice[k] as number;
      if (district.open || k === 0) return fail('alreadyOpen', 'buy', price);
      const shown = showKeyOf(k);
      if (shown !== null && !isUnlocked(state, shown)) return fail('districtHidden', 'buy', price);
      const previous = campaign.districts[k - 1] as { open: boolean; star: number };
      if (!previous.open || previous.star < ECONOMY_V1.districtOpenStars) return fail('needStars', 'buy', price);
      if (campaign.money < price) return fail('notEnoughMoney', 'buy', price);
      return plan('buy', price, () => {
        district.open = true; // 星级不变，开通的这一步只是让片区开始用
        spend(campaign, price);
        refreshShops(state);
        return k;
      });
    }

    case 'setRules': {
      const patch = command.rules as Record<string, unknown> | null;
      if (patch === null || typeof patch !== 'object') return fail('unknownRule');
      for (const [column, id] of Object.entries(patch)) {
        if (!COLUMNS.includes(column as RuleColumn)) return fail('unknownRule');
        if (id !== undefined && (typeof id !== 'string' || !hasRule(column as RuleColumn, id))) return fail('unknownRule');
      }
      if (command.peak !== undefined) {
        if (command.peak !== 'noon' && command.peak !== 'evening') return fail('unknownTarget');
        if (campaign.ruleSets === null) return fail('noRuleSets');
      }
      for (const [column, id] of Object.entries(patch)) {
        if (id !== undefined && !ruleOpen(state, column as RuleColumn, id as string)) return fail('ruleLocked');
      }
      return plan('free', 0, () => {
        setRules(state, command.rules, command.peak);
        return -1;
      });
    }

    case 'prioritizeOrder': {
      const order = Number.isInteger(command.order) ? state.orders[command.order] : undefined;
      if (order === undefined) return fail('unknownTarget');
      if (order.status !== OrderStatus.Pending || order.manualAt >= 0) return fail('orderNotWaiting');
      return plan('free', 0, () => {
        prioritizeOrder(state, order.id);
        return order.id;
      });
    }

    case 'readTip': {
      // 已经读过的再标一次也算成功，什么也不变
      const tip = typeof command.tip === 'string' ? campaign.tips.find((t) => t.id === command.tip) : undefined;
      if (tip === undefined) return fail('unknownTarget');
      return plan('free', 0, () => {
        tip.read = true;
        return -1;
      });
    }

    case 'refundDrone': {
      if (isRefunded(state.drones, command.drone)) return fail('alreadyRefunded', 'refund');
      const d: Drone | undefined = Number.isInteger(command.drone) ? state.drones[command.drone] : undefined;
      if (d === undefined) return fail('unknownTarget', 'refund');
      const bought = campaign.drones[d.id] as { day: number; paid: number };
      if (bought.day !== today) return fail('notBoughtToday', 'refund');
      if (d.state !== DroneState.Dock || d.route.length > 0 || d.station < 0) return fail('droneBusy', 'refund', bought.paid);
      return plan('refund', bought.paid, () => {
        (state.stations[d.station] as Station).occupied -= 1;
        d.removed = true;
        d.station = -1;
        refund(campaign, bought.paid);
        return d.id;
      });
    }

    case 'refundBay': {
      if (isRefunded(state.stations, command.station)) return fail('alreadyRefunded', 'refund');
      const s = liveStation(state, command.station);
      if (s === null) return fail('unknownTarget', 'refund');
      const bought = (campaign.stations[s.id] as { bays: { day: number; paid: number }[] }).bays;
      const last = bought[bought.length - 1];
      if (last === undefined || last.day !== today) return fail('notBoughtToday', 'refund');
      if (s.bays - 1 < baysNeeded(state, s)) return fail('baysInUse', 'refund', last.paid);
      return plan('refund', last.paid, () => {
        s.bays -= 1;
        bought.pop();
        refund(campaign, last.paid);
        return s.id;
      });
    }

    case 'refundStation': {
      if (isRefunded(state.stations, command.station)) return fail('alreadyRefunded', 'refund');
      const s = liveStation(state, command.station);
      if (s === null) return fail('unknownTarget', 'refund');
      const info = campaign.stations[s.id] as {
        roof: number;
        gateLevel: number;
        built: { day: number; paid: number };
        bays: { day: number; paid: number }[];
      };
      if (info.built.day !== today) return fail('notBoughtToday', 'refund');
      // 当天建的站，自带之外买的停机位和起降口升级也都是当天买的，一起原价退回。
      // 起降口的升级价是固定的，所以按现在的等级把 2 级到现在等级的升级价加起来，就是当天实付的
      const total = info.bays.reduce((sum, b) => sum + b.paid, info.built.paid) + gateUpgradesTotal(info.gateLevel);
      if (fleetOf(state, s.id) > 0 || s.occupied > 0 || inboundTo(state, s.id) > 0) return fail('stationNotEmpty', 'refund', total);
      return plan('refund', total, () => {
        s.removed = true;
        s.bays = 0;
        s.occupied = 0;
        s.queue = [];
        info.bays = [];
        info.gateLevel = 1; // 退回的站不留任何购买的痕迹：起降口回到 1 级，间隔也跟着回去
        s.gateInterval = gateSteps(1);
        campaign.roofStation[info.roof] = -1;
        refund(campaign, total);
        reassignPendingHomes(state);
        return s.id;
      });
    }

    default:
      return fail('unknownCommand');
  }
}

/** 执行一个命令。条件不满足时不执行，状态一点不变，返回原因代码。 */
export function applyCommand(state: SimState, command: Command): CommandResult {
  const evaluation = evaluate(state, command);
  if (!evaluation.ok) return { ok: false, reason: evaluation.reason };
  const id = evaluation.plan.run();
  refreshUnlocks(state); // 命令的效果马上看得到：第二座站建成，「协同策略」一栏当场开放
  return { ok: true, id };
}

/** 只读：某个命令现在的价格和能不能执行，不修改状态。 */
export function quoteCommand(state: SimState, command: Command): CommandQuote {
  const evaluation = evaluate(state, command);
  if (evaluation.ok) return { ok: true, reason: null, kind: evaluation.plan.kind, price: evaluation.plan.price };
  return { ok: false, reason: evaluation.reason, kind: evaluation.kind, price: evaluation.price };
}

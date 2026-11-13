// 订单：按步产生和创建。
import {
  AMOUNT_BASE,
  AMOUNT_PER_DISTANCE,
  BIG_ORDER_MULTIPLIER,
  BIG_ORDER_SHARE,
  DAY_STEPS,
  DT,
  OrderStatus,
  PREP_MAX_SECONDS,
  PREP_MIN_SECONDS,
  STEPS_PER_SECOND,
} from '../constants.ts';
import { nextFloat, nextRange, poisson } from '../rng.ts';
import type { Order, SimState } from '../types.ts';
import { dist } from '../world.ts';
import { curveSteps } from './curve.ts';

// ---- 到达曲线 ----
// 控制点：天内的秒数和相对来单率。高峰点取 1，其余按比例。
const CURVE_SECONDS = [0, 45, 60, 75, 120, 135, 150, 170, 178, 186, 205, 220, 232, 283, 295, 330, 360];
const CURVE_RATE = [0.15, 0.25, 0.45, 1.0, 1.0, 0.45, 0.3, 0.3, 0.45, 0.3, 0.3, 0.5, 0.85, 0.85, 0.4, 0.25, 0.1];

/** 天内每一步的相对来单率。 */
export const ARRIVAL_CURVE: readonly number[] = curveSteps(CURVE_SECONDS, CURVE_RATE);

// ---- 送往哪个片区 ----
// 行是时段：午间、晚间、夜间、其余。列是老街、写字楼区、大学城。
const DESTINATION_SHARE: readonly (readonly [number, number, number])[] = [
  [0.3, 0.55, 0.15],
  [0.4, 0.2, 0.4],
  [0.4, 0.1, 0.5],
  [0.4, 0.3, 0.3],
];

function destinationPeriod(tickOfDay: number, noonOnly: boolean): number {
  if (noonOnly) return 0;
  if (tickOfDay >= 600 && tickOfDay < 1350) return 0;
  if (tickOfDay >= 2150 && tickOfDay < 2950) return 1;
  if (tickOfDay >= 2950) return 2;
  return 3;
}

function pickDistrict(u: number, tickOfDay: number, noonOnly: boolean): number {
  const row = DESTINATION_SHARE[destinationPeriod(tickOfDay, noonOnly)] as readonly [number, number, number];
  if (u < row[0]) return 0;
  if (u < row[0] + row[1]) return 1;
  return 2;
}

/** 累计权重数组里第一个大于 target 的位置，不超过末位。 */
export function searchCumulative(cum: readonly number[], target: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---- 创建 ----
export interface OrderSpec {
  merchant: number;
  building: number;
  portion: number;
  prepSteps: number; // 出餐需要的步数
  tOrder?: number; // 缺省为当前步
}

/** 离 (x, y) 最近的、还在使用的站。距离相同取编号小的。 */
export function nearestStation(state: SimState, x: number, y: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (const s of state.stations) {
    if (s.removed) continue;
    const d = dist(x, y, s.x, s.y);
    if (d < bestDist) {
      best = s.id;
      bestDist = d;
    }
  }
  return best;
}

/** 创建一张订单，放进待派队列和退单检查队列。 */
export function addOrder(state: SimState, spec: OrderSpec): Order {
  const merchant = state.world.merchants[spec.merchant];
  const building = state.world.buildings[spec.building];
  if (!merchant || !building) throw new RangeError('order refers to a missing merchant or building');
  const tOrder = spec.tOrder ?? state.step;
  const dMB = dist(merchant.x, merchant.y, building.x, building.y);
  const order: Order = {
    id: state.orders.length,
    tOrder,
    merchant: spec.merchant,
    building: spec.building,
    district: building.district,
    portion: spec.portion,
    units: 0,
    amount: (AMOUNT_BASE + AMOUNT_PER_DISTANCE * dMB) * (spec.portion === 2 ? BIG_ORDER_MULTIPLIER : 1),
    dMB,
    prepDone: tOrder + spec.prepSteps,
    home: nearestStation(state, merchant.x, merchant.y),
    status: OrderStatus.Pending,
    tAssign: -1,
    tArrive: -1,
    tPick: -1,
    tDeliver: -1,
    tCancel: -1,
    drone: -1,
    departed: -1,
    gateWait: 0,
    rev: 0,
    tip: 0,
    early: false,
    manualAt: -1,
    shared: false,
  };
  state.orders.push(order);
  state.pending.push(order.id);
  state.openQueue.push(order.id);
  return order;
}

/** 用订单随机数流抽一张订单：片区、楼、店、份量、出餐时间。 */
function generateOrder(state: SimState): void {
  const rng = state.rng.orders;
  const tickOfDay = state.step % DAY_STEPS;
  const uDistrict = nextFloat(rng);
  const uBuilding = nextFloat(rng);
  const uMerchant = nextFloat(rng);
  const prepSeconds = nextRange(rng, PREP_MIN_SECONDS, PREP_MAX_SECONDS);
  const uPortion = nextFloat(rng);

  const { world } = state;
  const district = state.config.scenario === 'oldStreet' ? 0 : pickDistrict(uDistrict, tickOfDay, state.config.noonDestinations);
  const candidates = world.buildingsByDistrict[district] as number[];
  const building = candidates[Math.min(Math.floor(uBuilding * candidates.length), candidates.length - 1)] as number;
  const cum = world.cumWeights[building] as number[];
  const merchant = searchCumulative(cum, uMerchant * (cum[cum.length - 1] as number));
  addOrder(state, {
    merchant,
    building,
    portion: uPortion < BIG_ORDER_SHARE ? 2 : 1,
    prepSteps: Math.round(prepSeconds * STEPS_PER_SECOND),
  });
}

/** 产生订单：每步的来单数服从泊松分布。订单量与派单规则无关，只用订单随机数流。 */
export function generateArrivals(state: SimState): void {
  const { config } = state;
  if (config.orderEndStep !== null && state.step >= config.orderEndStep) return;
  const curve = config.constantRate ? 1 : (ARRIVAL_CURVE[state.step % DAY_STEPS] as number);
  const lambda = ((config.peakRate / 60) * curve) * DT;
  const n = poisson(state.rng.orders, lambda);
  for (let i = 0; i < n; i++) generateOrder(state);
}

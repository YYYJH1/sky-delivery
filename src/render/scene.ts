// 把核心的状态换成画面要画的东西：等待中的订单怎么挂在票杆上，停机位怎么分，等降落的飞机怎么盘旋，航线的尾迹，
// 送达和退单的记号。全是纯函数和小的记录器，不碰 Pixi 和 DOM，不读系统时钟，输出只由状态和参数决定，所以测试可以直接调用。
// 画面（map-renderer.ts）每帧调用这里，拿到数据再摆精灵。
import { DroneState, OrderStatus, PROMISE_STEPS, StopKind, isUnlocked, showKeyOf } from '../core/index.ts';
import type { Drone, Order, SimState } from '../core/index.ts';
import type { City, ShopFront, StationRoof } from './city-types.ts';
import { AWNING_MAX, RAIL_LENGTH } from './city.ts';
import { modeOf } from './districts.ts';
import type { DistrictMode } from './districts.ts';
import type { Rect, Vec } from './geometry.ts';
import { bayPositions } from './layout.ts';

// ---- 订单小票 ----
/** 剩不到 8 秒（下单满 22 秒）起变成急红。 */
export const URGENT_AGE_STEPS = PROMISE_STEPS - 80;
export const TICKET_BAR_CELLS = 10;
/** 一家店的票杆上最多挂几张，挂不下的写「+n」。 */
export const MAX_TICKETS_PER_RAIL = 5;

export type TicketState = 'ok' | 'urgent' | 'late';

/** 下单后经过的步数对应的小票状态：不到 22 秒正常，22 到 30 秒（含）快超时，超过 30 秒已超时。 */
export function ticketState(ageSteps: number): TicketState {
  if (ageSteps > PROMISE_STEPS) return 'late';
  if (ageSteps >= URGENT_AGE_STEPS) return 'urgent';
  return 'ok';
}

/** 计时条的格数：离 30 秒承诺还剩多少，0 到 10。剩下的时间不为零就至少一格。 */
export function ticketBar(ageSteps: number): number {
  const left = 1 - ageSteps / PROMISE_STEPS;
  if (left <= 0) return 0;
  return Math.max(1, Math.min(TICKET_BAR_CELLS, Math.ceil(left * TICKET_BAR_CELLS)));
}

export interface WaitingTicket {
  readonly order: number;
  readonly age: number;
  readonly state: TicketState;
  readonly bar: number;
}

export interface ShopTickets {
  readonly shop: number;
  /** 挂在票杆上的，下单早的在左。 */
  readonly shown: readonly WaitingTicket[];
  /** 挂不下的张数。 */
  readonly overflow: number;
  /** 这家店离得最近的站，小票的边框用它的颜色。 */
  readonly nearestStation: number;
}

/** 离 (x, y) 最近的、还在使用的站。没有站时返回 -1。距离相同取编号小的。 */
export function nearestStationOf(state: SimState, x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  for (const s of state.stations) {
    if (s.removed) continue;
    const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
    if (d < bestD) {
      bestD = d;
      best = s.id;
    }
  }
  return best;
}

/**
 * 等待中的订单：还没被取走的（等派单的和已派出还没取到的），按店分组，下单早的在前。
 * from 是从订单列表的哪一项开始找：订单按下单顺序排，下单太久的都已经有了结果，调用者给一个下限就不必每帧扫全部。
 */
export function waitingTickets(state: SimState, nowSteps: number, from = 0): ShopTickets[] {
  const groups = new Map<number, WaitingTicket[]>();
  for (let i = from; i < state.orders.length; i++) {
    const o = state.orders[i] as Order;
    if (o.status !== OrderStatus.Pending && o.status !== OrderStatus.Assigned) continue;
    const age = Math.max(0, nowSteps - o.tOrder);
    const list = groups.get(o.merchant) ?? [];
    list.push({ order: o.id, age, state: ticketState(age), bar: ticketBar(age) });
    groups.set(o.merchant, list);
  }
  const out: ShopTickets[] = [];
  for (const [shop, list] of groups) {
    list.sort((a, b) => b.age - a.age || a.order - b.order);
    const m = state.world.merchants[shop];
    out.push({
      shop,
      shown: list.slice(0, MAX_TICKETS_PER_RAIL),
      overflow: Math.max(0, list.length - MAX_TICKETS_PER_RAIL),
      nearestStation: m === undefined ? -1 : nearestStationOf(state, m.x, m.y),
    });
  }
  out.sort((a, b) => a.shop - b.shop);
  return out;
}

/** 订单列表里下单时间不早于 minStep 的第一项的下标。订单按下单时间排，二分查找。 */
export function firstOrderSince(state: SimState, minStep: number): number {
  let lo = 0;
  let hi = state.orders.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (((state.orders[mid] as Order).tOrder) < minStep) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---- 票杆上小票的位置 ----
/** 前几张小票之间的左右倾斜，度。 */
export const TICKET_TILT: readonly number[] = [-3.5, 2.5, -1.5, 3.5, -2.5, 1.5];

export interface TicketSlot {
  /** 沿街边的位置和朝街里的位置（门面局部坐标）。 */
  readonly u: number;
  readonly v: number;
  /** 倾斜，度。 */
  readonly tilt: number;
}

/**
 * 一张票杆上 n 张小票挂在哪：以票杆中心为中心，两张时间隔大一点。
 * unit 是小票的放大倍数（整张地图放进窗口时小票要放大才看得清），小票之间的间隔跟着放大。
 */
export function ticketSlots(front: ShopFront, n: number, unit = 1): TicketSlot[] {
  const uc = front.awningStart + front.awningWidth / 2;
  const step = (n === 2 ? 16 : 13) * unit;
  const out: TicketSlot[] = [];
  for (let i = 0; i < n; i++) out.push({ u: uc + (i - (n - 1) / 2) * step, v: 14.2, tilt: TICKET_TILT[i % TICKET_TILT.length] as number });
  return out;
}

/** 票杆的两端，门面局部坐标里沿街边的位置。unit 同 ticketSlots：小票放大，票杆也跟着加长，挂得下。 */
export function railEnds(front: ShopFront, unit = 1): [number, number] {
  const uc = front.awningStart + front.awningWidth / 2;
  const half = (RAIL_LENGTH / 2) * unit;
  return [uc - half, uc + half];
}

/** 一张小票的中心在门面局部坐标里离夹子多远（沿 +v 方向），点选小票用它。小票画出来的大小是 15 乘 18，加下沿的锯齿。 */
export const TICKET_CENTER_DROP = 10.5;

/** 票杆上一张小票的位置：画板坐标里小票的中心，点选和悬停用。 */
export interface TicketPoint {
  readonly order: number;
  readonly x: number;
  readonly y: number;
}

/** 一张挂在票杆上的小票画在哪里：全是世界坐标，画面和点选都用它，画出来的就是点得中的。 */
export interface TicketPlacement {
  readonly ticket: WaitingTicket;
  /** 夹子的位置，小票从这里挂下去。 */
  readonly clip: Vec;
  /** 小票的中心。 */
  readonly center: Vec;
  /** 派单名次的圈画在小票下面这里。 */
  readonly rank: Vec;
  /** 左右倾斜，度。 */
  readonly tilt: number;
}

/** 一家店票杆上挂着的这几张小票，各自挂在哪里。unit 是小票的放大倍数。 */
export function placeTickets(front: ShopFront, shown: readonly WaitingTicket[], unit = 1): TicketPlacement[] {
  const slots = ticketSlots(front, shown.length, unit);
  return shown.map((ticket, i) => {
    const slot = slots[i] as TicketSlot;
    return {
      ticket,
      clip: frontPoint(front, slot.u, slot.v),
      center: frontPoint(front, slot.u, slot.v + TICKET_CENTER_DROP * unit),
      rank: frontPoint(front, slot.u, slot.v + 29 * unit),
      tilt: slot.tilt,
    };
  });
}

/** 门面局部坐标 (u, v) 换成世界坐标：局部 +u 沿街边，+v 朝街里，整体转 front.angle 度。 */
export function frontPoint(front: ShopFront, u: number, v: number): Vec {
  const a = (front.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: front.origin.x + u * c - v * s, y: front.origin.y + u * s + v * c };
}

export { AWNING_MAX };

// ---- 停机位 ----
/**
 * 每座站里每架占着停机位的飞机落在第几个位置。占着停机位的是停着、等起飞、起飞中、降落中的飞机（状态里 station 是这座站）。
 * 飞机进来时取最小的空位，出去时让出来，别的飞机的位置不动。
 */
export class SlotTracker {
  private readonly taken = new Map<number, Map<number, number>>();

  reset(): void {
    this.taken.clear();
  }

  /** 按当前状态更新，返回 飞机编号 到 位置的表（只含占着停机位的飞机）。 */
  update(state: SimState): Map<number, number> {
    const result = new Map<number, number>();
    for (const station of state.stations) {
      if (station.removed) {
        this.taken.delete(station.id);
        continue;
      }
      const before = this.taken.get(station.id) ?? new Map<number, number>();
      const occupants = state.drones.filter((d) => !d.removed && d.station === station.id && occupiesBay(d)).map((d) => d.id);
      const now = new Map<number, number>();
      const used = new Set<number>();
      for (const id of occupants) {
        const slot = before.get(id);
        if (slot !== undefined && slot < station.bays && !used.has(slot)) {
          now.set(id, slot);
          used.add(slot);
        }
      }
      for (const id of occupants) {
        if (now.has(id)) continue;
        let slot = 0;
        while (used.has(slot)) slot++;
        now.set(id, slot);
        used.add(slot);
      }
      this.taken.set(station.id, now);
      for (const [id, slot] of now) result.set(id, slot);
    }
    return result;
  }
}

/** 占着停机位的状态：停着、等起飞、起飞中、降落中。 */
export function occupiesBay(d: Pick<Drone, 'state'>): boolean {
  return d.state === DroneState.Dock || d.state === DroneState.TakeoffQueue || d.state === DroneState.Takeoff || d.state === DroneState.Land;
}

/** 停机位在屋顶里的位置（世界坐标）。roof 是屋顶的左上角。 */
export function slotWorldPositions(roofX: number, roofY: number, roofW: number, roofH: number, bays: number): Vec[] {
  return bayPositions(roofW, roofH, bays).map((p) => ({ x: roofX + p.x, y: roofY + p.y }));
}

// ---- 等降落的飞机 ----
export const HOLD_OMEGA = 1.2; // 绕站转圈的角速度，弧度每秒
/** 起降口空着时，飞机回到站点上空的下一步就降落，等了不满这么多步的还画在站点上，不转圈，圈才不会一闪一闪。 */
export const HOLD_GRACE_STEPS = 5;
export const HOLD_RAMP_STEPS = 4;

/** 在上空等了 ageSteps 步的飞机展开到圆周上的程度：0 还在站点中心，1 已经在圆周上。 */
export function holdEase(ageSteps: number): number {
  return Math.min(1, Math.max(0, (ageSteps - HOLD_GRACE_STEPS) / HOLD_RAMP_STEPS));
}

export interface HoldSlot {
  readonly index: number;
  readonly count: number;
}

/** 在站点上空盘旋的飞机（已经过了宽限的），按站分组，先到的排前面。返回 飞机编号 到 它在圈上的序号。 */
export function holdingSlots(state: SimState, nowSteps: number): { slots: Map<number, HoldSlot>; counts: Map<number, number> } {
  const groups = new Map<number, number[]>();
  for (const d of state.drones) {
    if (d.removed || d.state !== DroneState.LandQueue || holdEase(nowSteps - d.queuedAt) <= 0) continue;
    const list = groups.get(d.station) ?? [];
    list.push(d.id);
    groups.set(d.station, list);
  }
  const slots = new Map<number, HoldSlot>();
  const counts = new Map<number, number>();
  for (const [station, ids] of groups) {
    ids.sort((a, b) => (state.drones[a] as Drone).queuedAt - (state.drones[b] as Drone).queuedAt || a - b);
    ids.forEach((id, index) => slots.set(id, { index, count: ids.length }));
    counts.set(station, ids.length);
  }
  return { slots, counts };
}

/** 圈上第 index 架（共 count 架）在 seconds 时刻的位置，相对圆心。顺时针转，第一架从正上方起。 */
export function orbitOffset(radius: number, index: number, count: number, seconds: number): Vec {
  const angle = -Math.PI / 2 + HOLD_OMEGA * seconds + (2 * Math.PI * index) / Math.max(1, count);
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

// ---- 航线的尾迹 ----
export const TRAIL_STEPS = 40; // 约 4 秒

/**
 * 每架飞机最近 TRAIL_STEPS 步的位置（世界坐标）和有没有载货，按步记，环形缓冲。
 * 航线的尾迹由它画：机身后方约四秒，分三段逐段变淡。载货的一段实线，空飞的一段虚线。
 */
export class TrailTracker {
  private readonly xs = new Map<number, Float32Array>();
  private readonly ys = new Map<number, Float32Array>();
  private readonly loaded = new Map<number, Uint8Array>();
  private readonly heads = new Map<number, number>();
  private readonly counts = new Map<number, number>();

  reset(): void {
    this.xs.clear();
    this.ys.clear();
    this.loaded.clear();
    this.heads.clear();
    this.counts.clear();
  }

  /** 每个模拟步之后调用一次，记下各飞机现在的位置。 */
  record(state: SimState): void {
    for (const d of state.drones) {
      if (d.removed) continue;
      let xs = this.xs.get(d.id);
      let ys = this.ys.get(d.id);
      let ld = this.loaded.get(d.id);
      if (xs === undefined || ys === undefined || ld === undefined) {
        xs = new Float32Array(TRAIL_STEPS);
        ys = new Float32Array(TRAIL_STEPS);
        ld = new Uint8Array(TRAIL_STEPS);
        this.xs.set(d.id, xs);
        this.ys.set(d.id, ys);
        this.loaded.set(d.id, ld);
        this.heads.set(d.id, 0);
        this.counts.set(d.id, 0);
      }
      const head = this.heads.get(d.id) as number;
      xs[head] = d.x;
      ys[head] = d.y;
      ld[head] = d.onboard.length > 0 ? 1 : 0;
      this.heads.set(d.id, (head + 1) % TRAIL_STEPS);
      this.counts.set(d.id, Math.min(TRAIL_STEPS, (this.counts.get(d.id) as number) + 1));
    }
  }

  /** 这架飞机最近的位置，从旧到新。 */
  history(id: number): { x: number; y: number; loaded: boolean }[] {
    const xs = this.xs.get(id);
    const ys = this.ys.get(id);
    const ld = this.loaded.get(id);
    if (xs === undefined || ys === undefined || ld === undefined) return [];
    const n = this.counts.get(id) as number;
    const head = this.heads.get(id) as number;
    const out: { x: number; y: number; loaded: boolean }[] = [];
    for (let k = 0; k < n; k++) {
      const i = (head - n + k + TRAIL_STEPS * 2) % TRAIL_STEPS;
      out.push({ x: xs[i] as number, y: ys[i] as number, loaded: ld[i] === 1 });
    }
    return out;
  }
}

/** 折线上相邻的几乎共线的点合并掉，保留首尾和拐点。 */
export function simplify(points: readonly Vec[], tolerance = 0.6): Vec[] {
  if (points.length <= 2) return points.slice();
  const out: Vec[] = [points[0] as Vec];
  let anchor = points[0] as Vec;
  for (let i = 1; i < points.length - 1; i++) {
    const next = points[i + 1] as Vec;
    const p = points[i] as Vec;
    const dx = next.x - anchor.x;
    const dy = next.y - anchor.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const off = len < 1e-9 ? Math.hypot(p.x - anchor.x, p.y - anchor.y) : Math.abs((p.x - anchor.x) * dy - (p.y - anchor.y) * dx) / len;
    if (off > tolerance) {
      out.push(p);
      anchor = p;
    }
  }
  out.push(points[points.length - 1] as Vec);
  return out;
}

// ---- 送达和退单的记号 ----
export const DELIVERY_MARK_STEPS = 45; // 4.5 秒
export const CANCEL_MARK_STEPS = 35; // 3.5 秒
export const MARK_FADE_FRACTION = 0.4; // 最后这一段淡出

export interface Mark {
  readonly kind: 'ontime' | 'late' | 'cancel';
  /** 世界坐标：送达在楼上，退单在店上。 */
  readonly x: number;
  readonly y: number;
  /** 不透明度，0 到 1。 */
  readonly alpha: number;
  /** 退单的记号是哪家店的，其余为 -1。退单的记号画在这家店的票杆旁边，不压在屋顶中心的小票下面。 */
  readonly shop: number;
}

function fadeAlpha(age: number, duration: number): number {
  const keep = duration * (1 - MARK_FADE_FRACTION);
  return age <= keep ? 1 : Math.max(0, 1 - (age - keep) / (duration - keep));
}

/** 现在还看得见的送达和退单记号。from 同 waitingTickets。 */
export function activeMarks(state: SimState, nowSteps: number, from = 0): Mark[] {
  const out: Mark[] = [];
  for (let i = from; i < state.orders.length; i++) {
    const o = state.orders[i] as Order;
    if (o.tDeliver >= 0) {
      const age = nowSteps - o.tDeliver;
      const b = state.world.buildings[o.building];
      if (age >= 0 && age < DELIVERY_MARK_STEPS && b !== undefined) {
        out.push({ kind: o.tDeliver - o.tOrder <= PROMISE_STEPS ? 'ontime' : 'late', x: b.x, y: b.y, alpha: fadeAlpha(age, DELIVERY_MARK_STEPS), shop: -1 });
      }
    } else if (o.tCancel >= 0) {
      const age = nowSteps - o.tCancel;
      const m = state.world.merchants[o.merchant];
      if (age >= 0 && age < CANCEL_MARK_STEPS && m !== undefined) out.push({ kind: 'cancel', x: m.x, y: m.y, alpha: fadeAlpha(age, CANCEL_MARK_STEPS), shop: o.merchant });
    }
  }
  return out;
}

// ---- 送餐目的地 ----
export interface Destination {
  readonly x: number;
  readonly y: number;
  /** 有飞机正飞来：外面多一圈虚线。 */
  readonly active: boolean;
}

/** 载着货的飞机要去的楼：屋顶上的接收垫。 */
export function destinations(state: SimState): Destination[] {
  const out: Destination[] = [];
  for (const d of state.drones) {
    if (d.removed || d.onboard.length === 0) continue;
    const stop = d.route.find((r) => r.kind === StopKind.Drop);
    if (stop === undefined) continue;
    const order = state.orders[stop.order] as Order;
    const b = state.world.buildings[order.building];
    if (b === undefined) continue;
    out.push({ x: b.x, y: b.y, active: d.state === DroneState.Fly || d.state === DroneState.Drop });
  }
  return out;
}

// ---- 片区 ----
/** 各片区现在的样子，下标是片区序号。沙盒模式没有解锁和开通，片区一律开通。 */
export function districtModes(state: SimState): DistrictMode[] {
  const campaign = state.campaign;
  return state.world.districts.map((_, index) => {
    if (campaign === null) return 'open';
    const key = showKeyOf(index);
    return modeOf({ shown: key === null || isUnlocked(state, key), open: campaign.districts[index]?.open === true });
  });
}

// ---- 站点的屋顶 ----
/** 站点屋顶的默认大小：站点没有建在候选屋顶上时（沙盒模式）用它。 */
export const DEFAULT_ROOF: readonly [number, number] = [124, 96];

/**
 * 一座站的屋顶在世界里的矩形和中心。建在候选屋顶上的取城市里那块屋顶，没有对应屋顶的在站的坐标上另画一块默认大小的。
 * roofIndex 是站建在哪块候选屋顶上（地图里 roofs 的下标）。
 */
export function stationRoofRect(stationRoofs: ReadonlyMap<number, StationRoof>, state: SimState, station: number, roofIndex: number | null): { rect: Rect; center: Vec } {
  const s = state.stations[station] as { x: number; y: number };
  const roof = roofIndex === null ? undefined : stationRoofs.get(roofIndex);
  if (roof !== undefined) return { rect: roof.rect, center: { x: s.x, y: s.y } };
  return { rect: { x: s.x - DEFAULT_ROOF[0] / 2, y: s.y - DEFAULT_ROOF[1] / 2, w: DEFAULT_ROOF[0], h: DEFAULT_ROOF[1] }, center: { x: s.x, y: s.y } };
}

/** 城市里的候选屋顶，按候选屋顶的序号（地图里 roofs 的下标）取。 */
export function roofsByIndex(city: City): Map<number, StationRoof> {
  const map = new Map<number, StationRoof>();
  for (const r of city.stations) map.set(r.roof, r);
  return map;
}

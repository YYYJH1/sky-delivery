// 状态哈希：覆盖全部飞机、订单、站点、统计和随机数状态。用于确定性测试和存档校验。
import type { CampaignState, Drone, Order, SimConfig, SimState, Station, Stats } from './types.ts';

const scratch = new Float64Array(1);
const scratchWords = new Uint32Array(scratch.buffer);

/** 两条 32 位通道的哈希（不是密码学哈希）。 */
export class Hasher {
  private a = 0x811c9dc5 | 0;
  private b = 0x9e3779b9 | 0;

  private word(w: number): void {
    this.a = Math.imul(this.a ^ w, 0x01000193);
    this.a ^= this.a >>> 15;
    this.b = Math.imul((this.b + w) | 0, 0x85ebca6b);
    this.b ^= this.b >>> 13;
  }

  /** 数字。32 位整数写一个字，其余按 64 位浮点写两个字。 */
  num(n: number): void {
    if ((n | 0) === n) {
      this.word(n);
    } else {
      scratch[0] = n;
      this.word(scratchWords[0] as number);
      this.word(scratchWords[1] as number);
    }
  }

  bool(v: boolean): void {
    this.word(v ? 1 : 0);
  }

  str(s: string): void {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }

  nums(values: readonly number[]): void {
    this.word(values.length);
    for (const v of values) this.num(v);
  }

  /**
   * 任意的 JSON 值：数字、字符串、布尔、null、数组和普通对象。对象按键名排序，键名和值都写进去，
   * 所以记录里以后加字段，哈希自动覆盖。经营模式的日结、小结、便签等记录用它。
   */
  value(v: unknown): void {
    if (v === null) {
      this.word(0);
    } else if (typeof v === 'number') {
      this.word(1);
      this.num(v);
    } else if (typeof v === 'string') {
      this.word(2);
      this.str(v);
    } else if (typeof v === 'boolean') {
      this.word(3);
      this.bool(v);
    } else if (Array.isArray(v)) {
      this.word(4);
      this.word(v.length);
      for (const item of v) this.value(item);
    } else if (typeof v === 'object') {
      const keys = Object.keys(v).sort();
      this.word(5);
      this.word(keys.length);
      for (const key of keys) {
        this.str(key);
        this.value((v as Record<string, unknown>)[key]);
      }
    } else {
      this.word(6); // undefined 之类，JSON 存不下，只在状态被写坏时出现
    }
  }

  digest(): string {
    return fmix(this.a).toString(16).padStart(8, '0') + fmix(this.b).toString(16).padStart(8, '0');
  }
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hashConfig(h: Hasher, c: SimConfig): void {
  h.str(c.scenario);
  h.str(c.layout);
  h.num(c.mapSeed);
  h.num(c.seed);
  h.num(c.drones);
  h.num(c.extraBays);
  h.num(c.peakRate);
  h.num(c.gateInterval);
  h.num(c.chargeTime);
  h.num(c.capacity);
  h.bool(c.constantRate);
  h.bool(c.noonDestinations);
  h.str(c.rules.select);
  h.str(c.rules.zone);
  h.str(c.rules.pool);
  h.num(c.orderEndStep ?? -1);
  h.str(c.mode);
  h.str(c.returnRule);
}

function hashStation(h: Hasher, s: Station): void {
  h.num(s.id);
  h.num(s.x);
  h.num(s.y);
  h.num(s.bays);
  h.num(s.occupied);
  h.nums(s.queue);
  h.num(s.gateFree);
  h.num(s.gateInterval);
  h.bool(s.removed);
}

function hashDrone(h: Hasher, d: Drone): void {
  h.num(d.id);
  h.num(d.x);
  h.num(d.y);
  h.num(d.battery);
  h.num(d.home);
  h.num(d.state);
  h.num(d.station);
  h.num(d.route.length);
  for (const stop of d.route) {
    h.num(stop.kind);
    h.num(stop.order);
  }
  h.nums(d.onboard);
  h.num(d.load);
  h.num(d.tx);
  h.num(d.ty);
  h.num(d.tEnd);
  h.bool(d.returning);
  h.num(d.target);
  h.num(d.queuedAt);
  h.bool(d.stranded);
  h.num(d.departed);
  h.bool(d.removed);
}

function hashOrder(h: Hasher, o: Order): void {
  h.num(o.id);
  h.num(o.tOrder);
  h.num(o.merchant);
  h.num(o.building);
  h.num(o.district);
  h.num(o.portion);
  h.num(o.units);
  h.num(o.amount);
  h.num(o.dMB);
  h.num(o.prepDone);
  h.num(o.home);
  h.num(o.status);
  h.num(o.tAssign);
  h.num(o.tArrive);
  h.num(o.tPick);
  h.num(o.tDeliver);
  h.num(o.tCancel);
  h.num(o.drone);
  h.num(o.departed);
  h.num(o.gateWait);
  h.num(o.rev);
  h.num(o.tip);
  h.bool(o.early);
  h.num(o.manualAt);
  h.bool(o.shared);
}

function hashStats(h: Hasher, s: Stats): void {
  h.num(s.stranded);
  for (const rows of [s.landWait, s.bayEmpty, s.bayTotal]) {
    h.num(rows.length);
    for (const row of rows) h.nums(row);
  }
  h.num(s.early.length);
  for (const e of s.early) {
    h.num(e.step);
    h.num(e.order);
    h.str(e.rule);
    h.num(e.day);
    h.num(e.peak);
  }
  h.num(s.ruleChanges.length);
  for (const c of s.ruleChanges) {
    h.num(c.step);
    h.str(c.column);
    h.str(c.from);
    h.str(c.to);
  }
  h.nums(s.flightTotal);
  h.nums(s.flightLoaded);
}

function hashCampaign(h: Hasher, c: CampaignState): void {
  h.num(c.contentVersion);
  h.num(c.money);
  h.num(c.spent);
  h.num(c.refunded);
  h.nums(c.income);
  h.num(c.districts.length);
  for (const d of c.districts) {
    h.bool(d.open);
    h.num(d.star);
  }
  h.num(c.shopOpen.length);
  for (const open of c.shopOpen) h.bool(open);
  h.num(c.cumWeights.length);
  for (const row of c.cumWeights) h.nums(row);
  h.nums(c.roofStation);
  h.num(c.stations.length);
  for (const s of c.stations) {
    h.num(s.roof);
    h.num(s.gateLevel);
    h.num(s.built.day);
    h.num(s.built.paid);
    h.num(s.bays.length);
    for (const b of s.bays) {
      h.num(b.day);
      h.num(b.paid);
    }
  }
  h.num(c.drones.length);
  for (const p of c.drones) {
    h.num(p.day);
    h.num(p.paid);
  }
  h.nums(c.opening.orders);
  h.bool(c.opening.done);
  // 口碑计数、各项开放的步、两套规矩、日结和小结的记录、便签、送达总数、结局
  h.value(c.rating);
  h.value(c.unlocks);
  h.value(c.ruleSets);
  h.value(c.days);
  h.value(c.peaks);
  h.value(c.tips);
  h.num(c.delivered);
  h.value(c.ending);
  // 离开结算的记录
  h.value(c.away);
}

/** 整个模拟状态的哈希，16 位十六进制。静态地图只用创建时算好的摘要。 */
export function hashState(state: SimState): string {
  const h = new Hasher();
  h.num(state.step);
  hashConfig(h, state.config);
  h.str(state.world.digest);
  h.str(state.rules.select);
  h.str(state.rules.zone);
  h.str(state.rules.pool);
  for (const r of [state.rng.orders, state.rng.dispatch]) {
    h.num(r.a);
    h.num(r.b);
    h.num(r.c);
    h.num(r.d);
  }
  h.num(state.stations.length);
  for (const s of state.stations) hashStation(h, s);
  h.num(state.drones.length);
  for (const d of state.drones) hashDrone(h, d);
  h.num(state.orders.length);
  for (const o of state.orders) hashOrder(h, o);
  h.nums(state.pending);
  h.nums(state.openQueue);
  hashStats(h, state.stats);
  h.num(state.capacity);
  h.str(state.returnRule);
  h.bool(state.campaign !== null);
  if (state.campaign !== null) hashCampaign(h, state.campaign);
  return h.digest();
}

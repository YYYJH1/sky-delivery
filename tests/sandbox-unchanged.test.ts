// 沙盒模式不变：加入经营模式之前的核心，对下面几组配置跑两个游戏日，汇总数字是固定值。
// 加入经营模式之后沙盒的结果必须与它们逐项相同。固定值由修改前的核心算出，不由现在的核心算出。
// 加入经营模式时另做过逐步核对：把修改前后的核心各跑一遍，每一步的状态哈希相同。
import { describe, expect, it } from 'vitest';
import { runDays } from '../src/core/index.ts';
import type { ConfigOverrides } from '../src/core/index.ts';
import { CITY, OPENING } from './helpers.ts';

interface Golden {
  name: string;
  config: ConfigOverrides;
  orders: number;
  delivered: number;
  cancelled: number;
  rev: number;
  sumAssign: number;
  sumDeliver: number;
  sumCancel: number;
  sumGate: number;
  stranded: number;
  early: number;
  flight: number;
}

const GOLDEN: Golden[] = [
  { name: '老街开局 先下单 2 架', config: { ...OPENING, seed: 42 }, orders: 70, delivered: 68, cancelled: 2, rev: 490.981882, sumAssign: 256953, sumDeliver: 264452, sumCancel: 13503, sumGate: 59, stranded: 0, early: 0, flight: 79872.1551 },
  { name: '老街开局 快超时 3 架', config: { ...OPENING, drones: 3, peakRate: 15, seed: 43, rules: { select: 'deadline' } }, orders: 96, delivered: 95, cancelled: 1, rev: 678.822791, sumAssign: 377274, sumDeliver: 388420, sumCancel: 6926, sumGate: 423, stranded: 0, early: 34, flight: 112270.4763 },
  { name: '三片区 快超时 只由最近的站送', config: { ...CITY, seed: 44, rules: { select: 'deadline', zone: 'strict' } }, orders: 412, delivered: 407, cancelled: 5, rev: 3142.758733, sumAssign: 1468371, sumDeliver: 1522438, sumCancel: 15709, sumGate: 1579, stranded: 0, early: 100, flight: 710697.8731 },
  { name: '三片区 来回快 等 10 秒再帮 顺路的一起送 载量 2', config: { ...CITY, peakRate: 82, capacity: 2, seed: 46, rules: { select: 'roundtrip', zone: 'hybrid', pool: 'any' } }, orders: 542, delivered: 521, cancelled: 21, rev: 3916.204432, sumAssign: 1889205, sumDeliver: 1948035, sumCancel: 92561, sumGate: 1278, stranded: 0, early: 126, flight: 721820.6474 },
  { name: '三片区 大学城的先送 等 10 秒再帮 同一家店的一起送 载量 3', config: { ...CITY, peakRate: 82, capacity: 3, seed: 48, rules: { select: 'prioCampus', zone: 'hybrid', pool: 'same' } }, orders: 513, delivered: 492, cancelled: 21, rev: 3658.172434, sumAssign: 1868007, sumDeliver: 1937715, sumCancel: 115613, sumGate: 1139, stranded: 0, early: 94, flight: 734962.9949 },
  { name: '三座站 15 架 每站多 3 个停机位', config: { ...CITY, layout: 'three', drones: 15, extraBays: 3, peakRate: 60, seed: 50, rules: { select: 'deadline' } }, orders: 350, delivered: 344, cancelled: 6, rev: 2691.10778, sumAssign: 1187911, sumDeliver: 1233466, sumCancel: 14521, sumGate: 443, stranded: 0, early: 67, flight: 619859.518 },
];

describe('沙盒模式不变', () => {
  it.each(GOLDEN.map((g) => [g.name, g] as const))('与加入经营模式之前逐项相同：%s', (_name, g) => {
    const state = runDays(g.config, 2);
    expect(state.campaign).toBeNull();
    expect(state.capacity).toBe(g.config.capacity ?? 1);
    expect(state.returnRule).toBe('home');
    expect(state.stations.every((s) => !s.removed)).toBe(true);
    expect(state.drones.every((d) => !d.removed)).toBe(true);
    let rev = 0;
    let sumAssign = 0;
    let sumDeliver = 0;
    let sumCancel = 0;
    let sumGate = 0;
    let delivered = 0;
    let cancelled = 0;
    for (const o of state.orders) {
      rev += o.rev;
      sumAssign += o.tAssign;
      sumDeliver += o.tDeliver;
      sumCancel += o.tCancel;
      sumGate += o.gateWait;
      if (o.status === 3) delivered++;
      if (o.status === 4) cancelled++;
    }
    expect(state.orders.length).toBe(g.orders);
    expect([delivered, cancelled]).toEqual([g.delivered, g.cancelled]);
    expect(rev).toBeCloseTo(g.rev, 5);
    expect([sumAssign, sumDeliver, sumCancel, sumGate]).toEqual([g.sumAssign, g.sumDeliver, g.sumCancel, g.sumGate]);
    expect(state.stats.stranded).toBe(g.stranded);
    expect(state.stats.early.length).toBe(g.early);
    expect(state.stats.flightTotal.reduce((a, b) => a + b, 0)).toBeCloseTo(g.flight, 3);
  });
});

import { describe, expect, it } from 'vitest';
import { advance, createState, hashState, setRules, step } from '../src/core/index.ts';
import type { ConfigOverrides, SimState } from '../src/core/index.ts';
import { campaignOf, campaignState, clickOpening, must, roofWhere, unlockAll } from './campaign-helpers.ts';
import { CITY, OPENING } from './helpers.ts';

const CASES: [string, ConfigOverrides][] = [
  ['三片区 快超时 全站协同', CITY],
  ['三片区 先到先送 仅限最近站点', { ...CITY, rules: { select: 'fifo', zone: 'strict' } }],
  ['老街开局', OPENING],
  ['三片区 短程优先 延迟支援 顺路合并 载量 2', { ...CITY, peakRate: 82, capacity: 2, rules: { select: 'roundtrip', zone: 'hybrid', pool: 'any' } }],
  ['三片区 老街优先 仅限最近站点 同店合并 载量 2', { ...CITY, peakRate: 82, capacity: 2, rules: { select: 'prioOld', zone: 'strict', pool: 'same' } }],
  ['老街开局 顺路合并 载量 2', { ...OPENING, drones: 4, peakRate: 24, capacity: 2, rules: { pool: 'any' } }],
  ['三片区 写字楼区优先 全站协同 顺路合并 载量 2', { ...CITY, peakRate: 82, capacity: 2, rules: { select: 'prioOffice', zone: 'global', pool: 'any' } }],
  ['三片区 大学城优先 延迟支援 同店合并 载量 3', { ...CITY, peakRate: 82, capacity: 3, rules: { select: 'prioCampus', zone: 'hybrid', pool: 'same' } }],
];

describe('确定性', () => {
  it.each(CASES)('同一个种子运行两次，每一步的状态哈希相同：%s', (_name, config) => {
    const a = createState({ ...config, seed: 42 });
    const b = createState({ ...config, seed: 42 });
    const seen = new Set<string>();
    expect(hashState(a)).toBe(hashState(b));
    for (let i = 0; i < 2000; i++) {
      step(a);
      step(b);
      const h = hashState(a);
      expect(h).toBe(hashState(b));
      seen.add(h);
    }
    // 哈希随状态变化，不是常数
    expect(seen.size).toBeGreaterThan(1900);
    expect(a.orders.length).toBeGreaterThan(5);
  });

  it('不同的种子结果不同', () => {
    const a = createState({ ...CITY, seed: 42 });
    const b = createState({ ...CITY, seed: 43 });
    advance(a, 1800);
    advance(b, 1800);
    expect(hashState(a)).not.toBe(hashState(b));
    const sig = (s: SimState): string => s.orders.map((o) => `${o.tOrder}:${o.merchant}:${o.building}`).join(',');
    expect(sig(a)).not.toBe(sig(b));
  });

  it('不同的地图种子得到不同的地图', () => {
    const a = createState({ ...CITY, mapSeed: 7 });
    const b = createState({ ...CITY, mapSeed: 8 });
    expect(a.world.digest).not.toBe(b.world.digest);
    expect(hashState(a)).not.toBe(hashState(b));
  });

  it('分段推进等于一次推进', () => {
    const whole = createState({ ...CITY, seed: 44 });
    advance(whole, 4000);
    const parts = createState({ ...CITY, seed: 44 });
    for (const n of [1, 1, 5, 493, 1500, 2000]) advance(parts, n);
    expect(parts.step).toBe(4000);
    expect(hashState(parts)).toBe(hashState(whole));
    expect(parts).toEqual(whole);
  });

  it('状态是可以序列化的普通对象：存下再读回，之后的进程与不存档时相同', () => {
    for (const [, config] of CASES) {
      const original = createState({ ...config, seed: 45 });
      advance(original, 1700);
      const restored = JSON.parse(JSON.stringify(original)) as SimState;
      expect(restored).toEqual(original);
      expect(hashState(restored)).toBe(hashState(original));
      advance(original, 1500);
      advance(restored, 1500);
      expect(hashState(restored)).toBe(hashState(original));
      expect(restored).toEqual(original);
    }
  });
});

// ---- 状态哈希覆盖全部飞机、订单、站点、统计和随机数状态 ----
type Path = (string | number)[];

function leaves(value: unknown, path: Path, out: Path[]): void {
  if (Array.isArray(value)) {
    out.push([...path, 'length']);
    value.forEach((item, i) => leaves(item, [...path, i], out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, [...path, k], out);
  } else {
    out.push(path);
  }
}

function read(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], root);
}

function perturb(root: unknown, path: Path): void {
  const parent = read(root, path.slice(0, -1)) as Record<string | number, unknown>;
  const key = path[path.length - 1] as string | number;
  if (key === 'length' && Array.isArray(parent)) {
    parent.push(parent.length > 0 && typeof parent[0] === 'object' ? structuredClone(parent[0]) : 7);
    return;
  }
  const v = parent[key];
  if (v === null) parent[key] = 7;
  else if (typeof v === 'number') parent[key] = v + 1.5;
  else if (typeof v === 'boolean') parent[key] = !v;
  else if (typeof v === 'string') parent[key] = v + 'x';
  else throw new Error(`unexpected leaf at ${path.join('.')}`);
}

const SANDBOX_SECTIONS = ['step', 'rng', 'rules', 'capacity', 'returnRule', 'stations', 'drones', 'orders', 'pending', 'openQueue', 'stats'] as const;
const CAMPAIGN_SECTIONS = [...SANDBOX_SECTIONS, 'campaign'] as const;

/** 逐个改动状态里的字段，哈希都要变。返回没有让哈希变化的字段名。 */
function missedFields(state: SimState, sections: readonly (keyof SimState)[]): string[] {
  const base = hashState(state);
  const paths: Path[] = [];
  for (const key of sections) leaves(state[key], [key], paths);
  expect(paths.length).toBeGreaterThan(500);

  const missed: string[] = [];
  for (const path of paths) {
    const copy = structuredClone(state);
    perturb(copy, path);
    let same: boolean;
    try {
      same = hashState(copy) === base;
    } catch {
      same = false; // 空数组里塞进了形状不对的元素，说明哈希确实读了这个数组
    }
    if (same) missed.push(path.join('.'));
  }
  // 同类字段只列出第一次出现的名字，便于定位
  return [...new Set(missed.map((p) => p.replace(/\.\d+/g, '.#')))];
}

describe('状态哈希的覆盖', () => {
  it('改动飞机、订单、站点、统计、规则、随机数状态里的任何一个字段，哈希都会变', () => {
    // 老街开局运行到午高峰中途，换过一次策略：有已完成、进行中和排队的订单，有提前派出的记录和换卡记录
    const state = createState({ ...OPENING, seed: 46 });
    advance(state, 800);
    setRules(state, { select: 'deadline' });
    advance(state, 300);
    expect(state.orders.some((o) => o.status === 3)).toBe(true);
    expect(state.drones.some((d) => d.route.length > 0)).toBe(true);
    expect(state.stats.early.length).toBeGreaterThan(0);
    expect(state.stats.ruleChanges.length).toBe(1);
    expect(missedFields(state, SANDBOX_SECTIONS)).toEqual([]);
  });

  it('一起送的局面也一样：一架飞机路线上有两张订单、有同乘的订单', () => {
    const state = createState({ ...OPENING, drones: 4, peakRate: 36, capacity: 2, seed: 46, rules: { pool: 'any' } });
    advance(state, 1100);
    expect(state.orders.some((o) => o.shared)).toBe(true);
    expect(state.drones.some((d) => new Set(d.route.map((stop) => stop.order)).size >= 2)).toBe(true);
    expect(missedFields(state, SANDBOX_SECTIONS)).toEqual([]);
  });
});

describe('状态哈希的覆盖：配置', () => {
  it('改动配置里的任何一项（含载量、来单率恒定、目的片区固定用午间的比例、三栏的卡），哈希都会变', () => {
    const state = createState({ ...CITY, seed: 42 });
    advance(state, 200);
    const base = hashState(state);
    const missed: string[] = [];
    const change = (value: unknown): unknown => (typeof value === 'number' ? value + 1.5 : typeof value === 'boolean' ? !value : typeof value === 'string' ? `${value}x` : 7);
    for (const key of Object.keys(state.config)) {
      if (key === 'rules') continue;
      const copy = structuredClone(state);
      const config = copy.config as unknown as Record<string, unknown>;
      config[key] = change(config[key]);
      if (hashState(copy) === base) missed.push(key);
    }
    for (const key of Object.keys(state.config.rules)) {
      const copy = structuredClone(state);
      const rules = copy.config.rules as unknown as Record<string, unknown>;
      rules[key] = change(rules[key]);
      if (hashState(copy) === base) missed.push(`rules.${key}`);
    }
    expect(missed).toEqual([]);
    expect(Object.keys(state.config)).toEqual(expect.arrayContaining(['capacity', 'constantRate', 'noonDestinations']));
  });
});

// ---- 经营模式的状态 ----
/**
 * 一个内容丰富的经营模式状态：开局结束，三个片区开通，建过站又退回，买过飞机和停机位并退回一部分，买了双层货箱和就近降落，
 * 分成了午晚两套策略，跨过一次日结，生成过两场高峰小结，有便签。
 */
function richCampaign(): SimState {
  const state = unlockAll(campaignState({ seed: 46 }));
  const campaign = campaignOf(state);
  for (let i = 0; i < 700; i++) {
    clickOpening(state);
    step(state);
  }
  campaign.money += 20000;
  (campaign.districts[0] as { star: number }).star = 3;
  must(state, { type: 'openDistrict', district: 1 });
  (campaign.districts[1] as { star: number }).star = 3;
  must(state, { type: 'openDistrict', district: 2 });
  const office = must(state, { type: 'buildStation', roof: roofWhere((r) => r.district === 1) });
  must(state, { type: 'buyBay', station: office });
  must(state, { type: 'buyBay', station: office });
  must(state, { type: 'buyDrone', station: office });
  must(state, { type: 'upgradeGate', station: office });
  must(state, { type: 'buyDoubleBox' });
  must(state, { type: 'buyNearestLanding' });
  must(state, { type: 'setRules', rules: { select: 'deadline', pool: 'any' } });
  // 建了又退的站、买了又退的飞机和停机位
  const temp = must(state, { type: 'buildStation', roof: roofWhere((r) => r.district === 2) });
  must(state, { type: 'refundStation', station: temp });
  const extra = must(state, { type: 'buyDrone', station: office });
  must(state, { type: 'refundDrone', drone: extra });
  must(state, { type: 'buyBay', station: 0 });
  must(state, { type: 'buyBay', station: 0 });
  must(state, { type: 'refundBay', station: 0 });
  must(state, { type: 'setRules', rules: { select: 'roundtrip' }, peak: 'evening' });
  advance(state, 3300); // 午高峰和晚高峰的小结，第一次日结
  return state;
}

describe('状态哈希的覆盖：经营模式', () => {
  it('改动经营模式状态里的任何一个字段（金钱、星级、开店、权重、屋顶、购买记录、开局订单、载量、退回标记等），哈希都会变', () => {
    const state = richCampaign();
    const campaign = campaignOf(state);
    // 状态里确实有这些内容，覆盖检查才有意义
    expect(state.capacity).toBe(2);
    expect(state.returnRule).toBe('nearest');
    expect(state.stations.some((s) => s.removed)).toBe(true);
    expect(state.drones.some((d) => d.removed)).toBe(true);
    expect(campaign.stations.some((s) => s.bays.length > 0)).toBe(true);
    expect(campaign.roofStation.filter((s) => s >= 0).length).toBe(2);
    expect(campaign.districts.every((d) => d.open)).toBe(true);
    expect(campaign.opening.orders.length).toBe(5);
    expect(campaign.opening.done).toBe(true);
    // 两套策略、日结和小结的记录、便签
    expect(campaign.ruleSets).not.toBeNull();
    expect(campaign.days.length).toBe(1);
    expect(campaign.peaks.length).toBe(2);
    expect(campaign.tips.length).toBeGreaterThanOrEqual(3);
    expect(campaign.days[0]?.districts.length).toBe(3);
    expect(campaign.rating.length).toBe(3);
    expect(campaign.delivered).toBeGreaterThan(30);
    expect(campaign.income.length).toBeGreaterThanOrEqual(1);
    expect(campaign.spent).toBeGreaterThan(0);
    expect(campaign.refunded).toBeGreaterThan(0);
    expect(state.orders.length).toBeGreaterThan(30);
    expect(missedFields(state, CAMPAIGN_SECTIONS)).toEqual([]);
  });

  it('沙盒状态里 campaign 是 null，经营模式的状态哈希与沙盒不同', () => {
    const sandbox = createState({ ...OPENING, seed: 46 });
    expect(sandbox.campaign).toBeNull();
    expect(hashState(campaignState({ seed: 46 }))).not.toBe(hashState(sandbox));
  });

  it('改动配置里的 mode 和 returnRule，哈希都会变', () => {
    const state = campaignState({ seed: 42 });
    const base = hashState(state);
    const copy = structuredClone(state);
    (copy.config as { mode: string }).mode = 'sandbox';
    expect(hashState(copy)).not.toBe(base);
    const other = structuredClone(state);
    (other.config as { returnRule: string }).returnRule = 'nearest';
    expect(hashState(other)).not.toBe(base);
  });
});

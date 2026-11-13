// 存档和运行循环的测试共用的小工具。
import { advance, applyCommand, createState, hashState, isUnlocked, prioritizeOrder, quoteCommand, setRules } from '../src/core/index.ts';
import type { Command, ConfigOverrides, RuleSet, SimState } from '../src/core/index.ts';
import { POLICIES, ruleCommands, shoppingList } from '../tools/autoplay-lib.ts';
import { applyDebug, parseGameParams } from '../src/ui/debug-params.ts';
import { MemoryStore, SLOTS, StoreError, parseStoredSave, slotKey, unpackSaveText } from '../src/save/index.ts';
import type { KeyValueStore, SlotName, StorageLike } from '../src/save/index.ts';
import { CITY } from './helpers.ts';

/** 测试里用的墙上时间，毫秒。模块里不读时钟，时间都从测试传进去。 */
export const WALL = 1_731_400_000_000;

/** 走了若干步的状态。 */
export function runState(config: ConfigOverrides, steps: number): SimState {
  const state = createState(config);
  advance(state, steps);
  return state;
}

/** 三片区、16 架飞机，载量 2，来单略多于运力，每一栏都换过卡之后字段里各种值都有。 */
export const BUSY: ConfigOverrides = { ...CITY, peakRate: 82, capacity: 2 };

/** 读出某一份存档并解析（压缩的和没有压缩的都行），返回状态的哈希。这份存档不存在或不通过时返回 null。 */
export async function hashOfSlot(store: KeyValueStore, slot: SlotName, namespace?: string): Promise<string | null> {
  const text = await store.get(slotKey(slot, namespace));
  if (text === null) return null;
  const parsed = await parseStoredSave(text);
  return parsed.ok ? hashState(parsed.state) : null;
}

/** 某一份存档在存储里的原文。压缩的存档是压缩之后的写法。 */
export async function readStored(store: KeyValueStore, slot: SlotName, namespace?: string): Promise<string> {
  const text = await store.get(slotKey(slot, namespace));
  if (text === null) throw new Error(`${slot} is empty`);
  return text;
}

/** 某一份存档的 JSON 原文，压缩的先解压。改坏存档之前先用它取出原文。 */
export async function readJson(store: KeyValueStore, slot: SlotName, namespace?: string): Promise<string> {
  const unpacked = await unpackSaveText(await readStored(store, slot, namespace));
  if (!unpacked.ok) throw new Error(`${slot} could not be unpacked: ${unpacked.reason.message}`);
  return unpacked.text;
}

/** 四份存档各自的状态哈希，按 main、backup1、backup2、backup3 的顺序。 */
export async function slotHashes(store: KeyValueStore): Promise<(string | null)[]> {
  return Promise.all(SLOTS.map((slot) => hashOfSlot(store, slot)));
}

// ---- 带脚本的一局：换规矩卡、点击订单插队 ----
const RULE_CHANGES: readonly [number, Partial<RuleSet>][] = [
  [400, { select: 'deadline' }],
  [1000, { zone: 'hybrid' }],
  [1600, { pool: 'any' }],
  [2200, { select: 'roundtrip', zone: 'strict' }],
  [2800, { select: 'prioOffice', pool: 'same' }],
  [3400, { select: 'prioCampus', zone: 'global' }],
  [4000, { select: 'prioOld', pool: 'single' }],
  [4300, { select: 'fifo', zone: 'hybrid', pool: 'any' }],
];

/**
 * 在第 state.step 步开始之前执行的玩家操作，只由当前步和状态决定：
 * 按表换规矩卡，每隔 330 步点击队尾的等待订单让它插队。
 * 参照的那一局和从存档恢复的那一局都用它，所以两边的操作完全相同。
 */
export function applyScript(state: SimState): void {
  for (const [at, patch] of RULE_CHANGES) {
    if (state.step === at) setRules(state, patch);
  }
  if (state.step % 330 === 165) {
    const id = state.pending[state.pending.length - 1];
    if (id !== undefined) prioritizeOrder(state, id);
  }
}

// ---- 经营模式里带脚本的一局：命令穿插在运行里 ----

/** 开局的五张订单：出现 10 步之后替玩家点击。 */
function clickOpening(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null || campaign.opening.done) return;
  for (const id of campaign.opening.orders) {
    const order = state.orders[id];
    if (order !== undefined && order.manualAt < 0 && state.step >= order.tOrder + 10) {
      applyCommand(state, { type: 'prioritizeOrder', order: id });
    }
  }
}

/** 最近买的、当天可以退回的一架飞机的退回命令，没有为 null。 */
function refundCommand(state: SimState): Command | null {
  for (let i = state.drones.length - 1; i >= 0; i--) {
    const drone = state.drones[i];
    if (drone === undefined || drone.removed) continue;
    const command: Command = { type: 'refundDrone', drone: i };
    if (quoteCommand(state, command).ok) return command;
  }
  return null;
}

/**
 * 经营模式里，在第 state.step 步开始之前的玩家操作。只由当前步和状态决定：
 * 参照的那一局和从存档恢复的那一局都用它，所以两边的操作完全相同。
 * 命令的种类尽量多：点开局的订单，按均衡玩法换卡、买飞机、停机位、建站、开通片区、升级起降口、买双层货箱，
 * 买就近降落，点击等待的订单插队，把当天买的飞机退回去。
 */
export function campaignScript(state: SimState): void {
  clickOpening(state);
  if (state.step % 10 === 0) {
    for (const command of ruleCommands(state, POLICIES.balanced)) applyCommand(state, command);
    for (let n = 0; n < 6; n++) {
      const command = shoppingList(state, POLICIES.balanced).find((c) => quoteCommand(state, c).ok);
      if (command === undefined) break;
      applyCommand(state, command);
    }
  }
  if (state.step % 330 === 165) {
    const id = state.pending[state.pending.length - 1];
    if (id !== undefined) applyCommand(state, { type: 'prioritizeOrder', order: id });
  }
  if (state.step % 1700 === 850 && isUnlocked(state, 'nearestLanding')) applyCommand(state, { type: 'buyNearestLanding' });
  if (state.step % 2500 === 1250) {
    const command = refundCommand(state);
    if (command !== null) applyCommand(state, command);
  }
}

/**
 * 一局很快就有各种东西的经营模式开局：老街和写字楼区都开通，各项开放全部打开，有一笔钱，已经快进过开局的五张订单。
 * 带脚本的运行从这里开始，几个游戏日之内就有多座站、多架飞机、两套规矩、各种日结和小结的记录。
 */
export function richCampaign(seed = 7, money = 8000): SimState {
  const state = createState({ mode: 'campaign', seed });
  applyDebug(state, parseGameParams(`?seed=${seed}&ff=100&open=1&stars=3,2&unlock=all&money=${money}`));
  return state;
}

// ---- 故障注入的存储 ----
export type FaultMode = 'throw' | 'torn';

/**
 * 在第 failAt 次写或删（从 0 起数）时出错的存储，包着一个内存存储。
 * throw：抛出错误，这个键保持原值。torn：先把值写进去一半再抛出错误，模拟不是原子的写入被打断。
 */
export class FaultyStore implements KeyValueStore {
  readonly inner: MemoryStore;
  failAt: number | null = null;
  mode: FaultMode = 'throw';
  mutations = 0;

  constructor(inner: MemoryStore) {
    this.inner = inner;
  }

  get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    const n = this.mutations++;
    if (this.failAt === n) {
      if (this.mode === 'torn') await this.inner.set(key, value.slice(0, Math.floor(value.length / 2)));
      throw new StoreError('other', `injected failure at write ${n}`);
    }
    await this.inner.set(key, value);
  }

  async remove(key: string): Promise<void> {
    const n = this.mutations++;
    if (this.failAt === n) throw new StoreError('other', `injected failure at write ${n}`);
    await this.inner.remove(key);
  }

  keys(prefix?: string): Promise<string[]> {
    return this.inner.keys(prefix);
  }
}

// ---- 假的 localStorage ----
/** 有容量上限的 localStorage。容量按键和值的字符数合计算，超过时像浏览器一样抛出 QuotaExceededError。 */
export class FakeStorage implements StorageLike {
  private readonly data = new Map<string, string>();
  private readonly quota: number;

  constructor(quota = Number.POSITIVE_INFINITY) {
    this.quota = quota;
  }

  get length(): number {
    return this.data.size;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    let used = key.length + value.length;
    for (const [k, v] of this.data) if (k !== key) used += k.length + v.length;
    if (used > this.quota) {
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  /** 当前已用的字符数。 */
  used(): number {
    let total = 0;
    for (const [k, v] of this.data) total += k.length + v.length;
    return total;
  }
}

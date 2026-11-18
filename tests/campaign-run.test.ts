// 经营模式的运行：开局，订单，金钱，确定性，无头脚本。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISTRICT_RATES_V1 } from '../src/content/districts_v1.ts';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { OPENING_ORDERS_V1 } from '../src/content/opening_v1.ts';
import {
  DAY_STEPS,
  OrderStatus,
  PROMISE_STEPS,
  advance,
  applyCommand,
  dispatchable,
  districtLambda,
  hashState,
  openingMultiplier,
  refreshShops,
  step,
} from '../src/core/index.ts';
import type { Command, SimState } from '../src/core/index.ts';
import { runCampaign } from '../tools/campaign.ts';
import { campaignOf, campaignState, clickOpening, must, runningState, unlockAll } from './campaign-helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('开局：五张订单', () => {
  it('五张订单按内容表的步出现，店和楼来自内容表，开局时没有随机订单', () => {
    const state = campaignState({ seed: 42 });
    advance(state, 600);
    expect(state.orders.length).toBe(5);
    state.orders.forEach((o, i) => {
      const spec = OPENING_ORDERS_V1[i] as (typeof OPENING_ORDERS_V1)[number];
      expect([o.tOrder, o.merchant, o.building, o.portion, o.prepDone - o.tOrder]).toEqual([spec.step, spec.merchant, spec.building, spec.portion, spec.prepSteps]);
      expect(o.district).toBe(0);
    });
    expect(campaignOf(state).opening.orders).toEqual([0, 1, 2, 3, 4]);
    expect(campaignOf(state).opening.done).toBe(false);
    // 订单随机数流没有被用过
    expect(state.rng.orders).toEqual(campaignState({ seed: 42 }).rng.orders);
  });

  it('第一张订单来自 nameIndex 为 0 的店，在开局的第 0 步出现', () => {
    const state = campaignState();
    step(state);
    expect(state.orders.length).toBe(1);
    expect(state.orders[0]).toMatchObject({ tOrder: 0, merchant: 0, status: OrderStatus.Pending });
  });

  it('其中两张几乎同时出现，相差不超过 1 秒，第一张之后的四张在第 10 到 50 秒之间', () => {
    const state = campaignState();
    advance(state, 600);
    const times = state.orders.map((o) => o.tOrder / 10);
    expect(times[0]).toBeLessThanOrEqual(1);
    for (const t of times.slice(1)) {
      expect(t).toBeGreaterThanOrEqual(10);
      expect(t).toBeLessThanOrEqual(50);
    }
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
    expect(gaps.filter((g) => g <= 1).length).toBe(1);
  });

  it('自动派单关着：没有点击的订单一直等着，即使有飞机空着，点击之后在下一次派单时派出', () => {
    const state = campaignState({ seed: 42 });
    advance(state, 50);
    const first = state.orders[0] as { status: number; tAssign: number };
    expect(first.status).toBe(OrderStatus.Pending);
    expect(state.drones.every((d) => d.route.length === 0)).toBe(true);
    expect(dispatchable(state)).toEqual([]);
    must(state, { type: 'prioritizeOrder', order: 0 });
    expect(dispatchable(state)).toEqual([0]);
    advance(state, 1);
    expect(first.tAssign).toBe(50); // 第 50 步是一次派单
    // 第二张订单（第 100 步）出现之后没有点击，仍有一架飞机空着，订单也不派
    advance(state, 89);
    const second = state.orders[1] as { status: number; tAssign: number };
    expect(state.step).toBe(140);
    expect(second.status).toBe(OrderStatus.Pending);
    expect(state.drones.some((d) => d.route.length === 0 && d.state === 0)).toBe(true);
    must(state, { type: 'prioritizeOrder', order: 1 });
    advance(state, 1);
    expect(second.tAssign).toBe(140);
  });

  it('两张订单同时等待、只有一架飞机空着：点击的先后决定先送哪一张', () => {
    for (const order of [2, 3]) {
      const state = campaignState({ seed: 42 });
      for (let i = 0; i < 330; i++) {
        clickOpeningExcept(state, order === 2 ? 3 : 2);
        step(state);
      }
      // 第 3、4 张订单出现之后，一架飞机还在送第 2 张：只有一架空着
      const first = state.orders[order] as { tAssign: number };
      const other = state.orders[order === 2 ? 3 : 2] as { tAssign: number };
      expect(first.tAssign).toBeGreaterThanOrEqual(0);
      expect(other.tAssign).toBeLessThan(0); // 另一张被点击之前一直等着
    }
  });

  it('五张订单都有了结果之后，自动派单打开，同时开始产生随机订单，在此之前订单只有五张', () => {
    const state = campaignState({ seed: 42 });
    let flip = -1;
    for (let i = 0; i < 4000 && flip < 0; i++) {
      clickOpening(state);
      const wasDone = campaignOf(state).opening.done;
      const at = state.step;
      step(state);
      if (!wasDone && campaignOf(state).opening.done) flip = at;
      if (flip < 0) expect(state.orders.length).toBeLessThanOrEqual(5); // 开局的五张订单陆续出现，没有随机订单
    }
    expect(flip).toBeGreaterThan(0);
    const five = state.orders.slice(0, 5);
    expect(five.every((o) => o.status === OrderStatus.Delivered)).toBe(true);
    expect(flip).toBe(Math.max(...five.map((o) => o.tDeliver)) + 1); // 最后一张送达的下一步
    expect(flip).toBeGreaterThan(300);
    expect(flip).toBeLessThanOrEqual(600); // 约第 50 秒
    // 之后开始产生随机订单，并且自动派出（没有点击过的订单也派）
    for (let i = 0; i < 2500; i++) step(state);
    const random = state.orders.slice(5);
    expect(random.length).toBeGreaterThan(10);
    expect(random.every((o) => o.tOrder >= flip)).toBe(true);
    expect(random.some((o) => o.manualAt < 0 && o.tAssign >= 0)).toBe(true);
    expect(dispatchable(state).length).toBe(state.pending.length);
  });

  it('五张订单都没人点击：90 秒后退单，也算有结果，自动派单照样打开', () => {
    const state = campaignState({ seed: 42 });
    advance(state, 1255);
    expect(campaignOf(state).opening.done).toBe(false);
    advance(state, 10);
    expect(state.orders.slice(0, 5).every((o) => o.status === OrderStatus.Cancelled)).toBe(true);
    expect(campaignOf(state).opening.done).toBe(true);
    advance(state, 2000);
    expect(state.orders.length).toBeGreaterThan(5);
  });

  it('一张送达、一张退单也算：只要五张都有了结果', () => {
    const state = campaignState({ seed: 42 });
    for (let i = 0; i < 1250; i++) {
      for (const id of campaignOf(state).opening.orders.slice(0, 4)) {
        const o = state.orders[id] as { manualAt: number; status: number };
        if (o.manualAt < 0 && o.status === OrderStatus.Pending) must(state, { type: 'prioritizeOrder', order: id });
      }
      step(state);
    }
    expect(campaignOf(state).opening.done).toBe(false); // 第五张订单没有点击，还在等
    advance(state, 20);
    expect(state.orders[4]?.status).toBe(OrderStatus.Cancelled);
    expect(campaignOf(state).opening.done).toBe(true);
  });
});

/** 点击除 skip 之外的开局订单。 */
function clickOpeningExcept(state: SimState, skip: number): void {
  for (const id of campaignOf(state).opening.orders) {
    const o = state.orders[id] as { manualAt: number; status: number };
    if (id !== skip && o.manualAt < 0 && o.status === OrderStatus.Pending) must(state, { type: 'prioritizeOrder', order: id });
  }
}

describe('订单：每个开通的片区各自产生', () => {
  it('只有开通的片区产生订单：只开通老街时，订单都送往老街，店都是老街开张的店', () => {
    const state = runningState(11);
    advance(state, 4 * DAY_STEPS);
    expect(state.orders.length).toBeGreaterThan(80);
    expect(state.orders.every((o) => o.district === 0)).toBe(true);
    const open = campaignOf(state).shopOpen;
    expect(state.orders.every((o) => open[o.merchant] === true)).toBe(true);
    expect(state.orders.every((o) => (MAP_V1.shops[o.merchant] as { district: number }).district === 0)).toBe(true);
  });

  it('各片区的来单数与内容表的来单率相符：基础来单率 / 60 × 曲线 × 星级倍数 × 开业期倍数，三个片区长时间运行的统计检验', () => {
    const stars = [3, 2, 1];
    const days = 10;
    const state = runningState(7, stars, [true, true, true]);
    advance(state, days * DAY_STEPS);
    for (const k of [0, 1, 2]) {
      // 三个片区从第 0 步起就开通，开业期从第 0 天算起
      let expected = 0;
      for (let s = 0; s < days * DAY_STEPS; s++) expected += districtLambda(k, s % DAY_STEPS, stars[k] as number, openingMultiplier(k, Math.floor(s / DAY_STEPS) + 1));
      const observed = state.orders.filter((o) => o.district === k).length;
      const z = (observed - expected) / Math.sqrt(expected);
      expect(Math.abs(z), `district ${k}: expected ${expected.toFixed(1)}, observed ${observed}`).toBeLessThan(4.5);
    }
    expect(DISTRICT_RATES_V1.length).toBe(3);
  });

  it('来单率随星级增加：同样的种子，三星的老街来单数约是一星的 1.5625 倍', () => {
    // 只看第一天：日结会按准时率改变星级，两架飞机撑不住三星的订单量，三星的老街几天之后就掉回二星，比值会被拉近
    const count = (star: number): number => {
      let total = 0;
      for (let seed = 21; seed < 33; seed++) {
        const state = runningState(seed, [star, 1, 1]);
        advance(state, DAY_STEPS);
        total += state.orders.length;
      }
      return total;
    };
    const one = count(1);
    const three = count(3);
    expect(three / one).toBeGreaterThan(1.3);
    expect(three / one).toBeLessThan(1.85);
  });

  it('送往写字楼区的订单里有来自老街的店的，比例与店的权重算出的相符，订单的店只从已开张的店里抽', () => {
    const state = runningState(7, [3, 2, 1], [true, true, true]);
    advance(state, 10 * DAY_STEPS);
    const campaign = campaignOf(state);
    const office = state.orders.filter((o) => o.district === 1);
    const fromOld = office.filter((o) => (MAP_V1.shops[o.merchant] as { district: number }).district === 0).length;
    expect(office.length).toBeGreaterThan(300);
    expect(fromOld).toBeGreaterThan(20);
    // 期望的比例：对写字楼区的每栋楼（等概率），老街的店占该楼累计权重的比例，再取平均
    let share = 0;
    const buildings = state.world.buildingsByDistrict[1] as number[];
    for (const b of buildings) {
      const row = campaign.cumWeights[b] as number[];
      let old = 0;
      let previous = 0;
      row.forEach((v, i) => {
        if ((MAP_V1.shops[i] as { district: number }).district === 0) old += v - previous;
        previous = v;
      });
      share += old / (row[row.length - 1] as number) / buildings.length;
    }
    const sigma = Math.sqrt((share * (1 - share)) / office.length);
    expect(Math.abs(fromOld / office.length - share)).toBeLessThan(4.5 * sigma);
    const open = campaign.shopOpen;
    expect(state.orders.every((o) => open[o.merchant] === true)).toBe(true);
  });

  it('店的权重与沙盒相同：热度权重 × exp(-距离 / 700) × （同片区加倍），没有开张的店权重为 0', () => {
    const state = runningState(3, [1, 1, 1], [true, true, false]);
    const campaign = campaignOf(state);
    for (const b of [0, 5, 22]) {
      const building = state.world.buildings[b] as { x: number; y: number; district: number };
      const row = campaign.cumWeights[b] as number[];
      let total = 0;
      MAP_V1.shops.forEach((shop, i) => {
        const open = campaign.shopOpen[i] as boolean;
        const d = Math.sqrt((shop.x - building.x) ** 2 + (shop.y - building.y) ** 2);
        const weight = open ? shop.rank ** -0.9 * Math.exp(-d / 700) * (shop.district === building.district ? 2 : 1) : 0;
        total += weight;
        expect(row[i]).toBeCloseTo(total, 9);
      });
    }
    expect(campaign.shopOpen.filter(Boolean).length).toBe(9 + 3);
  });

  it('片区升星之后店开张：星级改变后重算，新开张的店开始被抽到，没到星级的店不会被抽到', () => {
    const state = runningState(5, [1, 1, 1]);
    // 第一次日结之前星级不变：第一天的订单不会来自要二星以上才开张的店
    advance(state, DAY_STEPS - 1);
    const late = MAP_V1.shops.map((s, i) => (s.district === 0 && s.opensAtStar > 1 ? i : -1)).filter((i) => i >= 0);
    expect(state.orders.some((o) => late.includes(o.merchant))).toBe(false);
    const before = state.orders.length;
    (campaignOf(state).districts[0] as { star: number }).star = 3;
    refreshShops(state);
    // 再过一天，期间只有一次日结。三星的老街没达到二星的线时记一次，计数不到两次，星级不变，四星才开张的店不会开
    advance(state, DAY_STEPS);
    expect((campaignOf(state).districts[0] as { star: number }).star).toBe(3);
    const after = state.orders.slice(before);
    const open3 = MAP_V1.shops.map((s, i) => (s.district === 0 && s.opensAtStar <= 3 ? i : -1)).filter((i) => i >= 0);
    expect(after.some((o) => late.includes(o.merchant))).toBe(true);
    expect(after.every((o) => open3.includes(o.merchant))).toBe(true);
    // 星级条件：四、五星才开张的店仍然没有订单
    expect(after.some((o) => (MAP_V1.shops[o.merchant] as { opensAtStar: number }).opensAtStar > 3)).toBe(false);
  });

  it('订单只用订单随机数流：派单随机数流不动，策略和购买不改变订单序列', () => {
    const a = unlockAll(runningState(9));
    const b = runningState(9);
    must(a, { type: 'setRules', rules: { select: 'deadline' } });
    advance(a, DAY_STEPS);
    advance(b, DAY_STEPS);
    expect(a.orders.map((o) => [o.tOrder, o.merchant, o.building, o.portion])).toEqual(b.orders.map((o) => [o.tOrder, o.merchant, o.building, o.portion]));
    expect(a.rng.dispatch).toEqual(runningState(9).rng.dispatch);
  });
});

describe('金钱', () => {
  /** 一段带购买和退回的运行：开局点击，第三天买停机位、飞机，当天退回一架，再买，第四天再买、退回、升级起降口。价格翻倍之后前两天的进账只够买一个停机位，所以从第三天开始。 */
  const COMMANDS: { at: number; command: Command }[] = [
    { at: 2 * DAY_STEPS + 10, command: { type: 'buyBay', station: 0 } },
    { at: 2 * DAY_STEPS + 20, command: { type: 'buyDrone', station: 0 } },
    { at: 2 * DAY_STEPS + 30, command: { type: 'refundDrone', drone: 2 } },
    { at: 2 * DAY_STEPS + 40, command: { type: 'buyDrone', station: 0 } },
    { at: 2 * DAY_STEPS + 50, command: { type: 'buyBay', station: 0 } },
    { at: 3 * DAY_STEPS + 10, command: { type: 'buyBay', station: 0 } },
    { at: 3 * DAY_STEPS + 20, command: { type: 'refundBay', station: 0 } },
    { at: 3 * DAY_STEPS + 30, command: { type: 'upgradeGate', station: 0 } },
  ];

  it('进账在订单送达时加进余额，按送达那一天记录每天的进账', () => {
    const { state } = runCampaign({ seed: 42 }, 3, [], 10);
    const campaign = campaignOf(state);
    const byDay = [0, 0, 0];
    let total = 0;
    for (const o of state.orders) {
      if (o.status === OrderStatus.Delivered) {
        byDay[Math.floor(o.tDeliver / DAY_STEPS)] = (byDay[Math.floor(o.tDeliver / DAY_STEPS)] as number) + o.rev;
        total += o.rev;
      }
    }
    expect(total).toBeGreaterThan(300);
    expect(campaign.income.length).toBeGreaterThanOrEqual(3);
    byDay.forEach((sum, d) => expect(campaign.income[d]).toBeCloseTo(sum, 6));
    expect(campaign.money).toBeCloseTo(total, 6);
    expect(campaign.spent).toBe(0);
    expect(campaign.refunded).toBe(0);
  });

  it('余额等于全部送达订单的进账之和，减去全部购买，加上全部退回', () => {
    const { state, run } = runCampaign({ seed: 42 }, 4, COMMANDS, 10);
    const campaign = campaignOf(state);
    const done = run.commands.filter((c) => c.result.ok);
    expect(done.length).toBeGreaterThanOrEqual(6); // 买得起，命令确实执行了
    // 独立的账：每条成功命令在执行之前价签上的价格，买的合计、退的合计
    const bought = done.filter((c) => c.kind === 'buy').reduce((sum, c) => sum + c.price, 0);
    const refunded = done.filter((c) => c.kind === 'refund').reduce((sum, c) => sum + c.price, 0);
    expect(bought).toBeGreaterThan(0);
    expect(refunded).toBeGreaterThan(0);
    expect(campaign.spent).toBe(bought);
    expect(campaign.refunded).toBe(refunded);
    const earned = state.orders.filter((o) => o.status === OrderStatus.Delivered).reduce((sum, o) => sum + o.rev, 0);
    expect(campaign.money).toBeCloseTo(earned - bought + refunded, 6);
    expect(campaign.income.reduce((a, b) => a + b, 0)).toBeCloseTo(earned, 6);
    expect(campaign.money).toBeGreaterThanOrEqual(0);
  });

  it('不买任何东西时，余额只增不减，整数的购买价和小数的进账不会混淆', () => {
    const { state, run } = runCampaign({ seed: 43 }, 2, [], 10);
    expect(run.days[0]?.balance).toBeLessThan(run.days[1]?.balance as number);
    expect(campaignOf(state).money).toBe((run.days[1] as { balance: number }).balance);
  });
});

describe('确定性', () => {
  /** 带命令的运行：开局点击、第二天的购买和退回，逐步记下状态哈希。 */
  function hashes(seed: number, steps: number): string[] {
    const state = campaignState({ seed });
    const list = [hashState(state)];
    const commands = [
      { at: DAY_STEPS + 10, command: { type: 'buyBay', station: 0 } },
      { at: DAY_STEPS + 20, command: { type: 'buyDrone', station: 0 } },
      { at: DAY_STEPS + 30, command: { type: 'refundDrone', drone: 2 } },
      { at: DAY_STEPS + 40, command: { type: 'setRules', rules: { select: 'deadline' } } },
      { at: DAY_STEPS + 60, command: { type: 'buyDoubleBox' } },
      { at: DAY_STEPS + 70, command: { type: 'setRules', rules: { pool: 'any' } } },
    ] as const;
    for (let i = 0; i < steps; i++) {
      clickOpening(state);
      for (const c of commands) if (c.at === state.step) applyCommand(state, c.command);
      step(state);
      list.push(hashState(state));
    }
    return list;
  }

  it('经营模式带命令运行两次，每一步的状态哈希相同', () => {
    const a = hashes(42, 2 * DAY_STEPS);
    const b = hashes(42, 2 * DAY_STEPS);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length); // 哈希随状态变化，不是常数
  });

  it('不同的订单种子结果不同', () => {
    expect(hashes(42, 1500)[1500]).not.toBe(hashes(43, 1500)[1500]);
  });

  it('分段推进等于一次推进', () => {
    const whole = campaignState({ seed: 44 });
    advance(whole, 4000);
    const parts = campaignState({ seed: 44 });
    for (const n of [1, 1, 5, 493, 1500, 2000]) advance(parts, n);
    expect(hashState(parts)).toBe(hashState(whole));
    expect(parts).toEqual(whole);
  });

  it('状态是可以序列化的普通对象：存下再读回，之后的进程与不存档时相同', () => {
    const original = unlockAll(runningState(45, [2, 2, 1], [true, true, false]));
    advance(original, 1800);
    must(original, { type: 'setRules', rules: { select: 'deadline' } });
    const restored = JSON.parse(JSON.stringify(original)) as SimState;
    expect(restored).toEqual(original);
    expect(hashState(restored)).toBe(hashState(original));
    advance(original, 1500);
    advance(restored, 1500);
    expect(hashState(restored)).toBe(hashState(original));
    expect(restored).toEqual(original);
  });
});

describe('无头脚本 npm run campaign', () => {
  function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/campaign.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('从开局运行若干游戏日，每天打印来单、准时、超时、退单、进账、余额和各站的飞机数、停机位数，并写出 JSON', () => {
    const dir = join(ROOT, 'out');
    const file = join(dir, `test-campaign-${process.pid}.json`);
    mkdirSync(dir, { recursive: true });
    try {
      const r = cli(['--days', '2', '--seeds', '42-43', '--json', file]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('种子 42');
      expect(r.stdout).toContain('种子 43');
      expect(r.stdout).toContain('站0 2/2/1');
      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        runs: { seed: number; days: { day: number; orders: number; onTime: number; late: number; cancelled: number; income: number; balance: number; stations: { id: number; drones: number; bays: number }[] }[]; opening: { orderSteps: number[]; doneStep: number } }[];
      };
      expect(json.runs.map((x) => x.seed)).toEqual([42, 43]);
      for (const run of json.runs) {
        expect(run.days.length).toBe(2);
        expect(run.opening.orderSteps).toEqual(OPENING_ORDERS_V1.map((o) => o.step));
        expect(run.opening.doneStep).toBeGreaterThan(300);
        for (const day of run.days) {
          expect(day.orders).toBeGreaterThan(10);
          expect(day.onTime + day.late + day.cancelled).toBeGreaterThan(10);
          expect(day.stations).toEqual([{ id: 0, drones: 2, bays: 2, gateLevel: 1 }]);
        }
        expect(run.days[1]?.balance).toBeGreaterThan(run.days[0]?.balance as number);
      }
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('命令表在指定的步执行命令，失败的命令只打印原因，不中止运行', () => {
    const dir = join(ROOT, 'out');
    const table = join(dir, `test-campaign-commands-${process.pid}.json`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        table,
        JSON.stringify([
          { at: DAY_STEPS + 5, command: { type: 'buyBay', station: 0 } },
          { at: DAY_STEPS + 6, every: 100, command: { type: 'buyDrone', station: 0 } }, // 第一天结束时的余额只够买停机位，飞机等进账够了再买
          { at: DAY_STEPS + 7, command: { type: 'buildStation', roof: 7 } },
          { at: DAY_STEPS + 8, command: { type: 'upgradeGate', station: 0 } },
        ]),
      );
      const r = cli(['--days', '2', '--seeds', '42', '--commands', table]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('命令 4 条');
      expect(r.stdout).toContain('buyBay');
      expect(r.stdout).toContain('成功');
      expect(r.stdout).toContain('失败 districtClosed');
      expect(r.stdout).toMatch(/站0 3\/3\/1/); // 买了一个停机位和一架飞机
    } finally {
      rmSync(table, { force: true });
    }
  });

  it('参数不合法时报错退出', () => {
    for (const args of [['--days', '0'], ['--seeds', 'x'], ['--select', 'nope'], ['--bogus'], ['--commands', 'does-not-exist.json']]) {
      const r = cli(args);
      expect(r.status, args.join(' ')).not.toBe(0);
    }
  });

  it('每天结束时打印日结之后的情况：各片区的星级和最近两天的准时率、退单率，当天开放了什么，当天出现的便签，两场小结的主句和附加句', () => {
    const dir = join(ROOT, 'out');
    const file = join(dir, `test-campaign-report-${process.pid}.json`);
    mkdirSync(dir, { recursive: true });
    try {
      const r = cli(['--days', '3', '--seeds', '42', '--json', file]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('日结之后');
      expect(r.stdout).toMatch(/第 1 天：老街 2星 准时 55% 退单 0%/);
      expect(r.stdout).toContain('开放：selectColumn@1800 priceTags@3600 doubleBox@3600');
      expect(r.stdout).toContain('便签：firstOrder@0 autoDispatchOn@453');
      expect(r.stdout).toMatch(/午高峰小结 \w+/);
      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        runs: {
          report: { day: number; districts: { district: number; star: number; onTimePct: number | null; cancelPct: number | null; kind: string }[]; unlocked: { key: string; step: number }[]; tips: { id: string; step: number }[]; peaks: { peak: string; main: string; extra: string | null }[] }[];
          ending: unknown;
        }[];
      };
      const report = json.runs[0]?.report ?? [];
      expect(report.map((d) => d.day)).toEqual([1, 2, 3]);
      expect(report[0]?.districts[0]).toMatchObject({ district: 0, star: 2, onTimePct: 55, cancelPct: 0, kind: 'starUp' });
      // 日结在第 3600 步，归在第 1 天。双层货箱和数据员随价签一起开放
      expect(report[0]?.unlocked).toEqual([{ key: 'selectColumn', step: 1800 }, { key: 'priceTags', step: DAY_STEPS }, { key: 'doubleBox', step: DAY_STEPS }, { key: 'dataClerk', step: DAY_STEPS }]);
      expect(report[0]?.tips.map((t) => t.id)).toEqual(['firstOrder', 'autoDispatchOn', 'firstRedOrder', 'boardReady', 'canAddBay', 'dataClerk']);
      expect(report[1]?.unlocked).toEqual([]);
      expect(report.every((d) => d.peaks.length === 2)).toBe(true);
      expect(report[0]?.peaks.map((p) => [p.peak, p.main])).toEqual([['noon', 'waitDrone'], ['evening', 'waitDrone']]);
      expect(json.runs[0]?.ending).toBeNull();
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('命令表里的购买因为价签还没开放而失败时打印原因；写了 every 的命令隔几步再试，直到成功，连续失败的原因相同时合成一行', () => {
    const dir = join(ROOT, 'out');
    const table = join(dir, `test-campaign-retry-${process.pid}.json`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        table,
        JSON.stringify([
          { at: 100, every: 500, command: { type: 'buyBay', station: 0 } }, // 第 3600 步之前价签没开放，试到成功为止
          { at: DAY_STEPS + 1, every: 20, times: 2, command: { type: 'buyDrone', station: 0 } }, // 第 2 个成功之前先要有停机位
          { at: 50, command: { type: 'buyDoubleBox' } }, // 只试一次
        ]),
      );
      const r = cli(['--days', '2', '--seeds', '42', '--commands', table]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('命令 3 条');
      expect(r.stdout).toMatch(new RegExp(`命令 步 100 .*buyBay.* -> 失败 priceTagsLocked 价格 ${ECONOMY_V1.bayBase}，共 8 次，最后一次在步 3600`));
      expect(r.stdout).toMatch(/命令 步 4100 .*buyBay.* -> 成功/);
      expect(r.stdout).toMatch(new RegExp(`命令 步 50 .*buyDoubleBox.* -> 失败 priceTagsLocked 价格 ${ECONOMY_V1.doubleBoxPrice}\\n`));
      expect(r.stdout).toContain('站0 3/3/1'); // 一个停机位，一架飞机
    } finally {
      rmSync(table, { force: true });
    }
  });

  it('命令表里的 every 和 times 必须是正整数', () => {
    const dir = join(ROOT, 'out');
    mkdirSync(dir, { recursive: true });
    for (const bad of [{ every: 0 }, { every: 1.5 }, { every: 10, times: 0 }, { every: 'x' }]) {
      const table = join(dir, `test-campaign-bad-${process.pid}.json`);
      try {
        writeFileSync(table, JSON.stringify([{ at: 5, command: { type: 'buyBay', station: 0 }, ...bad }]));
        const r = cli(['--days', '1', '--commands', table]);
        expect(r.status, JSON.stringify(bad)).not.toBe(0);
      } finally {
        rmSync(table, { force: true });
      }
    }
  });
});

describe('准时的定义', () => {
  it('承诺时间 30 秒：送达用时不超过 300 步算准时', () => {
    expect(PROMISE_STEPS).toBe(300);
  });
});

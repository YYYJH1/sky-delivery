// 自动购买脚本：玩法的规则、一局的运行、节点的提取、汇总的算法、补丁、线程池和命令行。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { CAMPAIGN_RULES_V1 } from '../src/content/rules_v1.ts';
import { DAY_STEPS, OrderStatus } from '../src/core/index.ts';
import type { PeakRecord } from '../src/core/index.ts';
import { CLICK_DELAY, DECIDE_EVERY, NODE_INFO, POLICIES, POLICY_IDS, chooseRoof, playGame, ruleCommands, shoppingList, stepsToMinutes } from '../tools/autoplay-lib.ts';
import type { NodeId, RunRecord } from '../tools/autoplay-lib.ts';
import { applyPatch } from '../tools/autoplay-patch.ts';
import { quantile, renderMarkdown, summarize } from '../tools/autoplay-summary.ts';
import { createPool, nodesCsv, parseRunsJsonl, runsJsonl } from '../tools/autoplay.ts';
import { campaignOf, must, quietState, withMoney } from './campaign-helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFICE_ROOFS = MAP_V1.roofs.map((r, i) => (r.district === 1 ? i : -1)).filter((i) => i >= 0);

/** 有很多钱的开局：测试用，让玩法一开局就有东西可买。 */
const RICH = 100_000;

// ---- 分位数 ----

describe('分位数：最近秩法，没有达到的当作无穷大', () => {
  it('第 ceil(p × N) 个值，结果一定是某一局的真实取值', () => {
    const v = [5, 1, 3, 2, 4, 9, 8, 7, 6, 10];
    expect(quantile(v, 0.5)).toBe(5); // 第 5 个
    expect(quantile(v, 0.25)).toBe(3); // ceil(2.5) = 3
    expect(quantile(v, 0.75)).toBe(8); // ceil(7.5) = 8
    expect(quantile(v, 1)).toBe(10);
    expect(quantile([7], 0.25)).toBe(7);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('没有达到的局（null）排在最后：达到的不到一半时中位数是 null，分位数落在没达到的局上也是 null', () => {
    expect(quantile([1, 2, null, null], 0.5)).toBe(2); // 一半达到，中位数是第 2 个
    expect(quantile([1, null, null, null], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, null], 0.75)).toBe(3);
    expect(quantile([1, 2, 3, null], 1)).toBeNull();
    expect(quantile([null, null], 0.25)).toBeNull();
  });

  it('「中位数不超过 x」等价于「至少一半的局在 x 之前达到」', () => {
    const v = [6, 6, 6, 12, 12, 18, 18, 18, null, null];
    const median = quantile(v, 0.5) as number;
    expect(median).toBe(12);
    expect(v.filter((x) => x !== null && x <= median).length / v.length).toBeGreaterThanOrEqual(0.5);
    expect(v.filter((x) => x !== null && x < median).length / v.length).toBeLessThan(0.5);
  });
});

// ---- 补丁 ----

describe('补丁：把一份 JSON 合并进内容表，原地修改', () => {
  const tables = (): { economy: { price: number[]; cap: { small: number }; name: string; limit: number | null }; rows: { star: number; min: number }[] } => ({
    economy: { price: [1, 2, 3], cap: { small: 6 }, name: 'x', limit: null },
    rows: [
      { star: 2, min: 60 },
      { star: 3, min: 75 },
    ],
  });

  it('对象按键合并，数组里的元素按下标合并，整个数组替换时直接给数组，原来的对象和数组身份不变', () => {
    const t = tables();
    const price = t.economy.price;
    const first = t.rows[0];
    applyPatch(t, { economy: { price: [9, 8], cap: { small: 7 } }, rows: { '1': { min: 70 } } });
    expect(t.economy.price).toBe(price);
    expect(price).toEqual([9, 8]);
    expect(t.economy.cap.small).toBe(7);
    expect(t.rows[1]).toEqual({ star: 3, min: 70 });
    expect(t.rows[0]).toBe(first);
    expect(first).toEqual({ star: 2, min: 60 });
  });

  it('null 可以换成数，数也可以换成 null', () => {
    const t = tables();
    applyPatch(t, { economy: { limit: 8 } });
    expect(t.economy.limit).toBe(8);
    applyPatch(t, { economy: { limit: null } });
    expect(t.economy.limit).toBeNull();
  });

  it('写错了就抛错，不悄悄忽略：表不认识、键不存在、下标越界、类型不同、整张表不是对象', () => {
    const bad: unknown[] = [
      { nothing: { a: 1 } },
      { economy: { typo: 1 } },
      { economy: { cap: { medium: 1 } } },
      { rows: { '5': { min: 1 } } },
      { rows: { x: { min: 1 } } },
      { economy: { name: 5 } },
      { economy: { price: 5 } },
      { economy: 5 },
      [1, 2],
      null,
    ];
    for (const patch of bad) {
      expect(() => applyPatch(tables(), patch), JSON.stringify(patch)).toThrow(RangeError);
    }
  });
});

// ---- 玩法的规则 ----

describe('玩法：购物清单', () => {
  it('有空停机位的站先添飞机，没有空停机位就加停机位：开局的站 2 个停机位 2 架飞机，先加停机位，再添飞机', () => {
    const state = withMoney(quietState());
    const spec = { ...POLICIES.balanced, buys: { ...POLICIES.balanced.buys, district: false } }; // 先不看开通写字楼区
    const first = shoppingList(state, spec)[0];
    expect(first).toEqual({ type: 'buyBay', station: 0 });
    must(state, first as Parameters<typeof must>[1]);
    expect(shoppingList(state, spec)[0]).toEqual({ type: 'buyDrone', station: 0 });
  });

  it('有几座站时，在有空停机位的站里飞机最少的那座添飞机，并列取编号小的', () => {
    const state = withMoney(quietState());
    for (const d of campaignOf(state).districts) d.open = true;
    const second = must(state, { type: 'buildStation', roof: OFFICE_ROOFS[0] as number });
    must(state, { type: 'buyBay', station: 0 });
    must(state, { type: 'buyBay', station: 0 }); // 站 0：4 个停机位 2 架飞机，站 1：2 个停机位 0 架飞机
    expect(shoppingList(state, POLICIES.balanced)[0]).toEqual({ type: 'buyDrone', station: second });
    must(state, { type: 'buyDrone', station: second });
    must(state, { type: 'buyDrone', station: second }); // 站 1 满了（2 架），站 0 有 2 架
    expect(shoppingList(state, POLICIES.balanced)[0]).toEqual({ type: 'buyDrone', station: 0 });
  });

  it('写字楼区还没开通时，清单的第一项是开通它，开通之后是在写字楼区建站，选址不选小屋顶', () => {
    const state = withMoney(quietState());
    expect(shoppingList(state, POLICIES.balanced)[0]).toEqual({ type: 'openDistrict', district: 1 });
    campaignOf(state).districts[1]!.open = true;
    const list = shoppingList(state, POLICIES.balanced);
    expect(list[0]?.type).toBe('buildStation');
    const roof = (list[0] as { roof: number }).roof;
    expect(MAP_V1.roofs[roof]?.district).toBe(1);
    expect(MAP_V1.roofs[roof]?.size).not.toBe('small');
    expect(chooseRoof(state, 1)).toBe(roof);
    // 写字楼区有站之后不再列建站
    must(state, list[0] as Parameters<typeof must>[1]);
    expect(shoppingList(state, POLICIES.balanced).some((c) => c.type === 'buildStation')).toBe(false);
  });

  it('屋顶放满之后在双层货箱、新站、起降口之间选：没有小结时按双层货箱、新站、起降口排', () => {
    const state = withMoney(quietState());
    const station = state.stations[0] as { bays: number };
    station.bays = 9;
    for (let i = 0; i < 7; i++) must(state, { type: 'buyDrone', station: 0 }); // 9 架飞机，9 个停机位，开局的屋顶是中屋顶，上限 9
    campaignOf(state).districts[1]!.open = false;
    const list = shoppingList(state, { ...POLICIES.balanced, buys: { ...POLICIES.balanced.buys, district: false } });
    expect(list.map((c) => c.type)).toEqual(['buyDoubleBox', 'buildStation', 'upgradeGate']);
    // 只扩建一座站：不列建站。只买飞机：什么也不列
    expect(shoppingList(state, { ...POLICIES.singleStation, buys: { ...POLICIES.singleStation.buys, district: false } }).map((c) => c.type)).toEqual(['buyDoubleBox', 'upgradeGate']);
    expect(shoppingList(state, { ...POLICIES.dronesOnly, buys: { ...POLICIES.dronesOnly.buys, district: false } })).toEqual([]);
  });

  it('按最近一场高峰小结的主句排顺序：等起降口先升起降口，路上先建新站', () => {
    const state = withMoney(quietState());
    (state.stations[0] as { bays: number }).bays = 9;
    for (let i = 0; i < 7; i++) must(state, { type: 'buyDrone', station: 0 });
    const spec = { ...POLICIES.balanced, buys: { ...POLICIES.balanced.buys, district: false } };
    const record = (main: string): PeakRecord =>
      ({ day: 0, peak: 'noon', step: 0, orders: 1, onTime: 0, late: 1, lateOpen: 0, cancelled: 0, revenue: 0, districts: [], segments: null, select: 'fifo', early: null, changedMidPeak: false, main: { id: main }, extra: null }) as unknown as PeakRecord;
    campaignOf(state).peaks.push(record('waitGate'));
    expect(shoppingList(state, spec).map((c) => c.type)).toEqual(['upgradeGate', 'buildStation', 'buyDoubleBox']);
    campaignOf(state).peaks.push(record('road'));
    expect(shoppingList(state, spec).map((c) => c.type)).toEqual(['buildStation', 'buyDoubleBox', 'upgradeGate']);
    campaignOf(state).peaks.push(record('waitDrone'));
    expect(shoppingList(state, spec).map((c) => c.type)).toEqual(['buyDoubleBox', 'buildStation', 'upgradeGate']);
  });

  it('不操作的玩法清单永远是空的', () => {
    const state = withMoney(quietState());
    expect(shoppingList(state, POLICIES.idle)).toEqual([]);
    expect(ruleCommands(state, POLICIES.idle)).toEqual([]);
  });
});

describe('玩法：换卡', () => {
  it('「先送哪张单」一栏没开放时不换，开放后换成快超时的先送，换好之后不再重复下命令', () => {
    const closed = quietState({}, false);
    expect(ruleCommands(closed, POLICIES.balanced)).toEqual([]);
    const state = quietState({}, false);
    campaignOf(state).unlocks.selectColumn = 0; // 只开放「先送哪张单」一栏
    expect(ruleCommands(state, POLICIES.balanced)).toEqual([{ type: 'setRules', rules: { select: 'deadline' } }]);
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    expect(ruleCommands(state, POLICIES.balanced)).toEqual([]);
  });

  it('有两座以上的站，「别的站帮不帮」换成等 10 秒再帮', () => {
    const state = withMoney(quietState());
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    for (const d of campaignOf(state).districts) d.open = true;
    must(state, { type: 'buildStation', roof: OFFICE_ROOFS[0] as number });
    expect(ruleCommands(state, POLICIES.balanced).some((c) => c.type === 'setRules' && (c.rules as { zone?: string }).zone === 'hybrid')).toBe(true);
  });

  it('分成午晚两套之后各改各的：午高峰那套在「某一片的先送」开放后换成写字楼区的先送，晚高峰那套保持快超时的先送', () => {
    const state = withMoney(quietState());
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    const campaign = campaignOf(state);
    campaign.districts[1]!.open = true; // 开通写字楼区，下一步或下一个命令时分成两套
    must(state, { type: 'buyBay', station: 0 });
    expect(campaign.ruleSets).not.toBeNull();
    const commands = ruleCommands(state, POLICIES.balanced);
    expect(commands.filter((c) => c.type === 'setRules' && (c.rules as { select?: string }).select === 'prioOffice')).toEqual([{ type: 'setRules', rules: { select: 'prioOffice' }, peak: 'noon' }]);
    for (const c of commands) must(state, c);
    expect(campaign.ruleSets?.noon.select).toBe('prioOffice');
    expect(campaign.ruleSets?.evening.select).toBe('deadline');
    expect(ruleCommands(state, POLICIES.balanced)).toEqual([]); // 不会来回改
  });

  it('全程不换卡的玩法从不下换卡的命令', () => {
    const state = withMoney(quietState());
    expect(ruleCommands(state, POLICIES.noCards)).toEqual([]);
  });

  it('所有玩法都只换「先送哪张单」和「别的站帮不帮」，换的卡都在经营模式的卡表里，不碰「一趟送几单」，也就不选「一趟送一单」', () => {
    // 开放项全部打开，三个片区开通，建了第二座站，分成午晚两套：玩法能换的卡都摆出来了
    const make = (): ReturnType<typeof quietState> => {
      const state = withMoney(quietState());
      for (const d of campaignOf(state).districts) d.open = true;
      must(state, { type: 'buildStation', roof: OFFICE_ROOFS[0] as number });
      must(state, { type: 'buyBay', station: 0 });
      return state;
    };
    for (const id of POLICY_IDS) {
      const commands = ruleCommands(make(), POLICIES[id]);
      if (id === 'noCards' || id === 'idle') expect(commands, id).toEqual([]);
      else expect(commands.length, id).toBeGreaterThan(0);
      const state = make();
      for (const command of commands) {
        expect(command.type, id).toBe('setRules');
        if (command.type !== 'setRules') continue;
        for (const [column, card] of Object.entries(command.rules)) {
          expect(['select', 'zone'], `${id} ${column}`).toContain(column);
          expect(CAMPAIGN_RULES_V1[column as 'select' | 'zone'], `${id} ${column}`).toContain(card);
        }
        must(state, command); // 核心不拒绝
      }
    }
  });

  it('一局里换卡的命令都成功：玩法下的每一条换卡命令核心都接受，没有一条被表外的卡拒绝', () => {
    const { record, state } = playGame('balanced', 42, { days: 8, startMoney: RICH });
    expect(record.cardChanges).toBeGreaterThan(0);
    expect(state.stats.ruleChanges.every((c) => c.column !== 'pool')).toBe(true); // 玩家没有换过「一趟送几单」，买货箱时的自动换卡不记录
  });
});

// ---- 一局 ----

describe('一局：同一种子同一玩法的结果完全相同', () => {
  it.each(POLICY_IDS)('%s：运行两次，记录逐项相同，状态哈希相同，换种子则不同', (id) => {
    const a = playGame(id, 42, { days: 3 });
    const b = playGame(id, 42, { days: 3 });
    expect(b.record).toEqual(a.record);
    expect(JSON.stringify(b.record)).toBe(JSON.stringify(a.record));
    expect(b.record.hash).toBe(a.record.hash);
    expect(playGame(id, 43, { days: 3 }).record.hash).not.toBe(a.record.hash);
  });

  it('每局只由种子和玩法决定：交错运行别的局，结果不受影响', () => {
    const alone = playGame('balanced', 44, { days: 4, startMoney: 3000 }).record;
    playGame('noCards', 45, { days: 2 });
    playGame('dronesOnly', 46, { days: 2 });
    expect(playGame('balanced', 44, { days: 4, startMoney: 3000 }).record).toEqual(alone);
  });
});

describe('一局：开局的五张订单', () => {
  it.each(POLICY_IDS)('%s：第一天里五张开局订单都被点击，每张在出现 1 秒之后，自动派单随后打开', (id) => {
    const { state, record } = playGame(id, 42, { days: 1 });
    const campaign = campaignOf(state);
    expect(campaign.opening.orders.length).toBe(5);
    for (const orderId of campaign.opening.orders) {
      const order = state.orders[orderId] as { manualAt: number; tOrder: number };
      expect(order.manualAt, `order ${orderId}`).toBe(order.tOrder + CLICK_DELAY);
    }
    const done = campaign.opening.orders.map((orderId) => (state.orders[orderId] as { status: number }).status);
    expect(done.every((s) => s === OrderStatus.Delivered || s === OrderStatus.Cancelled)).toBe(true);
    expect(campaign.opening.done).toBe(true);
    expect(record.days).toBe(1);
  });
});

describe('一局：不操作', () => {
  it('点完五张订单之后什么也不做：没有购买，没有换卡，余额就是进账', () => {
    const { state, record } = playGame('idle', 42, { days: 4, startMoney: RICH });
    const campaign = campaignOf(state);
    expect(record.purchases).toEqual([]);
    expect(campaign.spent).toBe(0);
    expect(campaign.refunded).toBe(0);
    expect(record.cardChanges).toBe(0);
    expect(state.stats.ruleChanges).toEqual([]);
    expect(state.rules).toEqual({ select: 'fifo', zone: 'global', pool: 'single' });
    expect(state.stations.length).toBe(1);
    expect(state.drones.length).toBe(2);
    expect(campaign.districts.map((d) => d.open)).toEqual([true, false, false]);
    const income = campaign.income.reduce((a, b) => a + b, 0);
    expect(campaign.money).toBeCloseTo(RICH + income, 6);
    expect(record.nodes.firstPurchase).toBeNull();
    expect(record.maxGap).toBe(0);
  });
});

describe('一局：均衡', () => {
  it('调度台开放后很快换成快超时的先送，第一次购买在第一天日结之后', () => {
    const { record, state } = playGame('balanced', 42, { days: 3 });
    expect(record.nodes.selectOpen).not.toBeNull();
    expect(record.nodes.selectSet).not.toBeNull();
    expect(record.nodes.selectSet as number).toBeGreaterThanOrEqual(record.nodes.selectOpen as number);
    expect((record.nodes.selectSet as number) - (record.nodes.selectOpen as number)).toBeLessThanOrEqual(DECIDE_EVERY);
    expect(state.rules.select).toBe('deadline');
    const first = record.purchases[0];
    expect(first?.step).toBeGreaterThan(DAY_STEPS); // 价签在第一次日结之后才开放
    expect(first?.step).toBeLessThanOrEqual(DAY_STEPS + 2 * DECIDE_EVERY);
    expect(record.nodes.firstPurchase).toBe(first?.step);
  });

  it('购买的账目对得上：花的钱等于购买记录的价格之和，余额等于进账减花费，间隔和攒钱的时间合乎定义', () => {
    const { record, state } = playGame('balanced', 43, { days: 5 });
    const campaign = campaignOf(state);
    const spent = record.purchases.reduce((s, p) => s + p.price, 0);
    expect(campaign.spent).toBeCloseTo(spent, 6);
    expect(campaign.refunded).toBe(0);
    const income = state.orders.filter((o) => o.status === OrderStatus.Delivered).reduce((s, o) => s + o.rev, 0);
    expect(campaign.money).toBeCloseTo(income - spent, 6);
    let last = 0;
    for (const p of record.purchases) {
      expect(p.gap).toBe(p.step - last);
      expect(p.saving).toBeLessThanOrEqual(p.gap);
      expect(p.saving % DECIDE_EVERY).toBe(0);
      last = p.step;
    }
    expect(record.maxGap).toBe(Math.max(...record.purchases.map((p) => p.gap)));
    expect(record.daily.length).toBe(5);
    for (const d of record.daily) expect(d.lines.length).toBeGreaterThan(0); // 每天都有日结
  });

  it('老街三星之后开通写字楼区，在写字楼区建第二座站，换成两套规矩，别的站帮不帮换成等 10 秒再帮', () => {
    const { record, state } = playGame('balanced', 42, { days: 8 });
    const campaign = campaignOf(state);
    expect(record.nodes.officeOpened).not.toBeNull();
    expect(record.nodes.officeOpened as number).toBeGreaterThanOrEqual(record.nodes.oldStreet3 as number);
    expect(campaign.districts[1]?.open).toBe(true);
    expect(record.nodes.secondStation).not.toBeNull();
    expect(record.nodes.secondStation as number).toBeGreaterThan(record.nodes.officeOpened as number);
    const built = record.purchases.find((p) => p.type === 'buildStation');
    expect(MAP_V1.roofs[built?.target as number]?.district).toBe(1);
    expect(campaign.ruleSets).not.toBeNull();
    expect(campaign.ruleSets?.noon.zone).toBe('hybrid');
    expect(campaign.ruleSets?.evening.zone).toBe('hybrid');
    expect(record.crossRiver).not.toBeNull();
  });
});

describe('一局：只扩建一座站', () => {
  it('钱再多也从不建站，只买飞机、停机位、起降口升级和双层货箱，会开通写字楼区', () => {
    const { record, state } = playGame('singleStation', 42, { days: 8, startMoney: RICH });
    expect(state.stations.length).toBe(1);
    expect(record.purchases.some((p) => p.type === 'buildStation')).toBe(false);
    expect(record.nodes.secondStation).toBeNull();
    const types = new Set(record.purchases.map((p) => p.type));
    for (const t of types) expect(['buyDrone', 'buyBay', 'upgradeGate', 'buyDoubleBox', 'openDistrict']).toContain(t);
    expect(types.has('buyDrone')).toBe(true);
    expect(types.has('upgradeGate')).toBe(true); // 屋顶放满之后升起降口
    expect(campaignOf(state).districts[1]?.open).toBe(true);
    // 屋顶放满：开局的屋顶是中屋顶，上限 9 个停机位
    expect((state.stations[0] as { bays: number }).bays).toBe(9);
    expect(state.drones.filter((d) => !d.removed).length).toBe(9);
  });
});

describe('一局：全程不换卡', () => {
  it('从不下换卡的命令：规矩卡一直是开局的，先送哪张单和别的站帮不帮始终不变（买了货箱时核心自动换一趟送几单，不算玩家换卡）', () => {
    const { record, state } = playGame('noCards', 42, { days: 8, startMoney: RICH });
    expect(record.cardChanges).toBe(0);
    expect(record.nodes.selectSet).toBeNull();
    expect(state.stats.ruleChanges).toEqual([]);
    expect(state.rules.select).toBe('fifo');
    expect(state.rules.zone).toBe('global');
    expect(campaignOf(state).ruleSets?.noon.select ?? 'fifo').toBe('fifo');
    expect(campaignOf(state).ruleSets?.evening.zone ?? 'global').toBe('global');
    // 钱多时照样扩建：建了第二座站，两座站，别的站帮不帮仍是开局的卡
    expect(state.stations.length).toBeGreaterThanOrEqual(2);
    expect(record.purchases.length).toBeGreaterThan(10);
  });

  it('每一天结束时的规矩都与开局的相同（只买飞机不买货箱的情形下三栏全都不变）', () => {
    const { state } = playGame('noCards', 43, { days: 3 });
    expect(state.rules).toEqual({ select: 'fifo', zone: 'global', pool: 'single' });
  });
});

describe('一局：只买飞机', () => {
  it('只买飞机、放下这些飞机必须的停机位和开通片区：不建站，不升起降口，不买货箱', () => {
    const { record, state } = playGame('dronesOnly', 42, { days: 8, startMoney: RICH });
    const types = new Set(record.purchases.map((p) => p.type));
    for (const t of types) expect(['buyDrone', 'buyBay', 'openDistrict']).toContain(t);
    expect(state.stations.length).toBe(1);
    expect(state.capacity).toBe(1);
    expect(campaignOf(state).stations[0]?.gateLevel).toBe(1);
    expect(campaignOf(state).districts[1]?.open).toBe(true);
    // 每买一个停机位之前，站上没有空停机位：飞机数始终等于停机位数
    expect(state.drones.filter((d) => !d.removed).length).toBe((state.stations[0] as { bays: number }).bays);
  });
});

// ---- 节点 ----

describe('节点：从日结记录、解锁和购买记录里提取', () => {
  const nodes = (record: RunRecord): Record<NodeId, number | null> => record.nodes;

  it('星级节点在日结的那一步：第一天日结在第 3600 步，所以是 6 分钟的整数倍', () => {
    const { record } = playGame('balanced', 42, { days: 6 });
    for (const id of ['oldStreet2', 'oldStreet3', 'office3'] as const) {
      const v = nodes(record)[id];
      if (v !== null) expect(v % DAY_STEPS, id).toBe(0);
    }
    expect(stepsToMinutes(3600)).toBe(6);
  });

  it('写字楼区显示的那一步和老街升到三星的那一步相同，第二座站是第一次建站，第一个需要比较的购买选择是三件事里最早的', () => {
    const { record } = playGame('balanced', 42, { days: 8, startMoney: RICH });
    const n = nodes(record);
    expect(n.officeShown).toBe(n.oldStreet3);
    expect(n.secondStation).toBe(record.purchases.find((p) => p.type === 'buildStation')?.step);
    const candidates = [n.secondStation, n.doubleBoxOpen, n.firstGate].filter((v): v is number => v !== null);
    expect(n.firstChoice).toBe(Math.min(...candidates));
    expect(n.officeOpened).toBe(record.purchases.find((p) => p.type === 'openDistrict')?.step);
  });

  it('每个节点都有一个说明，主节点八个', () => {
    expect(NODE_INFO.filter((i) => i.target !== null).map((i) => i.id)).toEqual(['firstPurchase', 'oldStreet2', 'oldStreet3', 'officeShown', 'secondStation', 'firstChoice', 'office3', 'campusShown']);
    const { record } = playGame('idle', 42, { days: 1 });
    expect(Object.keys(record.nodes).sort()).toEqual(NODE_INFO.map((i) => i.id).sort());
  });
});

// ---- 汇总 ----

describe('汇总', () => {
  const base = playGame('balanced', 42, { days: 3 }).record;
  const fake = (seed: number, nodes: Partial<Record<NodeId, number | null>>, extra: Partial<RunRecord> = {}): RunRecord => ({
    ...base,
    seed,
    nodes: { ...base.nodes, firstPurchase: null, oldStreet2: null, oldStreet3: null, officeShown: null, secondStation: null, firstChoice: null, office3: null, campusShown: null, ...nodes },
    ...extra,
  });

  it('节点的分位数、达到的比例、第一天升二星的比例', () => {
    const records = [fake(1, { oldStreet2: 3600 }), fake(2, { oldStreet2: 3600 }), fake(3, { oldStreet2: 7200 }), fake(4, {})];
    const s = summarize(records, 't').policies[0]!;
    const stat = s.nodes.oldStreet2;
    expect(stat).toMatchObject({ runs: 4, reached: 3, p25: 6, p50: 6, p75: 12 });
    expect(stat.medianReached).toBe(6);
    expect(s.day1Star2).toBe(0.5);
    expect(s.starByDay.oldStreet2.slice(0, 3)).toEqual([0.5, 0.75, 0.75]);
    expect(s.nodes.office3).toMatchObject({ reached: 0, p50: null });
  });

  it('过河单：全部种子合并算，也给每个种子前 3 天的分位数，没开通写字楼区的局不算', () => {
    const records = [
      fake(1, {}, { crossRiver: { openStep: 0, orders: [10, 10, 10, 0, 0], fromOld: [5, 5, 5, 0, 0] } }),
      fake(2, {}, { crossRiver: { openStep: 0, orders: [10, 0, 0, 0, 0], fromOld: [1, 0, 0, 0, 0] } }),
      fake(3, {}, { crossRiver: null }),
    ];
    const c = summarize(records, 't').policies[0]!.crossRiver;
    expect(c.runs).toBe(2);
    expect(c.pooled.days1).toBeCloseTo(6 / 20, 12);
    expect(c.pooled.days3).toBeCloseTo(16 / 40, 12);
    expect(c.orders3).toBe(40);
    expect(c.perRun3.n).toBe(2);
    expect(c.perRun3.p50).toBeCloseTo(0.1, 12);
  });

  it('攒钱时间：每局最长的间隔按游戏日算，不超过两天的局占的比例，间隔超过两天的购买按种类数', () => {
    const records = [
      fake(1, {}, { maxGap: 2 * DAY_STEPS, maxSaving: DAY_STEPS, purchases: [{ step: 2 * DAY_STEPS, type: 'buyBay', target: 0, price: 70, gap: 2 * DAY_STEPS, saving: DAY_STEPS, balance: 0 }] }),
      fake(2, {}, { maxGap: 3 * DAY_STEPS, maxSaving: 3 * DAY_STEPS, purchases: [{ step: 3 * DAY_STEPS, type: 'buildStation', target: 3, price: 500, gap: 3 * DAY_STEPS, saving: 3 * DAY_STEPS, balance: 0 }] }),
    ];
    const s = summarize(records, 't').policies[0]!.saving;
    expect(s.gapWithinTwoDays).toBe(0.5);
    expect(s.savingWithinTwoDays).toBe(0.5);
    expect(s.gapDaysMax).toBe(3);
    expect(s.overTwoDays).toEqual([{ type: 'buildStation', count: 1 }]);
  });

  it('固定玩法：两个片区都三星的时间取较晚的，按 60、72 分钟和局内统计比例', () => {
    const long = { days: 16 };
    const records = [
      fake(1, { oldStreet3: 7200, office3: 3600 * 8 }, long), // 48 分钟
      fake(2, { oldStreet3: 7200, office3: 3600 * 11 }, long), // 66 分钟
      fake(3, { oldStreet3: 7200 }, long), // 写字楼区没到三星
      fake(4, { oldStreet3: 7200, office3: 3600 * 13 }, long), // 78 分钟
    ];
    const f = summarize(records, 't').policies[0]!.fixed;
    expect(f.within60).toBe(0.25);
    expect(f.within72).toBe(0.5);
    expect(f.withinHorizon).toBe(0.75); // 局内 96 分钟
    expect(f.bothThree.p50).toBe(66);
    expect(f.bothThree.p75).toBe(78);
    expect(f.bothThree.p25).toBe(48);
  });

  it('Markdown 汇总包含全部章节和各玩法的名称', () => {
    const records = POLICY_IDS.flatMap((id) => [playGame(id, 42, { days: 2 }).record, playGame(id, 43, { days: 2 }).record]);
    const text = renderMarkdown(summarize(records, '测试'));
    for (const heading of ['## 一 节点的时间', '## 二 均衡玩法对照目标', '## 三', '## 四 写字楼区的过河单', '## 五 攒钱时间', '## 六', '## 七']) expect(text).toContain(heading);
    for (const id of POLICY_IDS) expect(text).toContain(POLICIES[id].name);
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });
});

// ---- 线程池和命令行 ----

describe('线程池：工作线程里的结果与主线程里的逐项相同', () => {
  it('两个线程跑四局，顺序与任务表一致', async () => {
    const pool = createPool(2);
    try {
      const tasks = [
        { policy: 'balanced' as const, seed: 42, days: 2, clickDelay: CLICK_DELAY },
        { policy: 'idle' as const, seed: 43, days: 2, clickDelay: CLICK_DELAY },
        { policy: 'dronesOnly' as const, seed: 44, days: 2, clickDelay: CLICK_DELAY },
        { policy: 'noCards' as const, seed: 45, days: 2, clickDelay: CLICK_DELAY },
      ];
      const results = await pool.run(tasks);
      expect(results.length).toBe(4);
      results.forEach((r, i) => {
        const t = tasks[i] as (typeof tasks)[number];
        expect(r).toEqual(playGame(t.policy, t.seed, { days: t.days }).record);
      });
    } finally {
      await pool.close();
    }
  });

  it('线程数要在 1 到 16 之间', () => {
    expect(() => createPool(0)).toThrow(RangeError);
    expect(() => createPool(17)).toThrow(RangeError);
  });
});

describe('命令行：小规模的端到端', () => {
  const run = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/autoplay.ts', ...args], { cwd: ROOT, encoding: 'utf8' });

  it('两种玩法、两个种子、三天：写出原始数据、节点表、汇总表和运行信息，与进程内运行的结果逐项相同', () => {
    const out = join(ROOT, 'out', `test-autoplay-${process.pid}`);
    try {
      const r = run(['--out', out, '--policies', 'balanced,idle', '--seeds', '42-43', '--days', '3', '--workers', '2', '--quiet']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const records = parseRunsJsonl(readFileSync(join(out, 'runs.jsonl'), 'utf8'));
      expect(records.map((x) => `${x.policy}#${x.seed}`)).toEqual(['balanced#42', 'balanced#43', 'idle#42', 'idle#43']);
      for (const rec of records) expect(JSON.parse(JSON.stringify(rec))).toEqual(JSON.parse(JSON.stringify(playGame(rec.policy, rec.seed, { days: 3 }).record)));
      const csv = readFileSync(join(out, 'nodes.csv'), 'utf8').trim().split('\n');
      expect(csv.length).toBe(1 + 4);
      expect(csv[0]?.split(',').slice(0, 3)).toEqual(['policy', 'seed', 'firstPurchase']);
      expect(nodesCsv(records)).toBe(readFileSync(join(out, 'nodes.csv'), 'utf8'));
      expect(runsJsonl(records)).toBe(readFileSync(join(out, 'runs.jsonl'), 'utf8'));
      const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as { policies: { id: string }[] };
      expect(summary.policies.map((p) => p.id)).toEqual(['balanced', 'idle']);
      expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('## 一 节点的时间');
      const info = JSON.parse(readFileSync(join(out, 'run_info.json'), 'utf8')) as { patch: unknown; runs: number; settings: { days: number } };
      expect(info).toMatchObject({ patch: null, runs: 4, settings: { days: 3 } });
      // 不重跑，只重写汇总
      rmSync(join(out, 'summary.md'));
      const again = run(['--resummarize', out, '--quiet']);
      expect(again.status).toBe(0);
      expect(existsSync(join(out, 'summary.md'))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('补丁：改了价格，这一批的结果就不同，补丁记进运行信息，写错的补丁在运行前就报错', () => {
    const out = join(ROOT, 'out', `test-autoplay-patch-${process.pid}`);
    try {
      const args = ['--out', out, '--policies', 'balanced', '--seeds', '42', '--days', '3', '--workers', '1', '--quiet'];
      expect(run(args).status).toBe(0);
      const plain = parseRunsJsonl(readFileSync(join(out, 'runs.jsonl'), 'utf8'));
      const patch = '{"economy":{"droneBase":40,"bayBase":50}}';
      const patched = run([...args, '--patch', patch]);
      expect(patched.stderr).toBe('');
      expect(patched.status).toBe(0);
      const after = parseRunsJsonl(readFileSync(join(out, 'runs.jsonl'), 'utf8'));
      expect(after[0]?.hash).not.toBe(plain[0]?.hash);
      expect(after[0]?.purchases[0]?.price).toBeLessThan(plain[0]?.purchases[0]?.price as number);
      const info = JSON.parse(readFileSync(join(out, 'run_info.json'), 'utf8')) as { patch: unknown };
      expect(info.patch).toEqual({ economy: { droneBase: 40, bayBase: 50 } });
      const bad = run([...args, '--patch', '{"economy":{"nothing":1}}']);
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain('economy.nothing');
      expect(run(['--policies', 'nobody', '--out', out]).status).not.toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('补丁对核心里加载时算出的东西也起作用：改订单量曲线，来单数就不同', () => {
    const out = join(ROOT, 'out', `test-autoplay-curve-${process.pid}`);
    try {
      const args = ['--out', out, '--policies', 'idle', '--seeds', '42', '--days', '2', '--workers', '1', '--quiet'];
      expect(run(args).status).toBe(0);
      const plain = parseRunsJsonl(readFileSync(join(out, 'runs.jsonl'), 'utf8'));
      const zero = '{"districts":{"0":{"curveRate":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}}}';
      expect(run([...args, '--patch', zero]).status).toBe(0);
      const flat = parseRunsJsonl(readFileSync(join(out, 'runs.jsonl'), 'utf8'));
      const income = (r: RunRecord | undefined): number => (r?.daily ?? []).reduce((s, d) => s + d.income, 0);
      expect(income(plain[0])).toBeGreaterThan(0);
      expect(income(flat[0])).toBeLessThan(income(plain[0]) / 3); // 只剩开局的五张订单
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('玩法的名称', () => {
  it('五种玩法，名称各不相同', () => {
    expect(POLICY_IDS.length).toBe(5);
    expect(new Set(POLICY_IDS.map((id) => POLICIES[id].name)).size).toBe(5);
  });
});

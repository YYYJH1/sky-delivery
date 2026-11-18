// 自动购买脚本：玩法的规则、一局的运行、节点的提取、汇总的算法、补丁、线程池和命令行。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { STARS_V1 } from '../src/content/stars_v1.ts';
import { CAMPAIGN_RULES_V1 } from '../src/content/rules_v1.ts';
import { DAY_STEPS, EVENING_WINDOW, NOON_WINDOW, OrderStatus, addOrder, quoteCommand } from '../src/core/index.ts';
import type { PeakRecord } from '../src/core/index.ts';
import { CLICK_DELAY, DECIDE_EVERY, MAIN_NODES, NODE_INFO, POLICIES, POLICY_IDS, chooseRoof, gateCommand, peakOrdersOf, playGame, ruleCommands, shoppingList, stepsToMinutes } from '../tools/autoplay-lib.ts';
import type { NodeId, RunRecord } from '../tools/autoplay-lib.ts';
import { applyPatch } from '../tools/autoplay-patch.ts';
import { GOALS, WEAK_POLICIES, goalChecks, quantile, renderMarkdown, summarize } from '../tools/autoplay-summary.ts';
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
  it('有空停机位的站先购买无人机，没有空停机位就新增停机位：开局的站 2 个停机位 2 架无人机，先新增停机位，再购买无人机', () => {
    const state = withMoney(quietState());
    const spec = { ...POLICIES.balanced, buys: { ...POLICIES.balanced.buys, district: false } }; // 先不看开通写字楼区
    const first = shoppingList(state, spec)[0];
    expect(first).toEqual({ type: 'buyBay', station: 0 });
    must(state, first as Parameters<typeof must>[1]);
    expect(shoppingList(state, spec)[0]).toEqual({ type: 'buyDrone', station: 0 });
  });

  it('有几座站时，在有空停机位的站里无人机最少的那座购买无人机，并列取编号小的', () => {
    const state = withMoney(quietState());
    campaignOf(state).districts[1]!.open = true;
    const spec = { ...POLICIES.balanced, buys: { ...POLICIES.balanced.buys, district: false } }; // 先不看开通大学城
    const second = must(state, { type: 'buildStation', roof: OFFICE_ROOFS[0] as number });
    must(state, { type: 'buyBay', station: 0 });
    must(state, { type: 'buyBay', station: 0 }); // 站 0：4 个停机位 2 架飞机，站 1：2 个停机位 0 架飞机
    expect(shoppingList(state, spec)[0]).toEqual({ type: 'buyDrone', station: second });
    must(state, { type: 'buyDrone', station: second });
    must(state, { type: 'buyDrone', station: second }); // 站 1 满了（2 架），站 0 有 2 架
    expect(shoppingList(state, spec)[0]).toEqual({ type: 'buyDrone', station: 0 });
  });

  it('写字楼区还没开通时，清单的第一项是开通它，开通之后是在写字楼区建站，选址不选小屋顶', () => {
    const state = withMoney(quietState());
    expect(shoppingList(state, POLICIES.balanced)[0]).toEqual({ type: 'openDistrict', district: 1 });
    campaignOf(state).districts[1]!.open = true;
    const list = shoppingList(state, POLICIES.balanced);
    expect(list[0]).toEqual({ type: 'openDistrict', district: 2 }); // 写字楼区开通之后，下一个目标是大学城
    const build = list.find((c) => c.type === 'buildStation');
    expect(build).toBeDefined();
    const roof = (build as { roof: number }).roof;
    expect(MAP_V1.roofs[roof]?.district).toBe(1);
    expect(MAP_V1.roofs[roof]?.size).not.toBe('small');
    expect(chooseRoof(state, 1)).toBe(roof);
    // 写字楼区有站之后不再列建站
    must(state, build as Parameters<typeof must>[1]);
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

describe('玩法：升起降口的站', () => {
  /** 三座站，站 0 有 2 架飞机，站 1 有 3 架，站 2 有 1 架，起降口都是 1 级。 */
  function threeStations(): ReturnType<typeof quietState> {
    const state = withMoney(quietState());
    campaignOf(state).districts[1]!.open = true;
    must(state, { type: 'buildStation', roof: OFFICE_ROOFS[0] as number });
    must(state, { type: 'buildStation', roof: OFFICE_ROOFS[1] as number });
    must(state, { type: 'buyBay', station: 1 }); // 新站自带 2 个停机位，站 1 要放 3 架
    for (let i = 0; i < 3; i++) must(state, { type: 'buyDrone', station: 1 });
    must(state, { type: 'buyDrone', station: 2 });
    return state;
  }

  /** 一场小结的记录，只写选站要看的：附加句，和各站排队时间占比的一行。 */
  function record(extra: unknown, queuePcts: readonly number[] | null): PeakRecord {
    const stations = queuePcts === null ? undefined : queuePcts.map((queuePct, station) => ({ station, queuePct }));
    return { day: 0, peak: 'noon', step: 0, main: { id: 'waitGate' }, extra, stations } as unknown as PeakRecord;
  }

  const upgrade = (station: number): { type: 'upgradeGate'; station: number } => ({ type: 'upgradeGate', station });

  it('附加句是等待起飞或等待降落时，升它点名的站，不看各站的排队占比', () => {
    const state = threeStations();
    expect(gateCommand(state, record({ id: 'takeoffWait', station: 2, percent: 30 }, [60, 50, 1]))).toEqual(upgrade(2));
    expect(gateCommand(state, record({ id: 'landQueue', station: 1, count: 1.4 }, [60, 0, 50]))).toEqual(upgrade(1));
  });

  it('点名的站已经到 3 级时，改取排队占比最大的、还没到 3 级的站', () => {
    const state = threeStations();
    must(state, { type: 'upgradeGate', station: 2 });
    must(state, { type: 'upgradeGate', station: 2 });
    expect(gateCommand(state, record({ id: 'takeoffWait', station: 2, percent: 30 }, [10, 20, 90]))).toEqual(upgrade(1));
  });

  it('没有点名起降的附加句（别的附加句，或者没有附加句）时，升排队占比最大的站，并列取编号小的', () => {
    const state = threeStations();
    expect(gateCommand(state, record(null, [12, 30, 25]))).toEqual(upgrade(1));
    expect(gateCommand(state, record({ id: 'emptyFlight', percent: 40 }, [12, 30, 25]))).toEqual(upgrade(1));
    expect(gateCommand(state, record({ id: 'bayIdle', station: 2, percent: 60 }, [12, 25, 25]))).toEqual(upgrade(1));
    // 全是 0 也是并列，取编号最小的站
    expect(gateCommand(state, record(null, [0, 0, 0]))).toEqual(upgrade(0));
  });

  it('排队占比最大的站已经到 3 级时，取剩下的站里最大的', () => {
    const state = threeStations();
    must(state, { type: 'upgradeGate', station: 1 });
    must(state, { type: 'upgradeGate', station: 1 });
    expect(gateCommand(state, record(null, [12, 90, 25]))).toEqual(upgrade(2));
    // 三座站都到 3 级：没有可升的
    for (const station of [0, 2]) {
      must(state, { type: 'upgradeGate', station });
      must(state, { type: 'upgradeGate', station });
    }
    expect(gateCommand(state, record(null, [12, 90, 25]))).toBeNull();
  });

  it('上一场没有各站的记录时，沿用飞机最多的站：没有小结，或者记录里没有各站的行，或者行里的站都不能升', () => {
    const state = threeStations();
    expect(gateCommand(state, undefined)).toEqual(upgrade(1));
    expect(gateCommand(state, record(null, null))).toEqual(upgrade(1));
    expect(gateCommand(state, record(null, []))).toEqual(upgrade(1));
    // 记录里只有站 1，它已经到 3 级，站 0 和站 2 不在记录里：回到飞机最多的站里没到 3 级的，站 0 和站 2 里站 0 的飞机多
    must(state, { type: 'upgradeGate', station: 1 });
    must(state, { type: 'upgradeGate', station: 1 });
    expect(gateCommand(state, { ...record(null, null), stations: [{ station: 1, queuePct: 50 }] } as unknown as PeakRecord)).toEqual(upgrade(0));
  });

  it('不改购物清单的顺序：屋顶放满之后，等起降口先升起降口，升的站按新规则取', () => {
    const state = withMoney(quietState());
    (state.stations[0] as { bays: number }).bays = 9;
    for (let i = 0; i < 7; i++) must(state, { type: 'buyDrone', station: 0 });
    const spec = { ...POLICIES.balanced, buys: { ...POLICIES.balanced.buys, district: false } };
    campaignOf(state).peaks.push(record({ id: 'takeoffWait', station: 0, percent: 30 }, [30])); // 主句是等起降口
    expect(shoppingList(state, spec)).toEqual([upgrade(0), { type: 'buildStation', roof: chooseRoof(state, 0) }, { type: 'buyDoubleBox' }]);
  });
});

describe('玩法：大学城', () => {
  /** 写字楼区开通并到三星、已经显示大学城，写字楼区有站：开通大学城之前的局面。 */
  const readyForCampus = (): ReturnType<typeof quietState> => {
    const state = withMoney(quietState());
    const campaign = campaignOf(state);
    campaign.districts[1]!.open = true;
    campaign.districts[1]!.star = 3;
    campaign.unlocks.showOffice = 0;
    campaign.unlocks.showCampus = 0;
    must(state, { type: 'buildStation', roof: OFFICE_ROOFS[0] as number });
    return state;
  };

  it('写字楼区到三星、大学城显示之后，清单的第一项是开通大学城，开通之后是在大学城建第一座站，选址不选小屋顶', () => {
    const state = readyForCampus();
    expect(shoppingList(state, POLICIES.balanced)[0]).toEqual({ type: 'openDistrict', district: 2 });
    must(state, { type: 'openDistrict', district: 2 });
    const list = shoppingList(state, POLICIES.balanced);
    expect(list[0]?.type).toBe('buildStation');
    const roof = (list[0] as { roof: number }).roof;
    expect(MAP_V1.roofs[roof]?.district).toBe(2);
    expect(MAP_V1.roofs[roof]?.size).not.toBe('small');
    expect(chooseRoof(state, 2)).toBe(roof);
    must(state, list[0] as Parameters<typeof must>[1]);
    expect(shoppingList(state, POLICIES.balanced).some((c) => c.type === 'buildStation' || c.type === 'openDistrict')).toBe(false);
  });

  it('大学城还没显示，或者写字楼区还没到三星时，清单里的开通大学城核心会拒绝，脚本跳过它去买别的', () => {
    const state = readyForCampus();
    campaignOf(state).unlocks.showCampus = -1;
    const command = shoppingList(state, POLICIES.balanced)[0] as Parameters<typeof must>[1];
    expect(command).toEqual({ type: 'openDistrict', district: 2 });
    expect(quoteCommand(state, command).reason).toBe('districtHidden');
    campaignOf(state).unlocks.showCampus = 0;
    campaignOf(state).districts[1]!.star = 2;
    expect(quoteCommand(state, command).reason).toBe('needStars');
  });

  it('只买飞机和只扩建一座站也开通大学城，但不在那里建站', () => {
    for (const id of ['dronesOnly', 'singleStation'] as const) {
      const state = readyForCampus();
      const spec = POLICIES[id];
      const list = shoppingList(state, spec);
      expect(list[0], id).toEqual({ type: 'openDistrict', district: 2 });
      must(state, list[0] as Parameters<typeof must>[1]);
      expect(shoppingList(state, spec).some((c) => c.type === 'buildStation'), id).toBe(false);
    }
  });

  it('不操作的玩法清单仍然是空的，不开通大学城', () => {
    expect(shoppingList(readyForCampus(), POLICIES.idle)).toEqual([]);
  });

  it('「协同策略」：大学城建站之前是延迟支援，大学城建站之后换成全站协同，晚高峰那套的调度策略仍是时限优先', () => {
    const state = readyForCampus();
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    const zones = (): string[] =>
      ruleCommands(state, POLICIES.balanced)
        .filter((c) => c.type === 'setRules' && (c.rules as { zone?: string }).zone !== undefined)
        .map((c) => (c as { rules: { zone: string } }).rules.zone);
    expect(zones()).toEqual(['hybrid', 'hybrid']); // 午晚两套
    for (const c of ruleCommands(state, POLICIES.balanced)) must(state, c);
    must(state, { type: 'openDistrict', district: 2 });
    expect(zones()).toEqual([]); // 大学城开通了，但还没有站
    must(state, { type: 'buildStation', roof: chooseRoof(state, 2) });
    expect(zones()).toEqual(['global', 'global']);
    for (const c of ruleCommands(state, POLICIES.balanced)) must(state, c);
    expect(campaignOf(state).ruleSets?.evening).toMatchObject({ select: 'deadline', zone: 'global' });
    expect(ruleCommands(state, POLICIES.balanced)).toEqual([]);
    expect(ruleCommands(state, POLICIES.noCards)).toEqual([]);
  });
});

describe('玩法：换卡', () => {
  it('「调度策略」一栏没开放时不换，开放后换成时限优先，换好之后不再重复下命令', () => {
    const closed = quietState({}, false);
    expect(ruleCommands(closed, POLICIES.balanced)).toEqual([]);
    const state = quietState({}, false);
    campaignOf(state).unlocks.selectColumn = 0; // 只开放「调度策略」一栏
    expect(ruleCommands(state, POLICIES.balanced)).toEqual([{ type: 'setRules', rules: { select: 'deadline' } }]);
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    expect(ruleCommands(state, POLICIES.balanced)).toEqual([]);
  });

  it('有两座以上的站，「协同策略」换成延迟支援', () => {
    const state = withMoney(quietState());
    must(state, { type: 'setRules', rules: { select: 'deadline' } });
    for (const d of campaignOf(state).districts) d.open = true;
    must(state, { type: 'buildStation', roof: OFFICE_ROOFS[0] as number });
    expect(ruleCommands(state, POLICIES.balanced).some((c) => c.type === 'setRules' && (c.rules as { zone?: string }).zone === 'hybrid')).toBe(true);
  });

  it('分成午晚两套之后各改各的：午高峰那套在「{片区}优先」开放后换成写字楼区优先，晚高峰那套保持时限优先', () => {
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

  it('所有玩法都只换「调度策略」和「协同策略」，换的卡都在经营模式的卡表里，不碰「合单策略」，也就不选「单独配送」', () => {
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
    expect(state.stats.ruleChanges.every((c) => c.column !== 'pool')).toBe(true); // 玩家没有换过「合单策略」，买货箱时的自动换卡不记录
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
  it('调度台开放后很快换成时限优先，第一次购买在第一天日结之后', () => {
    const { record, state } = playGame('balanced', 42, { days: 3 });
    expect(record.nodes.selectOpen).not.toBeNull();
    expect(record.nodes.selectSet).not.toBeNull();
    expect(record.nodes.selectSet as number).toBeGreaterThanOrEqual(record.nodes.selectOpen as number);
    expect((record.nodes.selectSet as number) - (record.nodes.selectOpen as number)).toBeLessThanOrEqual(DECIDE_EVERY);
    // 写字楼区开通之后午高峰那套换成「写字楼区优先」，所以看第一次换卡
    expect(state.stats.ruleChanges.find((c) => c.column === 'select')?.to).toBe('deadline');
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

  it('老街三星之后开通写字楼区，在写字楼区建第二座站，换成两套策略，协同策略换成延迟支援', () => {
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

describe('一局：均衡玩到大学城', () => {
  it('写字楼区四星之后显示并开通大学城，在那里建站，之后「协同策略」是全站协同', () => {
    const { record, state } = playGame('balanced', 42, { days: 30 });
    const n = record.nodes;
    expect(n.campusShown).not.toBeNull();
    expect(n.campusOpened).not.toBeNull();
    expect(n.campusOpened as number).toBeGreaterThanOrEqual(n.campusShown as number);
    expect(n.campusShown as number).toBeGreaterThanOrEqual(n.office4 as number);
    const built = record.purchases.filter((p) => p.type === 'buildStation').map((p) => (MAP_V1.roofs[p.target as number] as { district: number }).district);
    expect(built).toContain(2);
    expect(campaignOf(state).districts[2]?.open).toBe(true);
    expect(state.rules.zone).toBe('global');
    expect(campaignOf(state).ruleSets?.noon.zone).toBe('global');
    expect(campaignOf(state).ruleSets?.evening.select).toBe('deadline');
  });

  it('全程不换卡的玩法同样开通大学城、在那里建站，策略卡仍是开局的', () => {
    const { record, state } = playGame('noCards', 42, { days: 30 });
    expect(record.nodes.campusOpened).not.toBeNull();
    expect(record.cardChanges).toBe(0);
    expect(state.rules).toMatchObject({ select: 'fifo', zone: 'global' });
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
  it('从不下换卡的命令：策略卡一直是开局的，调度策略和协同策略始终不变（买了货箱时核心自动换合单策略，不算玩家换卡）', () => {
    const { record, state } = playGame('noCards', 42, { days: 8, startMoney: RICH });
    expect(record.cardChanges).toBe(0);
    expect(record.nodes.selectSet).toBeNull();
    expect(state.stats.ruleChanges).toEqual([]);
    expect(state.rules.select).toBe('fifo');
    expect(state.rules.zone).toBe('global');
    expect(campaignOf(state).ruleSets?.noon.select ?? 'fifo').toBe('fifo');
    expect(campaignOf(state).ruleSets?.evening.zone ?? 'global').toBe('global');
    // 钱多时照样扩建：建了第二座站，两座站，协同策略仍是开局的卡
    expect(state.stations.length).toBeGreaterThanOrEqual(2);
    expect(record.purchases.length).toBeGreaterThan(10);
  });

  it('每一天结束时的策略都与开局的相同（只买飞机不买货箱的情形下三栏全都不变）', () => {
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

  it('每个节点都有一个说明，主节点十二个，其中有目标的是前期的七个和结局，大学城的节点没有目标', () => {
    expect(MAIN_NODES.length).toBe(12);
    expect(NODE_INFO.filter((i) => i.target !== null).map((i) => i.id)).toEqual(['firstPurchase', 'oldStreet2', 'oldStreet3', 'officeShown', 'secondStation', 'firstChoice', 'office3', 'ending']);
    expect(NODE_INFO.find((i) => i.id === 'ending')?.target).toEqual([120, 180]);
    // 双层货箱随价签开放，价签出现的那一刻（第一天结束）就要比较货箱、停机位和飞机，所以这个节点的目标是约 6 分钟，原来是 15 到 25 分钟
    expect(NODE_INFO.find((i) => i.id === 'firstChoice')?.target).toEqual([5.5, 6.5]);
    expect(NODE_INFO.find((i) => i.id === 'firstChoice')?.targetText).toBe('约 6');
    expect(NODE_INFO.slice(0, MAIN_NODES.length).map((i) => i.id)).toEqual([...MAIN_NODES]);
    const { record } = playGame('idle', 42, { days: 1 });
    expect(Object.keys(record.nodes).sort()).toEqual(NODE_INFO.map((i) => i.id).sort());
  });

  it('大学城的四个节点：开通是第一次开通片区 2，三星和四星在日结的那一步，结局是核心记下的那一步', () => {
    const { record, state } = playGame('balanced', 42, { days: 30 });
    const n = record.nodes;
    expect(n.campusOpened).toBe(record.purchases.find((p) => p.type === 'openDistrict' && p.target === 2)?.step);
    for (const id of ['campus3', 'campus4', 'oldStreet4', 'office4'] as const) {
      const v = n[id];
      if (v !== null) expect(v % DAY_STEPS, id).toBe(0);
    }
    const ending = campaignOf(state).ending;
    expect(n.ending).toBe(ending === null ? null : ending.step);
    if (n.ending !== null) {
      // 三个片区都到过四星之后才有结局，大学城四星不晚于结局
      expect(n.campus4 as number).toBeLessThanOrEqual(n.ending);
      expect(n.office4 as number).toBeLessThanOrEqual(n.ending);
      expect(n.oldStreet4 as number).toBeLessThanOrEqual(n.ending);
    }
  });
});

describe('高峰里各片区的订单：按下单时间落在午高峰或晚高峰的时段，按送往的片区数', () => {
  it('每天两行三列，包括退单的订单，时段之外的订单不算，没开通的片区是 0', () => {
    const { record, state } = playGame('balanced', 42, { days: 4 });
    const peaks = record.peakOrders;
    expect(peaks.noon.length).toBe(4);
    expect(peaks.evening.length).toBe(4);
    for (const row of [...peaks.noon, ...peaks.evening]) expect(row.length).toBe(3);
    // 与逐张订单数出来的相同
    const inNoon = state.orders.filter((o) => o.tOrder % DAY_STEPS >= NOON_WINDOW.start && o.tOrder % DAY_STEPS < NOON_WINDOW.end && Math.floor(o.tOrder / DAY_STEPS) < 4).length;
    const inEvening = state.orders.filter((o) => o.tOrder % DAY_STEPS >= EVENING_WINDOW.start && o.tOrder % DAY_STEPS < EVENING_WINDOW.end && Math.floor(o.tOrder / DAY_STEPS) < 4).length;
    expect(peaks.noon.flat().reduce((a, b) => a + b, 0)).toBe(inNoon);
    expect(peaks.evening.flat().reduce((a, b) => a + b, 0)).toBe(inEvening);
    expect(inNoon).toBeGreaterThan(0);
    for (const row of [...peaks.noon, ...peaks.evening]) expect(row[2]).toBe(0); // 前四天大学城没开通
    expect(peakOrdersOf(state, 4)).toEqual(peaks);
  });

  it('天数带小数时（玩到某一天的中途），最后不满一天的那天也数，不越界', () => {
    const { record, state } = playGame('balanced', 42, { days: 1.3 });
    expect(record.peakOrders.noon.length).toBe(2);
    expect(record.peakOrders.evening.length).toBe(2);
    const secondNoon = state.orders.filter((o) => Math.floor(o.tOrder / DAY_STEPS) === 1 && o.tOrder % DAY_STEPS >= NOON_WINDOW.start && o.tOrder % DAY_STEPS < NOON_WINDOW.end).length;
    expect(secondNoon).toBeGreaterThan(0);
    expect((record.peakOrders.noon[1] ?? []).reduce((a, b) => a + b, 0)).toBe(secondNoon);
  });

  it('时段的边界：午高峰是天内第 600 到 1499 步，晚高峰是第 2150 到 3099 步', () => {
    const state = quietState();
    const at = (tick: number): void => {
      addOrder(state, { merchant: 0, building: 0, portion: 1, prepSteps: 10, tOrder: tick });
    };
    for (const tick of [599, 600, 1499, 1500, 2149, 2150, 3099, 3100]) at(tick);
    const peaks = peakOrdersOf(state, 1);
    expect(peaks.noon[0]).toEqual([2, 0, 0]);
    expect(peaks.evening[0]).toEqual([2, 0, 0]);
  });
});

// ---- 汇总 ----

describe('汇总', () => {
  const base = playGame('balanced', 42, { days: 3 }).record;
  const fake = (seed: number, nodes: Partial<Record<NodeId, number | null>>, extra: Partial<RunRecord> = {}): RunRecord => ({
    ...base,
    seed,
    nodes: {
      ...base.nodes,
      firstPurchase: null,
      oldStreet2: null,
      oldStreet3: null,
      officeShown: null,
      secondStation: null,
      firstChoice: null,
      office3: null,
      campusShown: null,
      campusOpened: null,
      campus3: null,
      campus4: null,
      ending: null,
      officeOpened: null,
      oldStreet4: null,
      office4: null,
      ...nodes,
    },
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

  it('结局：局内到达的局数、分位数，在 120、150、180 分钟之前到达的比例，没有到达的局当作无穷大', () => {
    const m = (minutes: number): number => minutes * 600;
    const long = { days: 40 };
    const records = [fake(1, { ending: m(90) }, long), fake(2, { ending: m(126) }, long), fake(3, { ending: m(150) }, long), fake(4, { ending: m(186) }, long), fake(5, {}, long)];
    const e = summarize(records, 't').policies[0]!.ending;
    expect(e).toMatchObject({ runs: 5, reached: 4, p25: 126, p50: 150, p75: 186 });
    expect(e.within120).toBe(0.2);
    expect(e.within150).toBe(0.6);
    expect(e.within180).toBe(0.6);
    expect(summarize([fake(1, {}, long), fake(2, {}, long)], 't').policies[0]!.ending).toMatchObject({ reached: 0, p50: null, within180: 0 });
  });

  describe('各片区的订单占比', () => {
    const days = 12;
    const rows = (n: number[]): number[][] => Array.from({ length: days }, () => [...n]);
    /** 写字楼区在第 2 天开通，大学城在第 5 天开通，结局在第 7 天的日结，全程 12 天。 */
    const timeline = (): RunRecord => {
      const noon = rows([0, 0, 0]);
      const evening = rows([0, 0, 0]);
      for (const d of [3, 4]) {
        noon[d] = [10, 70, 20]; // 写字楼区开通之后，大学城开通之前
        evening[d] = [60, 40, 0];
      }
      for (const d of [6, 7]) {
        noon[d] = [20, 50, 30]; // 大学城开通之后，到结局那一天
        evening[d] = [20, 20, 60];
      }
      for (const d of [8, 9, 10, 11]) {
        noon[d] = [30, 40, 30]; // 结局之后
        evening[d] = [40, 30, 30];
      }
      noon[5] = [99, 99, 99]; // 大学城开通那一天只有半天，不算
      return fake(1, { officeOpened: 2 * DAY_STEPS + 100, campusOpened: 5 * DAY_STEPS + 1000, ending: 8 * DAY_STEPS }, { days, peakOrders: { noon, evening } });
    };

    it('三个时期各从一件事发生之后的第一个整天算起：开通那天、做日结的那天的前后都按定义划', () => {
      const s = summarize([timeline()], 't').policies[0]!.shares;
      expect(s.twoDistricts).toMatchObject({ runs: 1, days: 2, noon: [20, 140, 40], evening: [120, 80, 0] });
      expect(s.campus).toMatchObject({ runs: 1, days: 2, noon: [40, 100, 60], evening: [40, 40, 120] });
      expect(s.after).toMatchObject({ runs: 1, days: 4, noon: [120, 160, 120], evening: [160, 120, 120] });
      // 每个（局、天）里单场高峰最大的片区占的比例
      expect(s.campus.topNoon.p50).toBe(0.5);
      expect(s.campus.topEvening.p50).toBe(0.6);
      expect(s.twoDistricts.topNoon.p50).toBe(0.7);
    });

    it('没开通大学城的局，写字楼区开通之后一直算到局末，没有大学城时期和结局之后', () => {
      const r = fake(1, { officeOpened: 2 * DAY_STEPS + 100 }, { days, peakOrders: { noon: rows([10, 30, 0]), evening: rows([10, 30, 0]) } });
      const s = summarize([r], 't').policies[0]!.shares;
      expect(s.twoDistricts).toMatchObject({ runs: 1, days: 9, noon: [90, 270, 0] });
      expect(s.campus).toMatchObject({ runs: 0, days: 0 });
      expect(s.after).toMatchObject({ runs: 0, days: 0 });
    });

    it('没到结局的局，大学城开通之后一直算到局末', () => {
      const r = fake(1, { officeOpened: 2 * DAY_STEPS, campusOpened: 5 * DAY_STEPS + 1 }, { days, peakOrders: { noon: rows([10, 30, 20]), evening: rows([10, 30, 20]) } });
      expect(summarize([r], 't').policies[0]!.shares.campus.days).toBe(6); // 第 6 天到第 11 天
    });
  });

  describe('校准目标的核对', () => {
    const m = (minutes: number): number => minutes * 600;
    const long = { days: 40 };
    const ok = (id: 'balanced' | 'singleStation' | 'noCards' | 'dronesOnly' | 'idle', ending: number | null, extra: Partial<RunRecord> = {}): RunRecord => ({
      ...fake(1, ending === null ? {} : { ending: m(ending) }, { ...long, policy: id, maxSaving: DAY_STEPS, ...extra }),
    });
    const by = (checks: ReturnType<typeof goalChecks>, text: string): { goal: string; value: string; pass: boolean } => {
      const found = checks.find((c) => c.goal.includes(text));
      if (found === undefined) throw new Error(`no check for ${text}`);
      return found;
    };

    it('目标写在 GOALS 里：结局 120 到 180 分钟，均衡玩法 4 小时内到达的不低于九成，四种不需要判断的玩法在 180 分钟内到达的不超过两成，攒钱不超过两个游戏日，第一天升二星不低于八成，四星的线不超过 90%', () => {
      expect(GOALS.endingMinutes).toEqual([120, 180]);
      expect([GOALS.endingWithin, GOALS.endingShare, GOALS.weakWithin, GOALS.weakShare, GOALS.savingDays, GOALS.dayOneStar2, GOALS.fourStarLine]).toEqual([240, 0.9, 180, 0.2, 2, 0.8, 90]);
      expect(WEAK_POLICIES).toEqual(['singleStation', 'noCards', 'dronesOnly', 'idle']);
    });

    it('均衡玩法 4 小时内到达结局的比例和第一天升二星的比例：各写一行，不够时标为没有达到', () => {
      const good = Array.from({ length: 10 }, (_, i) => ok('balanced', i === 9 ? null : 150, { nodes: { ...fake(1, { ending: i === 9 ? null : m(150), oldStreet2: DAY_STEPS }).nodes } }));
      const c = goalChecks(summarize(good, 't'));
      expect(by(c, '240 分钟内到达结局').value).toBe('90%');
      expect(by(c, '240 分钟内到达结局').pass).toBe(true);
      expect(by(c, '第一天升到二星').value).toBe('100%');
      expect(by(c, '第一天升到二星').pass).toBe(true);
      const late = Array.from({ length: 10 }, (_, i) => ok('balanced', i < 2 ? null : 150, { nodes: { ...fake(1, { ending: i < 2 ? null : m(150), oldStreet2: i < 3 ? 2 * DAY_STEPS : DAY_STEPS }).nodes } }));
      const d = goalChecks(summarize(late, 't'));
      expect(by(d, '240 分钟内到达结局').pass).toBe(false);
      expect(by(d, '240 分钟内到达结局').value).toBe('80%');
      expect(by(d, '第一天升到二星').pass).toBe(false);
      expect(by(d, '第一天升到二星').value).toBe('70%');
    });

    it('四星的准时率线不超过 90%：读内容表里的数', () => {
      const four = STARS_V1.rules.find((r) => r.star === 4)?.onTimeMin as number;
      const checks = goalChecks(summarize([ok('balanced', 150)], 't'));
      expect(by(checks, '四星的准时率线').value).toBe(`${four}%`);
      expect(by(checks, '四星的准时率线').pass).toBe(four <= 90);
    });

    it('均衡玩法的结局中位数和四分位，四种玩法的比例，攒钱时间：达到和没达到各写一行', () => {
      const good = [ok('balanced', 130), ok('balanced', 150), ok('balanced', 170), ok('noCards', null), ok('singleStation', null), ok('dronesOnly', null), ok('idle', null)];
      const c = goalChecks(summarize(good, 't'));
      expect(by(c, '均衡玩法的结局中位数').pass).toBe(true);
      expect(by(c, '均衡玩法的结局四分位').pass).toBe(true);
      expect(by(c, '全程不换卡在 180 分钟内').pass).toBe(true);
      expect(by(c, '全程不换卡的每一次购买').pass).toBe(true);
      const bad = [ok('balanced', 90), ok('balanced', 100), ok('balanced', 190), ok('noCards', 150), ok('noCards', 160), ok('noCards', 170), ok('noCards', null), ok('noCards', null)];
      const d = goalChecks(summarize(bad, 't'));
      expect(by(d, '均衡玩法的结局中位数').pass).toBe(false);
      expect(by(d, '均衡玩法的结局四分位').pass).toBe(false);
      expect(by(d, '全程不换卡在 180 分钟内').pass).toBe(false);
      expect(by(d, '全程不换卡在 180 分钟内').value).toBe('60%');
      const slow = goalChecks(summarize([ok('balanced', 150, { maxSaving: 3 * DAY_STEPS })], 't'));
      expect(by(slow, '均衡的每一次购买').pass).toBe(false);
    });

    it('订单占比：大学城开通之后午高峰主要是写字楼区的订单，晚高峰主要是老街和大学城的订单，写出各占多少和最大的是哪个片区', () => {
      const days = 30;
      const make = (noon: number[], evening: number[]): RunRecord =>
        ok('balanced', 150, {
          days,
          peakOrders: { noon: Array.from({ length: days }, () => [...noon]), evening: Array.from({ length: days }, () => [...evening]) },
          nodes: { ...fake(1, { officeOpened: DAY_STEPS, campusOpened: 2 * DAY_STEPS, ending: 150 * 600 }).nodes },
        });
      const fine = by(goalChecks(summarize([make([20, 50, 30], [20, 25, 55])], 't')), '午高峰主要是写字楼区');
      expect(fine.pass).toBe(true);
      expect(fine.value).toContain('午高峰写字楼区 50%（最大的片区 写字楼区）');
      expect(fine.value).toContain('晚高峰老街加大学城 75%（最大的片区 大学城）');
      // 午高峰里写字楼区不到一半，或者晚高峰里写字楼区占了一半以上，都不算
      expect(by(goalChecks(summarize([make([30, 40, 30], [20, 25, 55])], 't')), '午高峰主要是写字楼区').pass).toBe(false);
      expect(by(goalChecks(summarize([make([20, 60, 20], [10, 60, 30])], 't')), '午高峰主要是写字楼区').pass).toBe(false);
    });
  });

  it('Markdown 汇总包含全部章节和各玩法的名称', () => {
    const records = POLICY_IDS.flatMap((id) => [playGame(id, 42, { days: 2 }).record, playGame(id, 43, { days: 2 }).record]);
    const text = renderMarkdown(summarize(records, '测试'));
    for (const heading of ['## 一 节点的时间', '## 二 均衡玩法对照目标', '## 三', '## 四 写字楼区的过河单', '## 五 攒钱时间', '## 六', '## 七', '## 八 结局', '## 九 各片区在两场高峰里的订单占比', '## 十 校准目标的核对']) expect(text).toContain(heading);
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

  it('--select-cards：午晚两套的「调度策略」按给的卡选，与进程内运行的结果相同，写进运行信息，不认识的卡在运行前就报错', () => {
    const out = join(ROOT, 'out', `test-autoplay-cards-${process.pid}`);
    try {
      const args = ['--out', out, '--policies', 'balanced', '--seeds', '42', '--days', '8', '--workers', '1', '--quiet'];
      const ok = run([...args, '--select-cards', 'prioOffice,prioOld']);
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);
      const [rec] = parseRunsJsonl(readFileSync(join(out, 'runs.jsonl'), 'utf8'));
      expect(rec?.hash).toBe(playGame('balanced', 42, { days: 8, selectCards: { noon: 'prioOffice', evening: 'prioOld' } }).record.hash);
      expect(rec?.hash).not.toBe(playGame('balanced', 42, { days: 8 }).record.hash);
      const info = JSON.parse(readFileSync(join(out, 'run_info.json'), 'utf8')) as { settings: { selectCards: unknown } };
      expect(info.settings.selectCards).toEqual({ noon: 'prioOffice', evening: 'prioOld' });
      expect(run([...args, '--select-cards', 'nope,deadline']).status).not.toBe(0);
      expect(run([...args, '--select-cards', 'deadline']).status).not.toBe(0);
      expect(run(args).status).toBe(0);
      const plain = JSON.parse(readFileSync(join(out, 'run_info.json'), 'utf8')) as { settings: { selectCards: unknown } };
      expect(plain.settings.selectCards).toBeNull();
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

describe('小结的对照：只加记录，不改变自动玩家的决定', () => {
  it('同一局，要对照和不要对照，节点、购买、每天的记录、局末状态逐项相同，只多一个 shadow 字段', () => {
    for (const id of ['balanced', 'noCards', 'singleStation'] as const) {
      const plain = playGame(id, 42, { days: 6 }).record;
      const shadowed = playGame(id, 42, { days: 6, shadow: true }).record;
      const { shadow, hash: shadowHash, ...rest } = shadowed;
      const { hash: plainHash, ...restPlain } = plain;
      expect(plain.shadow, id).toBeUndefined();
      expect(rest, id).toEqual(restPlain);
      expect(shadow?.gains, id).toHaveLength(12); // 6 个游戏日，每天两场高峰
      // 记录里补进了对照的话，状态哈希里有它
      if ((shadow?.compared ?? 0) > 0) expect(shadowHash, id).not.toBe(plainHash);
      else expect(shadowHash, id).toBe(plainHash);
    }
  });

  it('全程不换卡的玩法整场用的都是开局的卡，没有对照；换卡的玩法有对照，多准时的总数是各场之和', () => {
    const none = playGame('noCards', 42, { days: 6, shadow: true }).record.shadow;
    expect(none).toEqual({ compared: 0, total: 0, gains: Array.from({ length: 12 }, () => null) });
    const some = playGame('balanced', 42, { days: 6, shadow: true }).record.shadow;
    expect(some?.compared).toBeGreaterThan(6);
    expect(some?.total).toBe((some?.gains ?? []).reduce<number>((sum, g) => sum + (g ?? 0), 0));
  });
});

describe('玩法的名称', () => {
  it('五种玩法，名称各不相同', () => {
    expect(POLICY_IDS.length).toBe(5);
    expect(new Set(POLICY_IDS.map((id) => POLICIES[id].name)).size).toBe(5);
  });
});

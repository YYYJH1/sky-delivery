// 经营模式的命令：每个命令的每个条件，成功和失败各有测试，失败时状态不变。
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import {
  DAY_STEPS,
  DroneState,
  OrderStatus,
  RANGE,
  TAKEOFF_STEPS,
  addOrder,
  advance,
  applyCommand,
  bayPrice,
  createState,
  dronePrice,
  fleetOf,
  hashState,
  inboundTo,
  quoteCommand,
  refreshShops,
  stationCount,
  stationPrice,
  step,
} from '../src/core/index.ts';
import type { SimState, StepObserver } from '../src/core/index.ts';
import { campaignOf, expectRejected, must, quietState, roofWhere, withMoney } from './campaign-helpers.ts';

/** 一座站的第 n 架飞机的价格：第 1、2 架是基础价，第 n 架（n 不小于 3）是 round(基础价 × 增长率^(n-3))。 */
const droneAt = (n: number): number => Math.round(ECONOMY_V1.droneBase * ECONOMY_V1.droneGrowth ** Math.max(0, n - 3));
/** 一座站的第 n 个停机位的价格，n 不小于 3：round(基础价 × 增长率^(n-3))。 */
const bayAt = (n: number): number => Math.round(ECONOMY_V1.bayBase * ECONOMY_V1.bayGrowth ** (n - 3));
const FIRST_DRONE = ECONOMY_V1.droneBase;
const FIRST_BAY = ECONOMY_V1.bayBase;

const OFFICE_ROOF = roofWhere((r) => r.district === 1);
const CAMPUS_ROOF = roofWhere((r) => r.district === 2);
const OLD_SMALL = roofWhere((r) => r.district === 0 && r.size === 'small');
const OLD_MEDIUM = roofWhere((r) => r.district === 0 && r.size === 'medium' && !r.opening);
const OLD_LARGE = roofWhere((r) => r.district === 0 && r.size === 'large');
/** 老街东边靠河的一块小屋顶，离东边的楼很近。 */
const OLD_EAST = roofWhere((r) => r.district === 0 && r.x > 1000 && r.y < 500);

/** 开通三个片区（直接改状态，不走命令），店和权重随之更新。 */
function openAll(state: SimState): void {
  for (const d of campaignOf(state).districts) d.open = true;
  refreshShops(state);
}

/** 记下每次起飞开始的步。 */
function takeoffRecorder(starts: number[]): StepObserver {
  return {
    after(phase, s) {
      if (phase !== 'gates') return;
      for (const d of s.drones) if (d.state === DroneState.Takeoff && d.tEnd - TAKEOFF_STEPS === s.step) starts.push(s.step);
    },
  };
}

describe('价格', () => {
  it('飞机：一座站的第 1、2 架是基础价，第 n 架（n 不小于 3）是 round(基础价 × 增长率^(n-3))', () => {
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(all.map(dronePrice)).toEqual(all.map(droneAt));
    expect([1, 2, 3].map(dronePrice)).toEqual([FIRST_DRONE, FIRST_DRONE, FIRST_DRONE]);
    // 增长率大于 1：越往后越贵
    for (let n = 4; n <= 12; n++) expect(dronePrice(n)).toBeGreaterThan(dronePrice(n - 1));
  });

  it('停机位：新站自带 2 个，第 n 个（n 不小于 3）是 round(基础价 × 增长率^(n-3))', () => {
    const all = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(all.map(bayPrice)).toEqual(all.map(bayAt));
    expect(bayPrice(3)).toBe(FIRST_BAY);
    for (let n = 4; n <= 12; n++) expect(bayPrice(n)).toBeGreaterThan(bayPrice(n - 1));
  });

  it('一座站从 2 个停机位、2 架飞机扩到 12 个、12 架：停机位和飞机各自的合计，合计是价格表里算出来的数', () => {
    const range = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const bays = range.reduce((sum, n) => sum + bayPrice(n), 0);
    const drones = range.reduce((sum, n) => sum + dronePrice(n), 0);
    expect([bays, drones]).toEqual([range.reduce((sum, n) => sum + bayAt(n), 0), range.reduce((sum, n) => sum + droneAt(n), 0)]);
    // 价格表 v1 的数：停机位共 6,646，飞机共 3,197，合计 9,843
    expect([bays, drones, bays + drones]).toEqual([6646, 3197, 9843]);
  });

  it('每一档都从基础价直接算出后取整，不在上一档取整后的价格上累乘', () => {
    expect(dronePrice(9)).toBe(Math.round(ECONOMY_V1.droneBase * ECONOMY_V1.droneGrowth ** 6));
    expect(dronePrice(12)).toBe(Math.round(ECONOMY_V1.droneBase * ECONOMY_V1.droneGrowth ** 9));
    expect(bayPrice(12)).toBe(Math.round(ECONOMY_V1.bayBase * ECONOMY_V1.bayGrowth ** 9));
    // 在取整后的价格上累乘会得到另一个数
    let chained = ECONOMY_V1.droneBase;
    for (let n = 4; n <= 12; n++) chained = Math.round(chained * ECONOMY_V1.droneGrowth);
    expect(chained).not.toBe(dronePrice(12));
  });

  it('建站价 = round(基准价 × 屋顶的价格系数)，第 2、3、4 座站各有各的基准价，一座比一座贵', () => {
    const [second, third, fourth] = ECONOMY_V1.stationBase as [number, number, number];
    expect(second).toBeLessThan(third);
    expect(third).toBeLessThan(fourth);
    for (let roof = 0; roof < MAP_V1.roofs.length; roof++) {
      const coef = (MAP_V1.roofs[roof] as { priceCoef: number }).priceCoef;
      expect(stationPrice(1, roof)).toBe(Math.round(second * coef));
      expect(stationPrice(2, roof)).toBe(Math.round(third * coef));
      expect(stationPrice(3, roof)).toBe(Math.round(fourth * coef));
    }
  });
});

describe('命令：不是经营模式', () => {
  it('沙盒模式下所有命令都不执行，返回 notCampaign，状态不变', () => {
    const sandbox = createState({});
    const before = hashState(sandbox);
    for (const command of [
      { type: 'buildStation', roof: 0 },
      { type: 'buyDrone', station: 0 },
      { type: 'buyBay', station: 0 },
      { type: 'upgradeGate', station: 0 },
      { type: 'buyDoubleBox' },
      { type: 'buyNearestLanding' },
      { type: 'openDistrict', district: 1 },
      { type: 'setRules', rules: { select: 'deadline' } },
      { type: 'prioritizeOrder', order: 0 },
      { type: 'refundDrone', drone: 0 },
      { type: 'refundBay', station: 0 },
      { type: 'refundStation', station: 0 },
    ] as const) {
      expect(applyCommand(sandbox, command)).toEqual({ ok: false, reason: 'notCampaign' });
      expect(quoteCommand(sandbox, command).reason).toBe('notCampaign');
    }
    expect(hashState(sandbox)).toBe(before);
  });

  it('没有这种命令：unknownCommand', () => {
    expectRejected(quietState(), { type: 'fly' } as never, 'unknownCommand');
  });
});

describe('命令：建站', () => {
  it('成功：余额减去建站价，新站自带 2 个停机位，没有飞机，起降口 1 级，颜色序号等于站的编号，屋顶记为已占用', () => {
    const state = withMoney(quietState());
    openAll(state);
    const price = stationPrice(1, OFFICE_ROOF);
    expect(quoteCommand(state, { type: 'buildStation', roof: OFFICE_ROOF })).toEqual({ ok: true, reason: null, kind: 'buy', price });
    const before = campaignOf(state).money;
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    expect(id).toBe(1);
    expect(campaignOf(state).money).toBe(before - price);
    expect(campaignOf(state).spent).toBe(price);
    const roof = MAP_V1.roofs[OFFICE_ROOF] as { x: number; y: number };
    expect(state.stations[1]).toEqual({ id: 1, x: roof.x, y: roof.y, bays: 2, occupied: 0, queue: [], gateFree: 0, gateInterval: 12, removed: false });
    expect(state.drones.filter((d) => d.home === 1).length).toBe(0);
    expect(campaignOf(state).stations[1]).toEqual({ roof: OFFICE_ROOF, gateLevel: 1, built: { day: 0, paid: price }, bays: [] });
    expect(campaignOf(state).roofStation[OFFICE_ROOF]).toBe(1);
    expect(state.stats.landWait.length).toBe(2);
    expect(state.stats.bayTotal.length).toBe(2);
    expect(stationCount(state)).toBe(2);
  });

  it('第 2、3、4 座站的价格是价格表里的基准价乘各自屋顶的价格系数', () => {
    const state = withMoney(quietState());
    openAll(state);
    const bases = ECONOMY_V1.stationBase;
    [OFFICE_ROOF, CAMPUS_ROOF, OLD_SMALL].forEach((roof, i) => {
      const coef = (MAP_V1.roofs[roof] as { priceCoef: number }).priceCoef;
      const quote = quoteCommand(state, { type: 'buildStation', roof });
      expect(quote.price).toBe(Math.round((bases[i] as number) * coef));
      const before = campaignOf(state).money;
      must(state, { type: 'buildStation', roof });
      expect(before - campaignOf(state).money).toBe(quote.price);
    });
    expect(stationCount(state)).toBe(4);
  });

  it('屋顶所在的片区还没开通：districtClosed', () => {
    const state = withMoney(quietState());
    expectRejected(state, { type: 'buildStation', roof: OFFICE_ROOF }, 'districtClosed');
    expectRejected(state, { type: 'buildStation', roof: CAMPUS_ROOF }, 'districtClosed');
  });

  it('屋顶上已经有站：roofTaken（开局的屋顶，以及刚建过站的屋顶）', () => {
    const state = withMoney(quietState());
    openAll(state);
    expectRejected(state, { type: 'buildStation', roof: 0 }, 'roofTaken');
    must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    expectRejected(state, { type: 'buildStation', roof: OFFICE_ROOF }, 'roofTaken');
  });

  it('站数已到上限（首版最多 4 座）：stationLimit', () => {
    const state = withMoney(quietState());
    openAll(state);
    for (const roof of [OFFICE_ROOF, CAMPUS_ROOF, OLD_SMALL]) must(state, { type: 'buildStation', roof });
    expectRejected(state, { type: 'buildStation', roof: OLD_LARGE }, 'stationLimit');
  });

  it('余额不够：notEnoughMoney，差一点也不行，刚好够就行', () => {
    const state = quietState();
    openAll(state);
    const price = stationPrice(1, OFFICE_ROOF);
    campaignOf(state).money = price - 0.01;
    expectRejected(state, { type: 'buildStation', roof: OFFICE_ROOF }, 'notEnoughMoney');
    campaignOf(state).money = price;
    must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    expect(campaignOf(state).money).toBe(0);
  });

  it('屋顶编号不存在或不是整数：unknownTarget', () => {
    const state = withMoney(quietState());
    for (const roof of [-1, MAP_V1.roofs.length, 1.5, Number.NaN]) expectRejected(state, { type: 'buildStation', roof }, 'unknownTarget');
  });
});

describe('命令：购买无人机', () => {
  it('成功：新飞机满电，停在这座站的停机位上，归属这座站，占用数加一', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buyBay', station: 0 });
    const station = state.stations[0] as { x: number; y: number; occupied: number };
    const id = must(state, { type: 'buyDrone', station: 0 });
    expect(id).toBe(2);
    expect(state.drones[2]).toEqual({
      id: 2,
      x: station.x,
      y: station.y,
      battery: RANGE,
      home: 0,
      state: DroneState.Dock,
      station: 0,
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
    expect(station.occupied).toBe(3);
    expect(campaignOf(state).drones[2]).toEqual({ day: 0, paid: FIRST_DRONE });
  });

  it('这座站的飞机数不能超过停机位数：fleetFull，加一个停机位之后可以买', () => {
    const state = withMoney(quietState());
    expectRejected(state, { type: 'buyDrone', station: 0 }, 'fleetFull'); // 开局 2 架、2 个停机位
    must(state, { type: 'buyBay', station: 0 });
    must(state, { type: 'buyDrone', station: 0 });
    expectRejected(state, { type: 'buyDrone', station: 0 }, 'fleetFull');
  });

  it('飞机的价格按这座站已有的飞机数算：新站的头两架各是基础价，老站的第 3 架是基础价，第 4 架按增长率涨价', () => {
    const state = withMoney(quietState());
    openAll(state);
    const second = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    const price = (station: number): number => quoteCommand(state, { type: 'buyDrone', station }).price;
    expect(price(second)).toBe(FIRST_DRONE);
    must(state, { type: 'buyDrone', station: second });
    expect(price(second)).toBe(FIRST_DRONE);
    must(state, { type: 'buyDrone', station: second });
    expect(quoteCommand(state, { type: 'buyDrone', station: second }).reason).toBe('fleetFull');
    must(state, { type: 'buyBay', station: 0 });
    expect(price(0)).toBe(droneAt(3));
    must(state, { type: 'buyDrone', station: 0 });
    must(state, { type: 'buyBay', station: 0 });
    expect(price(0)).toBe(droneAt(4));
    expect(droneAt(4)).toBeGreaterThan(FIRST_DRONE);
  });

  it('一座站从 2 架扩到 12 架（大屋顶）：飞机和停机位实付的钱就是价格表里各档的合计', () => {
    const state = withMoney(quietState());
    openAll(state);
    const id = must(state, { type: 'buildStation', roof: OLD_LARGE });
    must(state, { type: 'buyDrone', station: id });
    must(state, { type: 'buyDrone', station: id });
    let bays = 0;
    let drones = 0;
    for (let n = 3; n <= 12; n++) {
      const m1 = campaignOf(state).money;
      must(state, { type: 'buyBay', station: id });
      bays += m1 - campaignOf(state).money;
      const m2 = campaignOf(state).money;
      must(state, { type: 'buyDrone', station: id });
      drones += m2 - campaignOf(state).money;
    }
    const range = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect([bays, drones]).toEqual([range.reduce((sum, n) => sum + bayAt(n), 0), range.reduce((sum, n) => sum + droneAt(n), 0)]);
    expect(fleetOf(state, id)).toBe(12);
    expect((state.stations[id] as { bays: number }).bays).toBe(12);
  });

  it('这座站的停机位被占满（占用的加上预约降落的）：noFreeBay', () => {
    const state = withMoney(quietState());
    openAll(state);
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    must(state, { type: 'buyDrone', station: id });
    // 别的站的飞机预约了这座站：占用数加预约数等于停机位数，而归属这座站的飞机数还不到停机位数
    const visitor = state.drones[0] as { returning: boolean; target: number };
    visitor.returning = true;
    visitor.target = id;
    expect(fleetOf(state, id)).toBe(1);
    expect((state.stations[id] as { occupied: number }).occupied + inboundTo(state, id)).toBe(2);
    expectRejected(state, { type: 'buyDrone', station: id }, 'noFreeBay');
  });

  it('余额不够：notEnoughMoney，刚好够就行', () => {
    const state = withMoney(quietState(), FIRST_BAY);
    must(state, { type: 'buyBay', station: 0 });
    campaignOf(state).money = droneAt(3) - 0.01;
    expectRejected(state, { type: 'buyDrone', station: 0 }, 'notEnoughMoney');
    campaignOf(state).money = droneAt(3);
    must(state, { type: 'buyDrone', station: 0 });
    expect(campaignOf(state).money).toBe(0);
  });

  it('站不存在：unknownTarget', () => {
    const state = withMoney(quietState());
    for (const station of [-1, 1, 99, 0.5]) expectRejected(state, { type: 'buyDrone', station }, 'unknownTarget');
  });
});

describe('命令：新增停机位', () => {
  it('价格按这座站已有的停机位数算：第 3 个是基础价，之后每个按增长率涨价', () => {
    const state = withMoney(quietState());
    const paid: number[] = [];
    for (let n = 3; n <= 9; n++) {
      const quote = quoteCommand(state, { type: 'buyBay', station: 0 });
      const before = campaignOf(state).money;
      must(state, { type: 'buyBay', station: 0 });
      paid.push(before - campaignOf(state).money);
      expect(quote.price).toBe(paid[paid.length - 1]);
    }
    expect(paid).toEqual([3, 4, 5, 6, 7, 8, 9].map(bayAt));
    expect(paid[0]).toBe(FIRST_BAY);
    expect((state.stations[0] as { bays: number }).bays).toBe(9);
  });

  it('屋顶的大小限制停机位上限：小 6，中 9，大 12，到了上限 bayLimit', () => {
    for (const [roof, cap, size] of [
      [0, 9, 'medium'], // 开局的屋顶是中的
      [OLD_SMALL, 6, 'small'],
      [OLD_MEDIUM, 9, 'medium'],
      [OLD_LARGE, 12, 'large'],
    ] as const) {
      const state = withMoney(quietState());
      const id = roof === 0 ? 0 : must(state, { type: 'buildStation', roof });
      expect((MAP_V1.roofs[roof] as { size: string }).size).toBe(size);
      while ((state.stations[id] as { bays: number }).bays < cap) must(state, { type: 'buyBay', station: id });
      expect((state.stations[id] as { bays: number }).bays).toBe(cap);
      expectRejected(state, { type: 'buyBay', station: id }, 'bayLimit');
    }
  });

  it('余额不够：notEnoughMoney，刚好够就行，站不存在：unknownTarget', () => {
    const state = quietState();
    campaignOf(state).money = FIRST_BAY - 0.01;
    expectRejected(state, { type: 'buyBay', station: 0 }, 'notEnoughMoney');
    campaignOf(state).money = FIRST_BAY;
    must(state, { type: 'buyBay', station: 0 });
    expect(campaignOf(state).money).toBe(0);
    for (const station of [-1, 1, 0.5]) expectRejected(withMoney(quietState()), { type: 'buyBay', station }, 'unknownTarget');
  });
});

describe('命令：升级起降口', () => {
  it('1 级到 2 级 240，2 级到 3 级 900，立即改变这座站的起降间隔（1.2、0.8、0.4 秒），3 级之后 gateMax', () => {
    const state = withMoney(quietState());
    const station = state.stations[0] as { gateInterval: number };
    expect(station.gateInterval).toBe(12);
    expect(quoteCommand(state, { type: 'upgradeGate', station: 0 }).price).toBe(240);
    const before = campaignOf(state).money;
    must(state, { type: 'upgradeGate', station: 0 });
    expect(before - campaignOf(state).money).toBe(240);
    expect(station.gateInterval).toBe(8);
    expect(campaignOf(state).stations[0]?.gateLevel).toBe(2);
    expect(quoteCommand(state, { type: 'upgradeGate', station: 0 }).price).toBe(900);
    const middle = campaignOf(state).money;
    must(state, { type: 'upgradeGate', station: 0 });
    expect(middle - campaignOf(state).money).toBe(900);
    expect(station.gateInterval).toBe(4);
    expect(campaignOf(state).stations[0]?.gateLevel).toBe(3);
    expectRejected(state, { type: 'upgradeGate', station: 0 }, 'gateMax');
  });

  it('每座站分别买：升级一座站不影响另一座站', () => {
    const state = withMoney(quietState());
    openAll(state);
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    must(state, { type: 'upgradeGate', station: id });
    expect((state.stations[id] as { gateInterval: number }).gateInterval).toBe(8);
    expect((state.stations[0] as { gateInterval: number }).gateInterval).toBe(12);
    expect(quoteCommand(state, { type: 'upgradeGate', station: 0 }).price).toBe(240);
  });

  it('余额不够：notEnoughMoney，站不存在：unknownTarget', () => {
    const state = quietState();
    campaignOf(state).money = 239.99;
    expectRejected(state, { type: 'upgradeGate', station: 0 }, 'notEnoughMoney');
    for (const station of [-1, 1, 0.5]) expectRejected(state, { type: 'upgradeGate', station }, 'unknownTarget');
  });

  it('升级之后每两次起飞之间的间隔随之改变：3 架同时派出，起飞开始的步相隔 12、8、4 步', () => {
    const startsAfter = (upgrades: number): number[] => {
      const state = withMoney(quietState());
      must(state, { type: 'buyBay', station: 0 });
      must(state, { type: 'buyDrone', station: 0 });
      for (let i = 0; i < upgrades; i++) must(state, { type: 'upgradeGate', station: 0 });
      for (let i = 0; i < 3; i++) addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 20 });
      const starts: number[] = [];
      const observer = takeoffRecorder(starts);
      for (let i = 0; i < 40; i++) step(state, observer);
      return starts;
    };
    expect(startsAfter(0)).toEqual([0, 12, 24]);
    expect(startsAfter(1)).toEqual([0, 8, 16]);
    expect(startsAfter(2)).toEqual([0, 4, 8]);
  });

  it('已经排上的放行不变，升级之后的下一次放行才按新间隔：第一架起飞后升级，第二架仍在原定的步，第三架按新间隔', () => {
    const state = withMoney(quietState());
    must(state, { type: 'buyBay', station: 0 });
    must(state, { type: 'buyDrone', station: 0 });
    for (let i = 0; i < 3; i++) addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 20 });
    const starts: number[] = [];
    const observer = takeoffRecorder(starts);
    step(state, observer); // 第 0 步：第一架起飞，下一次放行排在第 12 步
    must(state, { type: 'upgradeGate', station: 0 });
    for (let i = 0; i < 40; i++) step(state, observer);
    expect(starts).toEqual([0, 12, 20]);
  });
});

describe('命令：双层货箱', () => {
  it('180，全部飞机的载量变为 2，买过之后再买：alreadyOwned，余额不够：notEnoughMoney', () => {
    const state = quietState();
    expect(state.capacity).toBe(1);
    campaignOf(state).money = 179.99;
    expectRejected(state, { type: 'buyDoubleBox' }, 'notEnoughMoney');
    campaignOf(state).money = 180;
    expect(quoteCommand(state, { type: 'buyDoubleBox' })).toEqual({ ok: true, reason: null, kind: 'buy', price: 180 });
    must(state, { type: 'buyDoubleBox' });
    expect(state.capacity).toBe(2);
    expect(campaignOf(state).money).toBe(0);
    withMoney(state);
    expectRejected(state, { type: 'buyDoubleBox' }, 'alreadyOwned');
  });

  it('载量用状态里的值：大单（份量 2）在载量 1 时机上只占 1 份，买了双层货箱之后占满两层', () => {
    const state = withMoney(quietState());
    const a = addOrder(state, { merchant: 0, building: 10, portion: 2, prepSteps: 20 });
    step(state); // 第 0 步派单
    expect(a.units).toBe(1);
    must(state, { type: 'buyDoubleBox' });
    const b = addOrder(state, { merchant: 4, building: 2, portion: 2, prepSteps: 20 });
    advance(state, 5);
    expect(b.status).not.toBe(OrderStatus.Pending);
    expect(b.units).toBe(2);
  });

  it('买了双层货箱之后，一起送的策略生效：同样的订单，不买时没有同乘，买了之后有', () => {
    const run = (buy: boolean): { shared: number; mostLoad: number } => {
      const state = withMoney(quietState({ orderEndStep: null, seed: 42 }), 1000);
      campaignOf(state).opening.orders = [0, 1, 2, 3, 4]; // 跳过开局的五张固定订单，直接进入随机订单
      must(state, { type: 'setRules', rules: { pool: 'any' } });
      if (buy) must(state, { type: 'buyDoubleBox' });
      let mostLoad = 0;
      for (let i = 0; i < 2 * DAY_STEPS; i++) {
        step(state);
        for (const d of state.drones) mostLoad = Math.max(mostLoad, d.load);
      }
      return { shared: state.orders.filter((o) => o.shared).length, mostLoad };
    };
    const without = run(false);
    const withBox = run(true);
    expect(without.shared).toBe(0);
    expect(without.mostLoad).toBeLessThanOrEqual(1);
    expect(withBox.shared).toBeGreaterThan(3);
    expect(withBox.mostLoad).toBe(2);
  });
});

describe('命令：就近降落', () => {
  it('300，需要两座以上的站：只有一座站时 needTwoStations，买过之后再买：alreadyOwned，余额不够：notEnoughMoney', () => {
    const state = withMoney(quietState());
    expectRejected(state, { type: 'buyNearestLanding' }, 'needTwoStations');
    must(state, { type: 'buildStation', roof: OLD_EAST });
    campaignOf(state).money = 299.99;
    expectRejected(state, { type: 'buyNearestLanding' }, 'notEnoughMoney');
    campaignOf(state).money = 300;
    expect(state.returnRule).toBe('home');
    must(state, { type: 'buyNearestLanding' });
    expect(state.returnRule).toBe('nearest');
    expect(campaignOf(state).money).toBe(0);
    withMoney(state);
    expectRejected(state, { type: 'buyNearestLanding' }, 'alreadyOwned');
  });

  /** 老街开局的站在 (490, 610)，东边靠河的小屋顶上建第二座站。一架飞机从站 0 出发，送完离第二座站近得多。 */
  function twoStations(): SimState {
    const state = withMoney(quietState());
    must(state, { type: 'buildStation', roof: OLD_EAST });
    return state;
  }

  /** 放一张订单（店 3 在老街东边，楼 7 离第二座站很近），推进到飞机都落回停机位。 */
  function deliverAndLand(state: SimState): void {
    addOrder(state, { merchant: 3, building: 7, portion: 1, prepSteps: 20 });
    let flew = false;
    for (let i = 0; i < 1500; i++) {
      step(state);
      if (state.drones.some((d) => d.route.length > 0 || d.state !== DroneState.Dock)) flew = true;
      if (flew && state.drones.every((d) => d.state === DroneState.Dock && d.route.length === 0)) return;
    }
    throw new Error('the drones did not land');
  }

  it('买了之后，飞机送完降落到最近的站，归属站跟着变，价格按新的归属站算，不买时回原站，归属站不变', () => {
    const home = twoStations();
    deliverAndLand(home);
    expect(home.drones.map((d) => d.home)).toEqual([0, 0]);
    expect(home.stations.map((s) => s.occupied)).toEqual([2, 0]);
    expect([fleetOf(home, 0), fleetOf(home, 1)]).toEqual([2, 0]);

    const nearest = twoStations();
    must(nearest, { type: 'buyNearestLanding' });
    deliverAndLand(nearest);
    expect(nearest.drones.map((d) => d.home).sort()).toEqual([0, 1]);
    expect(nearest.stations.map((s) => s.occupied)).toEqual([1, 1]);
    const moved = nearest.drones.find((d) => d.home === 1) as { station: number };
    expect(moved.station).toBe(1);
    expect([fleetOf(nearest, 0), fleetOf(nearest, 1)]).toEqual([1, 1]);
    // 站 0 的飞机数少了一架：站 0 买飞机要按 1 架算，需要先有空的停机位才行，价格还是基础价，站 1 现在有 1 架飞机
    expect(quoteCommand(nearest, { type: 'buyDrone', station: 1 }).price).toBe(FIRST_DRONE);
  });

  it('最近的站停机位满了（占用数加预约数不小于停机位数）就找下一座，都满了回归属站', () => {
    const state = twoStations();
    must(state, { type: 'buyNearestLanding' });
    const second = state.stations[1] as { bays: number; occupied: number };
    second.occupied = second.bays; // 第二座站的停机位已被别的飞机占满
    deliverAndLand(state);
    expect(state.drones.map((d) => d.home)).toEqual([0, 0]);
    expect(state.stations[0]?.occupied).toBe(2);
  });
});

describe('命令：开通片区', () => {
  it('上一个片区达到三星、余额够：开通价取价格表，开通后星级不变，这个片区的楼和开局开张的店开始使用', () => {
    const state = withMoney(quietState());
    const campaign = campaignOf(state);
    expect(campaign.districts.map((d) => [d.open, d.star])).toEqual([[true, 1], [false, 1], [false, 1]]);
    expect(campaign.shopOpen.filter(Boolean).length).toBe(9); // 老街开局开 9 家
    expectRejected(state, { type: 'openDistrict', district: 1 }, 'needStars');
    const officePrice = ECONOMY_V1.districtOpenPrice[1] as number;
    expect(quoteCommand(state, { type: 'openDistrict', district: 1 })).toEqual({ ok: false, reason: 'needStars', kind: 'buy', price: officePrice });
    (campaign.districts[0] as { star: number }).star = 2;
    expectRejected(state, { type: 'openDistrict', district: 1 }, 'needStars');
    (campaign.districts[0] as { star: number }).star = 3;
    expect(quoteCommand(state, { type: 'openDistrict', district: 1 })).toEqual({ ok: true, reason: null, kind: 'buy', price: officePrice });
    const before = campaign.money;
    expect(must(state, { type: 'openDistrict', district: 1 })).toBe(1);
    expect(before - campaign.money).toBe(officePrice);
    expect(campaign.districts[1]).toEqual({ open: true, star: 1 });
    // 老街此时三星，二、三星开张的 3 家店也已开张（9 + 3 = 12），写字楼区一星开局开 3 家
    expect(campaign.shopOpen.filter(Boolean).length).toBe(12 + 3);
    MAP_V1.shops.forEach((s, i) => {
      if (s.district === 1) expect(campaign.shopOpen[i], `shop ${i}`).toBe(s.opensAtStar === 1);
    });
    // 写字楼区的楼已经可以抽到店：累计权重为正
    const officeBuilding = (state.world.buildingsByDistrict[1] as number[])[0] as number;
    const row = campaign.cumWeights[officeBuilding] as number[];
    expect(row[row.length - 1]).toBeGreaterThan(0);
    expectRejected(state, { type: 'openDistrict', district: 1 }, 'alreadyOpen');
    expectRejected(state, { type: 'openDistrict', district: 0 }, 'alreadyOpen');
  });

  it('大学城要写字楼区开通并达到三星，价格取价格表', () => {
    const state = withMoney(quietState());
    const campaign = campaignOf(state);
    (campaign.districts[0] as { star: number }).star = 3;
    expectRejected(state, { type: 'openDistrict', district: 2 }, 'needStars'); // 写字楼区还没开通
    must(state, { type: 'openDistrict', district: 1 });
    expectRejected(state, { type: 'openDistrict', district: 2 }, 'needStars'); // 写字楼区一星
    (campaign.districts[1] as { star: number }).star = 2;
    expectRejected(state, { type: 'openDistrict', district: 2 }, 'needStars');
    (campaign.districts[1] as { star: number }).star = 3;
    const before = campaign.money;
    must(state, { type: 'openDistrict', district: 2 });
    expect(before - campaign.money).toBe(ECONOMY_V1.districtOpenPrice[2]);
    expect(campaign.districts[2]).toEqual({ open: true, star: 1 });
    // 老街三星 12 家，写字楼区三星 3 + 2 = 5 家，大学城一星开局开 4 家
    expect(campaign.shopOpen.filter(Boolean).length).toBe(12 + 5 + 4);
    MAP_V1.shops.forEach((s, i) => {
      const district = campaign.districts[s.district] as { open: boolean; star: number };
      expect(campaign.shopOpen[i], `shop ${i}`).toBe(district.open && district.star >= s.opensAtStar);
    });
  });

  it('余额不够：notEnoughMoney，片区不存在：unknownTarget', () => {
    const state = quietState();
    (campaignOf(state).districts[0] as { star: number }).star = 3;
    campaignOf(state).money = 199.99;
    expectRejected(state, { type: 'openDistrict', district: 1 }, 'notEnoughMoney');
    for (const district of [-1, 3, 1.5]) expectRejected(state, { type: 'openDistrict', district }, 'unknownTarget');
  });

  it('开通片区之后，那里的候选屋顶可以建站', () => {
    const state = withMoney(quietState());
    expectRejected(state, { type: 'buildStation', roof: OFFICE_ROOF }, 'districtClosed');
    (campaignOf(state).districts[0] as { star: number }).star = 3;
    must(state, { type: 'openDistrict', district: 1 });
    must(state, { type: 'buildStation', roof: OFFICE_ROOF });
  });
});

describe('命令：换策略卡和点击订单插队', () => {
  it('换策略卡：沿用 setRules，立即生效并记下换卡的时刻，不收费', () => {
    const state = quietState();
    advance(state, 7);
    expect(quoteCommand(state, { type: 'setRules', rules: { select: 'deadline' } })).toEqual({ ok: true, reason: null, kind: 'free', price: 0 });
    must(state, { type: 'setRules', rules: { select: 'deadline', zone: 'hybrid' } });
    expect(state.rules).toEqual({ select: 'deadline', zone: 'hybrid', pool: 'single' });
    expect(state.stats.ruleChanges.map((c) => [c.step, c.column, c.to])).toEqual([
      [7, 'select', 'deadline'],
      [7, 'zone', 'hybrid'],
    ]);
  });

  it('策略卡不存在或栏不存在：unknownRule，一张也不换', () => {
    const state = quietState();
    expectRejected(state, { type: 'setRules', rules: { select: 'nope' } }, 'unknownRule');
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline', zone: 'nope' } }, 'unknownRule');
    expectRejected(state, { type: 'setRules', rules: { colour: 'red' } as never }, 'unknownRule');
    expectRejected(state, { type: 'setRules', rules: null as never }, 'unknownRule');
  });

  it('点击订单插队：沿用 prioritizeOrder，已经点击过、已经派出和不存在的订单不行', () => {
    const state = quietState();
    advance(state, 1);
    const a = addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 20 });
    const b = addOrder(state, { merchant: 6, building: 6, portion: 1, prepSteps: 20 });
    const c = addOrder(state, { merchant: 4, building: 2, portion: 1, prepSteps: 20 });
    must(state, { type: 'prioritizeOrder', order: a.id });
    expect(a.manualAt).toBe(1);
    expectRejected(state, { type: 'prioritizeOrder', order: a.id }, 'orderNotWaiting'); // 已经点击过
    advance(state, 5); // 派单：两架飞机各接一张，第三张还在等
    expect(b.status).toBe(OrderStatus.Assigned);
    expectRejected(state, { type: 'prioritizeOrder', order: b.id }, 'orderNotWaiting'); // 已经派出
    expect(c.status).toBe(OrderStatus.Pending);
    must(state, { type: 'prioritizeOrder', order: c.id });
    for (const order of [-1, 99, 0.5]) expectRejected(state, { type: 'prioritizeOrder', order }, 'unknownTarget');
  });
});

describe('命令：价格只读', () => {
  it('quoteCommand 不修改状态，条件不满足时也给出价格，余额不够时价签仍显示价格', () => {
    const state = quietState();
    const before = hashState(state);
    expect(quoteCommand(state, { type: 'upgradeGate', station: 0 })).toEqual({ ok: false, reason: 'notEnoughMoney', kind: 'buy', price: 240 });
    expect(quoteCommand(state, { type: 'buyBay', station: 0 })).toEqual({ ok: false, reason: 'notEnoughMoney', kind: 'buy', price: FIRST_BAY });
    expect(quoteCommand(state, { type: 'buyDoubleBox' }).price).toBe(180);
    expect(quoteCommand(state, { type: 'buyNearestLanding' })).toEqual({ ok: false, reason: 'needTwoStations', kind: 'buy', price: 300 });
    expect(hashState(state)).toBe(before);
  });

  it('同一步里先后执行的命令按先后顺序生效', () => {
    const state = quietState();
    campaignOf(state).money = FIRST_BAY;
    must(state, { type: 'buyBay', station: 0 });
    expectRejected(state, { type: 'buyBay', station: 0 }, 'notEnoughMoney');
    campaignOf(state).money = 1000;
    must(state, { type: 'buyBay', station: 0 });
    expect((state.stations[0] as { bays: number }).bays).toBe(4);
  });
});

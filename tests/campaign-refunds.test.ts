// 当天原价退回：飞机、停机位、站点。每一种退回的条件，退回后的余额和数量，已退回的飞机和站点不再参与任何计算。
import { describe, expect, it } from 'vitest';
import {
  DAY_STEPS,
  DroneState,
  OrderStatus,
  addOrder,
  advance,
  fleetOf,
  quoteCommand,
  refreshShops,
  stationCount,
  step,
} from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { campaignOf, expectRejected, liveDrones, must, quietState, roofWhere, withMoney } from './campaign-helpers.ts';

const OFFICE_ROOF = roofWhere((r) => r.district === 1);
const OLD_SMALL = roofWhere((r) => r.district === 0 && r.size === 'small');

function openAll(state: SimState): void {
  for (const d of campaignOf(state).districts) d.open = true;
  refreshShops(state);
}

/** 1000 块、开局的站加一个停机位，再买一架飞机：老街的站有 3 架飞机、3 个停机位。返回新飞机的编号。 */
function withThirdDrone(state: SimState): number {
  must(state, { type: 'buyBay', station: 0 });
  return must(state, { type: 'buyDrone', station: 0 });
}

describe('退回飞机', () => {
  it('当天买的飞机，停在停机位上、手上没有任务，可以按原价退回：余额加回实付的金额，飞机数和占用数各减一', () => {
    const state = withMoney(quietState(), 1000);
    const id = withThirdDrone(state);
    const campaign = campaignOf(state);
    expect(campaign.money).toBe(1000 - 140 - 100);
    expect(quoteCommand(state, { type: 'refundDrone', drone: id })).toEqual({ ok: true, reason: null, kind: 'refund', price: 100 });
    expect(must(state, { type: 'refundDrone', drone: id })).toBe(id);
    expect(campaign.money).toBe(1000 - 140);
    expect(campaign.refunded).toBe(100);
    expect(campaign.spent).toBe(240);
    const drone = state.drones[id] as { removed: boolean; station: number };
    expect(drone.removed).toBe(true);
    expect(drone.station).toBe(-1);
    expect(fleetOf(state, 0)).toBe(2);
    expect(liveDrones(state).length).toBe(2);
    expect((state.stations[0] as { occupied: number }).occupied).toBe(2);
    expect(state.drones.length).toBe(3); // 编号不回收，不从数组里删除
  });

  it('退回之后再买同一座站的飞机，价格按退回之后的飞机数算：还是第 3 架的 100', () => {
    const state = withMoney(quietState(), 1000);
    const id = withThirdDrone(state);
    must(state, { type: 'refundDrone', drone: id });
    expect(quoteCommand(state, { type: 'buyDrone', station: 0 }).price).toBe(100);
    const next = must(state, { type: 'buyDrone', station: 0 });
    expect(next).toBe(id + 1); // 新飞机用新的编号
  });

  it('不是当天买的不能退：开局自带的飞机，以及前一天买的飞机，notBoughtToday', () => {
    const state = withMoney(quietState(), 1000);
    expectRejected(state, { type: 'refundDrone', drone: 0 }, 'notBoughtToday');
    expectRejected(state, { type: 'refundDrone', drone: 1 }, 'notBoughtToday');
    const id = withThirdDrone(state);
    advance(state, DAY_STEPS - 1);
    expect(quoteCommand(state, { type: 'refundDrone', drone: id }).ok).toBe(true); // 第一天的最后一步还能退
    advance(state, 1);
    expect(state.step).toBe(DAY_STEPS);
    expectRejected(state, { type: 'refundDrone', drone: id }, 'notBoughtToday');
  });

  it('飞机要停在停机位上、手上没有任务：已经接了单、在起降口排队、在空中的都不能退，落回停机位之后可以退', () => {
    const state = withMoney(quietState(), 1000);
    const id = withThirdDrone(state);
    for (let i = 0; i < 3; i++) addOrder(state, { merchant: 0, building: 10, portion: 1, prepSteps: 20 });
    step(state); // 第 0 步派单：三架飞机各接一张订单，进起降口排队
    const drone = state.drones[id] as { route: unknown[]; state: number };
    expect(drone.route.length).toBeGreaterThan(0);
    expectRejected(state, { type: 'refundDrone', drone: id }, 'droneBusy'); // 排队等起飞
    advance(state, 40);
    expect(drone.state).not.toBe(DroneState.Dock);
    expectRejected(state, { type: 'refundDrone', drone: id }, 'droneBusy'); // 在空中
    for (let i = 0; i < 1500 && !(drone.state === DroneState.Dock && drone.route.length === 0); i++) step(state);
    expect(drone.state).toBe(DroneState.Dock);
    must(state, { type: 'refundDrone', drone: id });
    expect(liveDrones(state).length).toBe(2);
  });

  it('已经退回的飞机不能再退：alreadyRefunded，飞机不存在：unknownTarget', () => {
    const state = withMoney(quietState(), 1000);
    const id = withThirdDrone(state);
    must(state, { type: 'refundDrone', drone: id });
    expectRejected(state, { type: 'refundDrone', drone: id }, 'alreadyRefunded');
    for (const drone of [-1, 99, 0.5]) expectRejected(state, { type: 'refundDrone', drone }, 'unknownTarget');
  });

  it('已退回的飞机不参与派单、不动、不充电、不计入飞机数：之后的订单都由还在的飞机去送', () => {
    const state = withMoney(quietState(), 1000);
    const id = withThirdDrone(state);
    must(state, { type: 'refundDrone', drone: id });
    const frozen = JSON.stringify(state.drones[id]);
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 3; i++) addOrder(state, { merchant: (round * 3 + i) % 9, building: 10 + i, portion: 1, prepSteps: 30 });
      advance(state, 200);
    }
    expect(state.orders.filter((o) => o.status === OrderStatus.Delivered).length).toBeGreaterThan(8);
    expect(state.orders.some((o) => o.drone === id)).toBe(false);
    expect(JSON.stringify(state.drones[id])).toBe(frozen);
    expect(fleetOf(state, 0)).toBe(2);
    expect((state.stations[0] as { occupied: number }).occupied).toBeLessThanOrEqual(2);
  });
});

describe('退回停机位', () => {
  it('当天买的停机位可以按原价退回，后买的先退：先退第 4 个（164），再退第 3 个（140）', () => {
    const state = withMoney(quietState(), 1000);
    must(state, { type: 'buyBay', station: 0 }); // 140
    must(state, { type: 'buyBay', station: 0 }); // 164
    const campaign = campaignOf(state);
    expect(campaign.money).toBe(1000 - 140 - 164);
    expect(quoteCommand(state, { type: 'refundBay', station: 0 })).toEqual({ ok: true, reason: null, kind: 'refund', price: 164 });
    must(state, { type: 'refundBay', station: 0 });
    expect(campaign.money).toBe(1000 - 140);
    expect((state.stations[0] as { bays: number }).bays).toBe(3);
    must(state, { type: 'refundBay', station: 0 });
    expect(campaign.money).toBe(1000);
    expect((state.stations[0] as { bays: number }).bays).toBe(2);
    expect(campaign.refunded).toBe(304);
    expectRejected(state, { type: 'refundBay', station: 0 }, 'notBoughtToday'); // 开局自带的 2 个不能退
  });

  it('不是当天买的不能退：前一天买的停机位 notBoughtToday', () => {
    const state = withMoney(quietState(), 1000);
    must(state, { type: 'buyBay', station: 0 });
    advance(state, DAY_STEPS);
    expectRejected(state, { type: 'refundBay', station: 0 }, 'notBoughtToday');
    must(state, { type: 'buyBay', station: 0 }); // 今天买的第 4 个可以退
    must(state, { type: 'refundBay', station: 0 });
    expectRejected(state, { type: 'refundBay', station: 0 }, 'notBoughtToday'); // 再退就是昨天买的第 3 个
  });

  it('退回之后停机位数不能小于这座站的飞机数：baysInUse，先把飞机退掉就可以退', () => {
    const state = withMoney(quietState(), 1000);
    const id = withThirdDrone(state); // 3 个停机位、3 架飞机
    expectRejected(state, { type: 'refundBay', station: 0 }, 'baysInUse');
    must(state, { type: 'refundDrone', drone: id });
    must(state, { type: 'refundBay', station: 0 });
    expect((state.stations[0] as { bays: number }).bays).toBe(2);
  });

  it('退回之后停机位数也不能小于正占用停机位的飞机数（包括预约降落的）', () => {
    const state = withMoney(quietState(), 1000);
    openAll(state);
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    must(state, { type: 'buyBay', station: id }); // 3 个停机位，没有飞机
    const station = state.stations[id] as { occupied: number };
    station.occupied = 3; // 别的站的三架飞机停在这里
    expectRejected(state, { type: 'refundBay', station: id }, 'baysInUse');
    station.occupied = 2;
    must(state, { type: 'refundBay', station: id });
    // 预约降落的：占用 1 个，预约 1 架，停机位只剩 2 个，也不能再少
    must(state, { type: 'buyBay', station: id });
    station.occupied = 1;
    const visitor = state.drones[0] as { returning: boolean; target: number };
    visitor.returning = true;
    visitor.target = id;
    must(state, { type: 'refundBay', station: id }); // 3 个退成 2 个，占用 1 加预约 1 等于 2，可以
    expect((state.stations[id] as { bays: number }).bays).toBe(2);
    expectRejected(state, { type: 'refundBay', station: id }, 'notBoughtToday'); // 没有可退的了
  });

  it('站不存在：unknownTarget，站已退回：alreadyRefunded', () => {
    const state = withMoney(quietState(), 1000);
    openAll(state);
    for (const station of [-1, 5, 0.5]) expectRejected(state, { type: 'refundBay', station }, 'unknownTarget');
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    must(state, { type: 'refundStation', station: id });
    expectRejected(state, { type: 'refundBay', station: id }, 'alreadyRefunded');
  });
});

describe('退回站点', () => {
  it('当天建的站，没有飞机，可以按原价退回：余额加回建站价，站数减一，屋顶空出来，站的编号不回收', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    const campaign = campaignOf(state);
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    const price = 10000 - campaign.money;
    expect(price).toBeGreaterThan(300);
    expect(stationCount(state)).toBe(2);
    expect(quoteCommand(state, { type: 'refundStation', station: id })).toEqual({ ok: true, reason: null, kind: 'refund', price });
    must(state, { type: 'refundStation', station: id });
    expect(campaign.money).toBe(10000);
    expect(campaign.refunded).toBe(price);
    expect(stationCount(state)).toBe(1);
    expect(campaign.roofStation[OFFICE_ROOF]).toBe(-1);
    const station = state.stations[id] as { removed: boolean; bays: number; occupied: number; queue: number[] };
    expect(station).toMatchObject({ removed: true, bays: 0, occupied: 0, queue: [] });
    expect(state.stations.length).toBe(2); // 不从数组里删除
    // 屋顶空着，可以再建，价格按现在的站数算（第 2 座 500 起），新站用新的编号
    const again = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    expect(again).toBe(2);
    expect(10000 - campaign.money).toBe(price);
    expect(campaign.roofStation[OFFICE_ROOF]).toBe(2);
  });

  it('当天买在这座站上的停机位一起退回', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    const campaign = campaignOf(state);
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    must(state, { type: 'buyBay', station: id });
    must(state, { type: 'buyBay', station: id });
    const quote = quoteCommand(state, { type: 'refundStation', station: id });
    expect(quote.price).toBe(10000 - campaign.money);
    must(state, { type: 'refundStation', station: id });
    expect(campaign.money).toBe(10000);
    expect(campaign.stations[id]?.bays).toEqual([]);
  });

  it('当天买在这座站上的起降口升级也一起退回：2 级 240、3 级 900，价签报的总数随升级增加，退回之后余额回到原样', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    const campaign = campaignOf(state);
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    must(state, { type: 'buyBay', station: id });
    const withoutGate = quoteCommand(state, { type: 'refundStation', station: id }).price;
    expect(withoutGate).toBe(10000 - campaign.money);
    must(state, { type: 'upgradeGate', station: id });
    expect(campaign.money).toBe(10000 - withoutGate - 240);
    expect(quoteCommand(state, { type: 'refundStation', station: id })).toEqual({ ok: true, reason: null, kind: 'refund', price: withoutGate + 240 });
    must(state, { type: 'upgradeGate', station: id });
    expect(campaign.stations[id]?.gateLevel).toBe(3);
    const total = quoteCommand(state, { type: 'refundStation', station: id }).price;
    expect(total).toBe(withoutGate + 240 + 900);
    expect(total).toBe(10000 - campaign.money);
    must(state, { type: 'refundStation', station: id });
    expect(campaign.money).toBe(10000);
    expect(campaign.refunded).toBe(campaign.spent);
    expect(campaign.refunded).toBe(total);
  });

  it('退回的站不留购买的痕迹：起降口回到 1 级，间隔也回去；同一块屋顶再建站，新站从 1 级起，2 级的价格还是 240', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    const campaign = campaignOf(state);
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    must(state, { type: 'upgradeGate', station: id });
    must(state, { type: 'upgradeGate', station: id });
    expect((state.stations[id] as { gateInterval: number }).gateInterval).toBe(4);
    must(state, { type: 'refundStation', station: id });
    expect(campaign.stations[id]).toMatchObject({ gateLevel: 1, bays: [] });
    expect((state.stations[id] as { gateInterval: number }).gateInterval).toBe(12);
    const again = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    expect(campaign.stations[again]?.gateLevel).toBe(1);
    expect(quoteCommand(state, { type: 'upgradeGate', station: again }).price).toBe(240);
    // 老站不受影响：开局的站升级之后不能当天退站点，升级的钱也不会被退
    must(state, { type: 'upgradeGate', station: 0 });
    expectRejected(state, { type: 'refundStation', station: 0 }, 'notBoughtToday');
  });

  it('这座站已经没有飞机才能退：fleet 里还有飞机、停机位被占着、有飞机预约降落，都是 stationNotEmpty', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    const drone = must(state, { type: 'buyDrone', station: id });
    expectRejected(state, { type: 'refundStation', station: id }, 'stationNotEmpty');
    must(state, { type: 'refundDrone', drone });
    // 别的站的飞机停在这里（占用数不是 0，归属站不是这座站）
    const station = state.stations[id] as { occupied: number };
    station.occupied = 1;
    expectRejected(state, { type: 'refundStation', station: id }, 'stationNotEmpty');
    station.occupied = 0;
    // 别的站的飞机预约了这座站
    const visitor = state.drones[0] as { returning: boolean; target: number };
    visitor.returning = true;
    visitor.target = id;
    expectRejected(state, { type: 'refundStation', station: id }, 'stationNotEmpty');
    visitor.returning = false;
    visitor.target = -1;
    must(state, { type: 'refundStation', station: id });
  });

  it('不是当天建的不能退：开局的站，以及前一天建的站，notBoughtToday', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    expectRejected(state, { type: 'refundStation', station: 0 }, 'notBoughtToday');
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    advance(state, DAY_STEPS);
    expectRejected(state, { type: 'refundStation', station: id }, 'notBoughtToday');
  });

  it('站不存在：unknownTarget，已经退回：alreadyRefunded', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    for (const station of [-1, 7, 0.5]) expectRejected(state, { type: 'refundStation', station }, 'unknownTarget');
    const id = must(state, { type: 'buildStation', roof: OFFICE_ROOF });
    must(state, { type: 'refundStation', station: id });
    expectRejected(state, { type: 'refundStation', station: id }, 'alreadyRefunded');
  });

  it('已退回的站不参与任何计算：订单的本站不再是它，等待派单的订单重新找最近的站，不产生统计，站数不计它', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    // 在店 3（老街东边）旁边建一座站：它是离店 3 最近的站
    const east = roofWhere((r) => r.district === 0 && r.x > 1000 && r.y < 500);
    const id = must(state, { type: 'buildStation', roof: east });
    advance(state, 1); // 避开第 0 步的派单，订单放进去之后停在等待状态
    const order = addOrder(state, { merchant: 3, building: 7, portion: 1, prepSteps: 20 });
    expect(order.home).toBe(id);
    must(state, { type: 'refundStation', station: id });
    expect(order.status).toBe(OrderStatus.Pending);
    expect(order.home).toBe(0); // 重新找最近的站
    const later = addOrder(state, { merchant: 3, building: 7, portion: 1, prepSteps: 20 });
    expect(later.home).toBe(0);
    // 统计：已退回的站的各项累计不再增长
    const sum = (rows: number[][]): number => (rows[id] as number[]).reduce((a, b) => a + b, 0);
    const before = [sum(state.stats.landWait), sum(state.stats.bayEmpty), sum(state.stats.bayTotal)];
    advance(state, 600);
    expect([sum(state.stats.landWait), sum(state.stats.bayEmpty), sum(state.stats.bayTotal)]).toEqual(before);
    expect(stationCount(state)).toBe(1);
    // 订单都由站 0 的飞机去送，起降口不放行已退回的站
    expect(state.orders.every((o) => o.departed === 0 || o.departed === -1)).toBe(true);
    expect((state.stations[id] as { gateFree: number }).gateFree).toBeLessThanOrEqual(state.step);
  });

  it('新建的站接手等待中的订单：建站之后，等待派单的订单的本站改成离店最近的新站', () => {
    const state = withMoney(quietState(), 10000);
    openAll(state);
    advance(state, 1);
    const order = addOrder(state, { merchant: 3, building: 7, portion: 1, prepSteps: 20 });
    expect(order.home).toBe(0);
    const id = must(state, { type: 'buildStation', roof: roofWhere((r) => r.district === 0 && r.x > 1000 && r.y < 500) });
    expect(order.home).toBe(id);
  });
});

describe('钱：余额的来源和去处', () => {
  it('买的和退的都记在账上：余额 = 起始余额 − 全部购买 + 全部退回，价签报的价格就是实付和实退', () => {
    const state = withMoney(quietState(), 5000);
    openAll(state);
    const campaign = campaignOf(state);
    let expected = 5000;
    const run = (command: Parameters<typeof must>[1]): void => {
      const quote = quoteCommand(state, command);
      expect(quote.ok, JSON.stringify(command)).toBe(true);
      must(state, command);
      expected += quote.kind === 'refund' ? quote.price : -quote.price;
      expect(campaign.money).toBeCloseTo(expected, 9);
    };
    run({ type: 'buildStation', roof: OFFICE_ROOF });
    run({ type: 'buyBay', station: 1 });
    run({ type: 'buyDrone', station: 1 });
    run({ type: 'upgradeGate', station: 1 });
    run({ type: 'buyDoubleBox' });
    run({ type: 'buyNearestLanding' });
    run({ type: 'buyBay', station: 0 });
    run({ type: 'refundBay', station: 0 });
    const drone = state.drones.length - 1;
    run({ type: 'refundDrone', drone });
    run({ type: 'refundBay', station: 1 });
    run({ type: 'buildStation', roof: OLD_SMALL });
    run({ type: 'upgradeGate', station: 2 });
    run({ type: 'refundStation', station: 2 }); // 站点价和当天的起降口升级一起退
    expect(campaign.money).toBeCloseTo(5000 - campaign.spent + campaign.refunded, 9);
    expect(campaign.spent).toBeGreaterThan(campaign.refunded);
  });
});

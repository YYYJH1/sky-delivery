// 顾客的耐心：经营模式里订单的退单时限随送往的片区的星级变短，沙盒模式固定 90 秒。
import { describe, expect, it } from 'vitest';
import { STARS_V1 } from '../src/content/stars_v1.ts';
import { CANCEL_STEPS, OrderStatus, STEPS_PER_SECOND, addOrder, advance, createState, districtPatienceSeconds, orderPatienceSteps, patienceSteps, shortestPatienceSteps, step } from '../src/core/index.ts';
import type { Order, SimState } from '../src/core/index.ts';
import { expireOrders } from '../src/core/systems/expiry.ts';
import { campaignOf, quietState } from './campaign-helpers.ts';
import { OPENING } from './helpers.ts';

const SECONDS = STARS_V1.patienceSeconds;

/** 没有飞机的经营模式状态：订单没人接，只会因为耐心用完而退单。三个片区都开通。 */
function stranded(stars: readonly number[] = [1, 1, 1]): SimState {
  const state = quietState({}, false);
  for (const d of state.drones) d.removed = true;
  for (const s of state.stations) s.occupied = 0;
  const campaign = campaignOf(state);
  campaign.districts.forEach((d, k) => {
    d.open = true;
    d.star = stars[k] as number;
  });
  return state;
}

/** 在当前步给一个片区放一张订单。 */
function orderTo(state: SimState, district: number): Order {
  const buildings = state.world.buildingsByDistrict[district] as number[];
  return addOrder(state, { merchant: 0, building: buildings[0] as number, portion: 1, prepSteps: 10 });
}

/** 推进到订单的下单步加 age 步（含），返回这一步之后订单的状态。 */
function runTo(state: SimState, order: Order, age: number): number {
  advance(state, order.tOrder + age - state.step);
  step(state); // 退单阶段在每步里做，执行完第 tOrder + age 步才看得到
  return order.status;
}

describe('内容表里的耐心', () => {
  it('每一星一项，不随星级变长，一星和二星是沙盒的 90 秒，最高星的最短', () => {
    expect(SECONDS.length).toBe(STARS_V1.maxStar);
    for (let i = 1; i < SECONDS.length; i++) expect(SECONDS[i] as number).toBeLessThanOrEqual(SECONDS[i - 1] as number);
    expect(SECONDS[0]).toBe(CANCEL_STEPS / STEPS_PER_SECOND);
    expect(SECONDS[SECONDS.length - 1] as number).toBeLessThan(SECONDS[0] as number);
    for (const s of SECONDS) expect(Number.isInteger(s * STEPS_PER_SECOND)).toBe(true);
  });

  it('patienceSteps：按星级取，单位是步，超出范围时取最近的一档', () => {
    SECONDS.forEach((seconds, i) => expect(patienceSteps(i + 1)).toBe(seconds * STEPS_PER_SECOND));
    expect(patienceSteps(0)).toBe(patienceSteps(1));
    expect(patienceSteps(9)).toBe(patienceSteps(STARS_V1.maxStar));
    expect(shortestPatienceSteps()).toBe(Math.min(...SECONDS) * STEPS_PER_SECOND);
  });
});

describe('订单现在的时限', () => {
  it('经营模式：按订单送往的片区现在的星级，升星或掉星之后马上变，不记在订单上', () => {
    const state = stranded([1, 3, 5]);
    const [a, b, c] = [orderTo(state, 0), orderTo(state, 1), orderTo(state, 2)] as [Order, Order, Order];
    expect([a, b, c].map((o) => orderPatienceSteps(state, o))).toEqual([1, 3, 5].map((star) => patienceSteps(star)));
    expect([0, 1, 2].map((k) => districtPatienceSeconds(state, k))).toEqual([SECONDS[0], SECONDS[2], SECONDS[4]]);
    campaignOf(state).districts[0]!.star = 4;
    expect(orderPatienceSteps(state, a)).toBe(patienceSteps(4));
    expect(districtPatienceSeconds(state, 0)).toBe(SECONDS[3]);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort()); // 订单的字段不因为这件事多出来
  });

  it('沙盒模式：固定 90 秒，没有这个片区时也是 90 秒', () => {
    const sandbox = createState({ ...OPENING });
    const order = orderTo(sandbox, 0);
    expect(orderPatienceSteps(sandbox, order)).toBe(CANCEL_STEPS);
    expect(districtPatienceSeconds(sandbox, 1)).toBe(90);
    expect(districtPatienceSeconds(quietState(), 9)).toBe(90);
  });
});

describe('经营模式的退单', () => {
  it.each([1, 2, 3, 4, 5])('%i 星的片区：下单后恰好等满 %i 星的时限就退单，差一步不退', (star) => {
    const state = stranded([star, star, star]);
    const order = orderTo(state, 1);
    const limit = patienceSteps(star);
    expect(runTo(state, order, limit - 1)).toBe(OrderStatus.Pending);
    expect(order.tCancel).toBe(-1);
    expect(runTo(state, order, limit)).toBe(OrderStatus.Cancelled);
    expect(order.tCancel).toBe(order.tOrder + limit);
    expect(state.pending).not.toContain(order.id);
    expect(state.openQueue).not.toContain(order.id);
  });

  it('后下单的订单可以先退单：老街一星的订单先下，五星的写字楼区订单后下却先到时限', () => {
    const state = stranded([1, 5, 1]);
    const early = orderTo(state, 0); // 第 0 步，一星的限
    advance(state, 100);
    const late = orderTo(state, 1); // 第 100 步，五星的限，比一星的短
    expect(state.openQueue).toEqual([early.id, late.id]);
    expect(runTo(state, late, patienceSteps(5) - 1)).toBe(OrderStatus.Pending);
    expect(runTo(state, late, patienceSteps(5))).toBe(OrderStatus.Cancelled);
    expect(late.tCancel).toBe(100 + patienceSteps(5));
    expect(early.status).toBe(OrderStatus.Pending); // 先下单的这张还在等，还没到一星的限
    expect(state.openQueue).toEqual([early.id]);
    expect(runTo(state, early, patienceSteps(1))).toBe(OrderStatus.Cancelled);
    expect(early.tCancel).toBe(patienceSteps(1));
    expect(state.openQueue).toEqual([]);
  });

  it('同一步里几张订单一起到时限：按下单的先后退单，没到的留在队列里，次序不变', () => {
    const state = stranded([1, 4, 1]);
    const a = orderTo(state, 1);
    const b = orderTo(state, 1);
    advance(state, 5);
    const c = orderTo(state, 0);
    advance(state, 5);
    const d = orderTo(state, 1);
    expect(state.openQueue).toEqual([a.id, b.id, c.id, d.id]);
    advance(state, patienceSteps(4) - state.step); // 第 600 步还没执行
    expect(a.status).toBe(OrderStatus.Pending);
    step(state);
    expect([a, b].map((o) => [o.status, o.tCancel])).toEqual([
      [OrderStatus.Cancelled, patienceSteps(4)],
      [OrderStatus.Cancelled, patienceSteps(4)],
    ]);
    expect(c.status).toBe(OrderStatus.Pending);
    expect(d.status).toBe(OrderStatus.Pending);
    expect(state.openQueue).toEqual([c.id, d.id]);
    advance(state, 10);
    expect(d.status).toBe(OrderStatus.Cancelled);
    expect(d.tCancel).toBe(10 + patienceSteps(4));
    expect(c.status).toBe(OrderStatus.Pending); // 老街一星，限比四星的长
  });

  it('升星之后，还在等的订单按新的星级判断：已经等了一星的限的七成多的订单，片区从一星升到四星，下一步就退单', () => {
    const state = stranded([1, 1, 1]);
    const order = orderTo(state, 0);
    advance(state, 70 * STEPS_PER_SECOND);
    step(state);
    expect(order.status).toBe(OrderStatus.Pending); // 一星的限是 90 秒
    expect(patienceSteps(4)).toBeLessThan(70 * STEPS_PER_SECOND);
    campaignOf(state).districts[0]!.star = 4; // 四星的限已经超了
    step(state);
    expect(order.status).toBe(OrderStatus.Cancelled);
    expect(order.tCancel).toBe(state.step - 1);
  });

  it('掉星之后订单变得耐心：五星时的限还没到，掉到一星之后要等到一星的限才退单', () => {
    const state = stranded([5, 5, 5]);
    const order = orderTo(state, 2);
    const fiveStar = SECONDS[4] as number;
    const oneStar = SECONDS[0] as number;
    advance(state, (fiveStar - 5) * STEPS_PER_SECOND);
    campaignOf(state).districts[2]!.star = 1;
    expect(runTo(state, order, (fiveStar + 10) * STEPS_PER_SECOND)).toBe(OrderStatus.Pending); // 已经超过了五星的限
    expect(runTo(state, order, (oneStar - 1) * STEPS_PER_SECOND)).toBe(OrderStatus.Pending);
    expect(runTo(state, order, oneStar * STEPS_PER_SECOND)).toBe(OrderStatus.Cancelled);
  });

  it('已经取走的订单一定送到：不会因为时限退单，也从队列里拿掉', () => {
    const state = stranded([5, 5, 5]);
    const picked = orderTo(state, 1);
    advance(state, 5);
    const waiting = orderTo(state, 1);
    picked.status = OrderStatus.Picked;
    picked.tPick = state.step;
    advance(state, patienceSteps(5) + 20 - state.step);
    expect(picked.status).toBe(OrderStatus.Picked);
    expect(picked.tCancel).toBe(-1);
    expect(waiting.status).toBe(OrderStatus.Cancelled);
    expect(state.openQueue).not.toContain(picked.id);
  });

  it('下单离现在不到最短时限的订单一定没到时限：队列里排在后面的订单不被检查', () => {
    const state = stranded([5, 5, 5]);
    const old = orderTo(state, 0); // 老街五星，各星里最短的限
    advance(state, 10);
    const fresh = orderTo(state, 1);
    state.step = old.tOrder + shortestPatienceSteps() - 1;
    expireOrders(state);
    expect([old.status, fresh.status]).toEqual([OrderStatus.Pending, OrderStatus.Pending]);
    state.step = old.tOrder + shortestPatienceSteps();
    expireOrders(state);
    expect([old.status, fresh.status]).toEqual([OrderStatus.Cancelled, OrderStatus.Pending]);
  });
});

describe('沙盒模式的退单不变', () => {
  it('固定 90 秒：恰好等满 CANCEL_STEPS 才退单，与星级无关', () => {
    const sandbox = createState({ ...OPENING, drones: 1, orderEndStep: 0 });
    for (const d of sandbox.drones) d.removed = true;
    for (const s of sandbox.stations) s.occupied = 0;
    const order = orderTo(sandbox, 0);
    expect(runTo(sandbox, order, CANCEL_STEPS - 1)).toBe(OrderStatus.Pending);
    expect(runTo(sandbox, order, CANCEL_STEPS)).toBe(OrderStatus.Cancelled);
    expect(order.tCancel).toBe(order.tOrder + CANCEL_STEPS);
  });
});

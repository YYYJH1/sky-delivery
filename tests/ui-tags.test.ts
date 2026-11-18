// 价签和改装列表的状态：价格，能不能买，为什么不能买。价格和条件都来自核心的 quoteCommand。
// 期望的价格都由价格表（ECONOMY_V1）和核心的算价函数得出，不写死数字，价格表重新校准之后这里不用改。
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { bayPrice, dronePrice, gatePrice, hashState, quoteCommand, stationBasePrice, stationCount, stationPrice } from '../src/core/index.ts';
import { candidateRoofs } from '../src/ui/roofs.ts';
import { buildTag, doubleBoxItem, gateItem, gateRows, nearbyLandingItem, stationTags, tagFromQuote } from '../src/ui/tags.ts';
import { campaignOf, campaignState as lockedState, must, quietState, unlockAll, withMoney } from './campaign-helpers.ts';

/** 这个文件里的测试都要能买东西，所以开局先把价签、双层货箱这些开放项全部打开。开放条件本身的测试在 ui-unlocks.test.ts。 */
const campaignState = (): ReturnType<typeof lockedState> => unlockAll(lockedState());

describe('由报价做成价签', () => {
  it('能买：价格照核心的，不变淡', () => {
    const state = withMoney(campaignState(), 10_000);
    const quote = quoteCommand(state, { type: 'buyBay', station: 0 });
    expect(tagFromQuote(quote, 10_000)).toEqual({ price: bayPrice(3), ok: true, dim: false, reason: null });
  });

  it('余额不够：不能买，文字变淡，原因是 notEnoughMoney', () => {
    const state = withMoney(campaignState(), 10);
    const tag = tagFromQuote(quoteCommand(state, { type: 'buyBay', station: 0 }), 10);
    expect(tag).toEqual({ price: bayPrice(3), ok: false, dim: true, reason: 'notEnoughMoney' });
  });

  it('文字变淡只看余额：恰好够买不淡，差一点就淡', () => {
    const state = campaignState();
    const quote = quoteCommand(state, { type: 'buyBay', station: 0 });
    expect(tagFromQuote(quote, bayPrice(3)).dim).toBe(false);
    expect(tagFromQuote(quote, bayPrice(3) - 0.01).dim).toBe(true);
  });

  it('别的原因不能买、钱够：不变淡，价格照常显示，原因交给点击时的提示', () => {
    const state = withMoney(campaignState(), 10_000);
    const tag = tagFromQuote(quoteCommand(state, { type: 'buyDrone', station: 0 }), 10_000);
    expect(tag).toEqual({ price: dronePrice(3), ok: false, dim: false, reason: 'fleetFull' });
  });

  it('别的原因不能买、钱也不够：照样变淡。余额不够的价签文字变淡，不管还有没有别的原因', () => {
    const state = withMoney(campaignState(), 10);
    const tag = tagFromQuote(quoteCommand(state, { type: 'buyDrone', station: 0 }), 10);
    expect(tag).toEqual({ price: dronePrice(3), ok: false, dim: true, reason: 'fleetFull' });
    expect(stationTags(state, 0).addDrone.dim).toBe(true);
  });
});

describe('一座站的「新增停机位」和「购买无人机」', () => {
  it('价格按这座站自己已有的数量算：开局的站有自带的停机位和飞机，下一个停机位、下一架飞机各是下一档的价格', () => {
    const state = withMoney(campaignState(), 10_000);
    const tags = stationTags(state, 0);
    expect(tags.addBay.price).toBe(bayPrice(ECONOMY_V1.baysAtBuild + 1));
    expect(tags.addBay.price).toBe(bayPrice(3));
    expect(tags.addDrone.price).toBe(dronePrice(ECONOMY_V1.openingDrones + 1));
    expect(tags.addDrone.price).toBe(dronePrice(3));
    expect(tags.addBay.ok).toBe(true);
    expect(tags.addDrone.ok).toBe(false); // 停机位满了
    expect(tags.addDrone.reason).toBe('fleetFull');
  });

  it('新增了一个停机位之后，购买无人机能买了，停机位的价格涨到下一档', () => {
    const state = withMoney(campaignState(), 10_000);
    must(state, { type: 'buyBay', station: 0 });
    const tags = stationTags(state, 0);
    expect(tags.addBay.price).toBe(bayPrice(4));
    expect(tags.addDrone).toEqual({ price: dronePrice(3), ok: true, dim: false, reason: null });
  });

  it('另一座站的价格各算各的', () => {
    const state = withMoney(campaignState(), 10_000);
    const second = must(state, { type: 'buildStation', roof: 1 });
    must(state, { type: 'buyBay', station: second });
    must(state, { type: 'buyBay', station: second });
    expect(stationTags(state, 0).addBay.price).toBe(bayPrice(3));
    expect(stationTags(state, second).addBay.price).toBe(bayPrice(5));
  });

  it('停机位到了屋顶的上限：不能买，不变淡，原因是 bayLimit', () => {
    const state = withMoney(quietState());
    for (let i = ECONOMY_V1.baysAtBuild; i < ECONOMY_V1.bayCap.medium; i++) must(state, { type: 'buyBay', station: 0 }); // 开局的站在中屋顶上
    expect(stationTags(state, 0).addBay).toMatchObject({ ok: false, dim: false, reason: 'bayLimit' });
  });
});

describe('「新建站点」价签', () => {
  /** 开局时候选屋顶里最便宜的一块的建站价：第 2 座站的基准价乘候选屋顶里最小的价格系数，取整。 */
  function cheapestOpening(state: ReturnType<typeof campaignState>): number {
    const smallest = Math.min(...MAP_V1.roofs.filter((_, i) => candidateRoofs(state).some((c) => c.roof === i)).map((r) => r.priceCoef));
    return Math.round(ECONOMY_V1.stationBase[0]! * smallest);
  }

  it('价格是候选屋顶里最便宜的一块：开局的第 2 座站，基准价乘最小的系数，取整', () => {
    const state = campaignState();
    const candidates = candidateRoofs(state);
    const tag = buildTag(state, candidates);
    const price = cheapestOpening(state);
    expect(price).toBe(Math.min(...candidates.map((c) => stationPrice(1, c.roof))));
    expect(tag.price).toBe(price);
    expect(tag).toEqual({ price, ok: false, dim: true, reason: 'notEnoughMoney' });
  });

  it('钱够买最便宜的一块就能买，不变淡', () => {
    const state = campaignState();
    const price = cheapestOpening(state);
    withMoney(state, price);
    expect(buildTag(state, candidateRoofs(state))).toEqual({ price, ok: true, dim: false, reason: null });
    campaignOf(state).money = price - 0.5;
    expect(buildTag(state, candidateRoofs(state)).dim).toBe(true);
  });

  it('站数到了上限：不能建，不变淡，价格写下一座的基准价', () => {
    const state = withMoney(quietState(), 100_000);
    for (const roof of [1, 2, 3]) must(state, { type: 'buildStation', roof });
    expect(stationCount(state)).toBe(ECONOMY_V1.maxStations);
    expect(buildTag(state, candidateRoofs(state))).toMatchObject({ ok: false, dim: false, reason: 'stationLimit', price: stationBasePrice(stationCount(state)) });
    expect(stationBasePrice(stationCount(state))).toBe(ECONOMY_V1.stationBase[ECONOMY_V1.stationBase.length - 1]);
  });

  it('没有空着的候选屋顶时不能建，原因是 roofTaken，文字变不变淡只看余额', () => {
    const state = withMoney(campaignState(), 10_000);
    expect(buildTag(state, [])).toMatchObject({ ok: false, dim: false, reason: 'roofTaken' });
    withMoney(state, 10);
    expect(buildTag(state, [])).toMatchObject({ ok: false, dim: true, reason: 'roofTaken' });
  });
});

describe('改装列表', () => {
  it('双层货箱：价格取自价格表，买不起变淡，买了标为已经买过，再点提示已经买过', () => {
    const price = ECONOMY_V1.doubleBoxPrice;
    const state = campaignState();
    expect(doubleBoxItem(state)).toEqual({ key: 'doubleBox', price, note: 'desc', dim: true, click: { kind: 'run', command: { type: 'buyDoubleBox' } } });
    withMoney(state, price);
    expect(doubleBoxItem(state)).toMatchObject({ price, note: 'desc', dim: false });
    must(state, { type: 'buyDoubleBox' });
    expect(doubleBoxItem(state)).toEqual({ key: 'doubleBox', price, note: 'owned', dim: false, click: { kind: 'hint', hint: 'alreadyOwned' } });
  });

  it('就近降落：只有一座站时没开放，提示要有第二座站；有了第二座站才能买，买之前不是开关', () => {
    const price = ECONOMY_V1.nearestLandingPrice;
    const state = withMoney(campaignState(), 10_000);
    expect(nearbyLandingItem(state)).toEqual({ key: 'nearbyLanding', price, note: 'locked', dim: false, click: { kind: 'hint', hint: 'needTwoStations' } });
    must(state, { type: 'buildStation', roof: 1 });
    expect(nearbyLandingItem(state)).toEqual({ key: 'nearbyLanding', price, note: 'desc', dim: false, click: { kind: 'run', command: { type: 'buyNearestLanding' } } });
    withMoney(state, price - 1);
    expect(nearbyLandingItem(state)).toMatchObject({ note: 'desc', dim: true });
  });

  it('就近降落买下之后变成开关：开着，点击发出关闭的命令，成功之后的系统提示是已关闭', () => {
    const price = ECONOMY_V1.nearestLandingPrice;
    const state = withMoney(campaignState(), 10_000);
    must(state, { type: 'buildStation', roof: 1 });
    must(state, { type: 'buyNearestLanding' });
    expect(state.returnRule).toBe('nearest');
    expect(nearbyLandingItem(state)).toEqual({
      key: 'nearbyLanding',
      price,
      note: 'toggle',
      dim: false,
      on: true,
      click: { kind: 'run', command: { type: 'setNearestLanding', on: false }, done: '就近降落已关闭。' },
    });
  });

  it('开关免费，来回切换：关着时点击发出开启的命令，成功之后的系统提示是已开启，仍记着已买下', () => {
    const state = withMoney(campaignState(), 10_000);
    must(state, { type: 'buildStation', roof: 1 });
    must(state, { type: 'buyNearestLanding' });
    const money = campaignOf(state).money;
    expect(quoteCommand(state, { type: 'setNearestLanding', on: false })).toEqual({ ok: true, reason: null, kind: 'free', price: 0 });
    must(state, { type: 'setNearestLanding', on: false });
    expect(state.returnRule).toBe('home');
    expect(campaignOf(state).nearestOwned).toBe(true);
    expect(campaignOf(state).money).toBe(money);
    expect(nearbyLandingItem(state)).toMatchObject({ note: 'toggle', on: false, click: { kind: 'run', command: { type: 'setNearestLanding', on: true }, done: '就近降落已开启。' } });
    must(state, { type: 'setNearestLanding', on: true });
    expect(state.returnRule).toBe('nearest');
    expect(nearbyLandingItem(state)).toMatchObject({ note: 'toggle', on: true });
  });

  it('开关和余额无关：没钱也是开关，文字不变淡，关着时再点「购买」不会重复收费（核心报已购买）', () => {
    const state = withMoney(campaignState(), 10_000);
    must(state, { type: 'buildStation', roof: 1 });
    must(state, { type: 'buyNearestLanding' });
    must(state, { type: 'setNearestLanding', on: false });
    withMoney(state, 0);
    expect(nearbyLandingItem(state)).toMatchObject({ note: 'toggle', dim: false, on: false });
    expect(quoteCommand(state, { type: 'buyNearestLanding' })).toMatchObject({ ok: false, reason: 'alreadyOwned' });
  });

  it('没买下就近降落时开关不可用：核心拒绝，原因是 ruleLocked', () => {
    const state = withMoney(campaignState(), 10_000);
    must(state, { type: 'buildStation', roof: 1 });
    expect(quoteCommand(state, { type: 'setNearestLanding', on: true })).toMatchObject({ ok: false, reason: 'ruleLocked' });
    expect(nearbyLandingItem(state).note).toBe('desc');
  });

  it('开局的配置里就近降落已经开着：从一开始就是开关，哪怕只有一座站', () => {
    const state = withMoney(unlockAll(lockedState({ returnRule: 'nearest' })), 0);
    expect(nearbyLandingItem(state)).toMatchObject({ note: 'toggle', on: true });
  });

  it('没选中站点时起降口一行列 2 级，点击提示先选一座站', () => {
    const state = campaignState();
    expect(gateItem(state, null)).toEqual({ key: 'gate2', price: gatePrice(2), note: 'needStation', dim: true, click: { kind: 'hint', hint: 'noStationSelected' } });
    withMoney(state, gatePrice(2));
    expect(gateItem(state, null).dim).toBe(false);
  });

  it('选中一座站：显示下一级。1 级的站列 2 级，升到 2 级后列 3 级，3 级的站标为已经买过', () => {
    const state = withMoney(campaignState(), 10_000);
    expect(gateItem(state, 0)).toEqual({ key: 'gate2', price: gatePrice(2), note: 'desc', dim: false, click: { kind: 'run', command: { type: 'upgradeGate', station: 0 } } });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(gateItem(state, 0)).toMatchObject({ key: 'gate3', price: gatePrice(3), note: 'desc' });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(gateItem(state, 0)).toEqual({ key: 'gate3', price: gatePrice(3), note: 'owned', dim: false, click: { kind: 'hint', hint: 'alreadyOwned' } });
  });

  it('改装单里起降口的两行：没选站点时都写请先选择站点，价格是 2 级和 3 级的，余额不够变淡', () => {
    const state = campaignState();
    const [second, third] = gateRows(state, null);
    expect(second).toEqual({ key: 'gate2', price: gatePrice(2), note: 'needStation', dim: true, click: { kind: 'hint', hint: 'noStationSelected' } });
    expect(third).toEqual({ key: 'gate3', price: gatePrice(3), note: 'needStation', dim: true, click: { kind: 'hint', hint: 'noStationSelected' } });
    withMoney(state, gatePrice(2));
    expect(gateRows(state, null).map((g) => g.dim)).toEqual([false, true]);
    withMoney(state, gatePrice(3));
    expect(gateRows(state, null).map((g) => g.dim)).toEqual([false, false]);
  });

  it('改装单里起降口的两行：选中一座一级站，2 级能买，3 级写需要先升级至 2 级，不能点', () => {
    const state = withMoney(campaignState(), 10_000);
    const [second, third] = gateRows(state, 0);
    expect(second).toEqual({ key: 'gate2', price: gatePrice(2), note: 'desc', dim: false, click: { kind: 'run', command: { type: 'upgradeGate', station: 0 } } });
    expect(third).toEqual({ key: 'gate3', price: gatePrice(3), note: 'locked', dim: false, click: { kind: 'none' } });
  });

  it('改装单里起降口的两行：不能点的 3 级一行不看余额，钱再多也不能买', () => {
    const state = withMoney(campaignState(), 1_000_000);
    expect(gateRows(state, 0)[1]).toMatchObject({ note: 'locked', dim: false, click: { kind: 'none' } });
    withMoney(state, 0);
    expect(gateRows(state, 0)[1]).toMatchObject({ note: 'locked', dim: false, click: { kind: 'none' } });
  });

  it('改装单里起降口的两行：升到 2 级之后，2 级写已购买，3 级能买', () => {
    const state = withMoney(campaignState(), 10_000);
    must(state, { type: 'upgradeGate', station: 0 });
    const [second, third] = gateRows(state, 0);
    expect(second).toEqual({ key: 'gate2', price: gatePrice(2), note: 'owned', dim: false, click: { kind: 'hint', hint: 'alreadyOwned' } });
    expect(third).toEqual({ key: 'gate3', price: gatePrice(3), note: 'desc', dim: false, click: { kind: 'run', command: { type: 'upgradeGate', station: 0 } } });
    withMoney(state, gatePrice(3) - 1);
    expect(gateRows(state, 0)[1]).toMatchObject({ note: 'desc', dim: true });
  });

  it('改装单里起降口的两行：升到 3 级之后，两行都写已购买', () => {
    const state = withMoney(campaignState(), 10_000);
    must(state, { type: 'upgradeGate', station: 0 });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(gateRows(state, 0).map((g) => [g.key, g.note, g.click])).toEqual([
      ['gate2', 'owned', { kind: 'hint', hint: 'alreadyOwned' }],
      ['gate3', 'owned', { kind: 'hint', hint: 'alreadyOwned' }],
    ]);
  });

  it('改装单里起降口的两行：各座站各算各的', () => {
    const state = withMoney(campaignState(), 10_000);
    const second = must(state, { type: 'buildStation', roof: 1 });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(gateRows(state, 0).map((g) => g.note)).toEqual(['owned', 'desc']);
    expect(gateRows(state, second).map((g) => g.note)).toEqual(['desc', 'locked']);
  });

  it('起降口的价格取自价格表：2 级和 3 级', () => {
    expect([gatePrice(2), gatePrice(3)]).toEqual([ECONOMY_V1.gatePrice[1], ECONOMY_V1.gatePrice[2]]);
  });

  it('只读：算价签和改装列表不改状态', () => {
    const state = withMoney(campaignState(), 600);
    const before = hashState(state);
    const json = JSON.stringify(state);
    stationTags(state, 0);
    buildTag(state, candidateRoofs(state));
    doubleBoxItem(state);
    nearbyLandingItem(state);
    gateItem(state, 0);
    gateItem(state, null);
    gateRows(state, 0);
    gateRows(state, null);
    expect(hashState(state)).toBe(before);
    expect(JSON.stringify(state)).toBe(json);
  });
});

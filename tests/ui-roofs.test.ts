// 候选屋顶：平均飞行秒数（直线距离除以飞行速度，只算本片区已开张的店和全部的楼），候选屋顶的列表和价格。
// 价格和停机位上限取自价格表（ECONOMY_V1），价格表重新校准之后这里不用改。
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { SPEED, createState, hashState, quoteCommand, refreshShops, stationPrice } from '../src/core/index.ts';
import { STATION_SIZES } from '../src/render/city.ts';
import { averageFlightSeconds, candidateRoofs, roofFlight, roofLines, secondsText } from '../src/ui/roofs.ts';
import { campaignOf, campaignState, must, unlockAll, withMoney } from './campaign-helpers.ts';

describe('平均飞行秒数', () => {
  it('飞行速度是每秒 110，所以 110 个单位远的点是 1 秒', () => {
    expect(SPEED).toBe(110);
    expect(averageFlightSeconds({ x: 0, y: 0 }, [{ x: 110, y: 0 }])).toBeCloseTo(1, 12);
    expect(averageFlightSeconds({ x: 5, y: 5 }, [{ x: 5, y: 225 }])).toBeCloseTo(2, 12);
  });

  it('直线距离：三四五的直角三角形，斜边 550 是 5 秒', () => {
    expect(averageFlightSeconds({ x: 0, y: 0 }, [{ x: 330, y: 440 }])).toBeCloseTo(5, 12);
  });

  it('多个目标取平均，各自的距离先除以速度', () => {
    const from = { x: 0, y: 0 };
    const targets = [{ x: 110, y: 0 }, { x: 0, y: 220 }, { x: 330, y: 0 }];
    expect(averageFlightSeconds(from, targets)).toBeCloseTo((1 + 2 + 3) / 3, 12);
  });

  it('没有目标点时是 null，不是 0 也不是 NaN', () => {
    expect(averageFlightSeconds({ x: 0, y: 0 }, [])).toBeNull();
  });

  it('速度可以换：速度减半，用时加倍', () => {
    expect(averageFlightSeconds({ x: 0, y: 0 }, [{ x: 110, y: 0 }], 55)).toBeCloseTo(2, 12);
  });

  it('写成一位小数', () => {
    expect(secondsText(3.64)).toBe('3.6');
    expect(secondsText(3.66)).toBe('3.7');
    expect(secondsText(12)).toBe('12.0');
  });
});

describe('一块屋顶的飞行秒数：只算本片区已开张的店和全部的楼', () => {
  const roof = { x: 0, y: 0, district: 1 };
  const shops = [
    { x: 110, y: 0, district: 1 }, // 本片区，已开张：1 秒
    { x: 0, y: 330, district: 1 }, // 本片区，已开张：3 秒
    { x: 550, y: 0, district: 1 }, // 本片区，还没开张：不算
    { x: 11, y: 0, district: 0 }, // 别的片区，已开张：不算
  ];
  const open = [true, true, false, true];
  const buildings = [
    { x: 220, y: 0, district: 1 }, // 2 秒
    { x: 0, y: 440, district: 1 }, // 4 秒
    { x: 1, y: 1, district: 2 }, // 别的片区：不算
  ];

  it('店只算本片区已开张的，楼算本片区全部的', () => {
    const flight = roofFlight(roof, shops, open, buildings);
    expect(flight.shops).toBeCloseTo((1 + 3) / 2, 12);
    expect(flight.buildings).toBeCloseTo((2 + 4) / 2, 12);
  });

  it('没开张的店一开张就算进去', () => {
    const flight = roofFlight(roof, shops, [true, true, true, true], buildings);
    expect(flight.shops).toBeCloseTo((1 + 3 + 5) / 3, 12);
  });

  it('片区里一家店也没开张时，店的一项是 null，楼照常', () => {
    const flight = roofFlight(roof, shops, [false, false, false, true], buildings);
    expect(flight.shops).toBeNull();
    expect(flight.buildings).toBeCloseTo(3, 12);
  });
});

describe('候选屋顶的列表', () => {
  it('开局：老街有 6 块屋顶，开局的站占了一块，剩下 5 块，别的片区没开通所以没有', () => {
    const state = campaignState();
    const list = candidateRoofs(state);
    expect(list.map((c) => c.roof)).toEqual([1, 2, 3, 4, 5]);
    expect(list.every((c) => c.district === 0)).toBe(true);
  });

  it('每块带大小、停机位上限、位置，上限按屋顶大小取自价格表', () => {
    const list = candidateRoofs(campaignState());
    for (const c of list) {
      const roof = MAP_V1.roofs[c.roof];
      expect(c.size).toBe(roof?.size);
      expect(c.x).toBe(roof?.x);
      expect(c.y).toBe(roof?.y);
      expect(c.bayLimit).toBe(ECONOMY_V1.bayCap[c.size]);
    }
    expect(new Set(list.map((c) => c.size))).toEqual(new Set(['small', 'medium', 'large']));
  });

  it('价格是核心给的建站价：第 2 座站的基准价乘屋顶的系数，取整', () => {
    const state = campaignState();
    for (const c of candidateRoofs(state)) {
      expect(c.price).toBe(stationPrice(1, c.roof));
      expect(c.price).toBe(Math.round(ECONOMY_V1.stationBase[0]! * (MAP_V1.roofs[c.roof] as { priceCoef: number }).priceCoef));
      expect(c.price).toBe(quoteCommand(state, { type: 'buildStation', roof: c.roof }).price);
    }
  });

  it('余额不够时 ok 是 false，原因是 notEnoughMoney，钱够了就是 true', () => {
    const state = unlockAll(campaignState());
    expect(candidateRoofs(state).every((c) => !c.ok && c.reason === 'notEnoughMoney')).toBe(true);
    withMoney(state, 10_000);
    expect(candidateRoofs(state).every((c) => c.ok && c.reason === null)).toBe(true);
  });

  it('建了站的屋顶不再是候选，下一座站的价格按第 3 座的基准价', () => {
    const state = withMoney(unlockAll(campaignState()), 10_000);
    must(state, { type: 'buildStation', roof: 1 });
    const list = candidateRoofs(state);
    expect(list.map((c) => c.roof)).toEqual([2, 3, 4, 5]);
    for (const c of list) expect(c.price).toBe(Math.round(ECONOMY_V1.stationBase[1]! * (MAP_V1.roofs[c.roof] as { priceCoef: number }).priceCoef));
  });

  it('退回的站腾出屋顶，它又是候选', () => {
    const state = withMoney(unlockAll(campaignState()), 10_000);
    const id = must(state, { type: 'buildStation', roof: 3 });
    expect(candidateRoofs(state).some((c) => c.roof === 3)).toBe(false);
    must(state, { type: 'refundStation', station: id });
    expect(candidateRoofs(state).some((c) => c.roof === 3)).toBe(true);
  });

  it('开通写字楼区之后，它的屋顶也是候选，飞行秒数按写字楼区的店和楼算', () => {
    const state = withMoney(campaignState(), 10_000);
    campaignOf(state).districts[1]!.open = true;
    refreshShops(state);
    const office = candidateRoofs(state).filter((c) => c.district === 1);
    expect(office.map((c) => c.roof)).toEqual([6, 7, 8, 9, 10]);
    const shops = MAP_V1.shops.filter((s, i) => s.district === 1 && campaignOf(state).shopOpen[i]);
    const roof = MAP_V1.roofs[6] as { x: number; y: number };
    const expected = shops.reduce((sum, s) => sum + Math.hypot(s.x - roof.x, s.y - roof.y) / 110, 0) / shops.length;
    expect(office[0]?.flight.shops).toBeCloseTo(expected, 9);
    const buildings = MAP_V1.buildings.filter((b) => b.district === 1);
    const expectedBuildings = buildings.reduce((sum, b) => sum + Math.hypot(b.x - roof.x, b.y - roof.y) / 110, 0) / buildings.length;
    expect(office[0]?.flight.buildings).toBeCloseTo(expectedBuildings, 9);
  });

  it('老街开局时的数：只有星级够的店开张，楼是全部 20 栋', () => {
    const state = campaignState();
    const camp = campaignOf(state);
    const open = MAP_V1.shops.filter((s, i) => s.district === 0 && camp.shopOpen[i]);
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThan(14); // 有几家要升星才开张
    expect(MAP_V1.shops.filter((s) => s.district === 0 && s.opensAtStar === 1)).toHaveLength(open.length);
    const roof = MAP_V1.roofs[1] as { x: number; y: number };
    const flight = candidateRoofs(state).find((c) => c.roof === 1)?.flight;
    const shopSeconds = open.reduce((sum, s) => sum + Math.hypot(s.x - roof.x, s.y - roof.y) / 110, 0) / open.length;
    const all = MAP_V1.buildings.filter((b) => b.district === 0);
    expect(all).toHaveLength(20);
    const buildingSeconds = all.reduce((sum, b) => sum + Math.hypot(b.x - roof.x, b.y - roof.y) / 110, 0) / all.length;
    expect(flight?.shops).toBeCloseTo(shopSeconds, 9);
    expect(flight?.buildings).toBeCloseTo(buildingSeconds, 9);
    // 数量级：几秒，不是几十秒
    expect(flight?.shops).toBeGreaterThan(1);
    expect(flight?.shops).toBeLessThan(15);
  });

  it('只读：列出候选屋顶不改状态', () => {
    const state = withMoney(campaignState(), 500);
    const before = hashState(state);
    const json = JSON.stringify(state);
    candidateRoofs(state);
    expect(hashState(state)).toBe(before);
    expect(JSON.stringify(state)).toBe(json);
  });

  it('屋顶在地图上的大小按小、中、大递增', () => {
    expect(STATION_SIZES.small[0]).toBeLessThan(STATION_SIZES.medium[0]);
    expect(STATION_SIZES.medium[0]).toBeLessThan(STATION_SIZES.large[0]);
    expect(STATION_SIZES.small[1]).toBeLessThan(STATION_SIZES.medium[1]);
    expect(STATION_SIZES.medium[1]).toBeLessThan(STATION_SIZES.large[1]);
  });

  it('每块屋顶旁边两行字取自词表：大小、停机位上限、价格，飞到本片区的店和楼平均几秒', () => {
    const state = campaignState();
    for (const c of candidateRoofs(state)) {
      const lines = roofLines(c);
      expect(lines).toHaveLength(2);
      const sizeWord = { small: '小', medium: '中', large: '大' }[c.size];
      expect(lines[0]).toBe(`${sizeWord}屋顶　最多 ${c.bayLimit} 个停机位　¥${c.price}`);
      expect(lines[1]).toBe(`飞到本片区的店平均 ${c.flight.shops!.toFixed(1)} 秒，飞到本片区的楼平均 ${c.flight.buildings!.toFixed(1)} 秒`);
    }
  });

  it('片区里还没有开张的店时算不出到店的平均秒数，只写第一行', () => {
    const [first] = candidateRoofs(campaignState());
    expect(first).toBeDefined();
    const lines = roofLines({ ...first!, flight: { shops: null, buildings: 3 } });
    expect(lines).toHaveLength(1);
  });

  it('不是经营模式的状态没有候选屋顶', () => {
    expect(candidateRoofs(createState({}))).toEqual([]);
  });
});

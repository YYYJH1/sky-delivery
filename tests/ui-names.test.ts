// 楼名：老街的住宅「{n} 号院」，写字楼区「{字母}座」，大学城「{n} 号宿舍楼」，编号在各片区内从 1 或 A 开始。
import { describe, expect, it } from 'vitest';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { buildCampaignWorld } from '../src/core/index.ts';
import { MAP_BUILDING_NAMES, MAP_BUILDING_PLACES, buildingName, buildingNames, letterOf, orderHoverText, placeName } from '../src/ui/names.ts';

describe('字母编号', () => {
  it('从 A 数到 Z，之后是 AA、AB，一直到 ZZ 和 AAA', () => {
    expect([0, 1, 2, 9, 25].map(letterOf)).toEqual(['A', 'B', 'C', 'J', 'Z']);
    expect([26, 27, 51, 52, 701, 702].map(letterOf)).toEqual(['AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('序号必须是非负整数', () => {
    expect(() => letterOf(-1)).toThrow(RangeError);
    expect(() => letterOf(1.5)).toThrow(RangeError);
  });
});

describe('楼名的写法', () => {
  it('住宅是「{n} 号院」，序号从 0 起，显示时加一', () => {
    expect(buildingName('residence', 0)).toBe('1 号院');
    expect(buildingName('residence', 6)).toBe('7 号院');
    expect(buildingName('residence', 19)).toBe('20 号院');
  });

  it('写字楼是「{字母}座」，从 A 起', () => {
    expect(buildingName('office', 0)).toBe('A 座');
    expect(buildingName('office', 1)).toBe('B 座');
    expect(buildingName('office', 9)).toBe('J 座');
  });

  it('宿舍楼是「{n} 号宿舍楼」', () => {
    expect(buildingName('dorm', 0)).toBe('1 号宿舍楼');
    expect(buildingName('dorm', 11)).toBe('12 号宿舍楼');
  });

  it('序号不合法时报错', () => {
    expect(() => buildingName('residence', -1)).toThrow(RangeError);
    expect(() => buildingName('dorm', 0.5)).toThrow(RangeError);
  });

  it('订单悬停里写成片区加楼名，中间一个空格：老街 7 号院', () => {
    expect(placeName(0, '7 号院')).toBe('老街 7 号院');
    expect(placeName(1, 'A 座')).toBe('写字楼区 A 座');
    expect(placeName(2, '3 号宿舍楼')).toBe('大学城 3 号宿舍楼');
  });
});

describe('一批楼的楼名', () => {
  it('编号按片区各自从头数，下标和传入的顺序相同', () => {
    const names = buildingNames([
      { district: 0, kind: 'residence' },
      { district: 1, kind: 'office' },
      { district: 0, kind: 'residence' },
      { district: 2, kind: 'dorm' },
      { district: 1, kind: 'office' },
    ]);
    expect(names).toEqual(['1 号院', 'A 座', '2 号院', '1 号宿舍楼', 'B 座']);
  });

  it('地图 v1：老街 20 栋住宅，写字楼区 10 栋写字楼，大学城 12 栋宿舍楼，都从头编号', () => {
    expect(MAP_BUILDING_NAMES).toHaveLength(MAP_V1.buildings.length);
    const of = (district: number): string[] => MAP_BUILDING_NAMES.filter((_, i) => MAP_V1.buildings[i]?.district === district);
    expect(of(0)).toEqual(Array.from({ length: 20 }, (_, i) => `${i + 1} 号院`));
    expect(of(1)).toEqual(['A 座', 'B 座', 'C 座', 'D 座', 'E 座', 'F 座', 'G 座', 'H 座', 'I 座', 'J 座']);
    expect(of(2)).toEqual(Array.from({ length: 12 }, (_, i) => `${i + 1} 号宿舍楼`));
  });

  it('地图 v1 的每栋楼都有不同的完整写法，下标与核心的 world.buildings 对得上', () => {
    const world = buildCampaignWorld();
    expect(MAP_BUILDING_PLACES).toHaveLength(world.buildings.length);
    expect(new Set(MAP_BUILDING_PLACES).size).toBe(MAP_BUILDING_PLACES.length);
    world.buildings.forEach((b, i) => {
      const district = ['老街', '写字楼区', '大学城'][b.district] as string;
      expect(MAP_BUILDING_PLACES[i], String(i)).toMatch(new RegExp(`^${district} `));
    });
    expect(MAP_BUILDING_PLACES[0]).toBe('老街 1 号院');
    expect(MAP_BUILDING_PLACES[20]).toBe('写字楼区 A 座');
    expect(MAP_BUILDING_PLACES[30]).toBe('大学城 1 号宿舍楼');
  });

  it('开局订单里的楼：第 10 号楼是老街 11 号院', () => {
    expect(MAP_BUILDING_PLACES[10]).toBe('老街 11 号院');
  });
});

describe('订单悬停的文字', () => {
  /** 订单悬停的文字，取自词表：楼名、菜名、已等待的秒数。 */
  const hover = (building: string, dish: string, seconds: number): string => fmt(STR.hud.orderHover, { building, dish, seconds });

  it('楼名带片区，菜名取自店，等的秒数向下取整：老街 11 号院，牛肉面，已等待 12 秒', () => {
    // 店 0 是老陈面馆（牛肉面），楼 10 是老街的第 11 栋
    expect(orderHoverText({ merchant: 0, building: 10, tOrder: 100 }, 100 + 125)).toBe(hover('老街 11 号院', '牛肉面', 12));
    expect(orderHoverText({ merchant: 0, building: 10, tOrder: 100 }, 100 + 129.9)).toBe(hover('老街 11 号院', '牛肉面', 12));
  });

  it('刚下的单已等待 0 秒，时间倒流也不会出负数', () => {
    expect(orderHoverText({ merchant: 0, building: 10, tOrder: 50 }, 50)).toBe(hover('老街 11 号院', '牛肉面', 0));
    expect(orderHoverText({ merchant: 0, building: 10, tOrder: 50 }, 40)).toBe(hover('老街 11 号院', '牛肉面', 0));
  });

  it('写字楼区和大学城的订单：楼名和菜名各取各的', () => {
    // 店 14 是二楼咖啡（冰美式），楼 20 是写字楼区的 A 座
    expect(orderHoverText({ merchant: 14, building: 20, tOrder: 0 }, 30)).toBe(hover('写字楼区 A 座', '冰美式', 3));
    // 店 20 是大学路烧烤（烤串十串），楼 30 是大学城的 1 号宿舍楼
    expect(orderHoverText({ merchant: 20, building: 30, tOrder: 0 }, 250)).toBe(hover('大学城 1 号宿舍楼', '烤串十串', 25));
  });

  it('开局的第一张订单（店 0，楼 10）悬停的文字', () => {
    expect(orderHoverText({ merchant: 0, building: 10, tOrder: 0 }, 50)).toBe(hover('老街 11 号院', '牛肉面', 5));
  });

  it('指向不存在的店或楼时报错', () => {
    expect(() => orderHoverText({ merchant: 99, building: 0, tOrder: 0 }, 0)).toThrow(RangeError);
    expect(() => orderHoverText({ merchant: 0, building: 99, tOrder: 0 }, 0)).toThrow(RangeError);
  });
});

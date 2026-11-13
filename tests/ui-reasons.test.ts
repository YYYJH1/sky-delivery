// 命令失败的原因代码到词表的对照：每个核心的原因代码都有一行，对得上的取词表的文字，对不上的显示通用提示。
// 提示里的价格、上限取自内容表（ECONOMY_V1、UNLOCKS_V1），内容表重新校准之后这里不用改。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { STR } from '../src/content/strings.zh.ts';
import { UNLOCKS_V1 } from '../src/content/unlocks_v1.ts';
import { bayPrice, quoteCommand } from '../src/core/index.ts';
import type { CommandFailure } from '../src/core/index.ts';
import { GENERIC_REASON, REASON_KEYS, failureContext, failureText, hintText } from '../src/ui/reasons.ts';
import { campaignState, expectRejected, must, quietState, unlockAll, withMoney } from './campaign-helpers.ts';

/** 从核心的源码里读出 CommandFailure 的全部取值，核心加了新的原因代码，这里就会发现。 */
function coreFailureCodes(): string[] {
  const text = readFileSync(new URL('../src/core/campaign/commands.ts', import.meta.url), 'utf8');
  const start = text.indexOf('export type CommandFailure =');
  const end = text.indexOf(';', start);
  const block = text.slice(start, end);
  return [...block.matchAll(/\|\s*'([A-Za-z]+)'/g)].map((m) => m[1] as string);
}

/** 词表里有、核心不会返回的键：界面自己用的。 */
const UI_ONLY_KEYS = ['noStationSelected', 'needDoubleBox'];

describe('对照表', () => {
  it('核心的每个原因代码都在表里，表里也没有核心没有的代码', () => {
    const codes = coreFailureCodes();
    expect(codes.length).toBeGreaterThan(15);
    expect(Object.keys(REASON_KEYS).sort()).toEqual([...codes].sort());
  });

  it('表里写的词表键都存在', () => {
    for (const [code, key] of Object.entries(REASON_KEYS)) {
      expect(Object.hasOwn(STR.reasons, key), `${code} -> ${key}`).toBe(true);
    }
  });

  it('词表里的每个键不是被表用到，就是界面自己用的：没有白放的文字', () => {
    const used = new Set<string>(Object.values(REASON_KEYS));
    const unused = Object.keys(STR.reasons).filter((key) => !used.has(key) && !UI_ONLY_KEYS.includes(key));
    expect(unused).toEqual([]);
  });

  it('正常操作碰不到的六个代码统一对到 generic，其余的代码各有自己的文字', () => {
    const generic = Object.entries(REASON_KEYS)
      .filter(([, key]) => key === GENERIC_REASON)
      .map(([code]) => code)
      .sort();
    expect(generic).toEqual(['alreadyRefunded', 'noRuleSets', 'notCampaign', 'unknownCommand', 'unknownRule', 'unknownTarget']);
  });

  it('价签、双层货箱、片区显示、规矩卡、订单状态、起降口和片区开通这几个代码，各对到词表里同名的条目', () => {
    expect(REASON_KEYS.priceTagsLocked).toBe('priceTagsLocked');
    expect(REASON_KEYS.doubleBoxLocked).toBe('doubleBoxLocked');
    expect(REASON_KEYS.districtHidden).toBe('districtHidden');
    expect(REASON_KEYS.ruleLocked).toBe('ruleLocked');
    expect(REASON_KEYS.orderNotWaiting).toBe('orderNotWaiting');
    expect(REASON_KEYS.gateMax).toBe('gateMax');
    expect(REASON_KEYS.alreadyOpen).toBe('alreadyOpen');
  });

  it('可以对上的代码一一对应：需要两个键的 noFreeBay 和 fleetFull 都落在 noFreeBay，另一条 bayLimitReached 由 bayLimit 用', () => {
    expect(REASON_KEYS.notBoughtToday).toBe('refundOnlyToday');
    expect(REASON_KEYS.baysInUse).toBe('bayInUse');
    expect(REASON_KEYS.stationNotEmpty).toBe('stationDronesAway');
    expect(REASON_KEYS.needStars).toBe('needThreeStars');
    expect(REASON_KEYS.stationLimit).toBe('stationLimitReached');
    expect(REASON_KEYS.roofTaken).toBe('rooftopTaken');
    expect(REASON_KEYS.fleetFull).toBe('noFreeBay');
  });
});

describe('提示文字', () => {
  it('余额不够：写还差多少钱', () => {
    expect(failureText('notEnoughMoney', { shortfall: 30 })).toBe('钱不够，还差 ¥30。');
  });

  it('没有空停机位：屋顶还能加就让玩家先加，屋顶放满了就让玩家去别的站', () => {
    expect(failureText('noFreeBay', { roofFull: false })).toBe('这座站没有空停机位。先加一个停机位，再添飞机。');
    expect(failureText('fleetFull')).toBe('这座站没有空停机位。先加一个停机位，再添飞机。');
    expect(failureText('fleetFull', { roofFull: true, limit: 9 })).toBe('这块屋顶最多放 9 个停机位，已经放满。可以把飞机添到别的站，或者建新站。');
    expect(failureText('noFreeBay', { roofFull: true, limit: 6 })).toContain('最多放 6 个停机位');
  });

  it('停机位到了屋顶的上限、站数到了上限', () => {
    expect(failureText('bayLimit', { limit: 12 })).toBe('这块屋顶最多放 12 个停机位，已经放满。可以把飞机添到别的站，或者建新站。');
    expect(failureText('stationLimit', { limit: 4 })).toBe('最多建 4 座站，已经建满。可以给现有的站添飞机，或者升级起降口。');
  });

  it('片区没开通、上一个片区没到三星：带片区名', () => {
    expect(failureText('districtClosed', { district: 1 })).toBe('写字楼区还没有开通。先开通，再建站。');
    expect(failureText('needStars', { district: 1 })).toBe('老街到三星才能开通写字楼区。');
    expect(failureText('needStars', { district: 2 })).toBe('写字楼区到三星才能开通大学城。');
  });

  it('不需要数的原因直接取词表', () => {
    expect(failureText('roofTaken')).toBe('这块屋顶已经有站了。换一块空着的屋顶。');
    expect(failureText('needTwoStations')).toBe('要有第二座站。');
    expect(failureText('alreadyOwned')).toBe('这一项已经买过了。');
    expect(failureText('notBoughtToday')).toBe('只有今天买的东西能退。');
    expect(failureText('droneBusy')).toBe('这架飞机还在送单。等它回站再退。');
    expect(failureText('baysInUse')).toBe('停机位不够放现有的飞机。先退一架飞机，再退停机位。');
    expect(failureText('stationNotEmpty')).toBe('这座站还有飞机。先把飞机退掉，再退这座站。');
  });

  it('需要的数没给时报错，不显示错的文字', () => {
    expect(() => failureText('notEnoughMoney')).toThrow(/shortfall/);
    expect(() => failureText('bayLimit')).toThrow(/limit/);
    expect(() => failureText('districtClosed')).toThrow(/district/);
    expect(() => failureText('priceTagsLocked')).toThrow(/amount/);
  });

  it('没有没选中站点这个核心代码，它是界面自己的提示', () => {
    expect(hintText('noStationSelected')).toBe('先选一座站。');
    expect(hintText('alreadyOwned')).toBe('这一项已经买过了。');
  });

  it('新补的几条：价签、双层货箱、片区、规矩卡没开放，订单已经派出，起降口最高级，片区已经开通', () => {
    expect(failureText('priceTagsLocked', { amount: UNLOCKS_V1.priceTagsBalance })).toBe(`要等第一天日结之后、余额到 ¥${UNLOCKS_V1.priceTagsBalance}，才能买东西。`);
    expect(failureText('doubleBoxLocked')).toBe('停机位放满以后还缺飞机时，才能买双层货箱。');
    expect(failureText('districtHidden')).toBe('上一个片区到三星之后，这一片才会出现在地图上。');
    expect(failureText('ruleLocked')).toBe('这张卡还没开放。');
    expect(failureText('orderNotWaiting')).toBe('这张单已经在送，或者已经排到最前了。');
    expect(failureText('gateMax')).toBe('这座站的起降口已经是 3 级。');
    expect(failureText('alreadyOpen')).toBe('这个片区已经开通了。');
  });

  it('对到 generic 的六个代码显示词表里的通用提示', () => {
    expect(GENERIC_REASON).toBe('generic');
    for (const code of ['noRuleSets', 'alreadyRefunded', 'unknownTarget', 'unknownCommand', 'notCampaign', 'unknownRule'] as const) {
      expect(failureText(code)).toBe('这一步现在做不了。');
    }
  });

  it('每个代码都能出文字，不抛错，也不是空的', () => {
    const context = { shortfall: 5, limit: 6, district: 1, roofFull: false, amount: UNLOCKS_V1.priceTagsBalance };
    for (const code of Object.keys(REASON_KEYS) as CommandFailure[]) {
      const text = failureText(code, context);
      expect(text.length, code).toBeGreaterThan(2);
    }
  });
});

describe('从状态取提示要用的数', () => {
  it('余额不够：还差的钱是价格减余额，带小数的余额向上取整，至少是 1', () => {
    const state = unlockAll(campaignState());
    const command = { type: 'buyBay', station: 0 } as const;
    const price = bayPrice(3); // 开局的站下一个停机位的价格
    withMoney(state, 20);
    expectRejected(state, command, 'notEnoughMoney');
    expect(failureContext(state, command, 'notEnoughMoney')).toEqual({ shortfall: price - 20 });
    withMoney(state, price - 0.8);
    expect(failureContext(state, command, 'notEnoughMoney')).toEqual({ shortfall: 1 });
    withMoney(state, price - 0.0001);
    expect(failureContext(state, command, 'notEnoughMoney').shortfall).toBe(1);
  });

  it('添飞机没有空停机位：开局的站停机位和飞机一样多，屋顶是中屋顶，上限取自价格表，没放满', () => {
    const state = withMoney(unlockAll(campaignState()));
    const command = { type: 'buyDrone', station: 0 } as const;
    expectRejected(state, command, 'fleetFull');
    const context = failureContext(state, command, 'fleetFull');
    expect(context).toEqual({ limit: ECONOMY_V1.bayCap.medium, roofFull: false });
    expect(failureText('fleetFull', context)).toBe('这座站没有空停机位。先加一个停机位，再添飞机。');
  });

  it('停机位加到上限、飞机补满之后再添飞机：屋顶放满了，提示改成去别的站', () => {
    const cap = ECONOMY_V1.bayCap.medium;
    const state = withMoney(quietState());
    for (let i = ECONOMY_V1.baysAtBuild; i < cap; i++) must(state, { type: 'buyBay', station: 0 });
    for (let i = ECONOMY_V1.openingDrones; i < cap; i++) must(state, { type: 'buyDrone', station: 0 });
    const command = { type: 'buyDrone', station: 0 } as const;
    expectRejected(state, command, 'fleetFull');
    const context = failureContext(state, command, 'fleetFull');
    expect(context).toEqual({ limit: cap, roofFull: true });
    expect(failureText('fleetFull', context)).toBe(`这块屋顶最多放 ${cap} 个停机位，已经放满。可以把飞机添到别的站，或者建新站。`);
    const bay = { type: 'buyBay', station: 0 } as const;
    expectRejected(state, bay, 'bayLimit');
    expect(failureText('bayLimit', failureContext(state, bay, 'bayLimit'))).toContain(`最多放 ${cap} 个停机位`);
  });

  it('站数到上限：上限取自价格表', () => {
    expect(failureContext(campaignState(), { type: 'buildStation', roof: 1 }, 'stationLimit')).toEqual({ limit: ECONOMY_V1.maxStations });
  });

  it('价签还没开放：要攒到的余额取自内容表，整句里写的就是它', () => {
    const state = withMoney(campaignState());
    const command = { type: 'buyBay', station: 0 } as const;
    expectRejected(state, command, 'priceTagsLocked');
    const context = failureContext(state, command, 'priceTagsLocked');
    expect(context).toEqual({ amount: UNLOCKS_V1.priceTagsBalance });
    expect(failureText('priceTagsLocked', context)).toBe(`要等第一天日结之后、余额到 ¥${UNLOCKS_V1.priceTagsBalance}，才能买东西。`);
  });

  it('片区没开通：建站的屋顶在哪个片区，就是哪个片区', () => {
    const state = withMoney(unlockAll(campaignState()));
    const command = { type: 'buildStation', roof: 7 } as const;
    expectRejected(state, command, 'districtClosed');
    expect(failureContext(state, command, 'districtClosed')).toEqual({ district: 1 });
  });

  it('没有数可取的代码返回空对象，取数不改状态', () => {
    const state = withMoney(campaignState(), 40);
    const json = JSON.stringify(state);
    expect(failureContext(state, { type: 'buyDoubleBox' }, 'alreadyOwned')).toEqual({});
    expect(failureContext(state, { type: 'prioritizeOrder', order: 0 }, 'unknownTarget')).toEqual({});
    expect(quoteCommand(state, { type: 'buyBay', station: 0 }).price).toBe(bayPrice(3));
    expect(JSON.stringify(state)).toBe(json);
  });
});

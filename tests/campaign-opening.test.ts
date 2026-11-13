// 新片区的开业期：开通的那一天和之后几天来单打折，开通的那一天从日结记录里取，不存进状态。
import { describe, expect, it } from 'vitest';
import { DISTRICT_RATES_V1 } from '../src/content/districts_v1.ts';
import { DAY_STEPS, advance, applyCommand, createState, currentOpeningMultiplier, districtLambda, districtOpenDay, hashState, openingMultiplier, openingPhase, step } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { campaignOf, must, quietState, runningState, withMoney } from './campaign-helpers.ts';

const OPENING = DISTRICT_RATES_V1.map((d) => d.opening);

/** 写字楼区已经显示、老街三星、有钱：可以用命令开通写字楼区。没有订单。 */
function readyToOpenOffice(): SimState {
  const state = withMoney(quietState({}, false));
  const campaign = campaignOf(state);
  campaign.unlocks.showOffice = 0;
  campaign.unlocks.priceTags = 0;
  campaign.districts[0]!.star = 3;
  return state;
}

describe('内容表里的开业期', () => {
  it('老街开局就开通，没有开业期。写字楼区和大学城有，倍数在 0 到 1 之间，逐天不降，最后一项之后恢复 1', () => {
    expect(OPENING[0]).toEqual([]);
    for (const k of [1, 2]) {
      const table = OPENING[k] as number[];
      expect(table.length).toBeGreaterThanOrEqual(1);
      for (const m of table) {
        expect(m).toBeGreaterThan(0);
        expect(m).toBeLessThan(1);
      }
      expect(table).toEqual([...table].sort((a, b) => a - b));
    }
  });

  it('openingMultiplier：按开业第几天取表，没有开业期的片区和开业期之后都是 1', () => {
    for (const k of [0, 1, 2]) {
      const table = OPENING[k] as number[];
      table.forEach((m, i) => expect(openingMultiplier(k, i + 1)).toBe(m));
      expect(openingMultiplier(k, table.length + 1)).toBe(1);
      expect(openingMultiplier(k, table.length + 30)).toBe(1);
      expect(openingMultiplier(k, 0)).toBe(1);
    }
    expect(openingMultiplier(0, 1)).toBe(1);
  });

  it('districtLambda 的开业期倍数是最后一个乘数，缺省为 1：同一步同一星级，倍数越小来单率越低', () => {
    const base = districtLambda(1, 900, 2);
    expect(districtLambda(1, 900, 2, 1)).toBe(base);
    expect(districtLambda(1, 900, 2, 0.5)).toBeCloseTo(base * 0.5, 15);
    expect(districtLambda(1, 900, 2, OPENING[1]![0] as number)).toBeCloseTo(base * (OPENING[1]![0] as number), 15);
  });
});

describe('开通的那一天：从日结记录里取，没有存档字段', () => {
  it('没开通的片区是 null，老街开局就开通，是第 0 天', () => {
    const state = quietState({}, false);
    expect(districtOpenDay(state, 1)).toBeNull();
    expect(districtOpenDay(state, 2)).toBeNull();
    expect(districtOpenDay(state, 0)).toBe(0);
    expect(districtOpenDay(state, 7)).toBeNull();
    expect(openingPhase(state, 1)).toBeNull();
  });

  it('开通当天还没有日结：开通的那天就是今天', () => {
    const state = readyToOpenOffice();
    advance(state, DAY_STEPS + 1234); // 第 1 天（从 0 数起）的第 1234 步
    expect(campaignOf(state).days).toHaveLength(1);
    must(state, { type: 'openDistrict', district: 1 });
    expect(districtOpenDay(state, 1)).toBe(1);
    expect(openingPhase(state, 1)).toEqual({ day: 1, multiplier: OPENING[1]![0] });
  });

  it('开通之后每次日结都给它写一行，之后开通的那天不变，开业期按游戏日往后数，用完之后是 null', () => {
    const state = readyToOpenOffice();
    advance(state, DAY_STEPS + 2000);
    must(state, { type: 'openDistrict', district: 1 });
    const table = OPENING[1] as number[];
    const seen: (number | null)[] = [];
    for (let k = 0; k < table.length + 2; k++) {
      // 开通之后的每一天，开头和最后一步各看一次：同一天里答案相同
      const start = (1 + k) * DAY_STEPS;
      advance(state, Math.max(state.step, start + 5) - state.step);
      const first = openingPhase(state, 1);
      advance(state, start + DAY_STEPS - 1 - state.step);
      const last = openingPhase(state, 1);
      expect(last).toEqual(first);
      expect(districtOpenDay(state, 1)).toBe(1);
      seen.push(first === null ? null : first.day);
      if (k < table.length) expect(first).toEqual({ day: k + 1, multiplier: table[k] });
      else expect(first).toBeNull();
    }
    expect(seen).toEqual([...table.map((_, i) => i + 1), null, null]);
  });

  it('开通在一天的最后一步：下一次日结写它的第一行，开通的那天是这一天，不是下一天', () => {
    const state = readyToOpenOffice();
    advance(state, 2 * DAY_STEPS - 1);
    must(state, { type: 'openDistrict', district: 1 });
    expect(districtOpenDay(state, 1)).toBe(1);
    advance(state, 1); // 第 2 天的第 0 步还没执行，日结在这一步里做
    advance(state, 1);
    expect(campaignOf(state).days.length).toBe(2);
    expect(districtOpenDay(state, 1)).toBe(1);
    expect(openingPhase(state, 1)).toEqual({ day: 2, multiplier: OPENING[1]![1] });
  });

  it('只看状态：存档读出来的状态（JSON 往返）得到同样的开通日和开业期，状态里没有额外的字段', () => {
    const state = readyToOpenOffice();
    advance(state, DAY_STEPS + 700);
    must(state, { type: 'openDistrict', district: 1 });
    advance(state, DAY_STEPS - 100);
    const copy = JSON.parse(JSON.stringify(state)) as SimState;
    expect(hashState(copy)).toBe(hashState(state));
    expect(districtOpenDay(copy, 1)).toBe(districtOpenDay(state, 1));
    expect(openingPhase(copy, 1)).toEqual(openingPhase(state, 1));
    // 片区的记录里只有开通与否和星级
    expect(Object.keys(campaignOf(state).districts[1] as object).sort()).toEqual(['open', 'star']);
  });

  it('两个片区各自算：大学城晚两天开通，各有各的开业期', () => {
    const state = readyToOpenOffice();
    must(state, { type: 'openDistrict', district: 1 });
    advance(state, 2 * DAY_STEPS + 10);
    const campaign = campaignOf(state);
    campaign.districts[1]!.star = 3;
    campaign.unlocks.showCampus = 0;
    must(state, { type: 'openDistrict', district: 2 });
    expect(districtOpenDay(state, 1)).toBe(0);
    expect(districtOpenDay(state, 2)).toBe(2);
    expect(openingPhase(state, 1)).toBeNull();
    expect(openingPhase(state, 2)).toEqual({ day: 1, multiplier: OPENING[2]![0] });
    expect(currentOpeningMultiplier(state, 2)).toBe(OPENING[2]![0]);
    expect(currentOpeningMultiplier(state, 1)).toBe(1);
    expect(currentOpeningMultiplier(state, 0)).toBe(1);
  });

  it('不是经营模式或片区编号不存在：null', () => {
    const sandbox = createState({});
    expect(districtOpenDay(sandbox, 0)).toBeNull();
    expect(openingPhase(sandbox, 1)).toBeNull();
    expect(openingPhase(quietState(), 9)).toBeNull();
  });

  it('开通命令失败时没有开业期', () => {
    const state = quietState({}, false);
    expect(applyCommand(state, { type: 'openDistrict', district: 1 }).ok).toBe(false);
    expect(openingPhase(state, 1)).toBeNull();
  });
});

describe('开业期里的来单', () => {
  /** 没有飞机的状态里，每天把星级拉回一星，数每天送往写字楼区的订单。写字楼区第 0 步开通。 */
  function officeOrdersPerDay(seed: number, days: number): number[] {
    const state = runningState(seed, [1, 1, 1], [true, true, false]);
    for (const d of state.drones) d.removed = true;
    for (const s of state.stations) s.occupied = 0;
    const counts = new Array<number>(days).fill(0);
    for (let i = 0; i < days * DAY_STEPS; i++) {
      for (const d of campaignOf(state).districts) d.star = 1;
      step(state);
    }
    for (const o of state.orders) if (o.district === 1) counts[Math.floor(o.tOrder / DAY_STEPS)] = (counts[Math.floor(o.tOrder / DAY_STEPS)] as number) + 1;
    return counts;
  }

  it('开通当天、第二天、第三天的来单数之比等于内容表的倍数（多个种子合计）', () => {
    const days = 4;
    const seeds = Array.from({ length: 10 }, (_, i) => 100 + i);
    const total = new Array<number>(days).fill(0);
    for (const seed of seeds) officeOrdersPerDay(seed, days).forEach((n, d) => (total[d] = (total[d] as number) + n));
    // 一星一整天的期望来单数：把一天的来单率按步加起来
    let full = 0;
    for (let t = 0; t < DAY_STEPS; t++) full += districtLambda(1, t, 1);
    const table = OPENING[1] as number[];
    for (let d = 0; d < days; d++) {
      const expected = full * (table[d] ?? 1) * seeds.length;
      const z = ((total[d] as number) - expected) / Math.sqrt(expected);
      expect(Math.abs(z), `day ${d}: expected ${expected.toFixed(0)}, observed ${total[d]}`).toBeLessThan(4.5);
    }
    // 打折是真的：第一天不到第三天的一半，第二天不到第三天
    expect(total[0] as number).toBeLessThan(0.5 * (total[2] as number));
    expect(total[1] as number).toBeLessThan(total[2] as number);
    expect(total[3] as number).toBeGreaterThan(0.8 * (total[2] as number));
  });

  it('老街没有开业期：开局第一天的来单数不受影响', () => {
    const state = runningState(5);
    for (const d of state.drones) d.removed = true;
    for (const s of state.stations) s.occupied = 0;
    advance(state, DAY_STEPS);
    let full = 0;
    for (let t = 0; t < DAY_STEPS; t++) full += districtLambda(0, t, 1);
    const z = (state.orders.length - full) / Math.sqrt(full);
    expect(Math.abs(z)).toBeLessThan(4.5);
  });
});

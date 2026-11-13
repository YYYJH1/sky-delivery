// 声音的限频：按真实时间（毫秒）决定要不要真的出声，用假的时钟检查各种情形，再用真实的核心按 1 倍速和 3 倍速的帧时间检查整体的频率。
import { describe, expect, it } from 'vitest';
import { BUSY_MAX, BUSY_WINDOW_MS, SOUND_IDS, SOUND_INFO } from '../src/audio/catalog.ts';
import type { SoundId } from '../src/audio/catalog.ts';
import { createLimiter } from '../src/audio/limiter.ts';
import { soundsBetween, takeSnapshot } from '../src/audio/triggers.ts';
import { DAY_STEPS, applyCommand, refreshShops, step, UNLOCK_KEYS } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { campaignState } from './campaign-helpers.ts';

const FREQUENT = SOUND_IDS.filter((id) => SOUND_INFO[id].kind === 'frequent');

describe('声音的分类和参数', () => {
  it('常有的四种：起飞、准时送达、大单送达、退单。很少的三种：升星、高峰小结、高峰开始。玩家操作的两种：换策略卡、便签读过收起', () => {
    expect([...FREQUENT].sort()).toEqual(['bigOrder', 'cancel', 'onTime', 'takeoff']);
    expect(SOUND_IDS.filter((id) => SOUND_INFO[id].kind === 'rare').sort()).toEqual(['peakStart', 'starUp', 'summary']);
    expect(SOUND_IDS.filter((id) => SOUND_INFO[id].kind === 'ui').sort()).toEqual(['noteRead', 'rule']);
  });

  it('间隔都是正数，优先级各不相同，预算是每个窗口里最多两个', () => {
    for (const id of SOUND_IDS) expect(SOUND_INFO[id].gapMs).toBeGreaterThan(0);
    expect(new Set(SOUND_IDS.map((id) => SOUND_INFO[id].priority)).size).toBe(SOUND_IDS.length);
    expect(BUSY_MAX).toBe(2);
    expect(BUSY_WINDOW_MS).toBeGreaterThanOrEqual(3000);
  });

  it('常有的声音间隔不短于 3 秒，玩家操作的声音间隔不长于半秒', () => {
    for (const id of FREQUENT) expect(SOUND_INFO[id].gapMs).toBeGreaterThanOrEqual(3000);
    for (const id of SOUND_IDS) if (SOUND_INFO[id].kind === 'ui') expect(SOUND_INFO[id].gapMs).toBeLessThanOrEqual(500);
  });
});

describe('createLimiter', () => {
  it('同一个声音在间隔之内只放一次，间隔过了再放', () => {
    const limiter = createLimiter();
    const gap = SOUND_INFO.onTime.gapMs;
    expect(limiter.admit(['onTime'], 1000)).toEqual(['onTime']);
    expect(limiter.admit(['onTime'], 1000 + gap - 1)).toEqual([]);
    expect(limiter.admit(['onTime'], 1000 + gap)).toEqual(['onTime']);
  });

  it('被拒掉的声音不重新计间隔：从上一次真正播出的时刻算起', () => {
    const limiter = createLimiter();
    const gap = SOUND_INFO.onTime.gapMs;
    limiter.admit(['onTime'], 0);
    expect(limiter.admit(['onTime'], gap - 500)).toEqual([]);
    expect(limiter.admit(['onTime'], gap + 1)).toEqual(['onTime']);
  });

  it('同一时刻几个声音：常有的四种共用预算，只放优先级最高的两个，不管传入的顺序', () => {
    const limiter = createLimiter();
    expect(limiter.admit(['takeoff', 'onTime', 'cancel', 'bigOrder'], 0)).toEqual(['bigOrder', 'cancel']);
  });

  it('预算按窗口算：窗口里放满了就不放，窗口过去之后又有预算', () => {
    const limiter = createLimiter();
    limiter.admit(['bigOrder', 'cancel'], 0);
    expect(limiter.admit(['onTime'], 1000)).toEqual([]);
    expect(limiter.admit(['takeoff'], BUSY_WINDOW_MS - 1)).toEqual([]);
    expect(limiter.admit(['onTime'], BUSY_WINDOW_MS)).toEqual(['onTime']);
    // 窗口里又有了一个，还剩一个预算
    expect(limiter.admit(['takeoff'], BUSY_WINDOW_MS + 100)).toEqual(['takeoff']);
    expect(limiter.admit(['bigOrder'], BUSY_WINDOW_MS + 200)).toEqual([]);
  });

  it('被预算拒掉的声音不占预算，也不重新计间隔', () => {
    const limiter = createLimiter();
    limiter.admit(['bigOrder', 'cancel'], 0);
    limiter.admit(['onTime', 'takeoff'], 100);
    expect(limiter.admit(['onTime'], BUSY_WINDOW_MS)).toEqual(['onTime']);
  });

  it('很少出现的声音不占预算，也不被常有的声音挤掉', () => {
    const limiter = createLimiter();
    limiter.admit(['bigOrder', 'cancel'], 0);
    expect(limiter.admit(['starUp', 'summary', 'peakStart'], 10)).toEqual(['starUp', 'summary', 'peakStart']);
    // 它们占的不算预算：预算里还是只有前面那两个
    expect(limiter.admit(['onTime'], BUSY_WINDOW_MS)).toEqual(['onTime']);
  });

  it('很少出现的声音各有自己的间隔', () => {
    const limiter = createLimiter();
    limiter.admit(['summary', 'peakStart'], 0);
    expect(limiter.admit(['summary', 'peakStart', 'starUp'], 1000)).toEqual(['starUp']);
    expect(limiter.admit(['summary'], SOUND_INFO.summary.gapMs)).toEqual(['summary']);
    expect(limiter.admit(['peakStart'], SOUND_INFO.summary.gapMs + 100)).toEqual([]);
    expect(limiter.admit(['peakStart'], SOUND_INFO.peakStart.gapMs)).toEqual(['peakStart']);
  });

  it('玩家操作带来的声音间隔很短，也不占预算', () => {
    const limiter = createLimiter();
    limiter.admit(['bigOrder', 'cancel'], 0);
    expect(limiter.admit(['rule', 'noteRead'], 10)).toEqual(['rule', 'noteRead']);
    expect(limiter.admit(['rule'], 10 + SOUND_INFO.rule.gapMs - 1)).toEqual([]);
    expect(limiter.admit(['rule'], 10 + SOUND_INFO.rule.gapMs)).toEqual(['rule']);
  });

  it('时钟往回走：比现在还晚的记录作废，不会一直挡着', () => {
    const limiter = createLimiter();
    limiter.admit(['onTime', 'takeoff'], 100_000);
    expect(limiter.admit(['onTime', 'takeoff', 'cancel'], 5000)).toEqual(['cancel', 'onTime']);
  });

  it('reset 清掉全部记录', () => {
    const limiter = createLimiter();
    limiter.admit(['bigOrder', 'cancel', 'summary'], 0);
    limiter.reset();
    expect(limiter.admit(['bigOrder', 'cancel', 'summary'], 1)).toEqual(['summary', 'bigOrder', 'cancel']);
  });

  it('没有候选时什么也不放；传入的数组不被改动', () => {
    const limiter = createLimiter();
    expect(limiter.admit([], 0)).toEqual([]);
    const input: SoundId[] = ['takeoff', 'starUp'];
    limiter.admit(input, 0);
    expect(input).toEqual(['takeoff', 'starUp']);
  });
});

describe('按真实的帧时间：整体的频率', () => {
  /** 经营模式，三个片区都开通，加了几架飞机，订单多。 */
  function busy(drones: number): SimState {
    const state = campaignState({ seed: 21 });
    const campaign = state.campaign!;
    campaign.opening.orders = [0, 1, 2, 3, 4];
    campaign.opening.done = true;
    for (const key of UNLOCK_KEYS) if (key !== 'ruleSets' && campaign.unlocks[key] < 0) campaign.unlocks[key] = 0;
    campaign.money = 1_000_000;
    for (const district of campaign.districts) district.open = true;
    refreshShops(state);
    for (let i = 0; i < drones; i++) {
      if (!applyCommand(state, { type: 'buyBay', station: 0 }).ok) break;
      if (!applyCommand(state, { type: 'buyDrone', station: 0 }).ok) break;
    }
    return state;
  }

  /** 按 60 帧每秒、给定倍速推进 days 个游戏日，每帧观察一次，返回每个播出的声音和它的真实时刻（毫秒）。 */
  function play(speed: number, days: number, drones: number): { id: SoundId; at: number }[] {
    const state = busy(drones);
    const limiter = createLimiter();
    const frameMs = 1000 / 60;
    const played: { id: SoundId; at: number }[] = [];
    let acc = 0;
    let wall = 0;
    let previous = takeSnapshot(state);
    while (state.step < days * DAY_STEPS) {
      wall += frameMs;
      acc += frameMs * speed;
      const due = Math.min(6, Math.floor(acc / 100));
      acc -= Math.floor(acc / 100) * 100;
      for (let i = 0; i < due; i++) step(state);
      const current = takeSnapshot(state);
      for (const id of limiter.admit(soundsBetween(previous, current), wall)) played.push({ id, at: wall });
      previous = current;
    }
    return played;
  }

  for (const speed of [1, 3]) {
    it(`${speed} 倍速，订单很多的两个游戏日：每种声音都守着自己的间隔，常有的声音任何一个窗口里不超过预算，一分钟的声音不多于 30 个`, () => {
      const played = play(speed, 2, 9);
      expect(played.length).toBeGreaterThan(20);
      for (const id of SOUND_IDS) {
        const times = played.filter((p) => p.id === id).map((p) => p.at);
        for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `${id}`).toBeGreaterThanOrEqual(SOUND_INFO[id].gapMs - 1e-6);
      }
      const frequent = played.filter((p) => SOUND_INFO[p.id].kind === 'frequent').map((p) => p.at);
      for (let i = 0; i + BUSY_MAX < frequent.length; i++) {
        expect(frequent[i + BUSY_MAX]! - frequent[i]!, '窗口里的常有声音').toBeGreaterThanOrEqual(BUSY_WINDOW_MS - 1e-6);
      }
      // 任何一分钟里不超过 30 个
      for (let from = 0; from <= (played[played.length - 1]?.at ?? 0); from += 5000) {
        expect(played.filter((p) => p.at >= from && p.at < from + 60_000).length).toBeLessThanOrEqual(30);
      }
    });
  }

  it('高速运行时频率按真实时间算：3 倍速的每分钟声音数不超过预算的上限，也不会因为游戏时间过得快而成倍增加', () => {
    const slow = play(1, 2, 9);
    const fast = play(3, 2, 9);
    const perMinute = (list: readonly { at: number }[]): number => list.length / ((list[list.length - 1]?.at ?? 1) / 60_000);
    expect(perMinute(fast)).toBeLessThan(2.2 * perMinute(slow));
    expect(perMinute(fast)).toBeLessThanOrEqual((60_000 / BUSY_WINDOW_MS) * BUSY_MAX + 10);
  });
});

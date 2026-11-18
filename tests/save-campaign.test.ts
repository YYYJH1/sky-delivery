// 经营模式的存档：字段表对 campaign 的检查，旧格式（版本 1）的存档怎样读进来，内容版本不同时照常读。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FORECAST_V1 } from '../src/content/forecast_v1.ts';
import { CONTENT_VERSION as tableVersionConst } from '../src/content/version.ts';

// 旧存档样本是在内容版本 3 时写的。现在的内容版本可能更高，按数字比较，不按字面量类型
const tableVersion: number = tableVersionConst;
import { DAY_STEPS, advance, applyCommand, createState, hashState, isUnlocked, settleAway, step } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import {
  CONTENT_VERSION,
  MemoryStore,
  SAVE_VERSION,
  decodeSaveCode,
  encodeSaveText,
  loadGame,
  parseSave,
  parseStoredSave,
  saveGame,
  serializeSave,
  slotKey,
} from '../src/save/index.ts';
import type { FailureCode } from '../src/save/index.ts';
import { playGame } from '../tools/autoplay-lib.ts';
import type { PolicyId } from '../tools/autoplay-lib.ts';
import { campaignOf, expectRejected, must } from './campaign-helpers.ts';
import { BUSY, WALL, campaignScript, readJson, richCampaign, runState } from './save-helpers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 一局打了五个游戏日的经营模式：两座站，九架飞机，两套策略，日结、小结、便签的记录都有。 */
const RICH: SimState = playGame('balanced', 7, { days: 5 }).state;

function textOf(state: SimState, savedAt = WALL): string {
  const result = serializeSave(state, savedAt);
  if (!result.ok) throw new Error(`serialize failed: ${result.reason.message}`);
  return result.text;
}

/** 解析存档文本，改一下，再写回文本。 */
function tampered(state: SimState, edit: (save: Record<string, any>) => void): string {
  const save = JSON.parse(textOf(state)) as Record<string, unknown>;
  edit(save);
  return JSON.stringify(save);
}

function failure(input: string): { code: FailureCode; paths: string[] } {
  const result = parseSave(input);
  if (result.ok) throw new Error('expected the save to be rejected');
  return { code: result.reason.code, paths: result.reason.issues.map((issue) => issue.path) };
}

describe('校验：经营模式的字段表', () => {
  it('完整的经营模式状态能存能读，状态和哈希都不变，经营模式的记录都在', () => {
    const campaign = campaignOf(RICH);
    expect(campaign.ruleSets).not.toBeNull();
    // 存档格式 4 的新字段都有值：小结的机队时间构成和各站的行，日结的运力占用，两份计数，就近降落的标记
    expect(campaign.peaks.every((p) => p.fleet !== null && p.fleetBack !== null && p.stations.length >= 1)).toBe(true);
    expect(campaign.days.every((d) => d.busy !== null && d.busy.length === 24)).toBe(true);
    expect(campaign.tally.day.drones.some((n) => n > 0)).toBe(true);
    expect(typeof campaign.nearestOwned).toBe('boolean');
    expect(campaign.days.length).toBeGreaterThanOrEqual(4);
    expect(campaign.peaks.length).toBeGreaterThanOrEqual(8);
    expect(campaign.tips.length).toBeGreaterThanOrEqual(5);
    expect(campaign.stations.some((s) => s.bays.length > 0)).toBe(true);
    const result = parseSave(textOf(RICH));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual(RICH);
    expect(hashState(result.state)).toBe(hashState(RICH));
  });

  it('存档格式 4 的新字段往返存读不变：就近降落的标记和开关，两份计数，小结的机队时间构成、回站飞行占比和各站的行，日结的运力占用，包括 null 和有值两种', () => {
    const state = structuredClone(RICH);
    const campaign = campaignOf(state);
    campaign.nearestOwned = true;
    state.returnRule = 'home'; // 买过，现在关着
    // 当场高峰和当天的计数里都有数
    Object.assign(campaign.tally.peak, { steps: 437, takeoffWait: [11, 0], queue: [30, 5], sorties: [9, 4], fleet: [[1, 2, 3, 4, 5], [0, 0, 7, 0, 1]], back: [2, 0] });
    campaign.tally.day.drones[3] = 1234;
    campaign.tally.day.used[3] = 777;
    // 小结的两种写法：有机队时间构成和各站的行（起降排队有值和为 null 的两种，站的机队时间构成有值和为 null 的两种），以及没有的（旧的记录）
    const full = campaign.peaks[0]!;
    full.fleet = { loaded: 12, empty: 34, work: 20, queue: 6, parked: 28 };
    full.fleetBack = 21;
    full.stations = [
      { station: 0, gateWait: 1.4, landWaitAvg: 0.8333333333333334, takeoffWaitPct: 16, queuePct: 21, sorties: 17, fleet: { loaded: 10, empty: 30, work: 20, queue: 10, parked: 30 } },
      { station: 1, gateWait: null, landWaitAvg: 0, takeoffWaitPct: 0, queuePct: 0, sorties: 0, fleet: null },
    ];
    const old = campaign.peaks[1]!;
    old.fleet = null;
    old.fleetBack = null;
    old.stations = [];
    campaign.days[0]!.busy = Array.from({ length: 24 }, (_, i) => (i * 7) % 101);
    campaign.days[1]!.busy = null;
    const text = textOf(state);
    const back = parseSave(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.migratedFrom).toBeNull();
    expect(back.state).toEqual(state);
    expect(campaignOf(back.state).tally.peak.back).toEqual([2, 0]);
    expect(campaignOf(back.state).peaks.slice(0, 2).map((p) => p.fleetBack)).toEqual([21, null]);
    expect(hashState(back.state)).toBe(hashState(state));
    expect(textOf(back.state)).toBe(text); // 再存一次，文本逐字相同
    // 哈希覆盖回站飞行的计数和小结里的回站飞行占比：改一个数，哈希就变
    const tallyChanged = structuredClone(state);
    campaignOf(tallyChanged).tally.peak.back[0] = 3;
    expect(hashState(tallyChanged)).not.toBe(hashState(state));
    const shareChanged = structuredClone(state);
    campaignOf(shareChanged).peaks[0]!.fleetBack = 22;
    expect(hashState(shareChanged)).not.toBe(hashState(state));
  });

  it('campaign 的每一个字段缺失，都能指出缺的是哪一个', () => {
    for (const key of Object.keys(campaignOf(RICH))) {
      const result = failure(
        tampered(RICH, (save) => {
          delete save.state.campaign[key];
        }),
      );
      expect(result.code, `缺 ${key}`).toBe('schema');
      expect(result.paths, `缺 ${key}`).toEqual([`state.campaign.${key}`]);
    }
  });

  // 路径、把它改成什么、期望的失败类型
  const FIELD_CASES: [string, unknown, FailureCode][] = [
    ['state.campaign.money', null, 'non-finite'],
    ['state.campaign.money', '120', 'schema'],
    ['state.campaign.spent', null, 'non-finite'],
    ['state.campaign.contentVersion', 2.5, 'schema'],
    ['state.campaign.income', 7, 'schema'],
    ['state.campaign.income[0]', null, 'non-finite'],
    ['state.campaign.districts[0].open', 1, 'schema'],
    ['state.campaign.districts[1].star', 1.5, 'schema'],
    ['state.campaign.shopOpen[0]', 'yes', 'schema'],
    ['state.campaign.cumWeights[0][0]', null, 'non-finite'],
    ['state.campaign.roofStation[0]', 0.5, 'schema'],
    ['state.campaign.stations[0].roof', null, 'non-finite'],
    ['state.campaign.stations[0].gateLevel', '1', 'schema'],
    ['state.campaign.stations[0].built.paid', null, 'non-finite'],
    ['state.campaign.drones[0].day', 'today', 'schema'],
    ['state.campaign.opening.done', 0, 'schema'],
    ['state.campaign.opening.orders', {}, 'schema'],
    ['state.campaign.rating[0].misses', null, 'non-finite'],
    ['state.campaign.unlocks.priceTags', 1.5, 'schema'],
    ['state.campaign.unlocks.selectColumn', null, 'non-finite'],
    ['state.campaign.ruleSets.noon.select', 3, 'schema'],
    ['state.campaign.ruleSets', [], 'schema'],
    ['state.campaign.days[0].income', null, 'non-finite'],
    ['state.campaign.days[0].districts[0].kind', 5, 'schema'],
    ['state.campaign.days[0].districts[0].newShops', 'none', 'schema'],
    ['state.campaign.peaks[0].revenue', null, 'non-finite'],
    ['state.campaign.peaks[0].main', 'waitDrone', 'schema'],
    ['state.campaign.peaks[0].changedMidPeak', 'no', 'schema'],
    ['state.campaign.peaks[0].districts[0].n', 1.5, 'schema'],
    ['state.campaign.tips[0].read', 'yes', 'schema'],
    ['state.campaign.tips[0].id', 7, 'schema'],
    ['state.campaign.delivered', -0.5, 'schema'],
    ['state.campaign.goals', 'none', 'schema'],
    ['state.campaign.goals.day', 1.5, 'schema'],
    ['state.campaign.goals.peak', 3, 'schema'],
    ['state.campaign.goals.goals', {}, 'schema'],
    ['state.campaign.goals.goals[0].kind', 3, 'schema'],
    ['state.campaign.goals.goals[0].line', 'x', 'schema'],
    ['state.campaign.peaks[0].cleared', 'yes', 'schema'],
    ['state.campaign.peaks[0].baseline', 5, 'schema'],
    ['state.campaign.peaks[0].districts[0].line', 'x', 'schema'],
    ['state.campaign.peaks[0].districts[0].met', 1, 'schema'],
    ['state.campaign.days[0].peaksJudged', 1.5, 'schema'],
    ['state.campaign.days[0].peaksCleared', null, 'non-finite'],
    ['state.campaign.away', 3, 'schema'],
    ['state.campaign.nearestOwned', 1, 'schema'],
    ['state.campaign.tally', 'none', 'schema'],
    ['state.campaign.tally.peak.steps', 1.5, 'schema'],
    ['state.campaign.tally.peak.steps', -1, 'schema'],
    ['state.campaign.tally.peak.fleet', {}, 'schema'],
    ['state.campaign.tally.peak.fleet[0][1]', null, 'non-finite'],
    ['state.campaign.tally.peak.back', {}, 'schema'],
    ['state.campaign.tally.peak.back[0]', 0.5, 'schema'],
    ['state.campaign.tally.peak.back[0]', -1, 'schema'],
    ['state.campaign.tally.peak.back[1]', null, 'non-finite'],
    ['state.campaign.tally.peak.takeoffWait[0]', '3', 'schema'],
    ['state.campaign.tally.peak.queue', 7, 'schema'],
    ['state.campaign.tally.peak.sorties[0]', 0.5, 'schema'],
    ['state.campaign.tally.day.drones', null, 'schema'],
    ['state.campaign.tally.day.used[3]', null, 'non-finite'],
    ['state.campaign.peaks[0].fleet', 'half', 'schema'],
    ['state.campaign.peaks[0].fleet.work', null, 'non-finite'],
    ['state.campaign.peaks[0].fleetBack', 'half', 'schema'],
    ['state.campaign.peaks[0].fleetBack', [], 'schema'],
    ['state.campaign.peaks[0].stations', {}, 'schema'],
    ['state.campaign.peaks[0].stations[0].station', 0.5, 'schema'],
    ['state.campaign.peaks[0].stations[0].gateWait', 'slow', 'schema'],
    ['state.campaign.peaks[0].stations[0].queuePct', null, 'non-finite'],
    ['state.campaign.peaks[0].stations[0].sorties', '3', 'schema'],
    ['state.campaign.peaks[0].stations[0].fleet', 5, 'schema'],
    ['state.campaign.days[0].busy', 3, 'schema'],
    ['state.campaign.days[0].busy[2]', null, 'non-finite'],
    ['state.campaign.days[0].effects', 'none', 'schema'],
    ['state.campaign.forecast', 'none', 'schema'],
    ['state.campaign.forecast.charges', 1.5, 'schema'],
    ['state.campaign.forecast.charges', -1, 'schema'],
    ['state.campaign.forecast.charges', null, 'non-finite'],
    ['state.campaign.effectWatches', {}, 'schema'],
    ['state.capacity', '2', 'schema'],
    ['state.returnRule', 1, 'schema'],
    ['state.config.mode', 1, 'schema'],
    ['state.stations[0].removed', 0, 'schema'],
    ['state.drones[0].removed', 'false', 'schema'],
  ];

  it.each(FIELD_CASES)('把 %s 改成 %j：不通过，类型是 %s，并指出这个字段', (path, value, code) => {
    const input = tampered(RICH, (save) => {
      const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
      let node = save as Record<string, any>;
      for (const key of keys.slice(0, -1)) node = node[key];
      node[keys[keys.length - 1] as string] = value;
    });
    const result = failure(input);
    expect(result.code).toBe(code);
    expect(result.paths).toContain(path);
  });

  it('小结记录缺 fleetBack、当场高峰的计数缺 back：指出缺的是哪一个。fleetBack 可以是 null，写成 null 或整数都通过', () => {
    const noShare = failure(tampered(RICH, (save) => delete save.state.campaign.peaks[0].fleetBack));
    expect(noShare.code).toBe('schema');
    expect(noShare.paths).toEqual(['state.campaign.peaks[0].fleetBack']);
    const noBack = failure(tampered(RICH, (save) => delete save.state.campaign.tally.peak.back));
    expect(noBack.code).toBe('schema');
    expect(noBack.paths).toEqual(['state.campaign.tally.peak.back']);
    const nulls = tampered(RICH, (save) => {
      for (const peak of save.state.campaign.peaks) peak.fleetBack = null;
    });
    expect(parseSave(nulls).ok).toBe(true);
    const zero = tampered(RICH, (save) => (save.state.campaign.peaks[0].fleetBack = 0));
    expect(parseSave(zero).ok).toBe(true);
  });

  it('可以为 null 的字段：没有订单的百分数、没有升星的店、两套策略、结局，写成 null 或有值都通过', () => {
    // RICH 里这些字段有的是 null，有的有值。再造一个结局有值、小结里的四段时间为 null 的
    const input = tampered(RICH, (save) => {
      save.state.campaign.ending = { step: 100, days: 3, orders: 77 };
      save.state.campaign.peaks[0].segments = null;
      save.state.campaign.peaks[0].extra = null;
      save.state.campaign.tips[0].station = null;
      save.state.campaign.days[0].districts[0].onTimePct = null;
      save.state.campaign.ruleSets = null;
    });
    expect(parseSave(input).ok).toBe(true);
    const bad = failure(
      tampered(RICH, (save) => {
        save.state.campaign.ending = { step: 100, days: 3 };
      }),
    );
    expect(bad.paths).toEqual(['state.campaign.ending.orders']);
  });

  it('沙盒模式的 campaign 是 null，能存能读；写成别的东西，或者没有这个字段，都不通过', () => {
    const sandbox = runState(BUSY, 500);
    expect(sandbox.campaign).toBeNull();
    expect(parseSave(textOf(sandbox)).ok).toBe(true);
    expect(failure(tampered(sandbox, (save) => (save.state.campaign = 'none'))).paths).toEqual(['state.campaign']);
    expect(failure(tampered(sandbox, (save) => delete save.state.campaign)).paths).toEqual(['state.campaign']);
  });

  it('各项开放的名单不写死：多一项、少一项都照样通过，值只要是整数。以后核心增减开放项，不用改字段表', () => {
    const more = tampered(RICH, (save) => {
      save.state.campaign.unlocks.somethingNew = -1;
    });
    expect(parseSave(more).ok).toBe(true);
    const fewer = tampered(RICH, (save) => {
      delete save.state.campaign.unlocks.priceTags;
    });
    expect(parseSave(fewer).ok).toBe(true);
    const wrong = tampered(RICH, (save) => {
      save.state.campaign.unlocks.somethingNew = 'open';
    });
    expect(failure(wrong).paths).toEqual(['state.campaign.unlocks.somethingNew']);
  });

  it('字段表之外的新字段放行：以后经营模式再加字段，旧的字段表也不会拒绝存档', () => {
    const input = tampered(RICH, (save) => {
      save.state.campaign.somethingNew = { a: 1 };
      save.state.campaign.days[0].extra = 'x';
    });
    expect(parseSave(input).ok).toBe(true);
    // 新字段里的 NaN 照样被深度扫描发现
    const bad = tampered(RICH, (save) => {
      save.state.campaign.somethingNew = { a: null };
    });
    expect(parseSave(bad).ok).toBe(true); // null 不是 NaN，字段表之外的 null 放行
    const state = structuredClone(RICH) as SimState & { campaign: { somethingNew?: number } };
    (state.campaign as { somethingNew?: number }).somethingNew = Number.NaN;
    const result = serializeSave(state, WALL);
    expect(result.ok).toBe(false);
  });
});

describe('校验：真实的运行产生的状态都通过，不会把合法的存档拒之门外', () => {
  const POLICIES_TO_TRY: PolicyId[] = ['balanced', 'singleStation', 'noCards', 'dronesOnly', 'idle'];

  it.each(POLICIES_TO_TRY)('自动购买脚本，玩法 %s，三个订单种子，各打 6 个游戏日：结束时的状态能存能读', (policy) => {
    for (const seed of [3, 17, 42]) {
      const { state } = playGame(policy, seed, { days: 6 });
      const result = parseSave(textOf(state));
      expect(result.ok, `${policy} ${seed}`).toBe(true);
      if (result.ok) expect(hashState(result.state)).toBe(hashState(state));
    }
  });

  it('带脚本的中局，运行 3 个游戏日，每隔约 1000 步存一次：每个时刻的状态都能存能读', () => {
    for (const seed of [7, 11]) {
      const state = richCampaign(seed, 8000);
      let checked = 0;
      for (let i = 0; i < 3 * DAY_STEPS; i++) {
        campaignScript(state);
        step(state);
        if (state.step % 997 === 0) {
          const result = parseSave(textOf(state));
          expect(result.ok, `${seed} 第 ${state.step} 步`).toBe(true);
          if (result.ok) expect(hashState(result.state)).toBe(hashState(state));
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThanOrEqual(10);
    }
  });

  it('开局的第一步、结局之后、离开结算之后：都能存能读', () => {
    const fresh = createState({ mode: 'campaign', seed: 5 });
    expect(parseSave(textOf(fresh)).ok).toBe(true);
    const ended = structuredClone(RICH);
    campaignOf(ended).ending = { step: ended.step, days: 5, orders: 325 };
    expect(parseSave(textOf(ended)).ok).toBe(true);
    const away = structuredClone(RICH);
    expect(settleAway(away, 900)).not.toBeNull();
    const back = parseSave(textOf(away));
    expect(back.ok && campaignOf(back.state).away).toEqual(campaignOf(away).away);
    expect(back.ok && campaignOf(back.state).away).toHaveLength(1);
  });
});

describe('校验：数据员和效果记录的字段', () => {
  /**
   * 推演次数，三笔还在跟踪的购买（购买前的数值有值和为 null 的，没有小结记录的，副本记下的数有和没有的），和日结里的三种效果行（含不购买时的数）。
   * 效果行里的数故意取除不尽的小数，往返之后一位也不能变。
   */
  function withEffects(): SimState {
    const state = structuredClone(RICH);
    const campaign = campaignOf(state);
    campaign.forecast.charges = 3;
    campaign.effectWatches = [
      {
        kind: 'gate',
        step: 9000,
        station: 1,
        level: 2,
        peak: 'noon',
        beforeDay: 2,
        before: 1.4285714285714286,
        left: 2,
        twins: [
          { day: 3, peak: 'noon', value: 1.8571428571428572 },
          { day: 4, peak: 'noon', value: 0.9 },
        ],
      },
      { kind: 'doubleBox', step: 9100, station: null, level: null, peak: 'evening', beforeDay: 2, before: null, left: 3, twins: [] },
      { kind: 'nearest', step: 9200, station: null, level: null, peak: null, beforeDay: null, before: null, left: 1, twins: [] },
    ];
    campaign.days[1]!.effects = [
      { kind: 'gate', station: 1, level: 2, peak: 'noon', beforeDay: 0, afterDay: 1, before: 1.4, after: 0.5, twin: 1.2857142857142858 },
      { kind: 'doubleBox', station: null, level: null, peak: 'evening', beforeDay: 0, afterDay: 1, before: 1.0833333333333333, after: 1.25, twin: 1.0909090909090908 },
      { kind: 'nearest', station: null, level: null, peak: 'noon', beforeDay: 0, afterDay: 1, before: 37, after: 29, twin: 38 },
    ];
    return state;
  }

  it('往返存读不变：推演次数、购买的效果跟踪（有值和 null 两种）、日结里的三种效果行，状态和哈希都不变，再存一次文本逐字相同', () => {
    const state = withEffects();
    const text = textOf(state);
    const back = parseSave(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.migratedFrom).toBeNull();
    expect(back.state).toEqual(state);
    expect(campaignOf(back.state).forecast).toEqual({ charges: 3 });
    expect(campaignOf(back.state).effectWatches).toHaveLength(3);
    expect(campaignOf(back.state).days[1]!.effects).toHaveLength(3);
    expect(hashState(back.state)).toBe(hashState(state));
    expect(textOf(back.state)).toBe(text);
    // 哈希覆盖新字段：改一个数，哈希就变。副本记下的数（跟踪里的 twins）和不购买时的数（效果行里的 twin）也在内
    const other = structuredClone(state);
    campaignOf(other).days[1]!.effects[0]!.after = 0.6;
    expect(hashState(other)).not.toBe(hashState(state));
    const twinLine = structuredClone(state);
    campaignOf(twinLine).days[1]!.effects[0]!.twin += 0.1;
    expect(hashState(twinLine)).not.toBe(hashState(state));
    const twinWatch = structuredClone(state);
    campaignOf(twinWatch).effectWatches[0]!.twins[1]!.value += 0.1;
    expect(hashState(twinWatch)).not.toBe(hashState(state));
    const noTwins = structuredClone(state);
    campaignOf(noTwins).effectWatches[0]!.twins = [];
    expect(hashState(noTwins)).not.toBe(hashState(state));
  });

  // 路径、把它改成什么、期望的失败类型
  const CASES: [string, unknown, FailureCode][] = [
    ['state.campaign.effectWatches[0].kind', 3, 'schema'],
    ['state.campaign.effectWatches[0].step', 1.5, 'schema'],
    ['state.campaign.effectWatches[0].left', -1, 'schema'],
    ['state.campaign.effectWatches[0].left', null, 'non-finite'],
    ['state.campaign.effectWatches[0].station', 'one', 'schema'],
    ['state.campaign.effectWatches[0].level', 1.5, 'schema'],
    ['state.campaign.effectWatches[0].peak', 5, 'schema'],
    ['state.campaign.effectWatches[0].beforeDay', 0.5, 'schema'],
    ['state.campaign.effectWatches[0].before', 'x', 'schema'],
    ['state.campaign.effectWatches[0].twins', 'none', 'schema'],
    ['state.campaign.effectWatches[0].twins', {}, 'schema'],
    ['state.campaign.effectWatches[0].twins[0].day', 0.5, 'schema'],
    ['state.campaign.effectWatches[0].twins[0].peak', 5, 'schema'],
    ['state.campaign.effectWatches[0].twins[1].value', 'x', 'schema'],
    ['state.campaign.effectWatches[0].twins[1].value', null, 'non-finite'],
    ['state.campaign.days[1].effects[0].kind', 1, 'schema'],
    ['state.campaign.days[1].effects[0].peak', 0, 'schema'],
    ['state.campaign.days[1].effects[0].station', 'a', 'schema'],
    ['state.campaign.days[1].effects[0].level', {}, 'schema'],
    ['state.campaign.days[1].effects[0].beforeDay', 0.5, 'schema'],
    ['state.campaign.days[1].effects[0].afterDay', 1.5, 'schema'],
    ['state.campaign.days[1].effects[0].before', null, 'non-finite'],
    ['state.campaign.days[1].effects[1].after', 'x', 'schema'],
    ['state.campaign.days[1].effects[0].twin', 'x', 'schema'],
    ['state.campaign.days[1].effects[2].twin', null, 'non-finite'],
  ];

  it.each(CASES)('把 %s 改成 %j：不通过，类型是 %s，并指出这个字段', (path, value, code) => {
    const input = tampered(withEffects(), (save) => {
      const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
      let node = save as Record<string, any>;
      for (const key of keys.slice(0, -1)) node = node[key];
      node[keys[keys.length - 1] as string] = value;
    });
    const result = failure(input);
    expect(result.code).toBe(code);
    expect(result.paths).toContain(path);
  });

  it('效果行和效果跟踪缺字段：指出缺的是哪一个；站编号、等级可以是 null', () => {
    const line = failure(tampered(withEffects(), (save) => delete save.state.campaign.days[1].effects[0].before));
    expect(line.paths).toEqual(['state.campaign.days[1].effects[0].before']);
    const watch = failure(tampered(withEffects(), (save) => delete save.state.campaign.effectWatches[1].left));
    expect(watch.paths).toEqual(['state.campaign.effectWatches[1].left']);
    // 副本记下的数和不购买时的数是必须有的字段：缺了指出缺的是哪一个
    const twins = failure(tampered(withEffects(), (save) => delete save.state.campaign.effectWatches[1].twins));
    expect(twins.paths).toEqual(['state.campaign.effectWatches[1].twins']);
    const twin = failure(tampered(withEffects(), (save) => delete save.state.campaign.days[1].effects[2].twin));
    expect(twin.paths).toEqual(['state.campaign.days[1].effects[2].twin']);
    const entry = failure(tampered(withEffects(), (save) => delete save.state.campaign.effectWatches[0].twins[0].value));
    expect(entry.paths).toEqual(['state.campaign.effectWatches[0].twins[0].value']);
    const nulls = tampered(withEffects(), (save) => {
      save.state.campaign.days[1].effects[1].station = null;
      save.state.campaign.effectWatches[0].station = null;
      save.state.campaign.effectWatches[0].level = null;
    });
    expect(parseSave(nulls).ok).toBe(true);
  });
});

// ---- 旧格式 ----

/** 存档模块的版本 1 写出的一份经营模式存档，老街和写字楼区都开通，打了五个游戏日。样本在 fixtures 里，gzip 压缩过。 */
function legacyText(): string {
  return gunzipSync(readFileSync(join(HERE, 'fixtures', 'save-v1-campaign.json.gz'))).toString('utf8');
}

/**
 * 把读进来的状态里，比样本的版本新的版本加的字段拿掉，就是旧存档里原来的样子：
 * 版本 2 加了 away（版本 1 的样本没有），版本 3 加了目标线、达标标记、小结对照和每场的达标场数，
 * 版本 4 加了 nearestOwned、机队时间和排队的计数 tally（含回站飞行的计数 back）、小结的 fleet、fleetBack 和 stations、日结的 busy，
 * 还有数据员和效果记录：推演次数 forecast、购买的效果跟踪 effectWatches、日结的效果行 effects、开放项 dataClerk。
 * 版本 4 的迁移还把价签已开放而双层货箱没开放的存档补成同一步开放，这一项由 expectMigratedFrom 单独核对。
 */
function withoutAddedFields(state: SimState, from: 1 | 2 | 3): SimState {
  const copy = structuredClone(state) as unknown as { campaign: Record<string, any> };
  const campaign = copy.campaign;
  if (from < 2) delete campaign.away;
  if (from < 3) {
    delete campaign.goals;
    for (const peak of campaign.peaks) {
      delete peak.cleared;
      delete peak.baseline;
      for (const row of peak.districts) {
        delete row.line;
        delete row.met;
      }
    }
    for (const day of campaign.days) {
      delete day.peaksJudged;
      delete day.peaksCleared;
    }
  }
  delete campaign.nearestOwned;
  delete campaign.tally;
  delete campaign.forecast;
  delete campaign.effectWatches;
  delete campaign.unlocks.dataClerk;
  // 价签已开放的存档，迁移补开数据员时放出一张「数据员已到岗」的便签。样本里没有这张便签，拿掉之后与原来相同
  campaign.tips = campaign.tips.filter((tip: { id: string }) => tip.id !== 'dataClerk');
  for (const peak of campaign.peaks) {
    delete peak.fleet;
    delete peak.fleetBack;
    delete peak.stations;
  }
  for (const day of campaign.days) {
    delete day.busy;
    delete day.effects;
  }
  return copy as unknown as SimState;
}

/**
 * 迁移过的状态和样本里的原状态相比：把加的字段拿掉之后逐字段相同，只有双层货箱的开放步例外：
 * 样本里价签已开放而双层货箱没开放时，迁移把它补成价签开放的那一步。from 是样本的存档版本。
 * 数据员和效果记录的默认值也在这里核对：数据员的开放步是价签的开放步（价签没开放是 -1），推演次数 0，效果跟踪空，日结的效果行空。
 */
function expectMigratedFrom(migrated: SimState, original: SimState, from: 1 | 2 | 3): void {
  const added = campaignOf(migrated);
  const opened = campaignOf(original).unlocks.priceTags;
  expect(added.unlocks.dataClerk).toBe(opened >= 0 ? opened : -1);
  // 价签已开放的存档多一张数据员便签，步数是读档时的步。没开放的不放
  const clerkTips = added.tips.filter((tip) => tip.id === 'dataClerk');
  expect(clerkTips).toEqual(opened >= 0 ? [{ id: 'dataClerk', step: migrated.step, station: null, read: false }] : []);
  expect(added.forecast).toEqual({ charges: 0 });
  expect(added.effectWatches).toEqual([]);
  expect(added.days.every((day) => day.effects.length === 0)).toBe(true);
  const stripped = withoutAddedFields(migrated, from);
  const before = campaignOf(original).unlocks;
  const after = campaignOf(stripped).unlocks;
  expect(after.doubleBox).toBe(before.doubleBox < 0 && before.priceTags >= 0 ? before.priceTags : before.doubleBox);
  after.doubleBox = before.doubleBox;
  expect(stripped).toEqual(original);
}

/** 样本里记着的事实，生成样本的当时从状态里读出来的。 */
const LEGACY = {
  chars: 219_448,
  step: 18_001,
  money: 116.90512628479615,
  spent: 2267,
  income: [273.6698142529842, 268.4401228997039, 429.9209550606135, 564.2972767476025, 847.5769573238922, 0],
  orders: 415,
  delivered: 325,
  stations: 2,
  drones: 9,
  days: 5,
  peaks: 10,
  tips: 6,
  stars: [3, 1, 1],
  rules: { select: 'prioOffice', zone: 'hybrid', pool: 'single' },
  seed: 7,
  savedAt: 1_731_400_000_000,
};

describe('旧格式的存档（版本 1）', () => {
  it('样本确实是版本 1 的写法：内容版本是字符串 v1，经营模式的状态里没有 away', () => {
    const text = legacyText();
    expect(text).toHaveLength(LEGACY.chars);
    const raw = JSON.parse(text) as Record<string, any>;
    expect(raw.version).toBe(1);
    expect(raw.contentVersion).toBe('v1');
    expect(raw.savedAt).toBe(LEGACY.savedAt);
    expect(raw.state.campaign.away).toBeUndefined();
    expect(raw.state.campaign.contentVersion).toBe(3);
  });

  it('能读：先迁移再校验，读回来的状态里是当时的进度，没有改动任何已有的值', () => {
    const result = parseSave(legacyText());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    expect(result.version).toBe(SAVE_VERSION);
    expect(result.savedAt).toBe(LEGACY.savedAt);
    const state = result.state;
    const campaign = campaignOf(state);
    expect(state.step).toBe(LEGACY.step);
    expect(campaign.money).toBe(LEGACY.money);
    expect(campaign.spent).toBe(LEGACY.spent);
    expect(campaign.income).toEqual(LEGACY.income);
    expect(state.orders).toHaveLength(LEGACY.orders);
    expect(campaign.delivered).toBe(LEGACY.delivered);
    expect(state.stations).toHaveLength(LEGACY.stations);
    expect(state.drones).toHaveLength(LEGACY.drones);
    expect(campaign.days).toHaveLength(LEGACY.days);
    expect(campaign.peaks).toHaveLength(LEGACY.peaks);
    expect(campaign.tips.filter((t) => t.id !== 'dataClerk')).toHaveLength(LEGACY.tips); // 迁移另放的数据员便签不算
    expect(campaign.districts.map((d) => d.star)).toEqual(LEGACY.stars);
    expect(state.rules).toEqual(LEGACY.rules);
    expect(state.config.seed).toBe(LEGACY.seed);
    expect(campaign.ruleSets).not.toBeNull();
    // 迁移只加了字段：away，以及版本 3 的记录字段。把它们拿掉，整个状态与样本里的逐字段相同
    expect(campaign.away).toEqual([]);
    const original = (JSON.parse(legacyText()) as { state: SimState }).state;
    expectMigratedFrom(state, original, 1);
  });

  it('外层的内容版本：版本 1 写的是字符串，迁移时取状态里记着的真正的内容版本，是一个整数', () => {
    const result = parseSave(legacyText());
    expect(result.ok && result.contentVersion).toBe(3);
    expect(result.ok && result.contentChanged).toBe(tableVersion !== 3);
    // 状态里记的是更早的内容版本时，取那个，并标出内容变了。存档照常读
    const older = tampered(RICH, () => undefined);
    const raw = JSON.parse(older) as Record<string, any>;
    raw.version = 1;
    raw.contentVersion = 'v1';
    delete raw.state.campaign.away;
    raw.state.campaign.contentVersion = 2;
    const result2 = parseSave(JSON.stringify(raw));
    expect(result2.ok && result2.contentVersion).toBe(2);
    expect(result2.ok && result2.contentChanged).toBe(true);
    expect(result2.ok && campaignOf(result2.state).contentVersion).toBe(2);
  });

  it('沙盒模式的旧存档：字段表新要求的字段缺了就补默认值，内容版本取字符串里的数字', () => {
    const sandbox = runState(BUSY, 400);
    const raw = JSON.parse(textOf(sandbox)) as Record<string, any>;
    raw.version = 1;
    raw.contentVersion = 'v1';
    delete raw.state.campaign;
    delete raw.state.capacity;
    delete raw.state.returnRule;
    delete raw.state.config.mode;
    delete raw.state.config.returnRule;
    for (const item of [...raw.state.stations, ...raw.state.drones]) delete item.removed;
    const result = parseSave(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    expect(result.contentVersion).toBe(1);
    expect(result.state).toEqual(sandbox);
    expect(hashState(result.state)).toBe(hashState(sandbox));
  });

  it('版本 1 的存档内容有毛病，迁移之后照样被拦下：缺订单、数值是 NaN', () => {
    const raw = JSON.parse(legacyText()) as Record<string, any>;
    delete raw.state.orders;
    expect(failure(JSON.stringify(raw)).code).toBe('schema');
    const raw2 = JSON.parse(legacyText()) as Record<string, any>;
    raw2.state.campaign.money = null;
    expect(failure(JSON.stringify(raw2)).code).toBe('non-finite');
    // 外层的内容版本既不是字符串也不是整数：迁移不替它掩盖，校验报告
    const raw3 = JSON.parse(legacyText()) as Record<string, any>;
    delete raw3.contentVersion;
    expect(failure(JSON.stringify(raw3)).paths).toEqual(['contentVersion']);
  });

  it('存储里是旧的 JSON 原文：读档照常读，没有压缩的写法也认', async () => {
    const store = new MemoryStore({ [slotKey('main')]: legacyText() });
    const loaded = await loadGame(store, WALL);
    expect(loaded.status).toBe('ok');
    expect(loaded.save?.migratedFrom).toBe(1);
    expect(loaded.save?.fileVersion).toBe(1);
    expect(loaded.save?.contentChanged).toBe(tableVersion !== 3);
    expect(loaded.state?.step).toBe(LEGACY.step);
    expect(loaded.damaged).toBe(false);
    expect((await store.keys()).sort()).toEqual([slotKey('main')]);
  });

  it('读进来之后再存：写成最新的版本、压缩的写法，旧的 JSON 原文挪进备份一，两份都能读', async () => {
    const legacy = legacyText();
    const store = new MemoryStore({ [slotKey('main')]: legacy });
    const loaded = await loadGame(store, WALL);
    const state = loaded.state as SimState;
    const saved = await saveGame(store, state, WALL + 1000);
    expect(saved.ok && saved.packed).toBe(true);
    expect(await store.get(slotKey('backup1'))).toBe(legacy);
    const main = (await store.get(slotKey('main'))) as string;
    expect(main.startsWith('SKYSAVE1.')).toBe(true);
    const raw = JSON.parse(await readJson(store, 'main')) as Record<string, any>;
    expect(raw.version).toBe(SAVE_VERSION);
    expect(raw.contentVersion).toBe(CONTENT_VERSION);
    expect(raw.state.campaign.away).toEqual([]);
    // 再读：主存档是新格式，没有迁移。主存档读不出来时，回退到旧格式的备份也能读
    const again = await loadGame(store, WALL + 2000);
    expect(again.save?.migratedFrom).toBeNull();
    expect(again.state && hashState(again.state)).toBe(hashState(state));
    await store.set(slotKey('main'), 'broken');
    const fallback = await loadGame(store, WALL + 3000);
    expect(fallback.status).toBe('restored');
    expect(fallback.save?.migratedFrom).toBe(1);
    expect(fallback.state && hashState(fallback.state)).toBe(hashState(state));
  });

  it('旧版导出的导出码也能导入：里面是版本 1 的 JSON，导入时迁移', async () => {
    // 旧版的导出码就是 JSON 原文压缩之后的写法，encodeSaveText 没有变
    const code = await encodeSaveText(legacyText());
    const result = await decodeSaveCode(code);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    expect(result.state.step).toBe(LEGACY.step);
    expect(campaignOf(result.state).away).toEqual([]);
    const direct = parseSave(legacyText());
    expect(direct.ok && hashState(direct.state)).toBe(hashState(result.state));
  });

  it('迁移过的状态接着玩：照常运行，离开结算也能用', () => {
    const result = parseSave(legacyText());
    if (!result.ok) throw new Error('legacy save should load');
    const state = result.state;
    advance(state, 2 * DAY_STEPS);
    expect(state.step).toBe(LEGACY.step + 2 * DAY_STEPS);
    expect(campaignOf(state).days.length).toBeGreaterThan(LEGACY.days);
    const record = settleAway(state, 600);
    expect(record?.amount).toBeGreaterThan(0);
    expect(parseSave(textOf(state)).ok).toBe(true);
  });

  it('新版本的存档（版本比这个游戏认识的新）读不进来，不会被当成旧的', async () => {
    const raw = JSON.parse(legacyText()) as Record<string, any>;
    raw.version = SAVE_VERSION + 1;
    expect(failure(JSON.stringify(raw)).code).toBe('newer-version');
    const parsed = await parseStoredSave(await encodeSaveText(JSON.stringify(raw)));
    expect(!parsed.ok && parsed.reason.code).toBe('newer-version');
  });
});

// ---- 版本 2 的存档 ----

/** 存档模块的版本 2 写出的一份经营模式存档，打了五个游戏日。样本在 fixtures 里，gzip 压缩过。 */
function v2Text(): string {
  return gunzipSync(readFileSync(join(HERE, 'fixtures', 'save-v2-campaign.json.gz'))).toString('utf8');
}

/** 版本 2 样本里记着的事实，生成样本的当时从状态里读出来的。 */
const V2 = {
  chars: 219_455,
  step: 18_001,
  money: 116.90512628479615,
  orders: 415,
  delivered: 325,
  days: 5,
  peaks: 10,
  tips: 6,
  stars: [3, 1, 1],
  rules: { select: 'prioOffice', zone: 'hybrid', pool: 'single' },
  seed: 7,
  savedAt: 1_731_400_000_000,
};

describe('旧格式的存档（版本 2）', () => {
  it('样本确实是版本 2 的写法：没有 goals，小结里没有达标标记和对照，各片区一行没有目标线，日结里没有达标的场数', () => {
    const text = v2Text();
    expect(text).toHaveLength(V2.chars);
    const raw = JSON.parse(text) as Record<string, any>;
    expect(raw.version).toBe(2);
    // 样本是内容版本 4 时写的，之后内容表再改，样本里记的版本不变
    expect(raw.contentVersion).toBe(4);
    expect(raw.savedAt).toBe(V2.savedAt);
    const campaign = raw.state.campaign;
    expect(campaign.goals).toBeUndefined();
    expect(campaign.away).toEqual([]);
    expect(campaign.peaks).toHaveLength(V2.peaks);
    for (const peak of campaign.peaks) {
      expect(peak.cleared).toBeUndefined();
      expect(peak.baseline).toBeUndefined();
      for (const row of peak.districts) expect([row.line, row.met]).toEqual([undefined, undefined]);
    }
    for (const day of campaign.days) expect([day.peaksJudged, day.peaksCleared]).toEqual([undefined, undefined]);
  });

  it('能读：先迁移再校验，新字段补默认值，已有的值一个没改', () => {
    const result = parseSave(v2Text());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(2);
    expect(result.version).toBe(SAVE_VERSION);
    expect(result.savedAt).toBe(V2.savedAt);
    const state = result.state;
    const campaign = campaignOf(state);
    expect(state.step).toBe(V2.step);
    expect(campaign.money).toBe(V2.money);
    expect(state.orders).toHaveLength(V2.orders);
    expect(campaign.delivered).toBe(V2.delivered);
    expect(campaign.days).toHaveLength(V2.days);
    expect(campaign.peaks).toHaveLength(V2.peaks);
    expect(campaign.tips.filter((t) => t.id !== 'dataClerk')).toHaveLength(V2.tips); // 迁移另放的数据员便签不算
    expect(campaign.districts.map((d) => d.star)).toEqual(V2.stars);
    expect(state.rules).toEqual(V2.rules);
    expect(state.config.seed).toBe(V2.seed);
    // 默认值：旧存档里的高峰没有设过目标，没有对照
    expect(campaign.goals).toBeNull();
    for (const peak of campaign.peaks) {
      expect(peak.cleared).toBeNull();
      expect(peak.baseline).toBeNull();
      for (const row of peak.districts) expect([row.line, row.met]).toEqual([null, null]);
    }
    for (const day of campaign.days) expect([day.peaksJudged, day.peaksCleared]).toEqual([0, 0]);
    // 迁移只加了字段：把它们拿掉，整个状态与样本里的逐字段相同
    const original = (JSON.parse(v2Text()) as { state: SimState }).state;
    expectMigratedFrom(state, original, 2);
  });

  it('读进来的状态存出去再读回来，状态和哈希都不变，不再经过迁移', () => {
    const result = parseSave(v2Text());
    if (!result.ok) throw new Error('version 2 save should load');
    const again = parseSave(textOf(result.state));
    expect(again.ok && again.migratedFrom).toBeNull();
    expect(again.ok && again.state).toEqual(result.state);
    expect(again.ok && hashState(again.state)).toBe(hashState(result.state));
  });

  it('迁移过的状态接着玩：第一个高峰起算出目标，小结有达标一栏，日结有达标的场数，之后的存档照常读', () => {
    const result = parseSave(v2Text());
    if (!result.ok) throw new Error('version 2 save should load');
    const state = result.state;
    advance(state, 2 * DAY_STEPS);
    const campaign = campaignOf(state);
    expect(campaign.goals).not.toBeNull();
    expect(campaign.peaks.length).toBeGreaterThan(V2.peaks);
    const fresh = campaign.peaks.slice(V2.peaks);
    expect(fresh.every((p) => p.cleared === null || typeof p.cleared === 'boolean')).toBe(true);
    expect(fresh.some((p) => p.districts.some((d) => d.line !== null))).toBe(true);
    const day = campaign.days[campaign.days.length - 1];
    expect(day?.peaksJudged).toBeGreaterThanOrEqual(day?.peaksCleared ?? 0);
    expect(parseSave(textOf(state)).ok).toBe(true);
  });

  it('版本 2 的存档内容有毛病，迁移之后照样被拦下', () => {
    const raw = JSON.parse(v2Text()) as Record<string, any>;
    delete raw.state.orders;
    expect(failure(JSON.stringify(raw)).code).toBe('schema');
    const raw2 = JSON.parse(v2Text()) as Record<string, any>;
    raw2.state.campaign.money = null;
    expect(failure(JSON.stringify(raw2)).code).toBe('non-finite');
  });

  it('存储里是版本 2 的 JSON 原文：读档照常读，读进来之后再存成最新的版本，旧文挪进备份一', async () => {
    const legacy = v2Text();
    const store = new MemoryStore({ [slotKey('main')]: legacy });
    const loaded = await loadGame(store, WALL);
    expect(loaded.status).toBe('ok');
    expect(loaded.save?.migratedFrom).toBe(2);
    expect(loaded.save?.fileVersion).toBe(2);
    const state = loaded.state as SimState;
    const saved = await saveGame(store, state, WALL + 1000);
    expect(saved.ok).toBe(true);
    expect(await store.get(slotKey('backup1'))).toBe(legacy);
    const raw = JSON.parse(await readJson(store, 'main')) as Record<string, any>;
    expect(raw.version).toBe(SAVE_VERSION);
    expect(raw.state.campaign.goals).toBeNull();
    expect(raw.state.campaign.peaks[0].baseline).toBeNull();
  });

  it('版本 3 的存档里有对照、目标和达标标记时，能存能读，对照的字段有毛病会被拦下', () => {
    const state = structuredClone(RICH);
    const campaign = campaignOf(state);
    const peak = campaign.peaks[0]!;
    peak.cleared = true;
    peak.districts[0]!.line = 80;
    peak.districts[0]!.met = true;
    peak.baseline = { orders: 8, onTime: 5, late: 3, lateOpen: 1, cancelled: 0, revenue: 40.5, districts: [{ district: 0, n: 8, onTime: 5, pct: 62 }], lowLoad: false };
    campaign.goals = { day: 4, peak: 'evening', step: 3 * DAY_STEPS + 2150, goals: [{ district: 0, kind: 'capped', line: 55, basis: 'keep' }, { district: 1, kind: 'enough', line: null, basis: 'next' }] };
    const text = textOf(state);
    const back = parseSave(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.state).toEqual(state);
    expect(hashState(back.state)).toBe(hashState(state));
    // 对照和目标里的字段类型不对
    for (const [path, value] of [
      ['state.campaign.peaks[0].baseline.onTime', 'five'],
      ['state.campaign.peaks[0].baseline.lowLoad', 0],
      ['state.campaign.peaks[0].baseline.districts[0].pct', 'x'],
      ['state.campaign.goals.goals[1].line', 'x'],
    ] as const) {
      const input = tampered(state, (save) => {
        const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
        let node = save as Record<string, any>;
        for (const key of keys.slice(0, -1)) node = node[key];
        node[keys[keys.length - 1] as string] = value;
      });
      expect(failure(input).paths, path).toContain(path);
    }
  });
});

// ---- 版本 3 的存档 ----

/**
 * 存档模块的版本 3 写出的一份经营模式存档，均衡玩法，订单种子 7，打了五个游戏日，与上面的 RICH 是同一局。
 * 样本用提交 1befb4e 的代码生成，在 fixtures 里，gzip 压缩过。
 */
function v3Text(): string {
  return gunzipSync(readFileSync(join(HERE, 'fixtures', 'save-v3-campaign.json.gz'))).toString('utf8');
}

/** 版本 3 样本里记着的事实，生成样本的当时从状态里读出来的。 */
const V3 = {
  chars: 185_372,
  step: 18_001,
  contentVersion: 5,
  money: 62.26922794156319,
  spent: 2040,
  orders: 319,
  delivered: 283,
  stations: 2,
  drones: 9,
  days: 5,
  peaks: 10,
  tips: 6,
  stars: [4, 1, 1],
  rules: { select: 'prioOffice', zone: 'hybrid', pool: 'single' },
  seed: 7,
  savedAt: 1_731_400_000_000,
  priceTagsAt: 3600,
};

describe('旧格式的存档（版本 3）', () => {
  it('样本确实是版本 3 的写法：没有 nearestOwned，价签已开放而双层货箱还没开放', () => {
    const text = v3Text();
    expect(text).toHaveLength(V3.chars);
    const raw = JSON.parse(text) as Record<string, any>;
    expect(raw.version).toBe(3);
    // 样本是内容版本 5 时写的，之后内容表再改，样本里记的版本不变
    expect(raw.contentVersion).toBe(V3.contentVersion);
    expect(raw.savedAt).toBe(V3.savedAt);
    const campaign = raw.state.campaign;
    expect(campaign.nearestOwned).toBeUndefined();
    expect(campaign.unlocks.priceTags).toBe(V3.priceTagsAt);
    expect(campaign.unlocks.doubleBox).toBe(-1);
    expect(raw.state.returnRule).toBe('home');
    expect(campaign.peaks).toHaveLength(V3.peaks);
    expect(campaign.days).toHaveLength(V3.days);
  });

  it('能读：先迁移再校验，新字段补默认值，已有的值一个没改，只有双层货箱的开放步补成价签的开放步', () => {
    const result = parseSave(v3Text());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(3);
    expect(result.version).toBe(SAVE_VERSION);
    expect(result.savedAt).toBe(V3.savedAt);
    expect(result.contentVersion).toBe(V3.contentVersion);
    expect(result.contentChanged).toBe(tableVersion !== V3.contentVersion); // 内容表升到版本 6，样本里记的仍是 5，读档照常读
    const state = result.state;
    const campaign = campaignOf(state);
    expect(state.step).toBe(V3.step);
    expect(campaign.money).toBe(V3.money);
    expect(campaign.spent).toBe(V3.spent);
    expect(state.orders).toHaveLength(V3.orders);
    expect(campaign.delivered).toBe(V3.delivered);
    expect(state.stations).toHaveLength(V3.stations);
    expect(state.drones).toHaveLength(V3.drones);
    expect(campaign.days).toHaveLength(V3.days);
    expect(campaign.peaks).toHaveLength(V3.peaks);
    expect(campaign.tips.filter((t) => t.id !== 'dataClerk')).toHaveLength(V3.tips); // 迁移另放的数据员便签不算
    expect(campaign.districts.map((d) => d.star)).toEqual(V3.stars);
    expect(state.rules).toEqual(V3.rules);
    expect(state.config.seed).toBe(V3.seed);
    // 新字段的默认值：原来是回原站，没有买就近降落。机队时间和排队的计数补成全零，每座站一行
    expect(campaign.nearestOwned).toBe(false);
    expect(state.returnRule).toBe('home');
    // 旧的小结和日结没有记过机队时间、回站飞行占比、各站的行和运力占用：fleet 和 fleetBack 是 null，stations 是空的，busy 是 null
    for (const peak of campaign.peaks) expect([peak.fleet, peak.fleetBack, peak.stations]).toEqual([null, null, []]);
    for (const day of campaign.days) expect(day.busy).toBeNull();
    expect(campaign.tally).toEqual({
      peak: { steps: 0, fleet: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], back: [0, 0], takeoffWait: [0, 0], queue: [0, 0], sorties: [0, 0] },
      day: { drones: new Array<number>(24).fill(0), used: new Array<number>(24).fill(0) },
    });
    // 价签开放的那一步，双层货箱和数据员同时开放
    expect(campaign.unlocks.priceTags).toBe(V3.priceTagsAt);
    expect(campaign.unlocks.doubleBox).toBe(V3.priceTagsAt);
    expect(campaign.unlocks.dataClerk).toBe(V3.priceTagsAt);
    // 推演次数是 0，没有在跟踪的购买，旧的日结没有效果行
    expect(campaign.forecast).toEqual({ charges: 0 });
    expect(campaign.effectWatches).toEqual([]);
    for (const day of campaign.days) expect(day.effects).toEqual([]);
    // 迁移只加了字段，只有双层货箱的开放步例外：其余与样本逐字段相同
    expectMigratedFrom(state, (JSON.parse(v3Text()) as { state: SimState }).state, 3);
  });

  it('迁移补成全零的计数，从读档的那一步起累计：高峰窗口里只计读档之后的步，全天的分段只计读档之后的无人机', () => {
    const result = parseSave(v3Text());
    if (!result.ok) throw new Error('version 3 save should load');
    const state = result.state;
    const live = state.drones.filter((d) => !d.removed).length;
    expect(state.step).toBe(V3.step); // 第 5 天的第 1 步
    advance(state, 1000); // 到第 5 天的第 1001 步，午高峰的下单时段从第 600 步起
    const tally = campaignOf(state).tally;
    expect(tally.peak.steps).toBe(1001 - 600);
    expect(tally.day.drones.reduce((a, b) => a + b, 0)).toBe(live * 1000);
    expect(tally.day.drones.slice(7).every((n) => n === 0)).toBe(true); // 第 1001 步在第 6 段，之后的段还没有数
    expect(parseSave(textOf(state)).ok).toBe(true);
  });

  it('买过就近降落的版本 3 存档：nearestOwned 按 returnRule 补，开着的是 true，原来就是回原站的是 false', () => {
    const raw = JSON.parse(v3Text()) as Record<string, any>;
    raw.state.returnRule = 'nearest';
    const owned = parseSave(JSON.stringify(raw));
    expect(owned.ok && campaignOf(owned.state).nearestOwned).toBe(true);
    expect(owned.ok && owned.state.returnRule).toBe('nearest');
    raw.state.returnRule = 'home';
    const notOwned = parseSave(JSON.stringify(raw));
    expect(notOwned.ok && campaignOf(notOwned.state).nearestOwned).toBe(false);
  });

  it('价签没开放的版本 3 存档：双层货箱照样没开放，迁移不凭空开放；已开放的步原样保留', () => {
    const early = JSON.parse(v3Text()) as Record<string, any>;
    early.state.campaign.unlocks.priceTags = -1;
    early.state.campaign.unlocks.doubleBox = -1;
    const closed = parseSave(JSON.stringify(early));
    expect(closed.ok && campaignOf(closed.state).unlocks.doubleBox).toBe(-1);
    expect(closed.ok && campaignOf(closed.state).unlocks.dataClerk).toBe(-1);
    const open = JSON.parse(v3Text()) as Record<string, any>;
    open.state.campaign.unlocks.doubleBox = 7777;
    const kept = parseSave(JSON.stringify(open));
    expect(kept.ok && campaignOf(kept.state).unlocks.doubleBox).toBe(7777);
  });

  it('数据员：价签已开放的存档补成价签的开放步，同时放出「数据员已到岗」的便签，步数是读档时的步，之后的检查不会再放', () => {
    const result = parseSave(v3Text());
    if (!result.ok) throw new Error('version 3 save should load');
    const state = result.state;
    expect(isUnlocked(state, 'dataClerk')).toBe(true);
    expect(campaignOf(state).tips.filter((t) => t.id === 'dataClerk')).toEqual([{ id: 'dataClerk', step: V3.step, station: null, read: false }]);
    advance(state, 10);
    expect(campaignOf(state).unlocks.dataClerk).toBe(V3.priceTagsAt); // 开放的步不会被改写
    expect(campaignOf(state).tips.filter((t) => t.id === 'dataClerk')).toHaveLength(1);
  });

  it('数据员：价签没开放的存档补成 -1，之后价签开放的那一步数据员同时到岗，放出便签，只放一次', () => {
    const raw = JSON.parse(v3Text()) as Record<string, any>;
    raw.state.campaign.unlocks.priceTags = -1;
    raw.state.campaign.unlocks.doubleBox = -1;
    raw.state.campaign.money = 500; // 余额够，读档之后的第一步价签就开放
    const result = parseSave(JSON.stringify(raw));
    if (!result.ok) throw new Error('version 3 save should load');
    const state = result.state;
    expect(campaignOf(state).unlocks.dataClerk).toBe(-1);
    advance(state, 5);
    const campaign = campaignOf(state);
    expect(campaign.unlocks.priceTags).toBe(V3.step);
    expect(campaign.unlocks.dataClerk).toBe(V3.step);
    expect(campaign.tips.filter((t) => t.id === 'dataClerk').map((t) => t.step)).toEqual([V3.step]);
    advance(state, DAY_STEPS);
    expect(campaignOf(state).tips.filter((t) => t.id === 'dataClerk')).toHaveLength(1);
  });

  it('推演次数：补成 0，数据员虽已到岗但次数不足；读档之后每场高峰的小结加一次，攒到内容表的上限为止，用 useForecast 扣', () => {
    const result = parseSave(v3Text());
    if (!result.ok) throw new Error('version 3 save should load');
    const state = result.state;
    expect(campaignOf(state).forecast.charges).toBe(0);
    expectRejected(state, { type: 'useForecast' }, 'noForecastCharge');
    advance(state, DAY_STEPS); // 第 5 天的午、晚两场小结
    expect(campaignOf(state).peaks).toHaveLength(V3.peaks + 2);
    expect(campaignOf(state).forecast.charges).toBe(2);
    must(state, { type: 'useForecast' });
    expect(campaignOf(state).forecast.charges).toBe(1);
    advance(state, 2 * DAY_STEPS);
    expect(campaignOf(state).forecast.charges).toBe(FORECAST_V1.maxCharges);
    expect(parseSave(textOf(state)).ok).toBe(true);
  });

  it('迁移之后买的改装：购买前的数值取最近一场小结记录。旧记录里没有各站的行和机队时间构成，所以是 null，只记下那一场是午高峰还是晚高峰，三次日结之后跟踪删掉，没有写过一行', () => {
    const result = parseSave(v3Text());
    if (!result.ok) throw new Error('version 3 save should load');
    const state = result.state;
    const campaign = campaignOf(state);
    const last = campaign.peaks[campaign.peaks.length - 1]!;
    campaign.money = 10_000;
    must(state, { type: 'buyDoubleBox' });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(campaign.effectWatches).toEqual([
      { kind: 'doubleBox', step: V3.step, station: null, level: null, peak: last.peak, beforeDay: last.day, before: null, left: FORECAST_V1.effectDays, twins: [] },
      { kind: 'gate', step: V3.step, station: 0, level: 2, peak: last.peak, beforeDay: last.day, before: null, left: FORECAST_V1.effectDays, twins: [] },
    ]);
    advance(state, FORECAST_V1.effectDays * DAY_STEPS);
    expect(campaign.effectWatches).toEqual([]);
    expect(campaign.days.slice(V3.days).map((d) => d.effects)).toEqual([[], [], []]);
    expect(parseSave(textOf(state)).ok).toBe(true);
  });

  it('效果跟踪里副本记下的数：版本 3 的存档里没有跟踪，迁移补的是空数组；万一跟踪已经在，twins 补成空数组，其余字段不动', () => {
    const plain = parseSave(v3Text());
    expect(plain.ok && campaignOf(plain.state).effectWatches).toEqual([]);
    const raw = JSON.parse(v3Text()) as Record<string, any>;
    const watch = { kind: 'gate', step: 5, station: 0, level: 2, peak: 'noon', beforeDay: 0, before: 1.5, left: 3 };
    raw.state.campaign.effectWatches = [watch];
    const result = parseSave(JSON.stringify(raw));
    expect(result.ok && campaignOf(result.state).effectWatches).toEqual([{ ...watch, twins: [] }]);
    // 已经有 twins 的原样保留
    raw.state.campaign.effectWatches = [{ ...watch, twins: [{ day: 1, peak: 'noon', value: 0.8 }] }];
    const kept = parseSave(JSON.stringify(raw));
    expect(kept.ok && campaignOf(kept.state).effectWatches[0]!.twins).toEqual([{ day: 1, peak: 'noon', value: 0.8 }]);
  });

  it('读进来的状态存出去再读回来，状态和哈希都不变，不再经过迁移', () => {
    const result = parseSave(v3Text());
    if (!result.ok) throw new Error('version 3 save should load');
    const again = parseSave(textOf(result.state));
    expect(again.ok && again.migratedFrom).toBeNull();
    expect(again.ok && again.state).toEqual(result.state);
    expect(again.ok && hashState(again.state)).toBe(hashState(result.state));
  });

  it('迁移过的状态接着玩：照常运行两个游戏日，双层货箱马上能买，之后的存档照常读', () => {
    const result = parseSave(v3Text());
    if (!result.ok) throw new Error('version 3 save should load');
    const state = result.state;
    advance(state, 2 * DAY_STEPS);
    const campaign = campaignOf(state);
    expect(state.step).toBe(V3.step + 2 * DAY_STEPS);
    expect(campaign.days.length).toBeGreaterThan(V3.days);
    expect(campaign.peaks.length).toBeGreaterThan(V3.peaks);
    expect(campaign.unlocks.doubleBox).toBe(V3.priceTagsAt); // 开放的步不会被改写
    // 读档之后新生成的小结和日结有新字段：每座站一行，机队时间构成，24 段的运力占用。旧的记录仍然没有
    const freshPeaks = campaign.peaks.slice(V3.peaks);
    expect(freshPeaks.length).toBeGreaterThanOrEqual(4);
    expect(freshPeaks.every((p) => p.fleet !== null && p.fleetBack !== null && p.stations.length === 2)).toBe(true);
    expect(campaign.peaks.slice(0, V3.peaks).every((p) => p.fleet === null && p.fleetBack === null && p.stations.length === 0)).toBe(true);
    // 读档之后新生成的回站飞行占比是整数，不大于同一场的空载飞行
    for (const p of freshPeaks) {
      expect(Number.isInteger(p.fleetBack)).toBe(true);
      expect(p.fleetBack as number).toBeLessThanOrEqual(p.fleet?.empty as number);
    }
    const freshDays = campaign.days.slice(V3.days);
    expect(freshDays).toHaveLength(2);
    expect(freshDays.every((d) => d.busy !== null && d.busy.length === 24)).toBe(true);
    expect(campaign.days.slice(0, V3.days).every((d) => d.busy === null)).toBe(true);
    campaign.money = 10_000;
    expect(applyCommand(state, { type: 'buyDoubleBox' })).toEqual({ ok: true, id: -1 });
    expect(state.capacity).toBe(2);
    expect(parseSave(textOf(state)).ok).toBe(true);
    // 也能买下就近降落并开关
    expect(applyCommand(state, { type: 'buyNearestLanding' }).ok).toBe(true);
    expect(campaign.nearestOwned).toBe(true);
    expect(applyCommand(state, { type: 'setNearestLanding', on: false }).ok).toBe(true);
    const saved = parseSave(textOf(state));
    expect(saved.ok && campaignOf(saved.state).nearestOwned).toBe(true);
    expect(saved.ok && saved.state.returnRule).toBe('home');
  });

  it('版本 3 的存档内容有毛病，迁移之后照样被拦下', () => {
    const raw = JSON.parse(v3Text()) as Record<string, any>;
    delete raw.state.orders;
    expect(failure(JSON.stringify(raw)).code).toBe('schema');
    const raw2 = JSON.parse(v3Text()) as Record<string, any>;
    raw2.state.campaign.money = null;
    expect(failure(JSON.stringify(raw2)).code).toBe('non-finite');
  });

  it('存储里是版本 3 的 JSON 原文：读档照常读，读进来之后再存成最新的版本，旧文挪进备份一', async () => {
    const legacy = v3Text();
    const store = new MemoryStore({ [slotKey('main')]: legacy });
    const loaded = await loadGame(store, WALL);
    expect(loaded.status).toBe('ok');
    expect(loaded.save?.migratedFrom).toBe(3);
    expect(loaded.save?.fileVersion).toBe(3);
    const state = loaded.state as SimState;
    const saved = await saveGame(store, state, WALL + 1000);
    expect(saved.ok).toBe(true);
    expect(await store.get(slotKey('backup1'))).toBe(legacy);
    const raw = JSON.parse(await readJson(store, 'main')) as Record<string, any>;
    expect(raw.version).toBe(SAVE_VERSION);
    expect(raw.state.campaign.nearestOwned).toBe(false);
  });
});

describe('内容版本和存档里的不同：照常读，在读档的结果里标出来', () => {
  it('存档里的内容版本是旧的：状态原样读进来，loadGame 的结果标出 contentChanged，界面不需要提示', async () => {
    const store = new MemoryStore();
    const state = campaignState(7);
    // 写存档时按内容版本 0 写，模拟内容表后来升过版本
    await saveGame(store, state, WALL, { contentVersion: 0 });
    const loaded = await loadGame(store, WALL + 1);
    expect(loaded.status).toBe('ok');
    expect(loaded.save?.contentVersion).toBe(0);
    expect(loaded.save?.contentChanged).toBe(true);
    expect(loaded.damaged).toBe(false);
    expect(loaded.state && hashState(loaded.state)).toBe(hashState(state));
    // 内容版本相同时没有标
    await saveGame(store, state, WALL + 2);
    expect((await loadGame(store, WALL + 3)).save?.contentChanged).toBe(false);
  });

  it('比当前新的内容版本同样照常读', async () => {
    const store = new MemoryStore();
    await saveGame(store, campaignState(7), WALL, { contentVersion: tableVersion + 9 });
    const loaded = await loadGame(store, WALL + 1);
    expect(loaded.status).toBe('ok');
    expect(loaded.save?.contentChanged).toBe(true);
  });
});

function campaignState(seed: number): SimState {
  const state = createState({ mode: 'campaign', seed });
  advance(state, 800);
  return state;
}

// 片区纸条：按核心的 districtNote 选哪一条句子并填上参数。另测星的写法，以及多个片区时怎么轮换。
// 句子里的准时率线、取消率线、订单的下限都取自内容表（STARS_V1），内容表重新校准之后这里不用改。文字取自词表。
import { describe, expect, it } from 'vitest';
import { STARS_V1 } from '../src/content/stars_v1.ts';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { DAY_STEPS, districtNote } from '../src/core/index.ts';
import type { NoteKind } from '../src/core/index.ts';
import { noteDistrictFor, nextNoteDistrict, noteText, noteView, openDistricts, starsText } from '../src/ui/note.ts';
import { batchOrders, campaignOf, campaignState } from './campaign-helpers.ts';

/** 升到 star 星的条件，二星到五星。 */
function rule(star: number): { onTimeMin: number; cancelBelow: number | null } {
  const found = STARS_V1.rules.find((r) => r.star === star);
  if (found === undefined) throw new Error(`no rule for star ${star}`);
  return found;
}

const MIN = STARS_V1.minSample;
const NOTE = STR.hud.districtNote;

/**
 * 一批订单，各项按占总数的百分数给，总数是下限的 20 倍，所以不管下限是多少，订单都够数，比率也都是整数。
 * 百分数要是 5 的倍数。
 */
function share(parts: { onTime?: number; late?: number; cancelled?: number }): { onTime: number; late: number; cancelled: number } {
  const count = (percent: number | undefined): number => ((percent ?? 0) / 5) * MIN;
  return { onTime: count(parts.onTime), late: count(parts.late), cancelled: count(parts.cancelled) };
}

/** 第 day 天（从 0 数起）、老街、星级为 star 的状态，最近两天里有 counts 这些结果的订单。 */
function stateWith(star: number, day: number, counts: { onTime?: number; late?: number; cancelled?: number }, misses = 0) {
  const state = campaignState();
  const campaign = campaignOf(state);
  campaign.districts[0]!.star = star;
  campaign.rating[0]!.misses = misses;
  state.step = day * DAY_STEPS + 2000;
  batchOrders(state, 0, day, counts);
  return state;
}

describe('星的写法', () => {
  it('五颗：星级是几颗实心，其余空心', () => {
    expect(starsText(1)).toBe('★☆☆☆☆');
    expect(starsText(3)).toBe('★★★☆☆');
    expect(starsText(5)).toBe('★★★★★');
  });

  it('越界的星级夹在 0 到 5 之间', () => {
    expect(starsText(0)).toBe('☆☆☆☆☆');
    expect(starsText(9)).toBe('★★★★★');
    expect(starsText(-2)).toBe('☆☆☆☆☆');
  });
});

describe('片区纸条选哪一条', () => {
  it('游戏的第一天，一星：只看今天，写二星的准时率线，取自内容表', () => {
    const state = stateWith(1, 0, share({ onTime: 75, late: 25 }));
    const note = districtNote(state, 0);
    expect(note.kind).toBe('firstDay');
    expect(noteText(note)).toBe(fmt(NOTE.firstDay, { district: '老街', onTime: 75, needOnTime: rule(2).onTimeMin }));
  });

  it('第一天一个完成的订单也没有：写暂无完成订单，不写准时率', () => {
    const state = campaignState();
    const note = districtNote(state, 0);
    expect(note.kind).toBe('noData');
    expect(noteText(note)).toBe(fmt(NOTE.noData, { district: '老街' }));
  });

  it('完成的订单少于下限：写不足下限的单数，日结星级不变，不写升星的条件。第一天和以后都一样', () => {
    const tooFew = fmt(NOTE.tooFew, { district: '老街', min: MIN });
    const first = districtNote(stateWith(1, 0, { onTime: MIN - 1 }), 0);
    expect(first.kind).toBe('tooFew');
    expect(noteText(first)).toBe(tooFew);
    const later = districtNote(stateWith(1, 1, { onTime: 1, late: MIN - 2 }), 0);
    expect(later.kind).toBe('tooFew');
    expect(noteText(later)).toBe(tooFew);
    expect(noteText(districtNote(stateWith(3, 1, { onTime: MIN - 1 }), 0))).toBe(tooFew);
  });

  it('恰好等于下限：照常写升星的条件', () => {
    const note = districtNote(stateWith(1, 0, { onTime: MIN }), 0);
    expect(note.kind).toBe('firstDay');
    expect(noteText(note)).toBe(fmt(NOTE.firstDay, { district: '老街', onTime: 100, needOnTime: rule(2).onTimeMin }));
  });

  it('第二天起仍是一星：近两日准时率，写二星的准时率线', () => {
    const state = stateWith(1, 1, share({ onTime: 50, late: 50 }));
    const note = districtNote(state, 0);
    expect(note.kind).toBe('toTwoStars');
    expect(noteText(note)).toBe(fmt(NOTE.toTwoStars, { district: '老街', onTime: 50, needOnTime: rule(2).onTimeMin }));
  });

  it('二星：写升三星的条件，准时率线和取消率线都取自内容表', () => {
    const state = stateWith(2, 1, share({ onTime: 75, late: 25 }));
    const note = districtNote(state, 0);
    expect(note.kind).toBe('toNextStar');
    expect(noteText(note)).toBe(
      fmt(NOTE.toThreeStarsUp, { district: '老街', star: '三', needOnTime: rule(3).onTimeMin, needCancelRate: rule(3).cancelBelow as number, onTime: 75, cancelRate: 0 }),
    );
  });

  it('三星和四星：升高一星的条件跟着变，星写成汉字', () => {
    expect(noteText(districtNote(stateWith(3, 1, share({ onTime: 80, late: 20 })), 0))).toBe(
      fmt(NOTE.toThreeStarsUp, { district: '老街', star: '四', needOnTime: rule(4).onTimeMin, needCancelRate: rule(4).cancelBelow as number, onTime: 80, cancelRate: 0 }),
    );
    expect(noteText(districtNote(stateWith(4, 1, share({ onTime: 90, late: 10 })), 0))).toBe(
      fmt(NOTE.toThreeStarsUp, { district: '老街', star: '五', needOnTime: rule(5).onTimeMin, needCancelRate: rule(5).cancelBelow as number, onTime: 90, cancelRate: 0 }),
    );
  });

  it('五星：写已达五星', () => {
    const note = districtNote(stateWith(5, 1, share({ onTime: 95, cancelled: 5 })), 0);
    expect(note.kind).toBe('maxStars');
    expect(noteText(note)).toBe(fmt(NOTE.maxStars, { district: '老街', onTime: 95, cancelRate: 5 }));
  });

  it('可能降星，准时率没达到：三星，上次日结没有达到，现在近两日准时率 25%，要保持在二星的准时率线以上', () => {
    const state = stateWith(3, 1, share({ onTime: 25, late: 75 }), 1);
    const note = districtNote(state, 0);
    expect(note.kind).toBe('dropByOnTime');
    expect(noteText(note)).toBe(fmt(NOTE.dropByOnTime, { district: '老街', needOnTime: rule(2).onTimeMin, onTime: 25 }));
  });

  it('可能降星，取消率没达到：四星，准时率够但取消率不低于三星的线，写要低于这条线', () => {
    // 取消率取三星的线再多一些，准时率远高于三星的线
    const need = rule(3).cancelBelow as number;
    const cancelled = Math.ceil((need + 1) / 5) * 5;
    const state = stateWith(4, 1, share({ onTime: 100 - cancelled, cancelled }), 1);
    const note = districtNote(state, 0);
    expect(note.kind).toBe('dropByCancel');
    expect(noteText(note)).toBe(fmt(NOTE.dropByCancel, { district: '老街', needCancelRate: need, cancelRate: cancelled }));
  });

  it('可能降星的状态里，现在的统计已经达到了要保持的线：仍写升星的那一条', () => {
    const state = stateWith(3, 1, share({ onTime: 80, late: 20 }), 1);
    expect(districtNote(state, 0).kind).toBe('toNextStar');
  });

  it('可能降星的两条优先于订单太少：订单够数就写降星，不够数写订单太少，一张也没有写暂无完成订单', () => {
    expect(districtNote(stateWith(3, 1, share({ late: 100 }), 1), 0).kind).toBe('dropByOnTime');
    expect(districtNote(stateWith(3, 1, { late: MIN - 1 }, 1), 0).kind).toBe('tooFew');
    expect(districtNote(stateWith(3, 1, {}, 1), 0).kind).toBe('noData');
  });

  it('八种写法都能出整句，都从片区名写起：界面把片区名和星画在一起，后面接这一句的其余部分', () => {
    const seen = new Set<NoteKind>();
    const cases = [
      stateWith(1, 0, share({ onTime: 100 })),
      stateWith(1, 1, share({ onTime: 100 })),
      stateWith(2, 1, share({ onTime: 100 })),
      stateWith(5, 1, share({ onTime: 100 })),
      stateWith(3, 1, share({ late: 100 }), 1),
      stateWith(4, 1, share({ onTime: 90, cancelled: 10 }), 1),
      stateWith(1, 0, {}),
      stateWith(1, 0, { onTime: 1 }),
    ];
    for (const state of cases) {
      const view = noteView(state, 0);
      seen.add(view.kind);
      expect(view.text.startsWith(view.name)).toBe(true);
      expect(view.name + view.rest).toBe(view.text);
      expect(view.rest.startsWith('　')).toBe(true);
      expect(view.text).not.toMatch(/undefined|NaN|\{|\}/);
    }
    expect([...seen].sort()).toEqual(['dropByCancel', 'dropByOnTime', 'firstDay', 'maxStars', 'noData', 'toNextStar', 'toTwoStars', 'tooFew']);
  });

  it('只读：算纸条不改状态', () => {
    const state = stateWith(3, 1, share({ onTime: 25, late: 75 }), 1);
    const json = JSON.stringify(state);
    noteView(state, 0);
    expect(JSON.stringify(state)).toBe(json);
  });
});

describe('纸条的视图', () => {
  it('带星级、是不是可能掉星', () => {
    const risky = noteView(stateWith(3, 1, share({ late: 100 }), 1), 0);
    expect(risky).toMatchObject({ district: 0, name: '老街', star: 3, kind: 'dropByOnTime', atRisk: true });
    expect(noteView(stateWith(2, 1, share({ onTime: 100 })), 0).atRisk).toBe(false);
  });

  it('别的片区开通之后，也能看它的纸条', () => {
    const state = stateWith(2, 1, share({ onTime: 100 }));
    campaignOf(state).districts[1]!.open = true;
    campaignOf(state).districts[1]!.star = 3;
    const view = noteView(state, 1);
    expect(view).toMatchObject({ name: '写字楼区', star: 3 });
    expect(view.text.startsWith('写字楼区　')).toBe(true);
    expect(view.kind).toBe('noData'); // 老街的订单不算写字楼区的
  });
});

describe('几个片区之间换着看', () => {
  it('已开通的片区按编号：开局只有老街', () => {
    expect(openDistricts(campaignState())).toEqual([0]);
  });

  it('想看的片区没开通时，看编号最小的已开通的片区', () => {
    const state = campaignState();
    expect(noteDistrictFor(state, 1)).toBe(0);
    expect(noteDistrictFor(state, 0)).toBe(0);
  });

  it('点片区名：在已开通的片区里轮换，到头回到第一个；只有一个时不变', () => {
    const state = campaignState();
    expect(nextNoteDistrict(state, 0)).toBe(0);
    campaignOf(state).districts[1]!.open = true;
    expect(nextNoteDistrict(state, 0)).toBe(1);
    expect(nextNoteDistrict(state, 1)).toBe(0);
    campaignOf(state).districts[2]!.open = true;
    expect(nextNoteDistrict(state, 1)).toBe(2);
    expect(nextNoteDistrict(state, 2)).toBe(0);
  });

  it('当前的片区不在已开通的片区里时，轮换从第一个开始', () => {
    const state = campaignState();
    campaignOf(state).districts[1]!.open = true;
    expect(nextNoteDistrict(state, 2)).toBe(0);
  });
});

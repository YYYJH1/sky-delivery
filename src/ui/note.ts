// 片区纸条：当前片区的星级、升星条件和当前值。
// 核心的 districtNote 给出数据，并用 kind 指明用哪一条，这里按 kind 去词表取句子，填上参数。
// 界面每秒最多算十次，每次只算当前显示的那一个片区，districtNote 不是每帧调用的。
// 纯函数，不碰 DOM 和状态。
import { STARS_V1 } from '../content/stars_v1.ts';
import { STR, districtName, fmt, starNumeral } from '../content/strings.zh.ts';
import type { DistrictIndex } from '../content/strings.zh.ts';
import { districtNote } from '../core/index.ts';
import type { DistrictNote, NoteKind, SimState } from '../core/index.ts';

/** 星的个数，片区纸条上画五颗。 */
export const STAR_COUNT = 5;

const STAR_ON = '★';
const STAR_OFF = '☆';

/** 五颗星的文字写法，star 颗实心，其余空心。 */
export function starsText(star: number): string {
  const on = Math.min(STAR_COUNT, Math.max(0, Math.floor(star)));
  return STAR_ON.repeat(on) + STAR_OFF.repeat(STAR_COUNT - on);
}

export interface NoteView {
  readonly district: number;
  readonly name: string;
  readonly star: number;
  readonly kind: NoteKind;
  /** 处在「可能掉星」的状态。 */
  readonly atRisk: boolean;
  /** 词表里的整句，从片区名写起。 */
  readonly text: string;
  /** 整句里片区名之后的部分，界面把片区名和星画在一起，再接这一部分。 */
  readonly rest: string;
}

function need<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`ui: the district note needs ${name}`);
  return value;
}

/** 写准时率和退单率的几条都要求订单够数，所以取到 null 不会发生，0 只是兜底。还没有订单时写的是 noData。 */
function shown(pct: number | null): number {
  return pct ?? 0;
}

/** 一个片区纸条的整句。二星的准时率线、订单的下限都取自内容表，不写在这里。 */
export function noteText(note: DistrictNote): string {
  const district = districtName(note.district as DistrictIndex);
  const onTime = shown(note.onTimePct);
  const cancelRate = shown(note.cancelPct);
  switch (note.kind) {
    case 'noData':
      return fmt(STR.hud.districtNote.noData, { district });
    case 'tooFew':
      return fmt(STR.hud.districtNote.tooFew, { district, min: STARS_V1.minSample });
    case 'firstDay':
      return fmt(STR.hud.districtNote.firstDay, { district, onTime, needOnTime: need(note.next, 'the two-star rule').onTimeMin });
    case 'toTwoStars':
      return fmt(STR.hud.districtNote.toTwoStars, { district, onTime, needOnTime: need(note.next, 'the two-star rule').onTimeMin });
    case 'toNextStar': {
      const next = need(note.next, 'the next star rule');
      return fmt(STR.hud.districtNote.toThreeStarsUp, {
        district,
        onTime,
        cancelRate,
        needOnTime: next.onTimeMin,
        needCancelRate: need(next.cancelBelow, 'the cancel rate limit'),
        star: starNumeral(note.star + 1),
      });
    }
    case 'maxStars':
      return fmt(STR.hud.districtNote.maxStars, { district, onTime, cancelRate });
    case 'dropByOnTime':
      return fmt(STR.hud.districtNote.dropByOnTime, { district, onTime, needOnTime: need(note.keep, 'the keep rule').onTimeMin });
    case 'dropByCancel':
      return fmt(STR.hud.districtNote.dropByCancel, {
        district,
        cancelRate,
        needCancelRate: need(need(note.keep, 'the keep rule').cancelBelow, 'the cancel rate limit'),
      });
  }
}

/** 某个片区现在的片区纸条。 */
export function noteView(state: SimState, district: number): NoteView {
  const note = districtNote(state, district);
  const text = noteText(note);
  const name = districtName(district as DistrictIndex);
  return {
    district,
    name,
    star: note.star,
    kind: note.kind,
    atRisk: note.atRisk,
    text,
    rest: text.startsWith(name) ? text.slice(name.length) : text,
  };
}

/** 已经开通的片区，按编号。片区纸条上点片区名在它们之间轮换。 */
export function openDistricts(state: SimState): number[] {
  const out: number[] = [];
  state.campaign?.districts.forEach((d, k) => {
    if (d.open) out.push(k);
  });
  return out;
}

/** 纸条显示哪个片区：想看的那个已经开通就看它，否则看编号最小的已开通的片区。 */
export function noteDistrictFor(state: SimState, wanted: number): number {
  const open = openDistricts(state);
  return open.includes(wanted) ? wanted : (open[0] ?? 0);
}

/** 点片区名之后换到哪个片区：已开通的片区里的下一个，到头回到第一个。只有一个片区时不变。 */
export function nextNoteDistrict(state: SimState, current: number): number {
  const open = openDistricts(state);
  if (open.length === 0) return current;
  const at = open.indexOf(current);
  return open[(at + 1) % open.length] as number;
}

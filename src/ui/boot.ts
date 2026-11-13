// 打开页面时的读档：有存档就接着玩，没有就开新的经营模式。
// 读到备份和存档全坏了都要告诉玩家。坏档不删，存档模块已经把它隔离成带时间的副本。
// 读到存档之后结算离开期间的进账：离开的秒数是现在的墙上时间减存档的保存时间，
// 系统时间被调回过去时算成 0，不发放。
// 不碰 DOM 和系统时钟，时间和存储都由调用方传入。
import { awaySecondsSince } from '../app/index.ts';
import { createState, settleAway } from '../core/index.ts';
import type { AwayRecord, SimState } from '../core/index.ts';
import { decodeSaveCode, loadGame } from '../save/index.ts';
import type { KeyValueStore, LoadStatus, SlotOptions } from '../save/index.ts';

export type BootNotice =
  /** 主存档读不出来，换成了备份。savedAt 是备份的保存时间（墙上时间，毫秒）。 */
  | { readonly kind: 'restored'; readonly savedAt: number }
  /** 每一份存档都读不出来，开了新的一局。 */
  | { readonly kind: 'allBad' };

export interface BootResult {
  readonly state: SimState;
  /** 读到的存档所在的步。新开局为 null，表示还没有存过。 */
  readonly savedStep: number | null;
  readonly notice: BootNotice | null;
  /** 读档的结果，方便界面和测试看是怎么开的局。 */
  readonly status: LoadStatus;
  /** 读到的存档的内容版本与现在的不同。内容表按现在的版本生效，读档照常，界面不需要提示。新开局为 false。 */
  readonly contentChanged: boolean;
  /** 离开期间的进账，已经加进了 state 的余额。没有进账，或者是新开局时为 null。读档的状态变了，调用方要让会话记一次改变。 */
  readonly away: AwayRecord | null;
}

export interface BootOptions {
  /** 新开局的订单种子。 */
  readonly seed: number;
  /** 存档的键前缀等，原样传给存档模块。 */
  readonly save?: SlotOptions;
}

/** 新的一局经营模式。 */
export function newCampaign(seed: number): SimState {
  return createState({ mode: 'campaign', seed });
}

/** 一个随机的订单种子，随机数由调用方传入。 */
export function randomSeed(random: () => number): number {
  return Math.floor(random() * 2_147_483_647);
}

export async function boot(store: KeyValueStore, wallMs: number, options: BootOptions): Promise<BootResult> {
  const loaded = await loadGame(store, wallMs, options.save);
  const state = loaded.state;
  if ((loaded.status === 'ok' || loaded.status === 'restored') && state !== null && state.campaign !== null) {
    const savedAt = loaded.save?.savedAt ?? wallMs;
    const notice: BootNotice | null = loaded.status === 'restored' ? { kind: 'restored', savedAt } : null;
    // 读到的是备份时，离开的时间从备份的保存时间算起，比实际离开的时间长一点，上限照样管用
    const away = settleAway(state, awaySecondsSince(savedAt, wallMs));
    return { state, savedStep: state.step, notice, status: loaded.status, contentChanged: loaded.save?.contentChanged ?? false, away };
  }
  // 存档里是别的模式的状态，当作读不出来
  const bad = loaded.status === 'corrupt' || loaded.status === 'ok' || loaded.status === 'restored';
  return {
    state: newCampaign(options.seed),
    savedStep: null,
    notice: bad ? { kind: 'allBad' } : null,
    status: loaded.status,
    contentChanged: false,
    away: null,
  };
}

export type ImportResult =
  | { readonly ok: true; readonly state: SimState }
  /** code 是导出码读不出来（写法不对、被改过、复制不全），mode 是读出来了，但里面不是经营模式的状态。 */
  | { readonly ok: false; readonly reason: 'code' | 'mode' };

/**
 * 菜单里粘贴的导出码读成游戏状态。旧版本导出的码照样能读：先迁移再校验，和读存档用同一套。
 * 只读不写，调用方读得进来才去换掉现在的存档。
 */
export async function readImport(code: string): Promise<ImportResult> {
  const parsed = await decodeSaveCode(code);
  if (!parsed.ok) return { ok: false, reason: 'code' };
  if (parsed.state.campaign === null) return { ok: false, reason: 'mode' };
  return { ok: true, state: parsed.state };
}

/** 备份的保存时间，写成本地时间 2027-03-05 09:07。词表里「已换成 {时间} 的备份」的 {时间} 填这个。 */
export function formatSavedAt(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

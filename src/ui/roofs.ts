// 候选屋顶：选择建站时地图上标出来的屋顶，以及每块屋顶显示的数。
// 屋顶的位置、大小和价格系数在内容表 map_v1 里，价格由核心的 quoteCommand 给出，屋顶在地图上画多大由城市生成决定（src/render/city.ts）。
// 每块屋顶显示两行：大小、停机位上限、价格，以及飞到本片区的店和楼平均要几秒。
// 纯函数，不碰 DOM。
import { MAP_V1 } from '../content/map_v1.ts';
import type { RoofSize } from '../content/table_types.ts';
import { STR, fmt } from '../content/strings.zh.ts';
import { SPEED, bayCap, quoteCommand } from '../core/index.ts';
import type { CommandFailure, SimState } from '../core/index.ts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Placed extends Point {
  readonly district: number;
}

/** 从一个点飞到一组点的平均秒数：直线距离除以飞行速度，再取平均。没有目标点时为 null。 */
export function averageFlightSeconds(from: Point, targets: readonly Point[], speed: number = SPEED): number | null {
  if (targets.length === 0) return null;
  let total = 0;
  for (const t of targets) total += Math.hypot(t.x - from.x, t.y - from.y) / speed;
  return total / targets.length;
}

export interface RoofFlight {
  /** 飞到本片区已开张的店，平均几秒。片区里还没有开张的店时为 null。 */
  readonly shops: number | null;
  /** 飞到本片区全部的楼，平均几秒。 */
  readonly buildings: number | null;
}

/**
 * 在一块屋顶上建站，飞到本片区的店和楼平均要几秒。
 * 只算这个片区已开张的店和全部的楼：没开张的店还不会有订单，楼在片区开通时就都在用。
 * shopOpen 与 shops 一一对应。
 */
export function roofFlight(
  roof: Placed,
  shops: readonly Placed[],
  shopOpen: readonly boolean[],
  buildings: readonly Placed[],
  speed: number = SPEED,
): RoofFlight {
  const nearShops = shops.filter((s, i) => s.district === roof.district && shopOpen[i] === true);
  const nearBuildings = buildings.filter((b) => b.district === roof.district);
  return { shops: averageFlightSeconds(roof, nearShops, speed), buildings: averageFlightSeconds(roof, nearBuildings, speed) };
}

/** 一块可以建站的候选屋顶。 */
export interface CandidateRoof {
  /** 屋顶在地图 v1 里的下标，建站命令用它。 */
  readonly roof: number;
  readonly district: number;
  readonly size: RoofSize;
  /** 这块屋顶最多放几个停机位。 */
  readonly bayLimit: number;
  readonly x: number;
  readonly y: number;
  /** 在这块屋顶上建站的价格，取自核心。 */
  readonly price: number;
  /** 现在能建：余额够，站数没到上限。 */
  readonly ok: boolean;
  readonly reason: CommandFailure | null;
  readonly flight: RoofFlight;
}

/** 可以建站的候选屋顶：所在片区已开通，屋顶上还没有站。按地图 v1 里的顺序。 */
export function candidateRoofs(state: SimState): CandidateRoof[] {
  const campaign = state.campaign;
  if (campaign === null) return [];
  const { merchants, buildings } = state.world;
  const out: CandidateRoof[] = [];
  MAP_V1.roofs.forEach((roof, index) => {
    const district = campaign.districts[roof.district];
    if (district === undefined || !district.open) return;
    if (campaign.roofStation[index] !== -1) return;
    const quote = quoteCommand(state, { type: 'buildStation', roof: index });
    out.push({
      roof: index,
      district: roof.district,
      size: roof.size,
      bayLimit: bayCap(roof.size),
      x: roof.x,
      y: roof.y,
      price: quote.price,
      ok: quote.ok,
      reason: quote.reason,
      flight: roofFlight(roof, merchants, campaign.shopOpen, buildings),
    });
  });
  return out;
}

/** 平均秒数写成一位小数。 */
export function secondsText(seconds: number): string {
  return seconds.toFixed(1);
}

/**
 * 一块候选屋顶旁边写的字，每行一条，文字取自词表：第一行是大小、停机位上限和价格，
 * 第二行是飞到本片区的店和楼平均几秒。片区里还没有开张的店时算不出平均秒数，只有第一行。
 */
export function roofLines(c: CandidateRoof): string[] {
  const lines = [fmt(STR.hud.roof.line, { size: STR.hud.roof.size[c.size], limit: c.bayLimit, price: c.price })];
  if (c.flight.shops !== null && c.flight.buildings !== null) {
    lines.push(fmt(STR.hud.roof.distance, { shops: secondsText(c.flight.shops), buildings: secondsText(c.flight.buildings) }));
  }
  return lines;
}

/**
 * 地图上候选屋顶旁边的文字块要摆的几行：和 roofLines 是同样的内容，写着飞行秒数的那一句拆成店和楼两行，
 * 文字块窄一些，盖住的地图少一些。文字取自词表。
 */
export function roofLabelLines(c: CandidateRoof): string[] {
  const lines = [fmt(STR.hud.roof.line, { size: STR.hud.roof.size[c.size], limit: c.bayLimit, price: c.price })];
  if (c.flight.shops !== null && c.flight.buildings !== null) {
    lines.push(fmt(STR.hud.roof.distanceShops, { seconds: secondsText(c.flight.shops) }), fmt(STR.hud.roof.distanceBuildings, { seconds: secondsText(c.flight.buildings) }));
  }
  return lines;
}

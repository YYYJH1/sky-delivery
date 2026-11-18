// 会动的东西和店、站点的画法：飞机、订单小票、票杆和雨棚、站点屋顶、停机位、风向袋、起降口的环、送餐目的地、送达和退单的记号。
// 每个函数画在局部坐标的原点附近，调用者负责平移和旋转。
// 物件的纹理在启动时画一次（textures.ts），运行时只是精灵。
import { BASE_COLORS } from '../../content/palette.ts';
import { withAlpha } from '../look.ts';
import type { Theme } from '../look.ts';
import { GATE_BEAD, GATE_LINE, GATE_REST, gateOuter, gateRings, landingCircle } from '../layout.ts';
import type { GateArt } from '../layout.ts';
import { circle, fillWith, polyline, rect, roundRect, strokeLine, strokeWith } from './ctx.ts';
import type { Ctx } from './ctx.ts';

// ---- 飞机 ----
const ROTOR_C = 10;
const ROTOR_R = 6.4;
/** 机身六边形的顶点。 */
const BODY_POINTS: readonly (readonly [number, number])[] = [
  [0, -9.6],
  [4.9, -5.6],
  [4.9, 5.2],
  [2.9, 8.6],
  [-2.9, 8.6],
  [-4.9, 5.2],
  [-4.9, -5.6],
];

/** 货箱的半高：一张订单 8.4，双层货箱 12。 */
export function cargoHalf(cargo: number): number {
  return cargo === 1 ? 8.4 : 12;
}

/** 飞机的外轮廓，用于纸白衬边和影子。extra 是向外扩的宽度。 */
export function droneSilhouette(ctx: Ctx, color: string, extra: number, cargo: number): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.lineWidth = 3 + 2 * extra;
      ctx.beginPath();
      ctx.moveTo(sx * 2.5, sy * 2.5);
      ctx.lineTo(sx * ROTOR_C, sy * ROTOR_C);
      ctx.stroke();
      circle(ctx, sx * ROTOR_C, sy * ROTOR_C, ROTOR_R + extra);
      ctx.fill();
    }
  }
  polyline(ctx, BODY_POINTS, true);
  ctx.lineWidth = 2 * extra;
  ctx.fill();
  if (extra > 0) ctx.stroke();
  if (cargo > 0) {
    const hh = cargoHalf(cargo);
    roundRect(ctx, -8.8 - extra, -hh - extra + 0.6, 17.6 + 2 * extra, 2 * hh + 2 * extra, 1.4 + extra);
    ctx.fill();
  }
}

export interface DroneLook {
  readonly color: string;
  /** 0 空机，1 一个货箱，2 双层货箱。 */
  readonly cargo: number;
  /** 旋翼桨叶的相位，度。 */
  readonly spin: number;
  /** 外面一圈纸白衬边。停在停机位上的飞机没有衬边。 */
  readonly casing: boolean;
  /** 电量低：机背的圆顶变成蓝黑。 */
  readonly lowBattery: boolean;
}

/** 俯视的四旋翼，原点在机身中心，机头朝上。 */
export function drawDrone(ctx: Ctx, theme: Theme, look: DroneLook): void {
  const { pal } = theme;
  const ink = pal.ink;
  if (look.casing) {
    droneSilhouette(ctx, pal.paper, 1.9, look.cargo);
  }
  // 货箱在机臂和机身下面，比机身宽，两侧露出来
  if (look.cargo > 0) {
    const hh = cargoHalf(look.cargo);
    roundRect(ctx, -8.8, -hh + 0.6, 17.6, 2 * hh, 1.4);
    fillWith(ctx, BASE_COLORS.slip);
    strokeWith(ctx, theme.slipInk, 1.35);
    if (look.cargo === 1) {
      ctx.beginPath();
      ctx.moveTo(-8.8, 0.6);
      ctx.lineTo(8.8, 0.6);
      ctx.moveTo(0, -hh + 0.6);
      ctx.lineTo(0, hh + 0.6);
      strokeWith(ctx, theme.slipInk, 1, 0.7);
    } else {
      strokeLine(ctx, -8.8, 0.6, 8.8, 0.6, theme.slipInk, 1.35);
      ctx.beginPath();
      ctx.moveTo(-8.8, -5.4);
      ctx.lineTo(8.8, -5.4);
      ctx.moveTo(-8.8, 6.6);
      ctx.lineTo(8.8, 6.6);
      ctx.moveTo(0, -hh + 0.6);
      ctx.lineTo(0, hh + 0.6);
      strokeWith(ctx, theme.slipInk, 1, 0.65);
    }
  }
  // 机臂
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) strokeLine(ctx, sx * 2.5, sy * 2.5, sx * ROTOR_C, sy * ROTOR_C, ink, 2.7, 1, 'round');
  // 旋翼：纸白的盘，蓝黑细圈，两叶桨，桨毂。四个旋翼的桨叶角度不同
  let k = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const cx = sx * ROTOR_C;
      const cy = sy * ROTOR_C;
      const ang = ((look.spin + 38 + 47 * k) * Math.PI) / 180;
      k += 1;
      const bx = 5.2 * Math.cos(ang);
      const by = 5.2 * Math.sin(ang);
      circle(ctx, cx, cy, ROTOR_R);
      fillWith(ctx, pal.paper);
      strokeWith(ctx, ink, 1.15);
      strokeLine(ctx, cx - bx, cy - by, cx + bx, cy + by, ink, 1.7, 0.62, 'round');
      circle(ctx, cx, cy, 1.45);
      fillWith(ctx, ink);
    }
  }
  // 机身：站点颜色，填色相对线稿偏一点（套印）
  ctx.save();
  ctx.translate(0.55, 0.45);
  polyline(ctx, BODY_POINTS, true);
  fillWith(ctx, look.color);
  ctx.restore();
  polyline(ctx, BODY_POINTS, true);
  ctx.lineJoin = 'round';
  strokeWith(ctx, ink, 1.45);
  // 机头的折线和机背的圆顶
  ctx.beginPath();
  ctx.moveTo(-3, -3.6);
  ctx.lineTo(0, -6.4);
  ctx.lineTo(3, -3.6);
  ctx.lineJoin = 'round';
  strokeWith(ctx, pal.paper, 1.5, 1, 'round');
  circle(ctx, 0, 1.6, 1.9);
  fillWith(ctx, look.lowBattery ? ink : pal.paper);
  strokeWith(ctx, ink, 0.9);
  strokeLine(ctx, -2.6, 6.2, 2.6, 6.2, ink, 1.1, 0.7);
}

/** 影子：与飞机同轮廓的色块，原点在机身中心。偏移和不透明度由精灵决定。 */
export function drawDroneShadow(ctx: Ctx, theme: Theme, cargo: number): void {
  droneSilhouette(ctx, theme.shadowColor, 0, cargo);
}

// ---- 订单小票 ----
const TICKET_W = 15;
const TICKET_H = 18;

/** 小票的外形：上沿平，下沿锯齿。原点在夹子的位置（票的上沿中点）。 */
function ticketPath(ctx: Ctx): void {
  const w = TICKET_W;
  const h = TICKET_H;
  const n = 5;
  const pts: [number, number][] = [
    [-w / 2, 0],
    [w / 2, 0],
    [w / 2, h],
  ];
  for (let i = 1; i <= n; i++) {
    const xx = w / 2 - (i * w) / n;
    pts.push([xx + w / (2 * n), h + 3]);
    pts.push([xx, h]);
  }
  polyline(ctx, pts, true);
}

export type TicketState = 'ok' | 'urgent' | 'late';

/** 一张订单小票的外观。bar 是计时条的格数，0 到 10。 */
export interface TicketLook {
  /** 边框和夹子的颜色：正常时是离店最近那座站的颜色，快超时和已超时是急红。 */
  readonly edge: string;
  readonly state: TicketState;
  readonly bar: number;
}

/** 画一张小票，原点在夹子处。 */
export function drawTicket(ctx: Ctx, theme: Theme, look: TicketLook): void {
  const { pal } = theme;
  const red = look.state !== 'ok';
  const edge = red ? pal.red : look.edge;
  const barColor = red ? pal.red : theme.slipInk;
  // 错位的阴影
  ctx.save();
  ctx.translate(1.6, 2);
  ticketPath(ctx);
  fillWith(ctx, theme.slipInk, 0.14);
  ctx.restore();
  ticketPath(ctx);
  fillWith(ctx, BASE_COLORS.slip);
  ctx.lineJoin = 'round';
  strokeWith(ctx, edge, 1.2);
  strokeLine(ctx, -4.8, 4.2, 4.8, 4.2, theme.slipInk, 1.2, 0.38, 'round');
  strokeLine(ctx, -4.8, 7.6, 1.6, 7.6, theme.slipInk, 1.2, 0.38, 'round');
  rect(ctx, -5, 11.2, 10, 3);
  fillWith(ctx, theme.slipInk, 0.13);
  if (look.state === 'late') {
    rect(ctx, -5, 11.2, 10, 3);
    fillWith(ctx, pal.red);
    strokeLine(ctx, -5.4, 2, 5.4, 9.6, pal.red, 1.3, 0.9);
  } else if (look.bar > 0) {
    rect(ctx, -5, 11.2, look.bar, 3);
    fillWith(ctx, barColor);
  }
  roundRect(ctx, -3, -2.6, 6, 4.6, 0.8);
  fillWith(ctx, edge);
}

/** 小票的包围盒（原点在夹子处，含阴影）：用来定纹理的大小。 */
export const TICKET_BOX = { x: -9, y: -5, w: 20, h: 33 } as const;

// ---- 店的门面 ----
/** 沿街一侧的条纹雨棚：纸白和蓝黑相间。原点是雨棚的左上角，向 +y 伸出 depth。 */
export function drawAwning(ctx: Ctx, theme: Theme, x: number, y: number, w: number, depth = 7): void {
  const { pal } = theme;
  rect(ctx, x, y, w, depth);
  fillWith(ctx, pal.paper);
  const n = Math.max(4, Math.round(w / 6.5));
  const sw = w / n;
  for (let i = 0; i < n; i += 2) {
    rect(ctx, x + i * sw, y, sw, depth);
    fillWith(ctx, pal.ink, 0.55);
  }
  rect(ctx, x, y, w, depth);
  strokeWith(ctx, pal.ink, 0.9, 0.85);
}

/** 票杆：一根两端带立柱的横杆。 */
export function drawRail(ctx: Ctx, theme: Theme, x0: number, y: number, x1: number): void {
  const { pal } = theme;
  strokeLine(ctx, x0, y, x1, y, pal.ink, 2.2, 1, 'round');
  rect(ctx, x0 - 1.6, y - 4, 3.2, 6);
  fillWith(ctx, pal.ink);
  rect(ctx, x1 - 1.6, y - 4, 3.2, 6);
  fillWith(ctx, pal.ink);
}

// ---- 站点 ----
export interface StationArt {
  readonly w: number;
  readonly h: number;
  readonly number: string;
  readonly color: string;
  /** 站号的字体，要先加载好。 */
  readonly font: string;
  readonly shadow: number;
}

/** 站点屋顶：实心的站点颜色，内侧纸白虚线框，起降圈带编号，风向袋，右下方的排线阴影。原点在屋顶左上角。 */
export function drawStationRoof(ctx: Ctx, theme: Theme, art: StationArt): void {
  const { pal } = theme;
  const { w, h, color } = art;
  // 排线阴影：偏移的整块，被屋顶盖住的部分看不到
  ctx.beginPath();
  ctx.rect(art.shadow, art.shadow, w, h);
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = withAlpha(pal.ink, theme.hatchAlpha * 2.2);
  ctx.lineWidth = 1;
  const step = 4 * Math.SQRT2;
  ctx.beginPath();
  for (let k = Math.floor(0 / step); k <= Math.ceil((w + h + 2 * art.shadow) / step); k++) {
    const c = k * step;
    ctx.moveTo(-2, c + 2);
    ctx.lineTo(w + art.shadow + 2, c - (w + art.shadow + 2));
  }
  ctx.stroke();
  ctx.restore();
  // 填色相对线稿偏一点（套印）
  rect(ctx, 1.2, 0.9, w, h);
  fillWith(ctx, color);
  rect(ctx, 0, 0, w, h);
  strokeWith(ctx, pal.ink, 1.7);
  rect(ctx, 6, 6, w - 12, h - 12);
  ctx.setLineDash([7, 5]);
  strokeWith(ctx, pal.paper, 1.4, 0.9);
  ctx.setLineDash([]);
  // 起降圈和编号
  const { cx, cy, r } = landingCircle(w, h);
  circle(ctx, cx, cy, r);
  strokeWith(ctx, pal.paper, 2.6);
  ctx.beginPath();
  ctx.moveTo(cx - r - 5, cy);
  ctx.lineTo(cx - r + 4, cy);
  ctx.moveTo(cx + r - 4, cy);
  ctx.lineTo(cx + r + 5, cy);
  ctx.moveTo(cx, cy - r - 5);
  ctx.lineTo(cx, cy - r + 4);
  ctx.moveTo(cx, cy + r - 4);
  ctx.lineTo(cx, cy + r + 5);
  strokeWith(ctx, pal.paper, 1.6);
  ctx.fillStyle = pal.paper;
  ctx.font = `700 ${Math.round(r * 1.25)}px ${art.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(art.number, cx, cy + r * 0.42);
  drawWindsock(ctx, theme, 13, 13, -24);
}

/** 楼顶的风向袋：一根杆的圆点，加一个条纹锥。 */
export function drawWindsock(ctx: Ctx, theme: Theme, x: number, y: number, angleDeg: number): void {
  const { pal } = theme;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angleDeg * Math.PI) / 180);
  polyline(
    ctx,
    [
      [0, -2.6],
      [15, -1.1],
      [15, 1.1],
      [0, 2.6],
    ],
    true,
  );
  fillWith(ctx, pal.paper);
  strokeWith(ctx, pal.ink, 0.9);
  polyline(
    ctx,
    [
      [0, -2.6],
      [3.8, -2.2],
      [3.8, 2.2],
      [0, 2.6],
    ],
    true,
  );
  fillWith(ctx, pal.ink);
  polyline(
    ctx,
    [
      [7.6, -1.85],
      [11.4, -1.45],
      [11.4, 1.45],
      [7.6, 1.85],
    ],
    true,
  );
  fillWith(ctx, pal.ink);
  ctx.restore();
  circle(ctx, x, y, 1.9);
  fillWith(ctx, pal.ink);
}

/** 一个停机位：四个角标，原点在中心。 */
export function drawSlot(ctx: Ctx, theme: Theme, size: number): void {
  const s = size / 2;
  const t = size * 0.3;
  ctx.beginPath();
  ctx.moveTo(-s, -s + t);
  ctx.lineTo(-s, -s);
  ctx.lineTo(-s + t, -s);
  ctx.moveTo(s - t, -s);
  ctx.lineTo(s, -s);
  ctx.lineTo(s, -s + t);
  ctx.moveTo(s, s - t);
  ctx.lineTo(s, s);
  ctx.lineTo(s - t, s);
  ctx.moveTo(-s + t, s);
  ctx.lineTo(-s, s);
  ctx.lineTo(-s, s - t);
  ctx.lineJoin = 'round';
  strokeWith(ctx, theme.pal.paper, 1.5, 1, 'round');
}

// ---- 起降口的环 ----
/**
 * 起降口的环，圆心在屋顶上带站号的起降圈的圆心：一级只有起降圈本身，每升一级，在起降圈外面多一道纸白的环，和起降圈、停机位的角标同一种线。
 * 最外一道环上有一个小圆点，纸白填充，蓝黑描边，整个环转起来就看得出转动。小圆点停在偏右上 45° 的位置，避开起降圈的四个刻线。
 * 起降圈本身画在屋顶上，这里不画。原点在圆心。
 */
export function drawGate(ctx: Ctx, theme: Theme, art: GateArt): void {
  const { pal } = theme;
  for (const r of gateRings(art.pad, art.level, art.unit)) {
    circle(ctx, 0, 0, r);
    strokeWith(ctx, pal.paper, GATE_LINE * art.unit);
  }
  const r = gateOuter(art.pad, art.level, art.unit);
  circle(ctx, r * Math.sin(GATE_REST), -r * Math.cos(GATE_REST), GATE_BEAD * art.unit);
  fillWith(ctx, pal.paper);
  strokeWith(ctx, pal.ink, 0.9 * art.unit);
}

// ---- 送餐目的地、送达和退单的记号 ----
/** 屋顶上的接收垫：纸白方块，蓝黑描边，中间一个十字。active 时外面多一圈虚线。原点在中心。 */
export function drawDestination(ctx: Ctx, theme: Theme, active: boolean): void {
  const { pal } = theme;
  roundRect(ctx, -5.5, -5.5, 11, 11, 1.5);
  fillWith(ctx, pal.paper);
  strokeWith(ctx, pal.ink, 1.3);
  strokeLine(ctx, -2.6, 0, 2.6, 0, pal.ink, 1.3, 1, 'round');
  strokeLine(ctx, 0, -2.6, 0, 2.6, pal.ink, 1.3, 1, 'round');
  if (active) {
    ctx.setLineDash([2.5, 3.5]);
    circle(ctx, 0, 0, 10.5);
    strokeWith(ctx, pal.ink, 1.1, 0.75);
    ctx.setLineDash([]);
  }
}

/** 退单后留在店铺位置的小叉：蓝黑 42%。原点在中心。 */
export function drawCancelMark(ctx: Ctx, theme: Theme): void {
  strokeLine(ctx, -4.5, -4.5, 4.5, 4.5, theme.pal.ink, 1.8, 0.42, 'round');
  strokeLine(ctx, 4.5, -4.5, -4.5, 4.5, theme.pal.ink, 1.8, 0.42, 'round');
}

/** 准时送达留在楼上的记号：蓝黑的对勾，外面一圈细线。原点在中心。 */
export function drawOnTimeMark(ctx: Ctx, theme: Theme): void {
  const { pal } = theme;
  circle(ctx, 0, 0, 7);
  strokeWith(ctx, pal.ink, 1.2, 0.5);
  ctx.beginPath();
  ctx.moveTo(-3.6, 0.3);
  ctx.lineTo(-1, 2.9);
  ctx.lineTo(3.8, -2.9);
  ctx.lineJoin = 'round';
  strokeWith(ctx, pal.ink, 2, 1, 'round');
}

/** 超时送达留在楼上的记号：急红的圈，圈里一道横线。红色只用在快超时和已超时的订单上，超时送达的订单已经超时过。原点在中心。 */
export function drawLateMark(ctx: Ctx, theme: Theme): void {
  const { pal } = theme;
  circle(ctx, 0, 0, 7);
  strokeWith(ctx, pal.red, 1.5);
  strokeLine(ctx, -3.4, 0, 3.4, 0, pal.red, 2, 1, 'round');
}

// ---- 数据员 ----
/**
 * 站点屋顶上的数据员：一个站着的人，头在上，身体在下，脸朝屋顶下方（局部 +y），与屋顶一起转。
 * 头是纸白的圆，蓝黑描边，身体是蓝黑的一块，下面两条腿，身前捧着一块纸白的记事板，板上两道线。
 * 外面一圈纸白的衬边，和飞机一样，压在站点颜色的屋顶上也看得清。
 * 头在上、身体在下的轮廓缩到最小的镜头缩放下（十来个像素高）仍然认得出是个人，所以不画成俯视的肩膀和头顶。
 * 原点在人的中心，16 像素高、11 像素宽（layout.ts 的 CLERK_HEIGHT 和 CLERK_WIDTH）。
 */
export function drawClerk(ctx: Ctx, theme: Theme): void {
  const { pal } = theme;
  const ink = pal.ink;
  const paper = pal.paper;
  const head = (): void => circle(ctx, 0, -5.2, 2.7);
  const torso = (): void => roundRect(ctx, -4.4, -2, 8.8, 7.4, 2.2);
  const legs = (): void => {
    rect(ctx, -3.2, 5, 2.8, 3);
    rect(ctx, 0.4, 5, 2.8, 3);
  };
  // 衬边：每一部分都用纸白向外描一圈
  const casing = 1.3;
  ctx.lineJoin = 'round';
  for (const part of [head, torso, legs]) {
    part();
    fillWith(ctx, paper);
    strokeWith(ctx, paper, 2 * casing, 1, 'round');
  }
  // 人：身体和腿蓝黑，头纸白，蓝黑描边，身前一块纸白的记事板，板上两道线
  torso();
  fillWith(ctx, ink);
  legs();
  fillWith(ctx, ink);
  rect(ctx, -2.7, 0.1, 5.4, 4.4);
  fillWith(ctx, paper);
  strokeWith(ctx, ink, 0.8);
  strokeLine(ctx, -1.5, 1.6, 1.5, 1.6, ink, 0.7, 0.75);
  strokeLine(ctx, -1.5, 3, 1.5, 3, ink, 0.7, 0.75);
  head();
  fillWith(ctx, paper);
  strokeWith(ctx, ink, 1);
}

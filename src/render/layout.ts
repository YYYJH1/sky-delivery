// 站点屋顶里的排布：起降圈在哪，停机位怎么摆。纯算术，不碰画布，画屋顶的代码（draw/objects.ts）和摆精灵的代码（scene.ts）共用。
// 坐标是局部的，原点在屋顶左上角，单位是画板像素。

/** 起降圈的圆心和半径：左侧，随屋顶的大小。 */
export function landingCircle(w: number, h: number): { cx: number; cy: number; r: number } {
  const r = Math.min(h * 0.33, w * 0.2);
  return { cx: 16 + r, cy: h / 2, r };
}

/** 停机位排成两列，一行两个。行数按个数和上限里大的那个算：上限给了，就是按放满的样子排。 */
function bayRows(count: number, limit: number): number {
  return Math.max(1, Math.ceil(Math.max(count, limit) / 2));
}

/**
 * 停机位的位置：右侧两列，整组在屋顶里垂直居中。
 * limit 是这块屋顶最多放几个停机位。给了 limit，位置就按放满的样子排好：第 k 个停机位永远在同一个地方，
 * 买新的停机位只是用起下一个空位，已经停着的飞机不用挪。不给 limit 时按现有的个数排，个数比 limit 多时也按个数排。
 */
export function bayPositions(w: number, h: number, count: number, limit = count): { x: number; y: number }[] {
  const rows = bayRows(count, limit);
  const pitch = Math.min(21, (h - 16) / rows);
  const gx0 = w - 48;
  const gy0 = h / 2 - ((rows - 1) * pitch) / 2;
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < count; k++) out.push({ x: gx0 + (k % 2) * 21, y: gy0 + Math.floor(k / 2) * pitch });
  return out;
}

/** 停机位的边长：随行距缩小，最大 17。limit 的含义同 bayPositions，给了 limit，边长也只跟屋顶的上限有关，买停机位时不变。 */
export function slotSize(h: number, count: number, limit = count): number {
  const rows = bayRows(count, limit);
  return Math.min(17, ((h - 16) / rows) * 0.8);
}

/** 起降口最高几级，环最多画几道。与内容表里 gateSeconds 的个数一致，测试核对。 */
export const GATE_MAX_LEVEL = 3;
/**
 * 起降口的环：一级只有屋顶上那个带站号的起降圈，每升一级，在起降圈外面多一道环。
 * 第一道环离起降圈 GATE_FIRST，要越过起降圈四个刻线的端头（刻线伸出圈外 5）。相邻两道环隔 GATE_STEP。
 * 镜头缩小时环的间隔乘放大倍数 unit，缩到最小也看得出是几道，起降圈本身是烘焙在屋顶上的，不放大，所以第一道环的距离不乘。
 */
export const GATE_FIRST = 6;
export const GATE_STEP = 3.8;

/** 起降圈外面的环的半径，从里到外，pad 是起降圈的半径。一级没有，二级一道，三级两道。 */
export function gateRings(pad: number, level: number, unit = 1): number[] {
  const out: number[] = [];
  for (let k = 0; k < Math.max(1, Math.round(level)) - 1; k++) out.push(pad + GATE_FIRST + k * GATE_STEP * unit);
  return out;
}

/** 起降口最外一道环的半径：一级就是起降圈本身。转动的记号画在这一道上。每帧每座站算一次，所以不建数组。 */
export function gateOuter(pad: number, level: number, unit = 1): number {
  const n = Math.max(1, Math.round(level));
  return n === 1 ? pad : pad + GATE_FIRST + (n - 2) * GATE_STEP * unit;
}

/** 环的线宽，转动记号（小圆点）的半径，转动记号停着时在圈上的位置（弧度，0 朝上，顺时针为正），纹理四周多留的边。 */
export const GATE_LINE = 1.5;
export const GATE_BEAD = 2.2;
export const GATE_REST = Math.PI / 4;
export const GATE_MARGIN = 3;

/** 起降口的环要画成什么样：起降口的等级，屋顶上起降圈的半径，镜头缩小时的放大倍数。 */
export interface GateArt {
  readonly level: number;
  readonly pad: number;
  readonly unit: number;
}

/** 起降口的环的纹理，半边长要多大：从圆心到最外面的小圆点的边缘，再留一圈边。 */
export function gateExtent(art: GateArt): number {
  return Math.ceil(gateOuter(art.pad, art.level, art.unit) + GATE_BEAD * art.unit + GATE_MARGIN);
}

// ---- 数据员 ----
/**
 * 数据员的人物在屋顶上占多大：原大下 16 像素高，和一个停机位（最大 17）差不多。
 * 镜头缩小时人物按地图上记号的放大倍数（camera.ts 的 mark）放大，缩到最小也认得出是个人，所以位置要按放大之后的大小算。
 */
export const CLERK_HEIGHT = 16;
/** 人物原大下的宽度，身体的两侧。 */
export const CLERK_WIDTH = 11;
/** 人物离屋顶左边和下沿留多少：屋顶里侧的虚线框在 6，站在它里面。 */
export const CLERK_MARGIN = 7;
/** 人物的上沿最高到起降圈圆心下面这么多个半径的地方，不爬到圈的上半边去。 */
export const CLERK_ABOVE = 0.35;
/** 起降圈里的站号，一个数字约半个字宽加一点，半宽是圈的半径的这么多倍。人物的右边离它至少 1 像素。 */
export const NUMBER_HALF = 0.375;

/**
 * 人物的放大倍数：跟着镜头的记号倍数 unit 走，但不能压住起降圈里的站号，也不爬到圈的上半边，所以有上限，小屋顶的上限更小。至少是 1。
 */
export function clerkScale(w: number, h: number, unit: number): number {
  const circle = landingCircle(w, h);
  const vertical = (h - CLERK_MARGIN - (circle.cy + circle.r * CLERK_ABOVE)) / CLERK_HEIGHT;
  const horizontal = (circle.cx - circle.r * NUMBER_HALF - 1 - CLERK_MARGIN) / CLERK_WIDTH;
  return Math.max(1, Math.min(unit, vertical, horizontal));
}

/**
 * 数据员站在屋顶的左下角，起降圈的左下方：左边和下沿都离屋顶边缘 CLERK_MARGIN，在内侧虚线框之内，所以位置只看屋顶的高 h。
 * scale 是人物的放大倍数（clerkScale）。返回人物中心的位置，局部坐标，原点在屋顶左上角。
 * 人物放大时向右和向上长，起降圈的圆弧从它身后过去，人物画在上面。
 */
export function clerkSpot(h: number, scale = 1): { x: number; y: number } {
  return { x: CLERK_MARGIN + (CLERK_WIDTH * scale) / 2, y: h - CLERK_MARGIN - (CLERK_HEIGHT * scale) / 2 };
}

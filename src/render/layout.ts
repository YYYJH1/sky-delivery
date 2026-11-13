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

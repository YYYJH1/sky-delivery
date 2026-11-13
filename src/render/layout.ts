// 站点屋顶里的排布：起降圈在哪，停机位怎么摆。纯算术，不碰画布，画屋顶的代码（draw/objects.ts）和摆精灵的代码（scene.ts）共用。
// 坐标是局部的，原点在屋顶左上角，单位是画板像素。

/** 起降圈的圆心和半径：左侧，随屋顶的大小。 */
export function landingCircle(w: number, h: number): { cx: number; cy: number; r: number } {
  const r = Math.min(h * 0.33, w * 0.2);
  return { cx: 16 + r, cy: h / 2, r };
}

/** 停机位的位置：右侧两列，行数随停机位数，整组在屋顶里垂直居中。 */
export function bayPositions(w: number, h: number, count: number): { x: number; y: number }[] {
  const rows = Math.max(1, Math.ceil(count / 2));
  const pitch = Math.min(21, (h - 16) / rows);
  const gx0 = w - 48;
  const gy0 = h / 2 - ((rows - 1) * pitch) / 2;
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < count; k++) out.push({ x: gx0 + (k % 2) * 21, y: gy0 + Math.floor(k / 2) * pitch });
  return out;
}

/** 停机位的边长：随行距缩小，最大 17。 */
export function slotSize(h: number, count: number): number {
  const rows = Math.max(1, Math.ceil(count / 2));
  return Math.min(17, ((h - 16) / rows) * 0.8);
}

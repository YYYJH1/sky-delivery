// 地图上的排版：候选屋顶的文字放在哪里不压住别的东西，站点小卡摆在站的哪一边。
// 纯函数，只算矩形和位置，不碰 DOM。文字的宽度由页面量好之后传进来。

/** 左上角加宽高的矩形，屏幕坐标。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 两个矩形重叠的面积，不重叠为 0。 */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function pointInRect(rect: Rect, x: number, y: number, pad = 0): boolean {
  return x >= rect.x - pad && x <= rect.x + rect.w + pad && y >= rect.y - pad && y <= rect.y + rect.h + pad;
}

// ---- 文字的位置 ----

export interface LabelRequest {
  readonly id: number;
  /** 文字属于哪个东西，文字放在它旁边，不压住它。 */
  readonly anchor: Rect;
  /** 文字块的大小。 */
  readonly w: number;
  readonly h: number;
}

export interface PlacedLabel extends Rect {
  readonly id: number;
  /** 没有压住别的文字和东西。 */
  readonly clear: boolean;
}

function clampInto(rect: Rect, bounds: Rect): Rect {
  const x = Math.min(Math.max(rect.x, bounds.x), Math.max(bounds.x, bounds.x + bounds.w - rect.w));
  const y = Math.min(Math.max(rect.y, bounds.y), Math.max(bounds.y, bounds.y + bounds.h - rect.h));
  return { x, y, w: rect.w, h: rect.h };
}

/**
 * 给每块文字挑一个位置：先试东西的下方，再试上方、右边、左边，取第一个不压住已经放好的文字和 obstacles 的。
 * 都有重叠时取重叠最少的。位置都夹在 bounds 里面。按 requests 的顺序放，先放的占好位置。
 */
export function placeLabels(requests: readonly LabelRequest[], obstacles: readonly Rect[], bounds: Rect, gap = 6): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  for (const req of requests) {
    const a = req.anchor;
    const cx = a.x + a.w / 2;
    const cy = a.y + a.h / 2;
    const candidates: Rect[] = [
      { x: cx - req.w / 2, y: a.y + a.h + gap, w: req.w, h: req.h },
      { x: cx - req.w / 2, y: a.y - req.h - gap, w: req.w, h: req.h },
      { x: a.x + a.w + gap, y: cy - req.h / 2, w: req.w, h: req.h },
      { x: a.x - req.w - gap, y: cy - req.h / 2, w: req.w, h: req.h },
    ].map((c) => clampInto(c, bounds));
    let best: Rect = candidates[0] as Rect;
    let bestOverlap = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      let overlap = 0;
      for (const p of placed) overlap += overlapArea(c, p);
      for (const o of obstacles) overlap += overlapArea(c, o);
      if (overlap < bestOverlap) {
        best = c;
        bestOverlap = overlap;
      }
      if (overlap === 0) break;
    }
    placed.push({ ...best, id: req.id, clear: bestOverlap === 0 });
  }
  return placed;
}

// ---- 站点小卡的位置 ----

/** 小卡的大小和离站点的距离，按 1920×1080 的尺寸写，窗口缩放时一起缩放。 */
export const CARD_WIDTH = 270;
export const CARD_HEIGHT = 250;
export const CARD_GAP = 16;

/**
 * 小卡摆在选中的站旁边：站的右边放得下就摆右边，放不下摆左边（flip 为 true，小卡的右边贴着站）。
 * 竖直方向和站的顶边对齐，放不下时往上提，不超出窗口。at 是站在窗口里的矩形，中心加宽高。
 */
export function cardPlacement(
  at: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  windowWidth: number,
  windowHeight: number,
  scale: number,
): { left: number; top: number; flip: boolean } {
  const right = at.x + at.w / 2 + CARD_GAP * scale;
  const flip = right + CARD_WIDTH * scale > windowWidth - 8;
  const left = flip ? at.x - at.w / 2 - CARD_GAP * scale : right;
  const top = Math.min(Math.max(8, at.y - at.h / 2), Math.max(8, windowHeight - CARD_HEIGHT * scale - 8));
  return { left, top, flip };
}

// ---- 文字的宽度 ----

/**
 * 一行字在窗口里大约多宽。汉字、全角标点和全角空格是一个字号宽，数字约 0.58，空格和小数点更窄，别的字符约 0.6。
 * 只用来给文字挑位置、判断会不会压住别的东西，不要求和浏览器排出来的宽度一模一样。
 */
export function estimateWidth(text: string, px: number): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80) em += 1;
    else if (ch >= '0' && ch <= '9') em += 0.58;
    else if (ch === ' ' || ch === '.') em += 0.3;
    else em += 0.6;
  }
  return em * px;
}

// ---- 候选屋顶的文字 ----

/** 候选屋顶旁边的文字块：内边距、行高。 */
export const ROOF_LABEL_PAD_X = 7;
export const ROOF_LABEL_PAD_Y = 5;
export const ROOF_LABEL_LINE_HEIGHT = 1.4;

/** 文字块的字号，窗口像素：跟着窗口缩放，夹在 11 到 15 之间。 */
export function roofLabelFontPx(windowScale: number): number {
  return Math.max(11, Math.min(15, 15 * windowScale));
}

export interface RoofLabelInput {
  readonly roof: number;
  /** 候选屋顶在窗口里的外接框。 */
  readonly box: Rect;
  readonly lines: readonly string[];
  /** 现在买得起，买不起的文字画淡。 */
  readonly ok: boolean;
}

export interface PlacedRoofLabel extends Rect {
  readonly roof: number;
  readonly lines: readonly string[];
  readonly ok: boolean;
  /** 字号，窗口像素。 */
  readonly px: number;
}

/**
 * 给每块候选屋顶的文字挑位置：放在屋顶的下方、上方、右边或左边，不压住别的屋顶、别的文字和站，不钻出 bounds。
 * obstacles 是站在窗口里的外接框。位置的挑法见 placeLabels。
 */
export function layoutRoofLabels(inputs: readonly RoofLabelInput[], obstacles: readonly Rect[], bounds: Rect, px: number): PlacedRoofLabel[] {
  const requests: LabelRequest[] = inputs.map((r) => {
    const widest = Math.max(...r.lines.map((line) => estimateWidth(line, px)));
    return { id: r.roof, anchor: r.box, w: widest + 2 * ROOF_LABEL_PAD_X, h: r.lines.length * px * ROOF_LABEL_LINE_HEIGHT + 2 * ROOF_LABEL_PAD_Y };
  });
  const placed = placeLabels(requests, [...inputs.map((r) => r.box), ...obstacles], bounds);
  const out: PlacedRoofLabel[] = [];
  for (const p of placed) {
    const input = inputs.find((r) => r.roof === p.id);
    if (input === undefined) continue;
    out.push({ x: p.x, y: p.y, w: p.w, h: p.h, roof: p.id, lines: input.lines, ok: input.ok, px });
  }
  return out;
}

// ---- 悬停提示的位置 ----

/** 悬停提示离鼠标的距离。 */
export const TOOLTIP_OFFSET = { x: 14, y: 18 };

/**
 * 悬停提示摆在鼠标的右下方。靠近窗口右边放不下就翻到鼠标左边，靠近下边就翻到上边，再不行贴着窗口边。
 * w 和 h 是提示的大小，窗口像素。返回提示左上角的位置。
 */
export function tooltipPlacement(point: { readonly x: number; readonly y: number }, windowWidth: number, windowHeight: number, w: number, h: number): { left: number; top: number } {
  let left = point.x + TOOLTIP_OFFSET.x;
  if (left + w > windowWidth - 4) left = point.x - TOOLTIP_OFFSET.x - w;
  let top = point.y + TOOLTIP_OFFSET.y;
  if (top + h > windowHeight - 4) top = point.y - TOOLTIP_OFFSET.y - h;
  return { left: Math.max(4, left), top: Math.max(4, top) };
}

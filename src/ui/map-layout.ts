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

/** 离开东西一段距离摆文字的八个方向：下，上，右，左，再是四个斜角。 */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/** 文字离 a 有 distance 远的八个位置。 */
function ringCandidates(a: Rect, w: number, h: number, distance: number): Rect[] {
  return DIRECTIONS.map(([dx, dy]) => ({
    x: dx > 0 ? a.x + a.w + distance : dx < 0 ? a.x - distance - w : a.x + a.w / 2 - w / 2,
    y: dy > 0 ? a.y + a.h + distance : dy < 0 ? a.y - distance - h : a.y + a.h / 2 - h / 2,
    w,
    h,
  }));
}

/** 压住 obstacles（屋顶、站、调度台）或者别的文字的代价，远大于压住 soft（地图上的字）的代价。 */
const HARD_COST = 1e6;

/** 每离开东西一档，代价相当于多压住字块面积的这一比例：能紧贴就不拉远，躲开几个字不值得拉出一条长线。 */
const RING_COST = 0.08;

/**
 * 给每块文字挑一个位置：先试东西的下方，再试上方、右边、左边，取第一个不压住已经放好的文字、obstacles 和 soft 的。
 * 四个都压着东西时，如果给了 rings（离东西的距离，由近到远），就逐档试离开东西一段的八个方向，取第一个不压住的，
 * 离开东西的文字由调用者用细线连回去。还是没有就取代价最小的：压住 obstacles 和别的文字的代价最大，其次是压住 soft，
 * 离开东西越远代价越大。soft 是地图上的店名和片区名这类字，压住了不好看，但不像压住屋顶那样挡住要点的东西。
 * 位置都夹在 bounds 里面。按 requests 的顺序放，先放的占好位置。
 */
export function placeLabels(requests: readonly LabelRequest[], obstacles: readonly Rect[], bounds: Rect, gap = 6, rings: readonly number[] = [], soft: readonly Rect[] = []): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  for (const req of requests) {
    const a = req.anchor;
    const cx = a.x + a.w / 2;
    const cy = a.y + a.h / 2;
    const adjacent: Rect[] = [
      { x: cx - req.w / 2, y: a.y + a.h + gap, w: req.w, h: req.h },
      { x: cx - req.w / 2, y: a.y - req.h - gap, w: req.w, h: req.h },
      { x: a.x + a.w + gap, y: cy - req.h / 2, w: req.w, h: req.h },
      { x: a.x - req.w - gap, y: cy - req.h / 2, w: req.w, h: req.h },
    ];
    // 先试紧贴的四个，再逐档试离开一段的
    const candidates = [adjacent, ...rings.map((d) => ringCandidates(a, req.w, req.h, d))].map((group) => group.map((c) => clampInto(c, bounds)));
    let best: Rect = (candidates[0] as Rect[])[0] as Rect;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestClear = false;
    search: for (const [level, group] of candidates.entries()) {
      for (const c of group) {
        let hard = 0;
        for (const p of placed) hard += overlapArea(c, p);
        for (const o of obstacles) hard += overlapArea(c, o);
        let light = 0;
        for (const s of soft) light += overlapArea(c, s);
        const score = HARD_COST * hard + light + RING_COST * req.w * req.h * level;
        if (score < bestScore) {
          best = c;
          bestScore = score;
          bestClear = hard === 0 && light === 0;
        }
        // 一个位置什么也不压，更远的档只会代价更大
        if (hard === 0 && light === 0) break search;
      }
    }
    placed.push({ ...best, id: req.id, clear: bestClear });
  }
  return placed;
}

/** 两块矩形之间最近的距离，相交或贴边为 0。 */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.hypot(dx, dy);
}

// ---- 站点小卡的位置 ----

/**
 * 小卡的大小和离站点的距离，按 1920×1080 的尺寸写，窗口缩放时一起缩放。
 * CARD_HEIGHT 是一座站有最近一场高峰的记录、没有退回按钮时的高度，小卡还没量过大小时按它摆。
 * 小卡里的块有的有、有的没有，实际的高度每次不同，摆放时用量出来的高度（见 cardPlacement 的 height）。
 */
export const CARD_WIDTH = 270;
export const CARD_HEIGHT = 540;
export const CARD_GAP = 16;
/** 窗口下沿留给价签和片区纸条的高度，按 1920×1080 的尺寸。小卡变高之后往上提时，下沿停在这条线上，不压住它们。 */
export const CARD_BOTTOM_RESERVE = 108;

/**
 * 小卡摆在选中的站旁边：站的右边放得下就摆右边，放不下摆左边（flip 为 true，小卡的右边贴着站）。
 * 竖直方向和站的顶边对齐，放不下时往上提，下沿停在 CARD_BOTTOM_RESERVE 以上，窗口太矮时贴着上沿，不超出窗口。
 * at 是站在窗口里的矩形，中心加宽高。height 是小卡现在的高度（按 1920×1080 的尺寸），不给时用 CARD_HEIGHT。
 */
export function cardPlacement(
  at: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  windowWidth: number,
  windowHeight: number,
  scale: number,
  height: number = CARD_HEIGHT,
): { left: number; top: number; flip: boolean } {
  const right = at.x + at.w / 2 + CARD_GAP * scale;
  const flip = right + CARD_WIDTH * scale > windowWidth - 8;
  const left = flip ? at.x - at.w / 2 - CARD_GAP * scale : right;
  const top = Math.min(Math.max(8, at.y - at.h / 2), Math.max(8, windowHeight - (CARD_BOTTOM_RESERVE + height) * scale));
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

/** 文字离屋顶远时，从屋顶连到文字的一条细线：(x1, y1) 在屋顶的边上，(x2, y2) 在文字的边上，窗口坐标。 */
export interface Leader {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PlacedRoofLabel extends Rect {
  readonly roof: number;
  readonly lines: readonly string[];
  readonly ok: boolean;
  /** 字号，窗口像素。 */
  readonly px: number;
  /** 文字紧贴着屋顶时为 null，离开屋顶一段时是连回屋顶的细线。 */
  readonly leader: Leader | null;
}

/** 文字离屋顶不超过这么多窗口像素就算紧贴，不画线。紧贴时的间隔是 6。 */
export const LEADER_MIN_GAP = 14;

/** 文字离开屋顶摆放的几档距离，按字号的倍数，由近到远。 */
export const ROOF_LABEL_RINGS: readonly number[] = [2, 4, 7, 11];

function clampTo(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * 文字离屋顶远时，连回屋顶的细线：起点是屋顶框上离文字中心最近的点，终点是文字框上离起点最近的点。
 * 文字紧贴着屋顶（间隔不超过 LEADER_MIN_GAP）时不需要线，返回 null。
 */
export function leaderBetween(roof: Rect, label: Rect): Leader | null {
  if (rectGap(roof, label) <= LEADER_MIN_GAP) return null;
  const x1 = clampTo(label.x + label.w / 2, roof.x, roof.x + roof.w);
  const y1 = clampTo(label.y + label.h / 2, roof.y, roof.y + roof.h);
  return { x1, y1, x2: clampTo(x1, label.x, label.x + label.w), y2: clampTo(y1, label.y, label.y + label.h) };
}

/**
 * 给每块候选屋顶的文字挑位置：先放在屋顶的下方、上方、右边或左边，不压住别的屋顶、别的文字和站，不钻出 bounds。
 * 紧贴的四个位置都放不下时（屋顶挨得近，或者三个片区的屋顶都在选），离开屋顶一段再放，用一条细线连回屋顶（leader）。
 * obstacles 是站和调度台在窗口里的外接框，不能压。texts 是地图上的店名和片区名，尽量不压。位置的挑法见 placeLabels。
 */
export function layoutRoofLabels(inputs: readonly RoofLabelInput[], obstacles: readonly Rect[], bounds: Rect, px: number, texts: readonly Rect[] = []): PlacedRoofLabel[] {
  const requests: LabelRequest[] = inputs.map((r) => {
    const widest = Math.max(...r.lines.map((line) => estimateWidth(line, px)));
    return { id: r.roof, anchor: r.box, w: widest + 2 * ROOF_LABEL_PAD_X, h: r.lines.length * px * ROOF_LABEL_LINE_HEIGHT + 2 * ROOF_LABEL_PAD_Y };
  });
  const placed = placeLabels(requests, [...inputs.map((r) => r.box), ...obstacles], bounds, 6, ROOF_LABEL_RINGS.map((k) => k * px), texts);
  const out: PlacedRoofLabel[] = [];
  for (const p of placed) {
    const input = inputs.find((r) => r.roof === p.id);
    if (input === undefined) continue;
    out.push({ x: p.x, y: p.y, w: p.w, h: p.h, roof: p.id, lines: input.lines, ok: input.ok, px, leader: leaderBetween(input.box, p) });
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

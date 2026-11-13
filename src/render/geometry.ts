// 画面层的几何：矩形，向量，世界坐标和画板坐标的换算。纯函数，不碰 DOM 和 Pixi。
//
// 地图是一张略微转了角度的印刷图：世界坐标（核心里的坐标）转一个固定的角度，放进「画板」。
// 画板是屏幕朝向的：静态层烘焙成画板上的纹理，排线在画板上永远是 45°，飞机和小票的位置先换成画板坐标再画。
// 平移和缩放只作用在画板整体上，不影响烘焙。

export interface Vec {
  x: number;
  y: number;
}

/** 左上角加宽高。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rectRight = (r: Rect): number => r.x + r.w;
export const rectBottom = (r: Rect): number => r.y + r.h;
export const rectCenter = (r: Rect): Vec => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function contains(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/** 盖住两块矩形的最小矩形。 */
export function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

/**
 * 把 rect 挪到 zone 外面：向左、右、上、下各试一次，只挪到刚好不压住 zone（留 gap），
 * 取压住 others 最少的一个，一样少时取挪得最近的。返回要挪的量。rect 和 zone 本来就不相交时不用挪，返回 (0, 0)。
 */
export function moveClear(rect: Rect, zone: Rect, others: readonly Rect[], gap = 2): Vec {
  if (overlapArea(rect, zone) <= 0) return { x: 0, y: 0 };
  const moves: Vec[] = [
    { x: zone.x - gap - (rect.x + rect.w), y: 0 },
    { x: zone.x + zone.w + gap - rect.x, y: 0 },
    { x: 0, y: zone.y - gap - (rect.y + rect.h) },
    { x: 0, y: zone.y + zone.h + gap - rect.y },
  ];
  let best = moves[0] as Vec;
  let bestOverlap = Infinity;
  let bestDist = Infinity;
  for (const m of moves) {
    const moved: Rect = { x: rect.x + m.x, y: rect.y + m.y, w: rect.w, h: rect.h };
    let overlap = 0;
    for (const o of others) overlap += overlapArea(moved, o);
    const dist = Math.abs(m.x) + Math.abs(m.y);
    if (overlap < bestOverlap - 1e-9 || (Math.abs(overlap - bestOverlap) <= 1e-9 && dist < bestDist)) {
      best = m;
      bestOverlap = overlap;
      bestDist = dist;
    }
  }
  return best;
}

export function fromCenter(cx: number, cy: number, w: number, h: number): Rect {
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}

/** 线段 (ax,ay)-(bx,by) 到点 (px,py) 的距离。 */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return dist(px, py, ax + dx * t, ay + dy * t);
}

/**
 * 线段被矩形裁剪（Liang-Barsky），返回矩形外面的部分，最多两段。
 * 航线从屋顶边上出发，不盖住站点屋顶上的起降圈和停机位，用它把线段在站点的屋顶里的那一段去掉。
 */
export function clipOutside(ax: number, ay: number, bx: number, by: number, r: Rect): [number, number, number, number][] {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, ax - r.x],
    [dx, r.x + r.w - ax],
    [-dy, ay - r.y],
    [dy, r.y + r.h - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return [[ax, ay, bx, by]];
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return [[ax, ay, bx, by]];
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return [[ax, ay, bx, by]];
        if (t < t1) t1 = t;
      }
    }
  }
  const out: [number, number, number, number][] = [];
  if (t0 > 1e-6) out.push([ax, ay, ax + dx * t0, ay + dy * t0]);
  if (t1 < 1 - 1e-6) out.push([ax + dx * t1, ay + dy * t1, bx, by]);
  return out;
}

/** 世界坐标和画板坐标的换算：绕世界里的一点 focus 转 angle 弧度，再平移到画板中心。 */
export interface Board {
  /** 画板的宽高，像素（逻辑像素，不是设备像素）。 */
  readonly width: number;
  readonly height: number;
  /** 世界坐标转得的角度，弧度。画板上的朝向 = 世界里的朝向 + angle。 */
  readonly angle: number;
  readonly focus: Vec;
  toBoard(x: number, y: number): Vec;
  toWorld(bx: number, by: number): Vec;
  /** 世界里 (x, y) 处的矩形，换到画板上的外接框。 */
  boundsOf(rect: Rect): Rect;
}

export function makeBoard(width: number, height: number, focus: Vec, angle: number): Board {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const toBoard = (x: number, y: number): Vec => {
    const dx = x - focus.x;
    const dy = y - focus.y;
    return { x: width / 2 + dx * c - dy * s, y: height / 2 + dx * s + dy * c };
  };
  const toWorld = (bx: number, by: number): Vec => {
    const dx = bx - width / 2;
    const dy = by - height / 2;
    return { x: focus.x + dx * c + dy * s, y: focus.y - dx * s + dy * c };
  };
  const boundsOf = (rect: Rect): Rect => {
    const pts = [toBoard(rect.x, rect.y), toBoard(rect.x + rect.w, rect.y), toBoard(rect.x, rect.y + rect.h), toBoard(rect.x + rect.w, rect.y + rect.h)];
    const x0 = Math.min(...pts.map((p) => p.x));
    const y0 = Math.min(...pts.map((p) => p.y));
    const x1 = Math.max(...pts.map((p) => p.x));
    const y1 = Math.max(...pts.map((p) => p.y));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  return { width, height, angle, focus, toBoard, toWorld, boundsOf };
}

/** 画板整块在世界里占的外接框，用来决定城市要生成多大一块。 */
export function worldBoundsOfBoard(board: Board, margin = 0): Rect {
  const pts = [board.toWorld(0, 0), board.toWorld(board.width, 0), board.toWorld(0, board.height), board.toWorld(board.width, board.height)];
  const x0 = Math.min(...pts.map((p) => p.x)) - margin;
  const y0 = Math.min(...pts.map((p) => p.y)) - margin;
  const x1 = Math.max(...pts.map((p) => p.x)) + margin;
  const y1 = Math.max(...pts.map((p) => p.y)) + margin;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 朝向：0 朝上，顺时针为正。从 (ax,ay) 指向 (bx,by)。 */
export function headingOf(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(bx - ax, -(by - ay));
}

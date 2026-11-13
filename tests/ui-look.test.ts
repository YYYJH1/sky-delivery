// 界面物件的外观里不碰浏览器的那几块：固定种子的随机数，手画的圈、线和星，便签贴在哪里（目标、位置、歪的角度）。
import { describe, expect, it } from 'vitest';
import { STR, fmt } from '../src/content/strings.zh.ts';
import { TIP_IDS } from '../src/core/index.ts';
import type { Camera } from '../src/render/camera.ts';
import { boardToScreen } from '../src/render/camera.ts';
import type { TicketPoint } from '../src/render/scene.ts';
import { handCircle, handLine, handStar, smoothPath, stretchCircle, stretchUnderline } from '../src/ui/hand.ts';
import { rectsOverlap } from '../src/ui/map-layout.ts';
import type { Rect } from '../src/ui/map-layout.ts';
import { createRand, mixSeed } from '../src/ui/seeded.ts';
import { TIP_MAX_WIDTH, TIP_MIN_WIDTH, orderSpot, placeTip, sameSpot, tipTarget, tipTilt, tipWidth } from '../src/ui/tip-anchor.ts';

describe('固定种子的随机数', () => {
  it('同一个种子得到同一个序列，不同的种子得到不同的序列', () => {
    const a = createRand(7);
    const b = createRand(7);
    const c = createRand(8);
    const seqA = Array.from({ length: 8 }, () => a());
    expect(Array.from({ length: 8 }, () => b())).toEqual(seqA);
    expect(Array.from({ length: 8 }, () => c())).not.toEqual(seqA);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('混种子：同一组数得到同一个种子，顺序和数值不同得到不同的种子', () => {
    expect(mixSeed(1, 2, 3)).toBe(mixSeed(1, 2, 3));
    expect(mixSeed(1, 2, 3)).not.toBe(mixSeed(3, 2, 1));
    expect(mixSeed(1, 2, 3)).not.toBe(mixSeed(1, 2, 4));
  });
});

describe('手画的线', () => {
  it('同一个种子画出同一条线，不同的种子不一样', () => {
    expect(handCircle(50, 20, 46, 16, 3)).toBe(handCircle(50, 20, 46, 16, 3));
    expect(handCircle(50, 20, 46, 16, 3)).not.toBe(handCircle(50, 20, 46, 16, 4));
    expect(handLine(0, 4, 100, 4, 3)).toBe(handLine(0, 4, 100, 4, 3));
    expect(handStar(10, 10, 9, 3)).toBe(handStar(10, 10, 9, 3));
  });

  it('路径是 SVG 的写法：从 M 开始，圈和线由三次贝塞尔连成，星是闭合的折线', () => {
    expect(handCircle(50, 20, 46, 16, 3)).toMatch(/^M[-\d.,]+( C[-\d.,]+ [-\d.,]+ [-\d.,]+)+$/);
    expect(handLine(0, 4, 100, 4, 3)).toMatch(/^M[-\d.,]+( C[-\d.,]+ [-\d.,]+ [-\d.,]+)+$/);
    expect(handStar(10, 10, 9, 3)).toMatch(/^M[-\d.,]+( L[-\d.,]+){9} Z$/);
    expect(smoothPath([])).toBe('');
  });

  it('拉伸用的圈和下划线画在固定的坐标里：圈在 100 乘 40 里，下划线在 100 乘 8 里', () => {
    const numbers = (path: string): number[] => (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const circle = numbers(stretchCircle(1));
    const line = numbers(stretchUnderline(1));
    // 圈略微向外放大，所以允许比 100 乘 40 多出几个像素，但不能偏出很远
    expect(Math.min(...circle)).toBeGreaterThan(-12);
    expect(Math.max(...circle)).toBeLessThan(112);
    expect(Math.max(...line)).toBeLessThan(101);
    expect(Math.min(...line)).toBeGreaterThan(-1);
  });
});

describe('便签对应的目标', () => {
  it('七条便签都有去处：订单类贴在小票旁边，其余贴在页面上的物件旁边', () => {
    expect(TIP_IDS).toHaveLength(7);
    for (const id of TIP_IDS) expect(tipTarget(id), id).not.toBeNull();
    expect(tipTarget('firstOrder')).toEqual({ kind: 'order', urgent: false });
    expect(tipTarget('autoDispatchOn')).toEqual({ kind: 'order', urgent: false });
    expect(tipTarget('firstRedOrder')).toEqual({ kind: 'order', urgent: true });
    expect(tipTarget('boardReady')).toEqual({ kind: 'part', part: 'board' });
    expect(tipTarget('canAddBay')).toEqual({ kind: 'part', part: 'tag-bay' });
    expect(tipTarget('gateBusy')).toEqual({ kind: 'part', part: 'tag-upgrades' });
    expect(tipTarget('openOffice')).toEqual({ kind: 'part', part: 'open-tag-1' });
  });

  it('不认识的编号没有目标', () => {
    expect(tipTarget('nope')).toBeNull();
  });

  it('每张便签歪的角度固定，都在三度以内，不是平的', () => {
    for (const id of TIP_IDS) {
      expect(tipTilt(id)).toBe(tipTilt(id));
      expect(Math.abs(tipTilt(id))).toBeGreaterThan(0.5);
      expect(Math.abs(tipTilt(id))).toBeLessThanOrEqual(3);
    }
  });
});

describe('便签的宽度', () => {
  const texts = [
    STR.tips.firstOrder,
    STR.tips.autoDispatchOn,
    STR.tips.firstRedOrder,
    STR.tips.boardReady,
    STR.tips.canAddBay,
    fmt(STR.tips.gateBusy, { station: '一' }),
    STR.tips.openOffice,
  ];

  it('每张便签的宽度都在最窄和最宽之间', () => {
    for (const text of texts) {
      expect(tipWidth(text), text).toBeGreaterThanOrEqual(TIP_MIN_WIDTH);
      expect(tipWidth(text), text).toBeLessThanOrEqual(TIP_MAX_WIDTH);
    }
  });

  it('短的便签一行写完，长的便签一行放得下最长的一段（到逗号或句号为止）', () => {
    const em = 22;
    for (const text of texts) {
      const chars = [...text].length;
      const longest = Math.max(...text.split(new RegExp(`(?<=[${String.fromCodePoint(0xff0c, 0x3002)}])`, 'u')).map((part) => [...part].length));
      const need = (chars <= 11 ? chars : longest) * em;
      expect(tipWidth(text) - 36, text).toBeGreaterThanOrEqual(Math.min(need, TIP_MAX_WIDTH - 36));
    }
  });

  it('越长的便签不会越窄', () => {
    expect(tipWidth(STR.tips.boardReady)).toBeLessThanOrEqual(tipWidth(STR.tips.openOffice));
    expect(tipWidth(STR.tips.openOffice)).toBeLessThanOrEqual(tipWidth(fmt(STR.tips.gateBusy, { station: '一' })));
  });
});

describe('订单便签贴在哪张小票旁边', () => {
  // 一个不转、不缩放的镜头：画板坐标就是窗口坐标。画板按 board 的转角换算，这里直接用 boardToScreen 换，不假设它是恒等变换
  const camera: Camera = { scale: 1, x: 0, y: 0 };
  const points: TicketPoint[] = [
    { order: 7, x: 600, y: 400 },
    { order: 3, x: 300, y: 300 },
    { order: 5, x: 900, y: 500 },
  ];
  const at = (p: TicketPoint): { x: number; y: number } => boardToScreen(camera, p.x, p.y);
  const centerOf = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

  it('没有小票：没有位置', () => {
    expect(orderSpot([], camera, false, () => false, [], [])).toBeNull();
  });

  it('贴最早的一张（订单编号最小）', () => {
    const spot = orderSpot(points, camera, false, () => false, [], []);
    expect(spot).not.toBeNull();
    const c = centerOf((spot as NonNullable<typeof spot>).anchor);
    const early = at(points[1] as TicketPoint);
    expect(c.x).toBeCloseTo(early.x, 6);
    expect(c.y).toBeCloseTo(early.y, 6);
  });

  it('订单变红的便签贴最早的一张变红的小票，没有变红的就贴最早的一张', () => {
    const red = orderSpot(points, camera, true, (order) => order === 5 || order === 7, [], []);
    const c = centerOf((red as NonNullable<typeof red>).anchor);
    const target = at(points[0] as TicketPoint); // 变红的里面编号最小的是 5，对应第三个点
    const expected = at(points[2] as TicketPoint);
    expect(Math.hypot(c.x - expected.x, c.y - expected.y)).toBeLessThan(1e-6);
    expect(Math.hypot(c.x - target.x, c.y - target.y)).toBeGreaterThan(10);
    const none = orderSpot(points, camera, true, () => false, [], []);
    const n = centerOf((none as NonNullable<typeof none>).anchor);
    const early = at(points[1] as TicketPoint);
    expect(Math.hypot(n.x - early.x, n.y - early.y)).toBeLessThan(1e-6);
  });

  it('别的小票和站不能压，店名只是尽量不压', () => {
    const station: Rect = { x: 100, y: 100, w: 50, h: 40 };
    const text: Rect = { x: 10, y: 10, w: 60, h: 20 };
    const spot = orderSpot(points, camera, false, () => false, [station], [text]);
    const got = spot as NonNullable<typeof spot>;
    expect(got.avoid).toHaveLength(3);
    expect(got.avoid).toContainEqual(station);
    expect(got.soft).toEqual([text]);
  });

  it('同样的位置判为相同，位置变了判为不同', () => {
    const a = orderSpot(points, camera, false, () => false, [], []);
    const b = orderSpot(points, camera, false, () => false, [], []);
    const c = orderSpot(points.slice(0, 1), camera, false, () => false, [], []);
    expect(sameSpot(a, b)).toBe(true);
    expect(sameSpot(a, c)).toBe(false);
    expect(sameSpot(null, null)).toBe(true);
    expect(sameSpot(a, null)).toBe(false);
  });
});

describe('便签挑位置', () => {
  const bounds: Rect = { x: 0, y: 100, w: 1920, h: 880 };
  const anchor: Rect = { x: 900, y: 500, w: 24, h: 24 };

  it('目标旁边空着：紧贴着目标，不压住它', () => {
    const p = placeTip(250, 100, anchor, [], [], bounds);
    const tip: Rect = { x: p.left, y: p.top, w: 250, h: 100 };
    expect(rectsOverlap(tip, anchor)).toBe(false);
    // 离目标不远：间隔是 10
    const gapX = Math.max(anchor.x - (tip.x + tip.w), tip.x - (anchor.x + anchor.w), 0);
    const gapY = Math.max(anchor.y - (tip.y + tip.h), tip.y - (anchor.y + anchor.h), 0);
    expect(Math.hypot(gapX, gapY)).toBeLessThanOrEqual(10.5);
  });

  it('下边被站挡着：换到上面、右边或左边，仍然不压住站和目标', () => {
    const station: Rect = { x: 780, y: 534, w: 280, h: 140 };
    const p = placeTip(250, 100, anchor, [station], [], bounds);
    const tip: Rect = { x: p.left, y: p.top, w: 250, h: 100 };
    expect(rectsOverlap(tip, station)).toBe(false);
    expect(rectsOverlap(tip, anchor)).toBe(false);
  });

  it('目标在窗口角落：位置夹在范围里面', () => {
    const corner: Rect = { x: 1890, y: 960, w: 24, h: 24 };
    const p = placeTip(250, 100, corner, [], [], bounds);
    expect(p.left).toBeGreaterThanOrEqual(bounds.x);
    expect(p.top).toBeGreaterThanOrEqual(bounds.y);
    expect(p.left + 250).toBeLessThanOrEqual(bounds.x + bounds.w + 1e-6);
    expect(p.top + 100).toBeLessThanOrEqual(bounds.y + bounds.h + 1e-6);
  });
});

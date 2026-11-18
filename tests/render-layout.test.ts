// 站点屋顶里的排布：起降圈在哪，停机位怎么摆。画屋顶的代码和摆精灵的代码共用这里，所以屋顶上画的圈和飞机停的位置对得上。
import { describe, expect, it } from 'vitest';
import { STATION_SIZES } from '../src/render/city.ts';
import { CLERK_ABOVE, CLERK_HEIGHT, CLERK_MARGIN, CLERK_WIDTH, NUMBER_HALF, bayPositions, clerkScale, clerkSpot, landingCircle, slotSize } from '../src/render/layout.ts';
import { slotWorldPositions } from '../src/render/scene.ts';

/** 地图里三种屋顶的大小，各配一个停机位数：开局的 2 个，中屋顶放满的 9 个，大屋顶放满的 12 个。 */
const CASES: [string, readonly [number, number], number][] = [
  ['小屋顶 2 个', STATION_SIZES.small, 2],
  ['小屋顶 6 个', STATION_SIZES.small, 6],
  ['中屋顶 2 个', STATION_SIZES.medium, 2],
  ['中屋顶 9 个', STATION_SIZES.medium, 9],
  ['大屋顶 12 个', STATION_SIZES.large, 12],
  ['大屋顶 1 个', STATION_SIZES.large, 1],
];

describe('起降圈', () => {
  it('在屋顶左边，垂直居中，整个圈在屋顶里面', () => {
    for (const [name, [w, h]] of CASES) {
      const c = landingCircle(w, h);
      expect(c.cy, name).toBeCloseTo(h / 2, 9);
      expect(c.cx - c.r, name).toBeGreaterThanOrEqual(0);
      expect(c.cx + c.r, name).toBeLessThan(w * 0.6);
      expect(c.cy - c.r, name).toBeGreaterThanOrEqual(0);
      expect(c.cy + c.r, name).toBeLessThanOrEqual(h);
    }
  });

  it('屋顶越大圈越大', () => {
    const small = landingCircle(...STATION_SIZES.small);
    const large = landingCircle(...STATION_SIZES.large);
    expect(small.r).toBeLessThan(large.r);
  });
});

describe('停机位', () => {
  it('在屋顶右边，两列，都在屋顶之内，互不重叠；中屋顶和大屋顶里在起降圈右边', () => {
    for (const [name, [w, h], count] of CASES) {
      const spots = bayPositions(w, h, count);
      const half = slotSize(h, count) / 2;
      const circle = landingCircle(w, h);
      expect(spots, name).toHaveLength(count);
      for (const p of spots) {
        // 小屋顶窄，起降圈和第一列停机位有一小段重叠，别的屋顶里停机位整个在圈的右边
        if (w >= STATION_SIZES.medium[0]) expect(p.x - half, name).toBeGreaterThan(circle.cx + circle.r - 1);
        expect(p.x, name).toBeGreaterThan(w / 2);
        expect(p.x + half, name).toBeLessThanOrEqual(w);
        expect(p.y - half, name).toBeGreaterThanOrEqual(0);
        expect(p.y + half, name).toBeLessThanOrEqual(h);
      }
      expect(new Set(spots.map((p) => Math.round(p.x))).size, name).toBeLessThanOrEqual(2);
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          const a = spots[i]!;
          const b = spots[j]!;
          const apart = Math.abs(a.x - b.x) >= 2 * half - 1e-6 || Math.abs(a.y - b.y) >= 2 * half - 1e-6;
          expect(apart, `${name} ${i} ${j}`).toBe(true);
        }
      }
    }
  });

  it('按行排，一行两个，先左后右，行与行从上到下', () => {
    const spots = bayPositions(...STATION_SIZES.large, 6);
    expect(spots[0]!.x).toBeLessThan(spots[1]!.x);
    expect(spots[0]!.y).toBe(spots[1]!.y);
    expect(spots[2]!.y).toBeGreaterThan(spots[0]!.y);
    expect(spots[2]!.x).toBe(spots[0]!.x);
  });

  it('整组在屋顶里垂直居中', () => {
    for (const [name, [w, h], count] of CASES) {
      const spots = bayPositions(w, h, count);
      const top = Math.min(...spots.map((p) => p.y));
      const bottom = Math.max(...spots.map((p) => p.y));
      expect((top + bottom) / 2, name).toBeCloseTo(h / 2, 9);
    }
  });

  it('停机位的边长随行距缩小，最大 17', () => {
    expect(slotSize(112, 1)).toBe(17);
    expect(slotSize(80, 12)).toBeLessThan(17);
    expect(slotSize(80, 12)).toBeGreaterThan(0);
    expect(slotSize(112, 12)).toBeGreaterThan(slotSize(80, 12));
  });

  it('世界坐标里的位置是屋顶左上角加局部位置', () => {
    const local = bayPositions(124, 96, 4);
    const world = slotWorldPositions(1000, 500, 124, 96, 4);
    world.forEach((p, i) => {
      expect(p.x).toBeCloseTo(1000 + local[i]!.x, 9);
      expect(p.y).toBeCloseTo(500 + local[i]!.y, 9);
    });
  });
});

describe('停机位按屋顶的上限排好位置', () => {
  /** 三种屋顶和它们的停机位上限：小 6，中 9，大 12。 */
  const ROOFS: [string, readonly [number, number], number][] = [
    ['小屋顶', STATION_SIZES.small, 6],
    ['中屋顶', STATION_SIZES.medium, 9],
    ['大屋顶', STATION_SIZES.large, 12],
  ];

  it('买一个停机位，已有的停机位一个都不动，新的一个落在下一个空位', () => {
    for (const [name, [w, h], limit] of ROOFS) {
      const final = bayPositions(w, h, limit, limit);
      for (let count = 1; count < limit; count++) {
        const before = bayPositions(w, h, count, limit);
        const after = bayPositions(w, h, count + 1, limit);
        expect(before, `${name} ${count}`).toHaveLength(count);
        expect(after, `${name} ${count + 1}`).toHaveLength(count + 1);
        expect(after.slice(0, count), `${name} ${count}`).toEqual(before);
        expect(after[count], `${name} ${count}`).toEqual(final[count]);
      }
    }
  });

  it('不管现在有几个停机位，第 k 个都在放满时的位置上', () => {
    for (const [name, [w, h], limit] of ROOFS) {
      const final = bayPositions(w, h, limit, limit);
      for (let count = 1; count <= limit; count++) expect(bayPositions(w, h, count, limit), `${name} ${count}`).toEqual(final.slice(0, count));
    }
  });

  it('停机位的边长也不随个数变，买停机位时画出来的格子不会缩小', () => {
    for (const [name, [, h], limit] of ROOFS) {
      const size = slotSize(h, limit, limit);
      for (let count = 1; count <= limit; count++) expect(slotSize(h, count, limit), `${name} ${count}`).toBe(size);
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(17);
    }
  });

  it('位置都在屋顶之内，互不重叠，放满时整组在屋顶里垂直居中', () => {
    for (const [name, [w, h], limit] of ROOFS) {
      const spots = bayPositions(w, h, limit, limit);
      const half = slotSize(h, limit, limit) / 2;
      for (const p of spots) {
        expect(p.x - half, name).toBeGreaterThanOrEqual(0);
        expect(p.x + half, name).toBeLessThanOrEqual(w);
        expect(p.y - half, name).toBeGreaterThanOrEqual(0);
        expect(p.y + half, name).toBeLessThanOrEqual(h);
      }
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          const a = spots[i]!;
          const b = spots[j]!;
          expect(Math.abs(a.x - b.x) >= 2 * half - 1e-6 || Math.abs(a.y - b.y) >= 2 * half - 1e-6, `${name} ${i} ${j}`).toBe(true);
        }
      }
      const top = Math.min(...spots.map((p) => p.y));
      const bottom = Math.max(...spots.map((p) => p.y));
      expect((top + bottom) / 2, name).toBeCloseTo(h / 2, 9);
    }
  });

  it('没有上限时和以前一样按个数排，个数比上限多时也按个数排', () => {
    for (const [w, h] of [STATION_SIZES.small, STATION_SIZES.medium, STATION_SIZES.large]) {
      expect(bayPositions(w, h, 5)).toEqual(bayPositions(w, h, 5, 5));
      expect(slotSize(h, 5)).toBe(slotSize(h, 5, 5));
      // 调试时飞机补得比上限多，停机位也跟着多
      expect(bayPositions(w, h, 14, 9)).toEqual(bayPositions(w, h, 14));
      expect(slotSize(h, 14, 9)).toBe(slotSize(h, 14));
    }
  });

  it('世界坐标里同样不动：屋顶左上角加固定的局部位置', () => {
    const [w, h] = STATION_SIZES.medium;
    const before = slotWorldPositions(1000, 500, w, h, 3, 9);
    const after = slotWorldPositions(1000, 500, w, h, 4, 9);
    expect(after.slice(0, 3)).toEqual(before);
    const final = bayPositions(w, h, 9, 9);
    expect(after[3]!.x).toBeCloseTo(1000 + final[3]!.x, 9);
    expect(after[3]!.y).toBeCloseTo(500 + final[3]!.y, 9);
  });
});

describe('数据员的人物站在屋顶的哪里', () => {
  /** 三种屋顶。 */
  const ROOFS: [string, readonly [number, number]][] = [
    ['小屋顶', STATION_SIZES.small],
    ['中屋顶', STATION_SIZES.medium],
    ['大屋顶', STATION_SIZES.large],
  ];

  it('原大和停机位差不多：16 像素高，最大的停机位是 17，比高窄一些', () => {
    expect(CLERK_HEIGHT).toBe(16);
    expect(CLERK_WIDTH).toBe(11);
    expect(slotSize(112, 1)).toBeGreaterThanOrEqual(CLERK_HEIGHT);
  });

  it('放大倍数：跟着记号倍数走，至少是 1，不放大时就是 1；屋顶越大上限越高', () => {
    for (const [name, [w, h]] of ROOFS) {
      expect(clerkScale(w, h, 1), name).toBe(1);
      expect(clerkScale(w, h, 2), name).toBeGreaterThanOrEqual(1);
      expect(clerkScale(w, h, 2), name).toBeLessThanOrEqual(2);
      expect(clerkScale(w, h, 1.5), name).toBeLessThanOrEqual(clerkScale(w, h, 2));
    }
    const [small, medium, large] = ROOFS.map(([, [w, h]]) => clerkScale(w, h, 99));
    expect(small).toBeLessThan(medium!);
    expect(medium).toBeLessThan(large!);
    // 开局的站在中屋顶上，镜头缩到最小时记号倍数是 2，人物能放到 2 倍
    expect(clerkScale(...STATION_SIZES.medium, 2)).toBe(2);
  });

  it('左边和下沿都离屋顶边缘 CLERK_MARGIN，放大时向右和向上长，左下角不动', () => {
    for (const [name, [, h]] of ROOFS) {
      for (const k of [1, 1.5, 2]) {
        const spot = clerkSpot(h, k);
        expect(spot.x - (CLERK_WIDTH * k) / 2, `${name} ${k} 左边`).toBeCloseTo(CLERK_MARGIN, 9);
        expect(spot.y + (CLERK_HEIGHT * k) / 2, `${name} ${k} 下沿`).toBeCloseTo(h - CLERK_MARGIN, 9);
      }
    }
  });

  it('整个人在屋顶里侧的虚线框之内，放到上限时也是', () => {
    for (const [name, [w, h]] of ROOFS) {
      for (const unit of [1, 1.5, 2, 99]) {
        const k = clerkScale(w, h, unit);
        const spot = clerkSpot(h, k);
        expect(spot.x - (CLERK_WIDTH * k) / 2, `${name} ${unit} 左边`).toBeGreaterThanOrEqual(6);
        expect(spot.x + (CLERK_WIDTH * k) / 2, `${name} ${unit} 右边`).toBeLessThanOrEqual(w - 6);
        expect(spot.y - (CLERK_HEIGHT * k) / 2, `${name} ${unit} 上沿`).toBeGreaterThanOrEqual(6);
        expect(spot.y + (CLERK_HEIGHT * k) / 2, `${name} ${unit} 下沿`).toBeLessThanOrEqual(h - 6);
      }
    }
  });

  it('放到上限时不压住起降圈里的站号：右边在站号的左边，上沿不超过圈心下面 CLERK_ABOVE 个半径', () => {
    for (const [name, [w, h]] of ROOFS) {
      const circle = landingCircle(w, h);
      const k = clerkScale(w, h, 99);
      const spot = clerkSpot(h, k);
      // 站号写在圈心，宽度约 2 乘 NUMBER_HALF 个半径
      expect(spot.x + (CLERK_WIDTH * k) / 2, name).toBeLessThanOrEqual(circle.cx - circle.r * NUMBER_HALF - 1 + 1e-9);
      expect(spot.y - (CLERK_HEIGHT * k) / 2, name).toBeGreaterThanOrEqual(circle.cy + circle.r * CLERK_ABOVE - 1e-9);
    }
  });

  it('原大时整个人在圈心以下：人物在圈的左下方，只和圈的圆弧挨着', () => {
    for (const [name, [w, h]] of ROOFS) {
      const circle = landingCircle(w, h);
      const spot = clerkSpot(h, 1);
      expect(spot.y - CLERK_HEIGHT / 2, name).toBeGreaterThanOrEqual(circle.cy);
      expect(spot.x + CLERK_WIDTH / 2, name).toBeLessThanOrEqual(circle.cx);
    }
  });

  it('放大的人物更靠上、更靠右，大小跟着倍数走', () => {
    const [, h] = STATION_SIZES.medium;
    expect(clerkSpot(h, 1.8).y).toBeLessThan(clerkSpot(h, 1).y);
    expect(clerkSpot(h, 1.8).x).toBeGreaterThan(clerkSpot(h, 1).x);
  });
});

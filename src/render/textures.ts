// 动态元素的纹理：飞机、影子、订单小票、名次数字、停机位、目的地、送达和退单的记号，都在启动时用 Canvas 2D 画一次，
// 排进一张图集（原大的两倍分辨率），运行时精灵只是取其中一块。昼夜状态一换，整张图集重画一遍（色板不同）。
// 站点屋顶、店的门面、等降落的圈随场景里有什么按需画，缓存起来。
import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import { BASE_COLORS, STATION_COLOR_NAMES } from '../content/palette.ts';
import { context2d, makeCanvas } from './draw/ctx.ts';
import type { Ctx } from './draw/ctx.ts';
import {
  TICKET_BOX,
  drawAwning,
  drawCancelMark,
  drawDestination,
  drawDrone,
  drawDroneShadow,
  drawLateMark,
  drawOnTimeMark,
  drawRail,
  drawSlot,
  drawStationRoof,
  drawTicket,
} from './draw/objects.ts';
import type { StationArt } from './draw/objects.ts';
import { stationColor, withAlpha } from './look.ts';
import type { Theme } from './look.ts';

/**
 * 图集和动态纹理的分辨率：原大的两倍，设备像素比为 1 时由 Pixi 缩小，是 2×2 的均匀平均，边缘更平滑。
 * 整张地图放进窗口时画出来的东西比原大小得多，缩小的倍数不是整数，要开 mipmap 才不会闪。
 */
export const TEXTURE_RESOLUTION = 2;
export const SPIN_FRAMES = 6;
export const TICKET_BAR_MAX = 10;
const ATLAS_SIZE = 2048;
const PAD = 2;

export interface FontNames {
  readonly serif: string;
  readonly hand: string;
}

/** 一格一格往图集里排的小工具（按行排）。 */
class Packer {
  readonly size: number;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: Ctx;
  private x = PAD;
  private y = PAD;
  private rowH = 0;
  private readonly cells: { rect: Rectangle; anchor: { x: number; y: number } }[] = [];

  constructor(size: number) {
    this.size = size;
    this.canvas = makeCanvas(size, size);
    this.ctx = context2d(this.canvas);
  }

  /** 排一格：逻辑尺寸 w 乘 h，原点（锚点）在格内的 (ox, oy)。draw 在以原点为 (0,0) 的局部坐标里画。返回这一格的序号。 */
  add(w: number, h: number, ox: number, oy: number, draw: (ctx: Ctx) => void): number {
    const pw = Math.ceil(w * TEXTURE_RESOLUTION);
    const ph = Math.ceil(h * TEXTURE_RESOLUTION);
    if (this.x + pw + PAD > this.size) {
      this.x = PAD;
      this.y += this.rowH + PAD;
      this.rowH = 0;
    }
    if (this.y + ph + PAD > this.size) throw new Error('texture atlas is full');
    const px = this.x;
    const py = this.y;
    this.x += pw + PAD;
    this.rowH = Math.max(this.rowH, ph);
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(px, py, pw, ph);
    this.ctx.clip();
    this.ctx.setTransform(TEXTURE_RESOLUTION, 0, 0, TEXTURE_RESOLUTION, px + ox * TEXTURE_RESOLUTION, py + oy * TEXTURE_RESOLUTION);
    draw(this.ctx);
    this.ctx.restore();
    this.cells.push({ rect: new Rectangle(px / TEXTURE_RESOLUTION, py / TEXTURE_RESOLUTION, w, h), anchor: { x: ox / w, y: oy / h } });
    return this.cells.length - 1;
  }

  textures(mipmaps: boolean): Texture[] {
    const source = new CanvasSource({ resource: this.canvas, resolution: TEXTURE_RESOLUTION, scaleMode: 'linear', autoGenerateMipmaps: mipmaps });
    return this.cells.map((c) => new Texture({ source, frame: c.rect, defaultAnchor: c.anchor }));
  }
}

/** 图集里的一张表：按下标取纹理。 */
export class Atlas {
  readonly theme: Theme;
  private readonly all: Texture[];
  private readonly index = new Map<string, number>();

  constructor(theme: Theme, fonts: FontNames, mipmaps = false) {
    this.theme = theme;
    const packer = new Packer(ATLAS_SIZE);
    const key = (name: string, n: number): void => {
      this.index.set(name, n);
    };
    const colors = STATION_COLOR_NAMES.map((_, i) => stationColor(theme.pal, i));
    // 飞机：站点颜色 × 货箱 × 旋翼相位 × 有无衬边 × 电量低
    for (let c = 0; c < colors.length; c++) {
      for (let cargo = 0; cargo <= 2; cargo++) {
        for (let f = 0; f < SPIN_FRAMES; f++) {
          for (const low of [false, true]) {
            key(`drone:${c}:${cargo}:${f}:1:${low ? 1 : 0}`, packer.add(40, 44, 20, 22, (ctx) => drawDrone(ctx, theme, { color: colors[c] as string, cargo, spin: (f * 180) / SPIN_FRAMES, casing: true, lowBattery: low })));
          }
        }
      }
      // 停在停机位上：没有衬边，没有货箱
      for (const low of [false, true]) {
        key(`drone:${c}:0:0:0:${low ? 1 : 0}`, packer.add(40, 44, 20, 22, (ctx) => drawDrone(ctx, theme, { color: colors[c] as string, cargo: 0, spin: 0, casing: false, lowBattery: low })));
      }
    }
    for (let cargo = 0; cargo <= 2; cargo++) key(`shadow:${cargo}`, packer.add(40, 44, 20, 22, (ctx) => drawDroneShadow(ctx, theme, cargo)));
    // 订单小票：边框颜色（四个站）乘计时条格数，快超时和已超时是急红
    for (let c = 0; c < colors.length; c++) {
      for (let bar = 0; bar <= TICKET_BAR_MAX; bar++) {
        key(`ticket:ok:${c}:${bar}`, packer.add(TICKET_BOX.w, TICKET_BOX.h, -TICKET_BOX.x, -TICKET_BOX.y, (ctx) => drawTicket(ctx, theme, { edge: colors[c] as string, state: 'ok', bar })));
      }
    }
    for (let bar = 0; bar <= TICKET_BAR_MAX; bar++) {
      key(`ticket:urgent:${bar}`, packer.add(TICKET_BOX.w, TICKET_BOX.h, -TICKET_BOX.x, -TICKET_BOX.y, (ctx) => drawTicket(ctx, theme, { edge: theme.pal.red, state: 'urgent', bar })));
    }
    key('ticket:late', packer.add(TICKET_BOX.w, TICKET_BOX.h, -TICKET_BOX.x, -TICKET_BOX.y, (ctx) => drawTicket(ctx, theme, { edge: theme.pal.red, state: 'late', bar: TICKET_BAR_MAX })));
    // 派单名次的数字：手写体，纸白描边
    for (let n = 1; n <= 9; n++) {
      key(`digit:${n}`, packer.add(20, 24, 10, 15, (ctx) => drawDigit(ctx, theme, fonts.hand, String(n))));
    }
    key('slot', packer.add(24, 24, 12, 12, (ctx) => drawSlot(ctx, theme, 17)));
    key('dest:0', packer.add(28, 28, 14, 14, (ctx) => drawDestination(ctx, theme, false)));
    key('dest:1', packer.add(28, 28, 14, 14, (ctx) => drawDestination(ctx, theme, true)));
    key('cancel', packer.add(14, 14, 7, 7, (ctx) => drawCancelMark(ctx, theme)));
    key('ontime', packer.add(18, 18, 9, 9, (ctx) => drawOnTimeMark(ctx, theme)));
    key('late', packer.add(18, 18, 9, 9, (ctx) => drawLateMark(ctx, theme)));
    key('white', packer.add(4, 4, 2, 2, (ctx) => {
      ctx.fillStyle = BASE_COLORS.slip;
      ctx.fillRect(-2, -2, 4, 4);
    }));
    this.all = packer.textures(mipmaps);
  }

  get(name: string): Texture {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`no atlas texture ${name}`);
    return this.all[i] as Texture;
  }

  drone(color: number, cargo: number, frame: number, casing: boolean, low: boolean): Texture {
    const f = casing ? frame % SPIN_FRAMES : 0;
    return this.get(`drone:${color % STATION_COLOR_NAMES.length}:${casing ? cargo : 0}:${f}:${casing ? 1 : 0}:${low ? 1 : 0}`);
  }

  shadow(cargo: number): Texture {
    return this.get(`shadow:${cargo}`);
  }

  ticket(state: 'ok' | 'urgent' | 'late', color: number, bar: number): Texture {
    if (state === 'late') return this.get('ticket:late');
    const b = Math.max(0, Math.min(TICKET_BAR_MAX, bar));
    return state === 'urgent' ? this.get(`ticket:urgent:${b}`) : this.get(`ticket:ok:${color % STATION_COLOR_NAMES.length}:${b}`);
  }

  digit(n: number): Texture | null {
    return n >= 1 && n <= 9 ? this.get(`digit:${n}`) : null;
  }

  destroy(): void {
    const source = this.all[0]?.source;
    for (const t of this.all) t.destroy(false);
    source?.destroy();
  }
}

/**
 * 名次数字：手写体的小数字，外面一圈手画的圆，画在小票旁边。
 * 圆让相邻两张票的数字各自成一个记号，不会连起来读成两位数。圆里垫一层纸白，压在地图的线上也看得清。
 */
function drawDigit(ctx: Ctx, theme: Theme, font: string, text: string): void {
  const cy = -3.6;
  const radius = 6.9;
  ctx.fillStyle = withAlpha(theme.pal.paper, 0.94);
  ctx.beginPath();
  ctx.arc(0, cy, radius + 0.4, 0, Math.PI * 2);
  ctx.fill();
  // 手画的圆：半径略有起伏，收笔比起笔多走一小段，首尾不严丝合缝
  const phase = text.charCodeAt(0) * 1.7;
  ctx.strokeStyle = theme.pal.ink;
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const steps = 30;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = -2.3 + t * Math.PI * 2 * 1.07;
    const r = radius + 0.45 * Math.sin(a * 2 + phase) + 0.25 * t;
    const x = Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.97;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.font = `12px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.pal.ink;
  ctx.fillText(text, 0, 0.4);
}

// ---- 按需画的纹理 ----
/** 一块独立的画布纹理，原点在 (ox, oy)。 */
function standalone(w: number, h: number, ox: number, oy: number, draw: (ctx: Ctx) => void, mipmaps = false): Texture {
  const canvas = makeCanvas(w * TEXTURE_RESOLUTION, h * TEXTURE_RESOLUTION);
  const ctx = context2d(canvas);
  ctx.setTransform(TEXTURE_RESOLUTION, 0, 0, TEXTURE_RESOLUTION, ox * TEXTURE_RESOLUTION, oy * TEXTURE_RESOLUTION);
  draw(ctx);
  const source = new CanvasSource({ resource: canvas, resolution: TEXTURE_RESOLUTION, scaleMode: 'linear', autoGenerateMipmaps: mipmaps });
  return new Texture({ source, defaultAnchor: { x: ox / w, y: oy / h } });
}

export interface StationTextureKey {
  readonly w: number;
  readonly h: number;
  readonly color: number;
  readonly number: string;
}

/** 站点屋顶、店的门面、等降落的圈。同一个键只画一次。 */
export class DynamicTextures {
  readonly theme: Theme;
  readonly fonts: FontNames;
  private readonly mipmaps: boolean;
  private readonly cache = new Map<string, Texture>();

  constructor(theme: Theme, fonts: FontNames, mipmaps = false) {
    this.theme = theme;
    this.fonts = fonts;
    this.mipmaps = mipmaps;
  }

  private cached(key: string, make: () => Texture): Texture {
    let t = this.cache.get(key);
    if (t === undefined) {
      t = make();
      this.cache.set(key, t);
    }
    return t;
  }

  /** 站点屋顶，原点在屋顶左上角。 */
  station(k: StationTextureKey): Texture {
    const shadow = Math.round(k.h * 0.09);
    return this.cached(`st:${k.w}:${k.h}:${k.color}:${k.number}`, () => {
      const art: StationArt = { w: k.w, h: k.h, number: k.number, color: stationColor(this.theme.pal, k.color), font: this.fonts.serif, shadow };
      return standalone(k.w + shadow + 4, k.h + shadow + 4, 2, 2, (ctx) => drawStationRoof(ctx, this.theme, art), this.mipmaps);
    });
  }

  /**
   * 店的门面：雨棚和票杆，局部坐标 u 沿街边、v 朝街里，原点在街边的 u=0 处。
   * awningStart 和 awningWidth 是雨棚的位置，rail 是票杆的两端。
   */
  shopFront(awningStart: number, awningWidth: number, railX0: number, railX1: number): Texture {
    return this.cached(`sf:${awningStart}:${awningWidth}:${railX0}:${railX1}`, () => {
      const minU = Math.min(awningStart, railX0) - 6;
      const maxU = Math.max(awningStart + awningWidth, railX1) + 6;
      return standalone(
        maxU - minU,
        22,
        -minU,
        4,
        (ctx) => {
          drawAwning(ctx, this.theme, awningStart, 0, awningWidth, 7);
          drawRail(ctx, this.theme, railX0, 13, railX1);
        },
        this.mipmaps,
      );
    });
  }

  /** 站点上空等降落的圈：虚线圆，站点颜色。原点在圆心。unit 是线宽和虚线长度的放大倍数。 */
  holdRing(color: number, radius: number, unit = 1): Texture {
    const r = Math.round(radius);
    const u = Math.round(unit * 20) / 20;
    return this.cached(`hr:${color}:${r}:${u}`, () => {
      const pad = 4 + Math.ceil(2 * (u - 1));
      return standalone(
        2 * r + 2 * pad,
        2 * r + 2 * pad,
        r + pad,
        r + pad,
        (ctx) => {
          ctx.setLineDash([5 * u, 6 * u]);
          ctx.beginPath();
          ctx.arc(0, 0, r, 0, Math.PI * 2);
          ctx.strokeStyle = stationColor(this.theme.pal, color);
          ctx.lineWidth = 2 * u;
          ctx.stroke();
        },
        this.mipmaps,
      );
    });
  }

  /**
   * 选中的站：屋顶外面一圈蓝黑的粗框，框外衬一圈纸白，压在街区和别的屋顶上也看得出来，四角再加短的折角。
   * 原点在屋顶左上角，w 乘 h 是屋顶的大小。
   */
  selection(w: number, h: number): Texture {
    const rw = Math.round(w);
    const rh = Math.round(h);
    return this.cached(`sel:${rw}:${rh}`, () => {
      const gap = 8;
      const extent = gap + 12;
      return standalone(
        rw + 2 * extent,
        rh + 2 * extent,
        extent,
        extent,
        (ctx) => {
          const { pal } = this.theme;
          const x = -gap;
          const y = -gap;
          const bw = rw + 2 * gap;
          const bh = rh + 2 * gap;
          ctx.lineJoin = 'miter';
          ctx.strokeStyle = pal.paper;
          ctx.lineWidth = 11;
          ctx.strokeRect(x, y, bw, bh);
          ctx.strokeStyle = pal.ink;
          ctx.lineWidth = 4.6;
          ctx.strokeRect(x, y, bw, bh);
          // 四角的折角：比边线再粗一点，向里伸一小段
          const arm = Math.min(22, bw / 3, bh / 3);
          ctx.lineWidth = 7.4;
          ctx.lineCap = 'square';
          ctx.beginPath();
          for (const [cx, cy, dx, dy] of [
            [x, y, 1, 1],
            [x + bw, y, -1, 1],
            [x, y + bh, 1, -1],
            [x + bw, y + bh, -1, -1],
          ] as const) {
            ctx.moveTo(cx + dx * arm, cy);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx, cy + dy * arm);
          }
          ctx.stroke();
        },
        this.mipmaps,
      );
    });
  }

  /**
   * 选屋顶时的候选屋顶：纸白的半透明底，蓝黑的虚线框。鼠标在上面的那块底更实，换成实线粗框。
   * 原点在屋顶左上角，w 乘 h 是屋顶的大小。买不起的屋顶由精灵降低不透明度。
   */
  roofFrame(w: number, h: number, hovered: boolean): Texture {
    const rw = Math.round(w);
    const rh = Math.round(h);
    return this.cached(`rf:${rw}:${rh}:${hovered ? 1 : 0}`, () => {
      const extent = 6;
      return standalone(
        rw + 2 * extent,
        rh + 2 * extent,
        extent,
        extent,
        (ctx) => {
          const { pal } = this.theme;
          ctx.globalAlpha = hovered ? 0.96 : 0.74;
          ctx.fillStyle = pal.paper;
          ctx.fillRect(0, 0, rw, rh);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = pal.ink;
          ctx.lineWidth = hovered ? 5.2 : 3.4;
          ctx.lineJoin = 'miter';
          ctx.setLineDash(hovered ? [] : [11, 7]);
          ctx.strokeRect(0, 0, rw, rh);
          ctx.setLineDash([]);
        },
        this.mipmaps,
      );
    });
  }

  /** 地图上的字（店名）：思源黑体 13 像素，纸白描边。原点在字的左端基线。 */
  label(text: string, font: string, size: number): Texture {
    return this.cached(`lb:${font}:${size}:${text}`, () => {
      const probe = context2d(makeCanvas(8, 8));
      probe.font = `${size}px ${font}`;
      const w = Math.ceil(probe.measureText(text).width) + 8;
      return standalone(
        w,
        size + 10,
        4,
        size + 3,
        (ctx) => {
          ctx.font = `${size}px ${font}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          ctx.lineJoin = 'round';
          ctx.lineWidth = 4;
          ctx.strokeStyle = this.theme.pal.paper;
          ctx.strokeText(text, 0, 0);
          ctx.fillStyle = withAlpha(this.theme.pal.ink, 0.9);
          ctx.fillText(text, 0, 0);
        },
        this.mipmaps,
      );
    });
  }

  destroy(): void {
    for (const t of this.cache.values()) t.destroy(true);
    this.cache.clear();
  }
}

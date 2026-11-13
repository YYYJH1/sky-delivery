// 一批粗线段和虚线，合成一个网格，一次绘制。航线（尾迹、虚线、点线）用它画：每架飞机每帧都要重算几十个小段，
// 用精灵或 Graphics 一段一段画太慢，这里每帧只往一个类型化数组里写顶点，再整块上传。
// 一个 QuadBatch 画同一种颜色和不透明度的线，航线层按（站点颜色、不透明度档位）各开一个。
import { MeshSimple, Texture } from 'pixi.js';
import type { BLEND_MODES } from 'pixi.js';

export class QuadBatch {
  readonly mesh: MeshSimple;
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  private readonly capacity: number;
  private count = 0;

  constructor(capacity: number, tint: number, alpha: number, blendMode: BLEND_MODES) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 8);
    this.indices = new Uint32Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
      const v = q * 4;
      this.indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }
    this.mesh = new MeshSimple({
      texture: Texture.WHITE,
      vertices: this.positions,
      uvs: new Float32Array(capacity * 8),
      indices: this.indices.subarray(0, 0),
    });
    this.mesh.tint = tint;
    this.mesh.alpha = alpha;
    this.mesh.blendMode = blendMode;
    this.mesh.visible = false;
  }

  setBlendMode(mode: BLEND_MODES): void {
    this.mesh.blendMode = mode;
  }

  begin(): void {
    this.count = 0;
  }

  /** 从 (x0, y0) 到 (x1, y1) 的一段，宽 w。长度为零的段不画。 */
  segment(x0: number, y0: number, x1: number, y1: number, w: number): void {
    if (this.count >= this.capacity) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) return;
    const nx = (-dy / len) * (w / 2);
    const ny = (dx / len) * (w / 2);
    const p = this.positions;
    const o = this.count * 8;
    p[o] = x0 + nx;
    p[o + 1] = y0 + ny;
    p[o + 2] = x1 + nx;
    p[o + 3] = y1 + ny;
    p[o + 4] = x1 - nx;
    p[o + 5] = y1 - ny;
    p[o + 6] = x0 - nx;
    p[o + 7] = y0 - ny;
    this.count += 1;
  }

  /**
   * 沿折线画虚线：每段 dash 长，间隔 gap，宽 w。phase 是进入这一段折线时已经走了多少（在一个周期里），
   * 返回走完之后的相位，下一条折线接着画，虚线就连续。
   */
  dashed(points: readonly number[], w: number, dash: number, gap: number, phase = 0): number {
    const period = dash + gap;
    let ph = phase % period;
    for (let i = 0; i + 3 < points.length; i += 2) {
      let x0 = points[i] as number;
      let y0 = points[i + 1] as number;
      const x1 = points[i + 2] as number;
      const y1 = points[i + 3] as number;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) continue;
      const ux = dx / len;
      const uy = dy / len;
      let left = len;
      while (left > 1e-6) {
        if (ph < dash) {
          const run = Math.min(dash - ph, left);
          this.segment(x0, y0, x0 + ux * run, y0 + uy * run, w);
          x0 += ux * run;
          y0 += uy * run;
          left -= run;
          ph += run;
        } else {
          const skip = Math.min(period - ph, left);
          x0 += ux * skip;
          y0 += uy * skip;
          left -= skip;
          ph += skip;
        }
        if (ph >= period - 1e-9) ph = 0;
      }
    }
    return ph;
  }

  /** 折线画成实线，每段一个四边形。 */
  solid(points: readonly number[], w: number): void {
    for (let i = 0; i + 3 < points.length; i += 2) this.segment(points[i] as number, points[i + 1] as number, points[i + 2] as number, points[i + 3] as number, w);
  }

  /** 把这一帧写好的顶点交给 GPU。 */
  end(): void {
    const geometry = this.mesh.geometry;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    geometry.indices = this.indices.subarray(0, this.count * 6);
    geometry.getBuffer('aPosition').update();
  }

  get quads(): number {
    return this.count;
  }

  destroy(): void {
    this.mesh.destroy();
  }
}

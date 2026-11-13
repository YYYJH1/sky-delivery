// 四种状态（白天、傍晚、夜间、下雨）的色板，换成画布和 Pixi 用的写法。颜色只来自 src/content/palette.ts。
// 淡色一律用同一种颜色降低不透明度得到，不另配：用 withAlpha()。
import { BASE_COLORS, LOOK_NAMES, LOOK_VARIANTS, STATION_COLOR_NAMES } from '../content/palette.ts';
import type { ColorName, LookName } from '../content/palette.ts';

export type Look = LookName;
export { LOOK_NAMES };

/** 一种状态下的全部颜色，值是 #RRGGBB。 */
export type Pal = Readonly<Record<ColorName, string>>;

export function palFor(look: Look): Pal {
  return { ...BASE_COLORS, ...LOOK_VARIANTS[look] };
}

/** 站点的颜色，按站的编号取模。 */
export function stationColor(pal: Pal, station: number): string {
  const n = STATION_COLOR_NAMES.length;
  return pal[STATION_COLOR_NAMES[((station % n) + n) % n] as ColorName];
}

/** #RRGGBB 换成 0xRRGGBB 的整数，Pixi 的 tint 要用。 */
export function hexToInt(hex: string): number {
  return Number.parseInt(hex.slice(1, 7), 16);
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = hexToInt(hex);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function trimNumber(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** 同一颜色带透明度：withAlpha('#22304A', 0.3) 得到 rgba(34,48,74,0.3)。 */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${trimNumber(alpha)})`;
}

/** 一种状态下画面用的全部颜色和几个随状态变的不透明度。 */
export interface Theme {
  readonly look: Look;
  readonly pal: Pal;
  /** 夜间：底色深，线条是浅色。 */
  readonly dark: boolean;
  /** 画在小票白和货箱上的线：始终是白天的蓝黑，因为它们的底是小票白。 */
  readonly slipInk: string;
  /** 建筑和树的排线阴影的不透明度。 */
  readonly hatchAlpha: number;
  /** 飞机影子的颜色和不透明度：白天是蓝黑 16%，夜间用比纸面更深的街区色。 */
  readonly shadowColor: string;
  readonly shadowAlpha: number;
}

export function themeFor(look: Look): Theme {
  const pal = palFor(look);
  const dark = look === 'night';
  return {
    look,
    pal,
    dark,
    slipInk: BASE_COLORS.ink,
    hatchAlpha: dark ? 0.14 : look === 'dusk' ? 0.34 : 0.3,
    shadowColor: dark ? pal.block : pal.ink,
    shadowAlpha: dark ? 0.9 : 0.16,
  };
}

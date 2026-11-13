// 街区、楼和屋顶物件的数据结构。城市由 city.ts 按地图数据生成，烘焙（bake.ts）和动态层都只读它。
import type { Rect, Vec } from './geometry.ts';

/** 三个片区的屋顶画法：老街，写字楼区，大学城。 */
export type Style = 'old' | 'office' | 'campus';

export type PropKind =
  | 'tank'
  | 'heaters'
  | 'ac'
  | 'clothesline'
  | 'planters'
  | 'shed'
  | 'cooling'
  | 'pv'
  | 'helipad'
  | 'stair'
  | 'antenna'
  | 'skylight';

/** 屋顶上的一个物件。(x, y) 是物件中心，a 和 b 是各物件自己的参数（半径、个数、宽高）。 */
export interface Prop {
  readonly kind: PropKind;
  readonly x: number;
  readonly y: number;
  readonly a: number;
  readonly b: number;
}

/** 屋顶的角色：普通屋顶，地图上的店，送餐的楼，候选屋顶（可以建站）。 */
export type BuildingRole =
  | { readonly type: 'plain' }
  | { readonly type: 'shop'; readonly index: number }
  | { readonly type: 'home'; readonly index: number }
  | { readonly type: 'roof'; readonly index: number };

/** 老街的屋顶画法：瓦线（顺着屋脊画一侧）。 */
export interface Ridge {
  /** 屋脊是横的（沿着长边）。 */
  readonly horizontal: boolean;
  /** 瓦线画在屋脊的哪一侧：真是上侧或左侧，假是下侧或右侧。 */
  readonly side: boolean;
}

export interface Building {
  readonly id: number;
  readonly rect: Rect;
  readonly style: Style;
  readonly role: BuildingRole;
  /** 排线阴影的偏移量，随建筑高度增加。 */
  readonly shadow: number;
  /** 蓝色彩钢棚屋顶：整个屋顶是彩钢棚，不画瓦线。 */
  readonly steel: boolean;
  readonly ridge: Ridge | null;
  /** 写字楼的屋顶：彩钢蓝 10% 填充，内侧一圈女儿墙线。 */
  readonly tinted: boolean;
  /** 小天井：老街的屋顶里挖一小块街区灰。 */
  readonly patio: Rect | null;
  readonly props: readonly Prop[];
  /** 夜间和傍晚亮起的窗：位置和亮起的门槛，门槛小于这种状态的亮窗比例时亮。 */
  readonly windows: readonly { readonly x: number; readonly y: number; readonly t: number }[];
}

export interface Tree {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly seed: number;
}

export type BlockKind = 'normal' | 'park' | 'bank' | 'track';

export interface Block {
  readonly rect: Rect;
  readonly kind: BlockKind;
  readonly style: Style;
  /** 操场的外框（只有 track）。 */
  readonly track: Rect | null;
  /** 篮球场的外框。 */
  readonly court: Rect | null;
}

export interface Street {
  readonly orient: 'h' | 'v';
  /** 街的中心线：横街是 y，竖街是 x。 */
  readonly c: number;
  readonly w: number;
  /** 街沿着自己方向的范围。 */
  readonly a: number;
  readonly b: number;
  readonly main: boolean;
}

export interface Bridge {
  readonly rect: Rect;
  readonly horizontal: boolean;
}

export interface Label {
  /** 片区的序号，词表里取名字。 */
  readonly district: number;
  /** 字的中心位置（世界坐标）和字基线的偏移。 */
  readonly x: number;
  readonly y: number;
}

/** 店的门面：沿街一侧的条纹雨棚和票杆。局部坐标里，街边在 v=0，票朝 +v 挂下去。 */
export interface ShopFront {
  readonly shop: number;
  readonly building: number;
  readonly side: 'b' | 't' | 'l' | 'r';
  /** 门面的原点（世界坐标）和朝向：局部 +u 沿街边，+v 朝街里。angle 是度。 */
  readonly origin: Vec;
  readonly angle: number;
  /** 雨棚的宽，和雨棚左端在 u 方向上的位置。 */
  readonly awningWidth: number;
  readonly awningStart: number;
  /** 店名摆放的位置（世界坐标，字左端的基线）。 */
  readonly name: Vec;
}

export interface StationRoof {
  readonly roof: number;
  readonly rect: Rect;
  readonly building: number;
}

export interface River {
  /** 河道中心线，已经平滑，间隔十几个单位。 */
  readonly center: readonly Vec[];
  readonly halfWidth: number;
}

export interface City {
  readonly seed: number;
  readonly region: Rect;
  readonly streets: readonly Street[];
  readonly blocks: readonly Block[];
  readonly buildings: readonly Building[];
  readonly trees: readonly Tree[];
  /** 老街街区里的小院：不盖屋顶的格子，画一圈淡线，里面可能有树和小东西。 */
  readonly yards: readonly Rect[];
  readonly bridges: readonly Bridge[];
  readonly labels: readonly Label[];
  readonly river: River;
  readonly shops: readonly ShopFront[];
  readonly stations: readonly StationRoof[];
}

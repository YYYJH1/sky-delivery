// 色表：游戏用到的十三种颜色，只放数据，没有函数。画面和界面的样式都从这里取。
// 画面里出现的颜色值必须在这张表里。淡色不另配，用同一种颜色降低不透明度得到（10% 到 55%），所以不进表。
// 夜间等四种状态只换纸面、街区和线条三项，别的颜色不变。四种状态的色值写在 LOOK_VARIANTS 里。

/** 色表里每一项的名称。 */
export type ColorName =
  | 'paper'
  | 'block'
  | 'ink'
  | 'steel'
  | 'amber'
  | 'green'
  | 'purple'
  | 'red'
  | 'note'
  | 'slip'
  | 'therm'
  | 'board'
  | 'alu';

export type ColorTable = Readonly<Record<ColorName, string>>;

/** 白天的色表。 */
export const BASE_COLORS: ColorTable = {
  paper: '#F3F2EC', // 纸白：地图的纸面和道路，动态元素的衬边
  block: '#E3E2DB', // 街区灰：街区底色
  ink: '#22304A', // 蓝黑：全部线条、文字、排线阴影
  steel: '#2F6EB5', // 彩钢蓝：一号站及其飞机和航线。降低不透明度后用于河流、写字楼屋顶和彩钢棚
  amber: '#DE8A00', // 琥珀：二号站及其飞机和航线
  green: '#2F8F5F', // 球场绿：三号站及其飞机和航线。降低不透明度后用于绿地和操场
  purple: '#6B4FA0', // 葡萄紫：四号站及其飞机和航线
  red: '#D8342A', // 急红：只用于快超时和已超时的订单，票杆旁的超出张数，以及小结上圈出的问题项
  note: '#F4E27A', // 便签黄：只用于便签。夜间的亮窗也用它的实色点
  slip: '#FBFBF7', // 小票白：只用于小票和货箱
  therm: '#2A2A2E', // 热敏黑：小票上的字
  board: '#FCFCFA', // 白板白：只用于白板
  alu: '#9AA3AB', // 铝框灰：只用于白板
};

/** 四个站的颜色，站的编号按序取。 */
export const STATION_COLOR_NAMES: readonly ColorName[] = ['steel', 'amber', 'green', 'purple'];

export type LookName = 'day' | 'dusk' | 'night' | 'rain';

export const LOOK_NAMES: readonly LookName[] = ['day', 'dusk', 'night', 'rain'];

/**
 * 四种状态相对白天色表的变体，只写有变的项。
 * - 傍晚：纸面和街区压暗一档，偏一点蓝紫，线条略深。窗户亮起三成。
 * - 夜间：纸面改为深蓝灰，街区比纸面再深一点，线条改为浅色。亮窗用便签黄的实色点，七成以上亮着。
 * - 下雨：白天的阴天，纸面和街区偏冷偏灰，线条不变。
 * 小票、货箱、白板、便签是实物，四种状态下颜色不变。
 */
export const LOOK_VARIANTS: Readonly<Record<LookName, Readonly<Partial<Record<ColorName, string>>>>> = {
  day: {},
  dusk: { paper: '#B9BDC6', block: '#A9AEBA', ink: '#1F2A41' },
  night: { paper: '#222C40', block: '#1C2536', ink: '#D3DAE7' },
  rain: { paper: '#D9DDDF', block: '#C8CDD0' },
};

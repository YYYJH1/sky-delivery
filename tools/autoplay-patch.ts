// 试数值用的补丁：在核心加载之前，把一份 JSON 合并进内容表。不改任何文件，只在这一次运行的进程里有效。
// 用在 npm run autoplay 的 --patch 选项上，也就是校准时「试一试把这个数改成那样会怎样」，每次运行的 run_info.json 会记下补丁。
// 工作线程启动时读环境变量 AUTOPLAY_PATCH（JSON 文本）。本模块必须在核心之前加载：核心里有些东西在加载时由内容表算出
// （例如各片区的订单量曲线），晚了补丁就不起作用。ES 模块按 import 的先后求值，所以 autoplay.ts 把它放在核心之前。
//
// 补丁的写法：{ 表名: { 键: 值 } }。表名是 economy、stars、unlocks、notes、districts、starMultiplier、opening、map。例如
//   { "economy": { "stationBase": [450, 1400, 3600] },
//     "districts": { "0": { "baseRate": 11 } },
//     "stars": { "rules": { "0": { "onTimeMin": 55 } }, "minSample": 8 },
//     "map": { "shops": { "14": { "rank": 11 } } } }
// 对象按键合并，键必须已经存在。数组里的元素用下标做键合并，整个数组替换时直接给数组。值的类型要和原来的相同。
import { DISTRICT_RATES_V1, STAR_MULTIPLIER_V1 } from '../src/content/districts_v1.ts';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { NOTES_V1 } from '../src/content/notes_v1.ts';
import { OPENING_ORDERS_V1 } from '../src/content/opening_v1.ts';
import { STARS_V1 } from '../src/content/stars_v1.ts';
import { UNLOCKS_V1 } from '../src/content/unlocks_v1.ts';

/** 可以打补丁的内容表。 */
export const PATCH_TABLES: Readonly<Record<string, unknown>> = {
  economy: ECONOMY_V1,
  stars: STARS_V1,
  unlocks: UNLOCKS_V1,
  notes: NOTES_V1,
  districts: DISTRICT_RATES_V1,
  starMultiplier: STAR_MULTIPLIER_V1,
  opening: OPENING_ORDERS_V1,
  map: MAP_V1,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把 patch 合并进 target，原地修改，保持对象和数组的身份不变（别的模块已经拿着引用）。 */
function mergeInPlace(target: unknown, patch: Record<string, unknown>, path: string): void {
  if (Array.isArray(target)) {
    for (const [key, value] of Object.entries(patch)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= target.length) throw new RangeError(`${path}[${key}] is outside the table`);
      assign(target as unknown[], index, value, `${path}[${key}]`);
    }
    return;
  }
  if (!isPlainObject(target)) throw new RangeError(`${path} is not a table`);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(target, key)) throw new RangeError(`${path}.${key} does not exist`);
    assign(target, key, value, `${path}.${key}`);
  }
}

function assign(parent: unknown[] | Record<string, unknown>, key: string | number, value: unknown, path: string): void {
  const old = (parent as Record<string | number, unknown>)[key];
  if (Array.isArray(old)) {
    if (Array.isArray(value)) old.splice(0, old.length, ...value);
    else if (isPlainObject(value)) mergeInPlace(old, value, path);
    else throw new RangeError(`${path} is a list`);
  } else if (isPlainObject(old)) {
    if (!isPlainObject(value)) throw new RangeError(`${path} is a table`);
    mergeInPlace(old, value, path);
  } else {
    // null 表示「不限」之类，可以换成数，也可以从数换成 null
    const nullable = old === null || value === null;
    if (!nullable && typeof value !== typeof old) throw new RangeError(`${path} is a ${typeof old}, the patch gives a ${typeof value}`);
    if (typeof value === 'object' && value !== null) throw new RangeError(`${path} must be a number, a string, a boolean or null`);
    (parent as Record<string | number, unknown>)[key] = value;
  }
}

/** 把补丁合并进给定的表。表名不认识、键不存在、类型不同都会抛错，不会悄悄忽略。 */
export function applyPatch(tables: Readonly<Record<string, unknown>>, patch: unknown): void {
  if (!isPlainObject(patch)) throw new RangeError('the patch must be an object { table: { key: value } }');
  for (const [name, part] of Object.entries(patch)) {
    if (!Object.hasOwn(tables, name)) throw new RangeError(`unknown table "${name}"`);
    if (!isPlainObject(part)) throw new RangeError(`${name} must be an object`);
    mergeInPlace(tables[name], part, name);
  }
}

/** 环境变量里的补丁。 */
export const PATCH_ENV = 'AUTOPLAY_PATCH';

const fromEnv = process.env[PATCH_ENV];
if (fromEnv !== undefined && fromEnv !== '') applyPatch(PATCH_TABLES, JSON.parse(fromEnv));

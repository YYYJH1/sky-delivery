// 校验用的小工具：字段表和深度扫描。
// 字段表只检查「有没有这个字段、类型对不对」，多出来的字段放行，所以核心给状态加字段之后，
// 旧的字段表照样能用，新字段只是没有被检查。要检查它，就在字段表里加一行。
// 深度扫描不看字段表，走遍整个对象里的每一个数字，出现 NaN 或无穷就不通过。

/** 路径的一段：对象的键，或数组的下标。 */
export type PathKey = string | number;

/** 一处不通过的位置和原因。路径形如 state.drones[3].battery。 */
export interface Issue {
  path: string;
  message: string;
  /** 数字本身坏了（NaN、无穷，或者数字字段里是 null）时为 'non-finite'。 */
  kind?: 'non-finite';
}

/** 一次检查的上下文：当前走到哪里，以及已经发现的问题。 */
export interface Ctx {
  path: PathKey[];
  issues: Issue[];
  /** 发现的问题总数，包括没有记进 issues 的。 */
  total: number;
}

/** 最多记下几处问题。其余只计数。 */
export const MAX_ISSUES = 20;
// 问题多到这个数就不再往下查：整段数组都不对时，没有必要逐个报告
const BAIL_AFTER = 200;
// 嵌套超过这个层数按不通过处理，防止恶意输入或循环引用拖垮递归
export const MAX_DEPTH = 64;

export type Check = (value: unknown, ctx: Ctx) => void;
export type Shape = Readonly<Record<string, Check>>;

export function newCtx(): Ctx {
  return { path: [], issues: [], total: 0 };
}

export function formatPath(path: readonly PathKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? key : `.${key}`;
  }
  return out;
}

export function report(ctx: Ctx, message: string, kind?: 'non-finite'): void {
  ctx.total += 1;
  if (ctx.issues.length >= MAX_ISSUES) return;
  const issue: Issue = { path: formatPath(ctx.path), message };
  if (kind !== undefined) issue.kind = kind;
  ctx.issues.push(issue);
}

function bailed(ctx: Ctx): boolean {
  return ctx.total >= BAIL_AFTER;
}

/** 用于报错信息：值是什么，不把整个值打出来。 */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'number':
      if (Number.isNaN(value)) return 'NaN';
      if (value === Infinity) return 'Infinity';
      if (value === -Infinity) return '-Infinity';
      return String(value);
    case 'string':
      return 'a string';
    case 'boolean':
      return String(value);
    case 'object':
      return 'an object';
    default:
      return typeof value;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- 字段表 ----

/** 数字。是不是有限，由深度扫描统一检查，这里只看类型。JSON 里的 NaN 和无穷会变成 null，所以 null 也按数字坏了报告。 */
export const num: Check = (value, ctx) => {
  if (typeof value === 'number') return;
  if (value === null) report(ctx, 'expected a number, got null (NaN and Infinity are written as null in JSON)', 'non-finite');
  else report(ctx, `expected a number, got ${describe(value)}`);
};

/** 整数。 */
export const int: Check = (value, ctx) => {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !Number.isInteger(value)) report(ctx, `expected an integer, got ${value}`);
    return;
  }
  if (value === null) report(ctx, 'expected an integer, got null (NaN and Infinity are written as null in JSON)', 'non-finite');
  else report(ctx, `expected an integer, got ${describe(value)}`);
};

/** 非负整数。 */
export const natural: Check = (value, ctx) => {
  int(value, ctx);
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value < 0) {
    report(ctx, `expected a non-negative integer, got ${value}`);
  }
};

export const bool: Check = (value, ctx) => {
  if (typeof value !== 'boolean') report(ctx, `expected true or false, got ${describe(value)}`);
};

export const str: Check = (value, ctx) => {
  if (typeof value !== 'string') report(ctx, `expected a string, got ${describe(value)}`);
};

/** 数组，每个元素都按 item 检查。 */
export function arr(item: Check): Check {
  return (value, ctx) => {
    if (!Array.isArray(value)) {
      report(ctx, `expected an array, got ${describe(value)}`);
      return;
    }
    for (let i = 0; i < value.length; i++) {
      if (bailed(ctx)) return;
      ctx.path.push(i);
      item(value[i], ctx);
      ctx.path.pop();
    }
  };
}

/** 键不限、每个值都按 item 检查的对象，用于键的名单会随内容增减的地方，例如经营模式的各项开放。 */
export function recordOf(item: Check): Check {
  return (value, ctx) => {
    if (!isRecord(value)) {
      report(ctx, `expected an object, got ${describe(value)}`);
      return;
    }
    for (const key of Object.keys(value)) {
      if (bailed(ctx)) return;
      ctx.path.push(key);
      item(value[key], ctx);
      ctx.path.pop();
    }
  };
}

/** 可以是 null。 */
export function nullable(item: Check): Check {
  return (value, ctx) => {
    if (value !== null) item(value, ctx);
  };
}

/**
 * 对象。required 里的字段必须有，optional 里的字段可以没有。
 * 字段表之外的字段放行（深度扫描仍会检查其中的数字）。
 */
export function obj(required: Shape, optional: Shape = {}): Check {
  const requiredKeys = Object.keys(required);
  const optionalKeys = Object.keys(optional);
  return (value, ctx) => {
    if (!isRecord(value)) {
      report(ctx, `expected an object, got ${describe(value)}`);
      return;
    }
    for (const key of requiredKeys) {
      if (bailed(ctx)) return;
      ctx.path.push(key);
      const field = value[key];
      if (field === undefined) report(ctx, 'missing required field');
      else (required[key] as Check)(field, ctx);
      ctx.path.pop();
    }
    for (const key of optionalKeys) {
      if (bailed(ctx)) return;
      const field = value[key];
      if (field === undefined) continue;
      ctx.path.push(key);
      (optional[key] as Check)(field, ctx);
      ctx.path.pop();
    }
  };
}

/** 按类型成批写字段表：每个类型一串用空格隔开的字段名。 */
export function fields(spec: { int?: string; num?: string; natural?: string; bool?: string; str?: string }): Shape {
  const out: Record<string, Check> = {};
  const add = (names: string | undefined, check: Check): void => {
    for (const name of (names ?? '').split(/\s+/)) if (name !== '') out[name] = check;
  };
  add(spec.int, int);
  add(spec.num, num);
  add(spec.natural, natural);
  add(spec.bool, bool);
  add(spec.str, str);
  return out;
}

// ---- 深度扫描 ----

/** 允许的路径写法：[*] 代表任意下标，* 代表任意一个键。例如 state.stats.foo[*].bar。 */
export function compileAllowList(patterns: readonly string[]): (path: string) => boolean {
  const regexes = patterns.map((pattern) => {
    const body = pattern
      .split(/(\[\*\]|\*)/)
      .map((piece) => {
        if (piece === '[*]') return '\\[\\d+\\]';
        if (piece === '*') return '[^.\\[\\]]+';
        return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    return new RegExp(`^${body}$`);
  });
  return (path) => regexes.some((regex) => regex.test(path));
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * 走遍整个值里的每一个数字：NaN、Infinity 不通过（allow 里按路径放行的除外）。
 * 同时挡住 JSON 存不下的东西：函数、符号、BigInt、数组里的 undefined、Map 和 Set 这类非普通对象、嵌套过深。
 * 对象里值为 undefined 的字段 JSON 会直接丢掉，等于没有这个字段，所以放行。
 */
export function scanValues(root: unknown, ctx: Ctx, allow: (path: string) => boolean): void {
  const walk = (value: unknown, depth: number, inArray: boolean): void => {
    if (bailed(ctx)) return;
    switch (typeof value) {
      case 'number':
        if (!Number.isFinite(value) && !allow(formatPath(ctx.path))) {
          report(ctx, `${describe(value)} is not allowed in a save`, 'non-finite');
        }
        return;
      case 'string':
      case 'boolean':
        return;
      case 'undefined':
        if (inArray) report(ctx, 'undefined inside an array cannot be saved');
        return;
      case 'object':
        break;
      default:
        report(ctx, `${typeof value} cannot be saved`);
        return;
    }
    if (value === null) return;
    if (depth >= MAX_DEPTH) {
      report(ctx, `nested deeper than ${MAX_DEPTH} levels`);
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        ctx.path.push(i);
        walk(value[i], depth + 1, true);
        ctx.path.pop();
        if (bailed(ctx)) return;
      }
      return;
    }
    if (!isPlain(value)) {
      report(ctx, 'only plain objects can be saved (no Map, Set, Date or class instances)');
      return;
    }
    for (const key of Object.keys(value)) {
      ctx.path.push(key);
      walk((value as Record<string, unknown>)[key], depth + 1, false);
      ctx.path.pop();
      if (bailed(ctx)) return;
    }
  };
  walk(root, 0, false);
}

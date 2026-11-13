// 核心的边界：纯 TypeScript，不引用 DOM、渲染库、系统时钟，不使用 Math.random，不引用 tools 和 tests。
// 核心可以引用内容表（src/content），内容表只放数据，只允许用 import type 引用核心。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CORE = join(SRC, 'core');
const CONTENT = join(SRC, 'content');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

/** 去掉注释，只检查代码。 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = listFiles(CORE);
const CONTENT_FILES = listFiles(CONTENT);

/** 禁用的写法：随机数、时钟、DOM、定时器、Node 的运行环境，以及末位随平台变化的数学函数。 */
const FORBIDDEN: [RegExp, string][] = [
  [/\bMath\.random\b/, 'Math.random'],
  [/\bDate\b/, 'Date'],
  [/\bperformance\b/, 'performance'],
  [/\bdocument\b/, 'document'],
  [/\bwindow\b/, 'window'],
  [/\bnavigator\b/, 'navigator'],
  [/\bprocess\b/, 'process'],
  [/\brequire\b/, 'require'],
  [/\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\bqueueMicrotask\b/, 'timers'],
  [/\bMath\.(hypot|pow|exp|log|sin|cos|tan|atan2?|sinh|cosh|tanh|cbrt|expm1|log1p|log2|log10)\b/, 'platform-dependent math'],
];

describe('核心的边界', () => {
  it('找到了核心的全部源文件', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('不使用 Math.random、系统时钟、DOM、定时器和 Node 的运行环境', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const code = codeOf(file);
      for (const [pattern, name] of FORBIDDEN) {
        if (pattern.test(code)) hits.push(`${relative(CORE, file)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('只引用核心自己的文件和内容表，不引用 tools、tests、画面层和任何第三方库', () => {
    const bad: string[] = [];
    const specifier = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
    for (const file of FILES) {
      for (const m of codeOf(file).matchAll(specifier)) {
        const target = m[1] as string;
        if (!target.startsWith('.')) {
          bad.push(`${relative(CORE, file)}: ${target}`);
          continue;
        }
        const resolved = resolve(dirname(file), target);
        const inCore = resolved.startsWith(CORE + '/');
        const inContent = resolved.startsWith(CONTENT + '/');
        if (!(inCore || inContent) || !resolved.endsWith('.ts')) bad.push(`${relative(CORE, file)}: ${target}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('模块顶层没有可变的变量：状态都在传入的状态对象里', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      codeOf(file)
        .split('\n')
        .forEach((line, i) => {
          if (/^(let|var)\s/.test(line)) hits.push(`${relative(CORE, file)}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

// ---- 内容表 ----
/** 内容表里的数据文件（带版本号的表）：只放数据，不放逻辑，不放中文字符串。 */
const TABLES = CONTENT_FILES.filter((f) => /_v\d+\.ts$/.test(f));

describe('内容表的边界', () => {
  it('找到了内容表：地图、价格、各片区的订单规律、开局订单，以及版本号和类型', () => {
    const names = CONTENT_FILES.map((f) => relative(CONTENT, f));
    for (const name of ['map_v1.ts', 'economy_v1.ts', 'districts_v1.ts', 'opening_v1.ts', 'version.ts', 'table_types.ts']) {
      expect(names).toContain(name);
    }
    expect(TABLES.length).toBeGreaterThanOrEqual(4);
  });

  it('不使用随机数、系统时钟、DOM、定时器、Node 的运行环境和末位随平台变化的数学函数', () => {
    const hits: string[] = [];
    for (const file of CONTENT_FILES) {
      const code = codeOf(file);
      for (const [pattern, name] of FORBIDDEN) {
        if (pattern.test(code)) hits.push(`${relative(CONTENT, file)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('只引用内容表自己的文件，引用核心只允许 import type，不引用核心的逻辑，也不引用别的目录和第三方库', () => {
    const bad: string[] = [];
    const statement = /(?:import|export)\s+(type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
    for (const file of CONTENT_FILES) {
      for (const m of codeOf(file).matchAll(statement)) {
        const typeOnly = Boolean(m[1]);
        const target = m[2] as string;
        const where = `${relative(CONTENT, file)}: ${target}`;
        if (!target.startsWith('.')) {
          bad.push(where);
          continue;
        }
        const resolved = resolve(dirname(file), target);
        if (resolved.startsWith(CONTENT + '/') && resolved.endsWith('.ts')) continue;
        if (resolved.startsWith(CORE + '/') && resolved.endsWith('.ts') && typeOnly) continue;
        bad.push(where);
      }
    }
    expect(bad).toEqual([]);
  });

  it('数据文件里没有逻辑：没有函数、箭头函数、类、循环、分支和动态引用', () => {
    const logic: [RegExp, string][] = [
      [/\bfunction\b/, 'function'],
      [/=>/, 'arrow function'],
      [/\bclass\b/, 'class'],
      [/\b(for|while|do|if|else|switch|try)\b/, 'control flow'],
      [/\bimport\s*\(/, 'dynamic import'],
      [/\beval\b|\bnew\s+Function\b/, 'eval'],
    ];
    const hits: string[] = [];
    for (const file of TABLES) {
      const code = codeOf(file);
      for (const [pattern, name] of logic) {
        if (pattern.test(code)) hits.push(`${relative(CONTENT, file)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('数据文件的代码里没有中文字符串：中文由词表提供，店名用序号指向词表', () => {
    const hits: string[] = [];
    for (const file of TABLES) {
      if (/[\u3400-\u9fff\uff00-\uffef]/.test(codeOf(file))) hits.push(relative(CONTENT, file));
    }
    expect(hits).toEqual([]);
  });

  it('核心引用的内容表文件都在内容表目录里，不引用词表之类的中文文件', () => {
    const used = new Set<string>();
    const specifier = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
    for (const file of FILES) {
      for (const m of codeOf(file).matchAll(specifier)) {
        const target = resolve(dirname(file), m[1] as string);
        if (target.startsWith(CONTENT + '/')) used.add(relative(CONTENT, target));
      }
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((name) => /strings/.test(name))).toEqual([]);
  });
});

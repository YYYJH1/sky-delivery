// 存档模块（src/save）和运行循环（src/app）的边界：
// 只通过 src/core/index.ts 引用核心，核心不引用它们，不读系统时钟、不用随机数，只有适配层碰 DOM。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAVE = join(ROOT, 'src', 'save');
const APP = join(ROOT, 'src', 'app');
const CORE = join(ROOT, 'src', 'core');
const CORE_INDEX = join(CORE, 'index.ts');
const SAVE_INDEX = join(SAVE, 'index.ts');

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

/** 去掉注释，再把字符串和模板字符串的内容清空，只看真正执行的代码里出现了什么名字。 */
function bareCodeOf(file: string): string {
  return codeOf(file).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
}

/** 只留下注释的文字。 */
function commentsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const m of text.matchAll(/(?:^|[^:])(\/\/.*)$/gm)) out.push(m[1] as string);
  return out;
}

const SAVE_FILES = listFiles(SAVE);
const APP_FILES = listFiles(APP);
const name = (file: string): string => relative(ROOT, file);

/** 一个文件里全部 import 和 export ... from 的路径。 */
function specifiersOf(file: string): string[] {
  const out: string[] = [];
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  for (const m of codeOf(file).matchAll(pattern)) out.push(m[1] as string);
  return out;
}

describe('存档模块和运行循环的源文件都在', () => {
  it('找到了 src/save 和 src/app 的文件', () => {
    for (const f of ['index.ts', 'format.ts', 'validate.ts', 'schema.ts', 'migrate.ts', 'store.ts', 'local-storage.ts', 'slots.ts', 'code.ts', 'bytes.ts']) {
      expect(SAVE_FILES.map((x) => relative(SAVE, x))).toContain(f);
    }
    for (const f of ['index.ts', 'loop.ts', 'autosave.ts', 'session.ts', 'browser.ts']) {
      expect(APP_FILES.map((x) => relative(APP, x))).toContain(f);
    }
  });
});

describe('引用关系', () => {
  /** 一个文件引用的路径，解析成绝对路径。不是相对路径的（第三方库、node: 内置模块）原样返回。 */
  const resolved = (file: string): { raw: string; target: string | null }[] =>
    specifiersOf(file).map((raw) => ({ raw, target: raw.startsWith('.') ? resolve(dirname(file), raw) : null }));

  it('src/save 只引用自己目录里的文件，和核心的 src/core/index.ts，不引用核心的其他文件、src/app、tools、tests 和任何第三方库', () => {
    const bad: string[] = [];
    for (const file of SAVE_FILES) {
      for (const { raw, target } of resolved(file)) {
        const inSave = target !== null && target.startsWith(`${SAVE}/`) && target.endsWith('.ts');
        if (!inSave && target !== CORE_INDEX) bad.push(`${name(file)}: ${raw}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('src/app 只引用自己目录里的文件、src/save/index.ts 和 src/core/index.ts', () => {
    const bad: string[] = [];
    for (const file of APP_FILES) {
      for (const { raw, target } of resolved(file)) {
        const inApp = target !== null && target.startsWith(`${APP}/`) && target.endsWith('.ts');
        if (!inApp && target !== CORE_INDEX && target !== SAVE_INDEX) bad.push(`${name(file)}: ${raw}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('核心不引用存档模块和运行循环', () => {
    const hits: string[] = [];
    for (const file of listFiles(CORE)) {
      for (const { raw, target } of resolved(file)) {
        if (/\b(save|app)\b/i.test(raw) || (target !== null && (target.startsWith(`${SAVE}/`) || target.startsWith(`${APP}/`)))) {
          hits.push(`${relative(CORE, file)}: ${raw}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('纯逻辑：不读系统时钟，不用随机数，不碰 DOM、定时器和 Node 的运行环境', () => {
  const COMMON: [RegExp, string][] = [
    [/\bMath\.random\b/, 'Math.random'],
    [/\bperformance\b/, 'performance'],
    [/\bprocess\b/, 'process'],
    [/\brequire\b/, 'require'],
    [/\bBuffer\b/, 'Buffer'],
    [/\bsetTimeout\b|\bsetInterval\b|\bqueueMicrotask\b/, 'timers'],
  ];
  const BROWSER_ONLY: [RegExp, string][] = [
    [/\bDate\b/, 'Date'],
    [/\bdocument\b/, 'document'],
    [/\bwindow\b/, 'window'],
    [/\bnavigator\b/, 'navigator'],
    [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, 'storage'],
    [/\brequestAnimationFrame\b|\bcancelAnimationFrame\b/, 'animation frame'],
  ];
  const hits = (files: string[], patterns: [RegExp, string][]): string[] => {
    const out: string[] = [];
    for (const file of files) {
      const code = bareCodeOf(file);
      for (const [pattern, label] of patterns) if (pattern.test(code)) out.push(`${name(file)}: ${label}`);
    }
    return out;
  };

  it('src/save 的全部文件都是纯逻辑：连 DOM 和 localStorage 的全局名字都不出现（localStorage 由调用方传进来）', () => {
    expect(hits(SAVE_FILES, [...COMMON, ...BROWSER_ONLY])).toEqual([]);
  });

  it('src/app 里只有 browser.ts 能碰 DOM 和系统时钟，其余文件都是纯逻辑', () => {
    const pure = APP_FILES.filter((f) => relative(APP, f) !== 'browser.ts');
    expect(hits(pure, [...COMMON, ...BROWSER_ONLY])).toEqual([]);
    expect(hits([join(APP, 'browser.ts')], COMMON)).toEqual([]);
  });

  it('整个 src/save 和 src/app 里，读系统时钟的只有 browser.ts 里的一处 Date.now', () => {
    const uses = [...SAVE_FILES, ...APP_FILES].flatMap((file) => [...bareCodeOf(file).matchAll(/\bDate\b[^\n]*/g)].map((m) => `${name(file)}: ${m[0].trim()}`));
    expect(uses).toEqual(['src/app/browser.ts: Date.now(),']);
  });
});

describe('文字', () => {
  it('代码里没有写死的中文：面向玩家的文字都在词表里，这里的错误信息只给开发者看，用英文', () => {
    const bad: string[] = [];
    for (const file of [...SAVE_FILES, ...APP_FILES]) {
      if (/[㐀-鿿＀-￯　-〿]/.test(codeOf(file))) bad.push(name(file));
    }
    expect(bad).toEqual([]);
  });

  it('注释里不用分号和破折号连接句子', () => {
    const bad: string[] = [];
    let scanned = 0;
    for (const file of [...SAVE_FILES, ...APP_FILES]) {
      for (const comment of commentsOf(file)) {
        scanned += 1;
        if (/[；—–]|;\s|;$/.test(comment)) bad.push(`${name(file)}: ${comment.slice(0, 50)}`);
      }
    }
    expect(scanned).toBeGreaterThan(100); // 确实扫到了注释
    expect(bad).toEqual([]);
  });
});

describe('类型检查的配置', () => {
  it('src/save 和 src/app 各有 tsconfig，并且都在 npm run typecheck 里', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: { typecheck: string } };
    for (const config of ['src/save/tsconfig.json', 'src/app/tsconfig.json'] as const) {
      const json = JSON.parse(readFileSync(join(ROOT, config), 'utf8')) as { include: string[] };
      expect(json.include).toEqual(['.']);
      expect(pkg.scripts.typecheck).toContain(`tsc -p ${config}`);
    }
  });
});

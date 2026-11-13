// 渲染模块（src/render）的边界：渲染模块不依赖界面层、运行循环和存档，界面层可以用它，核心只从 src/core/index.ts 引用，
// 只有画布和 Pixi 的文件碰浏览器，随机用固定种子，不用 Math.random 和时钟，代码里没有写死的中文，
// 注释里不用分号和破折号连接句子，以及依赖和类型检查的配置。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const RENDER = join(SRC, 'render');
const CORE_INDEX = join(SRC, 'core', 'index.ts');

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), accept) : accept(e.name) ? [join(dir, e.name)] : []));
}

const isCode = (name: string): boolean => /\.tsx?$/.test(name);

/** 去掉注释，只检查代码。 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 去掉注释，再把字符串的内容清空，只看真正执行的代码里出现了什么名字。 */
function bareCodeOf(file: string): string {
  return codeOf(file).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
}

function commentsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const m of text.matchAll(/(?:^|[^:])(\/\/.*)$/gm)) out.push(m[1] as string);
  return out;
}

function importsOf(file: string): string[] {
  const out: string[] = [];
  for (const m of codeOf(file).matchAll(/(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  return out;
}

const RENDER_FILES = listFiles(RENDER, isCode);
const name = (file: string): string => relative(ROOT, file);

/** 碰浏览器和 Pixi 的文件：画布绘制、烘焙、纹理、网格和渲染器。其余是纯函数，测试在 node 里直接调用。 */
const IMPURE = [
  'render/bake.ts',
  'render/textures.ts',
  'render/quads.ts',
  'render/static-layers.ts',
  'render/map-renderer.ts',
  'render/draw/ctx.ts',
  'render/draw/objects.ts',
  'render/draw/props.ts',
];

/** 改游戏状态的函数。渲染模块只读状态，不引入它们。 */
const WRITERS = ['step', 'advance', 'applyCommand', 'createState', 'setRules', 'prioritizeOrder', 'addOrder', 'dispatchRound', 'refreshShops', 'splitRuleSets'];

/** 从 src/core/index.ts 引入的名字。 */
function importedFromCore(file: string): string[] {
  const names: string[] = [];
  for (const m of codeOf(file).matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*core\/index\.ts['"]/g)) {
    for (const part of (m[1] as string).split(',')) {
      const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] as string;
      if (n !== '') names.push(n);
    }
  }
  return names;
}

describe('源文件都在', () => {
  it('src/render 的主要文件', () => {
    const render = RENDER_FILES.map((f) => relative(RENDER, f));
    for (const f of ['city.ts', 'streets.ts', 'river.ts', 'geometry.ts', 'camera.ts', 'districts.ts', 'scene.ts', 'layout.ts', 'look.ts', 'rng.ts', 'map-spec.ts', 'bake.ts', 'textures.ts', 'quads.ts', 'static-layers.ts', 'map-renderer.ts', 'draw/objects.ts', 'draw/props.ts']) {
      expect(render).toContain(f);
    }
  });
});

describe('引用关系', () => {
  it('src/render 不引用界面层、运行循环和存档，核心只从 index.ts 引用，第三方只有 pixi.js', () => {
    const bad: string[] = [];
    for (const file of RENDER_FILES) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith('.')) {
          if (spec !== 'pixi.js') bad.push(`${name(file)}: ${spec}`);
          continue;
        }
        const target = resolve(dirname(file), spec);
        const inRender = target.startsWith(`${RENDER}/`);
        const inContent = target.startsWith(`${join(SRC, 'content')}/`);
        if (!(inRender || inContent || target === CORE_INDEX)) bad.push(`${name(file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('核心、存档、运行循环和内容表都不引用渲染模块，界面层可以用', () => {
    const hits: string[] = [];
    for (const dir of ['core', 'save', 'app', 'content']) {
      for (const file of listFiles(join(SRC, dir), isCode)) {
        for (const spec of importsOf(file)) {
          if (!spec.startsWith('.')) continue;
          const target = resolve(dirname(file), spec);
          if (target.startsWith(`${RENDER}/`) || target === RENDER) hits.push(`${name(file)}: ${spec}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('界面层引用渲染模块时只引用 .ts 的文件，不引用烘焙、纹理这些画布细节', () => {
    const allowed = ['camera.ts', 'districts.ts', 'geometry.ts', 'look.ts', 'map-renderer.ts', 'map-spec.ts', 'scene.ts', 'city.ts', 'city-types.ts'];
    const bad: string[] = [];
    for (const file of listFiles(join(SRC, 'ui'), isCode)) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(`${RENDER}/`)) continue;
        if (!allowed.includes(relative(RENDER, target))) bad.push(`${name(file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('改状态的函数不从核心引入：渲染模块只读状态', () => {
    const bad: string[] = [];
    for (const file of RENDER_FILES) for (const n of importedFromCore(file)) if (WRITERS.includes(n)) bad.push(`${name(file)}: ${n}`);
    expect(bad).toEqual([]);
  });
});

describe('纯函数模块不碰浏览器', () => {
  it('除了画布和 Pixi 的文件，没有 document、window、Pixi、画布类型、定时器、动画帧', () => {
    const bad: string[] = [];
    for (const file of RENDER_FILES) {
      if (IMPURE.includes(relative(SRC, file))) continue;
      const code = bareCodeOf(file);
      for (const [pattern, label] of [
        [/\bdocument\b/, 'document'],
        [/\bwindow\b/, 'window'],
        [/\bnavigator\b/, 'navigator'],
        [/\bHTML\w*Element\b|\bCanvasRenderingContext2D\b/, 'DOM types'],
        [/\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b/, 'timers'],
        [/\bperformance\b/, 'performance'],
      ] as const) {
        if (pattern.test(code)) bad.push(`${name(file)}: ${label}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('随机和时间', () => {
  it('画面层不用 Math.random 和 Date：随机来自固定种子', () => {
    const bad: string[] = [];
    for (const file of RENDER_FILES) {
      const code = bareCodeOf(file);
      if (/\bMath\.random\b/.test(code)) bad.push(`${name(file)}: Math.random`);
      if (/\bDate\b/.test(code)) bad.push(`${name(file)}: Date`);
    }
    expect(bad).toEqual([]);
  });

  it('画面层的随机数同样的种子得到同样的序列', async () => {
    const { createRand, mixSeed } = await import('../src/render/rng.ts');
    const a = createRand(123);
    const b = createRand(123);
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
    expect(createRand(1)()).not.toBe(createRand(2)());
    expect(mixSeed(1, 2, 3)).toBe(mixSeed(1, 2, 3));
    expect(mixSeed(1, 2, 3)).not.toBe(mixSeed(1, 2, 4));
    for (let i = 0; i < 200; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('文字', () => {
  it('代码里没有写死的中文：面向玩家的文字都在词表里', () => {
    const bad: string[] = [];
    for (const file of RENDER_FILES) if (/[㐀-鿿＀-￯　-〿]/.test(codeOf(file))) bad.push(name(file));
    expect(bad).toEqual([]);
  });

  it('注释里不用分号和破折号连接句子', () => {
    const bad: string[] = [];
    let scanned = 0;
    for (const file of RENDER_FILES) {
      for (const comment of commentsOf(file)) {
        scanned += 1;
        if (/[；—–]|;\s|;$/.test(comment)) bad.push(`${name(file)}: ${comment.slice(0, 50)}`);
      }
    }
    expect(scanned).toBeGreaterThan(300);
    expect(bad).toEqual([]);
  });
});

describe('依赖和类型检查', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string>; dependencies: Record<string, string> };

  it('pixi.js 写死 8.22.0，不用 8.23.0', () => {
    expect(pkg.dependencies['pixi.js']).toBe('8.22.0');
  });

  it('src/render 有 tsconfig，带 DOM，在 npm run typecheck 和根配置的引用里', () => {
    const render = JSON.parse(readFileSync(join(ROOT, 'tsconfig.render.json'), 'utf8')) as { compilerOptions: { lib: string[] }; include: string[] };
    expect(render.include).toEqual(['src/render']);
    expect(render.compilerOptions.lib).toContain('DOM');
    expect(pkg.scripts.typecheck).toContain('tsc -p tsconfig.render.json');
    const root = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { references: { path: string }[] };
    expect(root.references.map((r) => r.path)).toContain('./tsconfig.render.json');
  });
});

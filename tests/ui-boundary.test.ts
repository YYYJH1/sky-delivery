// 界面层（src/ui）的边界：只通过 src/core/index.ts 引用核心，核心和别的层不引用界面，界面用渲染模块（src/render）画地图，
// 部件不碰游戏状态，纯函数模块不碰 DOM，代码里没有写死的中文，页面和构建的配置。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const UI = join(SRC, 'ui');
const CORE_INDEX = join(SRC, 'core', 'index.ts');
const APP_INDEX = join(SRC, 'app', 'index.ts');
const SAVE_INDEX = join(SRC, 'save', 'index.ts');
const AUDIO_INDEX = join(SRC, 'audio', 'index.ts');

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), accept) : accept(e.name) ? [join(dir, e.name)] : [],
  );
}

const isCode = (name: string): boolean => /\.tsx?$/.test(name);

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

function commentsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const m of text.matchAll(/(?:^|[^:])(\/\/.*)$/gm)) out.push(m[1] as string);
  return out;
}

const UI_FILES = listFiles(UI, isCode);
const name = (file: string): string => relative(ROOT, file);
const base = (file: string): string => relative(UI, file);

interface Import {
  specifier: string;
  names: string[];
  typeOnly: boolean;
}

function importsOf(file: string): Import[] {
  const out: Import[] = [];
  const code = codeOf(file);
  const named = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(named)) {
    out.push({
      specifier: m[3] as string,
      typeOnly: Boolean(m[1]),
      names: (m[2] as string)
        .split(',')
        .map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] as string)
        .filter((x) => x !== ''),
    });
  }
  const seen = new Set(out.map((i) => i.specifier));
  const any = /(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(any)) {
    const specifier = m[1] as string;
    if (!seen.has(specifier)) out.push({ specifier, names: [], typeOnly: false });
  }
  return out;
}

describe('界面层的源文件都在', () => {
  it('找到了 src/ui 的文件', () => {
    const files = UI_FILES.map(base);
    for (const f of [
      'main.tsx',
      'components.tsx',
      'board-panel.tsx',
      'ticket-panels.tsx',
      'forecast-panel.tsx',
      'forecast.ts',
      'forecast-flow.ts',
      'sheets.tsx',
      'paper.ts',
      'paper-use.ts',
      'hand.ts',
      'tip-anchor.ts',
      'note-panels.tsx',
      'game.ts',
      'state.ts',
      'view-model.ts',
      'names.ts',
      'roofs.ts',
      'tags.ts',
      'card.ts',
      'reasons.ts',
      'schedule.ts',
      'board.ts',
      'note.ts',
      'tickets.ts',
      'tips.ts',
      'notices.ts',
      'money.ts',
      'map-state.ts',
      'map-view.ts',
      'map-hit.ts',
      'map-layout.ts',
      'boot.ts',
      'lock.ts',
      'debug-params.ts',
    ]) {
      expect(files).toContain(f);
    }
  });
});

describe('引用关系', () => {
  const PACKAGES = ['preact', 'preact/hooks', '@preact/signals'];

  it('src/ui 只引用自己的文件、src/core/index.ts、src/app/index.ts、src/save/index.ts、src/audio/index.ts、内容表、渲染模块，以及 preact 和 signals', () => {
    const bad: string[] = [];
    for (const file of UI_FILES) {
      for (const imp of importsOf(file)) {
        if (!imp.specifier.startsWith('.')) {
          if (!PACKAGES.includes(imp.specifier)) bad.push(`${name(file)}: ${imp.specifier}`);
          continue;
        }
        const target = resolve(dirname(file), imp.specifier);
        const inUi = target.startsWith(`${UI}/`) && /\.tsx?$/.test(target);
        const inContent = target.startsWith(`${join(SRC, 'content')}/`) && target.endsWith('.ts');
        const inRender = target.startsWith(`${join(SRC, 'render')}/`) && target.endsWith('.ts');
        const allowed = inUi || inContent || inRender || target === CORE_INDEX || target === APP_INDEX || target === SAVE_INDEX || target === AUDIO_INDEX;
        if (!allowed) bad.push(`${name(file)}: ${imp.specifier}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('界面不引用核心的其他文件：核心只通过 src/core/index.ts 引用', () => {
    const hits: string[] = [];
    for (const file of UI_FILES) {
      for (const imp of importsOf(file)) {
        if (imp.specifier.startsWith('.') && /\/core\//.test(resolve(dirname(file), imp.specifier) + '/') && resolve(dirname(file), imp.specifier) !== CORE_INDEX) {
          hits.push(`${name(file)}: ${imp.specifier}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('核心、存档、运行循环和内容表都不引用界面', () => {
    const hits: string[] = [];
    for (const dir of ['core', 'save', 'app', 'content']) {
      for (const file of listFiles(join(SRC, dir), isCode)) {
        for (const imp of importsOf(file)) {
          if (imp.specifier.startsWith('.') && resolve(dirname(file), imp.specifier).startsWith(`${UI}`)) hits.push(`${name(file)}: ${imp.specifier}`);
          if (/(^|\/)ui(\/|$)|preact/.test(imp.specifier)) hits.push(`${name(file)}: ${imp.specifier}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('只有 map-view.ts 引用 Pixi 的渲染器（map-renderer.ts），别的文件只引用渲染模块里的纯函数', () => {
    const users = UI_FILES.filter((file) => importsOf(file).some((i) => i.specifier.endsWith('map-renderer.ts'))).map(base).sort();
    expect(users).toEqual(['map-view.ts']);
  });
});

describe('部件不碰游戏状态', () => {
  const WRITERS = [
    'step',
    'advance',
    'applyCommand',
    'createState',
    'setRules',
    'prioritizeOrder',
    'addOrder',
    'deliverOrder',
    'dispatchRound',
    'refreshShops',
    'saveGame',
    'loadGame',
    // 开放、便签、日结、小结、两套策略、离开结算，改的也是游戏状态
    'unlock',
    'refreshUnlocks',
    'markTipRead',
    'pushTip',
    'settleDay',
    'recordPeakSummary',
    'splitRuleSets',
    'switchRuleSet',
    'autoPoolAfterDoubleBox',
    'settleAway',
  ];

  it('改状态的函数只有 game.ts、boot.ts 和 debug-params.ts 引用：部件、地图场景、界面数据都只读', () => {
    const allowed = ['game.ts', 'boot.ts', 'debug-params.ts'];
    const bad: string[] = [];
    for (const file of UI_FILES) {
      if (allowed.includes(base(file))) continue;
      for (const imp of importsOf(file)) for (const n of imp.names) if (WRITERS.includes(n)) bad.push(`${name(file)}: ${n}`);
    }
    expect(bad).toEqual([]);
  });

  /** 界面的部件：components.tsx 和另外几个 .tsx（入口 main.tsx 除外）。 */
  const PANELS = UI_FILES.filter((f) => f.endsWith('.tsx') && base(f) !== 'main.tsx');

  it('部件（components.tsx、board-panel.tsx、ticket-panels.tsx、note-panels.tsx、forecast-panel.tsx、sheets.tsx）不引用核心，也不引用存档和运行循环：它们只读 state.ts 里的界面数据', () => {
    expect(PANELS.map(base).sort()).toEqual(['board-panel.tsx', 'components.tsx', 'forecast-panel.tsx', 'note-panels.tsx', 'sheets.tsx', 'ticket-panels.tsx']);
    const bad = PANELS.flatMap((file) => importsOf(file).filter((i) => /\/(core|save|app)\//.test(i.specifier) || /\/(core|save|app)\/index/.test(i.specifier)).map((i) => `${base(file)}: ${i.specifier}`));
    expect(bad).toEqual([]);
  });

  it('读价格的 quoteCommand 只在 view-model.ts、roofs.ts、tags.ts、reasons.ts 和 game.ts 里用：部件和地图画法不直接读价格', () => {
    const users = UI_FILES.filter((file) => /\bquoteCommand\b/.test(bareCodeOf(file))).map(base).sort();
    expect(users).toEqual(['game.ts', 'reasons.ts', 'roofs.ts', 'tags.ts', 'view-model.ts']);
  });

  it('界面里读状态的字段集中在几个地方：部件里没有 state.campaign 之类的读法', () => {
    for (const file of UI_FILES.filter((f) => f.endsWith('.tsx') && base(f) !== 'main.tsx')) {
      const code = bareCodeOf(file);
      expect(code, base(file)).not.toMatch(/\.campaign\b/);
      expect(code, base(file)).not.toMatch(/\bSimState\b/);
    }
  });
});

describe('纯函数模块不碰 DOM、定时器和系统时钟', () => {
  /** 碰浏览器的文件：入口、画布绘制、部件（含纸和量大小的 hook）、运行（game.ts）。其余都是纯函数，测试在 node 里直接调用。 */
  const IMPURE = ['main.tsx', 'components.tsx', 'board-panel.tsx', 'ticket-panels.tsx', 'note-panels.tsx', 'forecast-panel.tsx', 'sheets.tsx', 'paper.ts', 'paper-use.ts', 'map-view.ts', 'game.ts'];

  it('其余文件里没有 document、window、navigator、存储、定时器、动画帧、Date 和随机数', () => {
    const bad: string[] = [];
    for (const file of UI_FILES) {
      if (IMPURE.includes(base(file))) continue;
      const code = bareCodeOf(file);
      for (const [pattern, label] of [
        [/\bdocument\b/, 'document'],
        [/\bwindow\b/, 'window'],
        [/\bnavigator\b/, 'navigator'],
        [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, 'storage'],
        [/\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\bqueueMicrotask\b/, 'timers'],
        [/\bCanvasRenderingContext2D\b|\bHTML\w*Element\b/, 'DOM types'],
        [/\bMath\.random\b/, 'Math.random'],
        [/\bperformance\b/, 'performance'],
      ] as const) {
        if (pattern.test(code)) bad.push(`${name(file)}: ${label}`);
      }
      // boot.ts 里用 Date 把时间写成本地时间，其余文件不读时间
      if (base(file) !== 'boot.ts' && /\bDate\b/.test(code)) bad.push(`${name(file)}: Date`);
    }
    expect(bad).toEqual([]);
  });

  it('boot.ts 里的 Date 只用来格式化传进来的时间，不读系统时钟', () => {
    const code = bareCodeOf(join(UI, 'boot.ts'));
    expect(code).not.toMatch(/Date\.now|new Date\(\)/);
  });

  it('不读系统时钟、不用随机数的地方：地图场景和界面数据只由状态和参数决定', () => {
    for (const f of ['map-state.ts', 'view-model.ts', 'tags.ts', 'card.ts', 'roofs.ts', 'schedule.ts', 'reasons.ts', 'names.ts', 'map-layout.ts', 'map-hit.ts', 'board.ts', 'note.ts', 'tickets.ts', 'tips.ts', 'notices.ts', 'money.ts', 'forecast.ts', 'forecast-flow.ts']) {
      const code = bareCodeOf(join(UI, f));
      expect(code, f).not.toMatch(/\bDate\b|\bMath\.random\b|\bperformance\b/);
    }
  });
});

describe('文字', () => {
  it('代码里没有写死的中文：面向玩家的文字都在词表里，错误信息只给开发者看，用英文', () => {
    const bad: string[] = [];
    for (const file of UI_FILES) {
      if (/[㐀-鿿＀-￯　-〿]/.test(codeOf(file))) bad.push(name(file));
    }
    expect(bad).toEqual([]);
  });

  it('样式表里也没有中文', () => {
    expect(readFileSync(join(UI, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/[㐀-鿿＀-￯　-〿]/);
  });

  it('注释里不用分号和破折号连接句子', () => {
    const bad: string[] = [];
    let scanned = 0;
    for (const file of UI_FILES) {
      for (const comment of commentsOf(file)) {
        scanned += 1;
        if (/[；—–]|;\s|;$/.test(comment)) bad.push(`${name(file)}: ${comment.slice(0, 50)}`);
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });
});

describe('依赖、类型检查和页面', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('preact 和 @preact/signals 写死版本号，不装 @preact/preset-vite 和 Babel', () => {
    expect(pkg.dependencies.preact).toBe('11.1.0');
    expect(pkg.dependencies['@preact/signals']).toBe('2.11.4');
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((k) => /preset-vite|babel/i.test(k))).toEqual([]);
    for (const version of Object.values(all)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('src/ui 有 tsconfig：JSX 用 react-jsx 和 preact，并且在 npm run typecheck 和根配置的引用里', () => {
    const config = JSON.parse(readFileSync(join(UI, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { jsx: string; jsxImportSource: string };
      include: string[];
    };
    expect(config.compilerOptions.jsx).toBe('react-jsx');
    expect(config.compilerOptions.jsxImportSource).toBe('preact');
    expect(config.include).toEqual(['.', '../audio']);
    expect(pkg.scripts.typecheck).toContain('tsc -p src/ui/tsconfig.json');
    const root = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { references: { path: string }[] };
    expect(root.references.map((r) => r.path)).toContain('./src/ui/tsconfig.json');
  });

  it('Vite：构建入口只有游戏页面 index.html，资源写成相对路径，开发服务器只监听本机', async () => {
    const { default: config } = (await import('../vite.config.ts')) as {
      default: { base: string; server: { host: string }; build: { rollupOptions: { input: Record<string, string> } } };
    };
    expect(config.base).toBe('./');
    expect(config.server.host).toBe('127.0.0.1');
    expect(Object.keys(config.build.rollupOptions.input)).toEqual(['index']);
  });

  it('index.html 是游戏页面：一块地图画布，一个界面容器，入口是 src/ui/main.tsx，字体样式表在 public/fonts，不引用外部的脚本和样式', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).toContain('<canvas id="map">');
    expect(html).toContain('id="hud"');
    expect(html).toContain('src="/src/ui/main.tsx"');
    expect(html).toContain('href="/fonts/fonts.css"');
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
  });
});

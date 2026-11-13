// 声音模块（src/audio）的边界：只引用自己目录里的文件和 src/core/index.ts，不用 Math.random，
// 合成、触发、限频、设置这几个文件是纯函数，不碰浏览器和时钟，只有 browser.ts 碰全局对象，
// 代码里没有写死的中文，注释里不用分号和破折号连接句子，也没有开发过程的说法和本机路径。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO = join(ROOT, 'src', 'audio');
const CORE_INDEX = join(ROOT, 'src', 'core', 'index.ts');

const FILES = readdirSync(AUDIO)
  .filter((name) => name.endsWith('.ts'))
  .sort()
  .map((name) => join(AUDIO, name));
const base = (file: string): string => relative(AUDIO, file);

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

/** 纯函数的文件：不碰浏览器和时钟。player.ts 通过传入的环境间接碰，browser.ts 是唯一直接碰全局对象的。 */
const PURE = ['dsp.ts', 'effects.ts', 'ambient.ts', 'catalog.ts', 'wav.ts', 'triggers.ts', 'limiter.ts', 'settings.ts'];

describe('源文件都在', () => {
  it('合成、目录、触发、限频、设置、播放器、浏览器适配层和公开接口', () => {
    expect(FILES.map(base)).toEqual([
      'ambient.ts',
      'browser.ts',
      'catalog.ts',
      'dsp.ts',
      'effects.ts',
      'index.ts',
      'limiter.ts',
      'player.ts',
      'settings.ts',
      'triggers.ts',
      'wav.ts',
    ]);
  });
});

describe('引用关系', () => {
  it('只引用自己目录里的文件和 src/core/index.ts，不引用别的目录和第三方库', () => {
    const bad: string[] = [];
    for (const file of FILES) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith('.')) {
          bad.push(`${base(file)}: ${spec}`);
          continue;
        }
        const target = resolve(dirname(file), spec);
        const inAudio = target.startsWith(`${AUDIO}/`) && target.endsWith('.ts');
        if (!inAudio && target !== CORE_INDEX) bad.push(`${base(file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('核心只有 triggers.ts 和 player.ts 引用：player.ts 只拿状态的类型，triggers.ts 不引用会改状态的函数', () => {
    const users = FILES.filter((file) => importsOf(file).some((spec) => resolve(dirname(file), spec) === CORE_INDEX)).map(base);
    // player.ts 只拿 SimState 类型
    expect(users).toEqual(['player.ts', 'triggers.ts']);
    const player = readFileSync(join(AUDIO, 'player.ts'), 'utf8');
    expect(player).toMatch(/import type \{ SimState \} from '\.\.\/core\/index\.ts';/);
    const triggers = readFileSync(join(AUDIO, 'triggers.ts'), 'utf8');
    const imported = /import \{([^}]*)\} from '\.\.\/core\/index\.ts'/.exec(triggers)?.[1] ?? '';
    const names = imported.split(',').map((s) => s.trim()).filter((s) => s !== '');
    for (const mutating of ['step', 'advance', 'applyCommand', 'setRules', 'addOrder', 'createState', 'deliverOrder', 'markTipRead', 'pushTip', 'settleDay', 'settleAway']) {
      expect(names, mutating).not.toContain(mutating);
    }
  });

  it('开发脚本 tools/render-sounds.ts 只引用 src/audio', () => {
    const file = join(ROOT, 'tools', 'render-sounds.ts');
    for (const spec of importsOf(file)) {
      if (spec.startsWith('node:')) continue;
      expect(resolve(dirname(file), spec).startsWith(`${AUDIO}/`), spec).toBe(true);
    }
  });
});

describe('运行环境', () => {
  const COMMON: [RegExp, string][] = [
    [/\bMath\.random\b/, 'Math.random'],
    [/\bDate\b/, 'Date'],
    [/\bperformance\b/, 'performance'],
    [/\bglobalThis\b/, 'globalThis'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\bnavigator\b/, 'navigator'],
    [/\bprocess\b/, 'process'],
    [/\brequire\b/, 'require'],
    [/\bnew\s+(?:webkit)?AudioContext\b/, 'new AudioContext'],
  ];
  /** 直接引用全局对象：属性访问（env.window）不算。 */
  const GLOBAL_NAMES: [RegExp, string][] = [
    [/(?<![.\w])window\b/, 'window'],
    [/(?<![.\w])document\b/, 'document'],
    [/(?<![.\w])(?:setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame)\b/, 'timers'],
  ];

  it('不用 Math.random、系统时钟、localStorage、全局对象和 Node 的运行环境，只有 browser.ts 可以', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      if (base(file) === 'browser.ts') continue;
      const code = bareCodeOf(file);
      for (const [pattern, name] of COMMON) if (pattern.test(code)) hits.push(`${base(file)}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it('合成、目录、触发、限频、设置是纯函数：连 window、document 和定时器的名字都不出现', () => {
    const hits: string[] = [];
    for (const name of PURE) {
      const code = bareCodeOf(join(AUDIO, name));
      for (const [pattern, label] of GLOBAL_NAMES) if (pattern.test(code)) hits.push(`${name}: ${label}`);
    }
    expect(hits).toEqual([]);
  });

  it('播放器只通过传入的环境碰浏览器：window、document、定时器都是 env 的属性', () => {
    const code = bareCodeOf(join(AUDIO, 'player.ts'));
    for (const [pattern, label] of GLOBAL_NAMES) {
      // 接口里声明的成员名（readonly window: {...}）不算
      const stripped = code.replace(/readonly (?:window|document):/g, '').replace(/^\s*(?:setTimeout|clearTimeout)\(.*$/gm, '');
      expect(pattern.test(stripped), label).toBe(false);
    }
  });

  it('合成不依赖外部素材：不读文件，不发请求，不解码音频', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const code = bareCodeOf(file);
      for (const [pattern, label] of [
        [/\bfetch\b/, 'fetch'],
        [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
        [/\bdecodeAudioData\b/, 'decodeAudioData'],
        [/\bnode:fs\b|\breadFileSync\b/, 'fs'],
        [/\bnew\s+Audio\b/, 'new Audio'],
        [/\bimport\s*\(/, 'dynamic import'],
      ] as const) {
        if (pattern.test(code)) hits.push(`${base(file)}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
    for (const file of FILES) expect(importsOf(file).filter((s) => /\.(wav|mp3|ogg|flac|m4a)$/.test(s)), base(file)).toEqual([]);
  });
});

describe('文字', () => {
  it('代码里没有写死的中文，玩家看得到的文字都在词表里', () => {
    const bad: string[] = [];
    for (const file of FILES) if (/\p{Script=Han}/u.test(codeOf(file))) bad.push(base(file));
    expect(bad).toEqual([]);
  });

  it('注释里不用分号和破折号连接句子', () => {
    const bad: string[] = [];
    for (const file of FILES) {
      for (const comment of commentsOf(file)) if (/[；—–]|;\s|;$/.test(comment)) bad.push(`${base(file)}: ${comment.slice(0, 50)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('类型检查', () => {
  it('src/audio 在 src/ui/tsconfig.json 的 include 里', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'src', 'ui', 'tsconfig.json'), 'utf8')) as { include: string[] };
    expect(config.include).toContain('../audio');
  });
});

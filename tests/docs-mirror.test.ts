// 给读者看的文档有中英两份：英文 X.md 和中文 X_zh.md 放在同一目录。首行是语言切换行，
// 标题的层级逐个相同，代码块的个数相同。
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 成对的文档：英文版和中文版的文件名，相对仓库根目录。 */
const PAIRS: readonly (readonly [string, string])[] = [
  ['README.md', 'README_zh.md'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES_zh.md'],
  ['public/fonts/SOURCES.md', 'public/fonts/SOURCES_zh.md'],
];

/** 切换行里的链接指向同一目录下的另一份。 */
function switchLine(enPath: string, zhPath: string, current: 'en' | 'zh'): string {
  const en = basename(enPath);
  const zh = basename(zhPath);
  return current === 'en'
    ? `<p align="center"><b>English</b> · <a href="${zh}">简体中文</a></p>`
    : `<p align="center"><a href="${en}">English</a> · <b>简体中文</b></p>`;
}

/** 标题的层级序列，代码块里的 # 不算。 */
function headingLevels(text: string): number[] {
  const levels: number[] = [];
  let inCode = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inCode = !inCode;
    else if (!inCode) {
      const m = /^(#{1,6}) /.exec(line);
      if (m) levels.push((m[1] as string).length);
    }
  }
  return levels;
}

function codeBlocks(text: string): number {
  return text.split('\n').filter((line) => line.startsWith('```')).length / 2;
}

describe('中英两份文档', () => {
  for (const [en, zh] of PAIRS) {
    const enText = readFileSync(join(ROOT, en), 'utf8');
    const zhText = readFileSync(join(ROOT, zh), 'utf8');

    it(`${en} 和 ${zh} 的首行是语言切换行`, () => {
      expect(enText.split('\n')[0]).toBe(switchLine(en, zh, 'en'));
      expect(zhText.split('\n')[0]).toBe(switchLine(en, zh, 'zh'));
    });

    it(`${en} 和 ${zh} 的标题层级逐个相同，代码块个数相同`, () => {
      expect(headingLevels(zhText)).toEqual(headingLevels(enText));
      expect(headingLevels(enText).length).toBeGreaterThan(0);
      expect(codeBlocks(zhText)).toBe(codeBlocks(enText));
      expect(Number.isInteger(codeBlocks(enText))).toBe(true);
    });
  }
});

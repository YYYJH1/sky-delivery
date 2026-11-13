// 试听用的开发脚本 tools/render-sounds.ts 的命令行：参数检查和说明。这里不真的写文件，渲染本身由合成的测试覆盖。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AMBIENT_IDS, SOUND_IDS } from '../src/audio/catalog.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools', 'render-sounds.ts');

function run(...args: string[]): { status: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe('tools/render-sounds.ts 的命令行', () => {
  it('--help：退出码 0，说明里有 --out 和全部声音的名字', () => {
    const { status, out } = run('--help');
    expect(status).toBe(0);
    expect(out).toContain('--out');
    for (const id of [...SOUND_IDS, ...AMBIENT_IDS]) expect(out).toContain(id);
  });

  it('没有 --out：退出码 2，说明缺什么，也不写任何东西', () => {
    const { status, err } = run();
    expect(status).toBe(2);
    expect(err).toContain('--out');
  });

  it('不认识的声音名：退出码 2，不建目录', () => {
    const target = join(ROOT, 'no-such-output-dir-for-render-sounds-test');
    const { status, err } = run('--out', target, '--only', 'takeoff,nope');
    expect(status).toBe(2);
    expect(err).toContain('nope');
    expect(existsSync(target)).toBe(false);
  });

  it('采样率不合理：退出码 2，不建目录', () => {
    const target = join(ROOT, 'no-such-output-dir-for-render-sounds-test');
    for (const rate of ['100', 'abc', '44100.5', '999999']) {
      const { status, err } = run('--out', target, '--rate', rate);
      expect(status, rate).toBe(2);
      expect(err, rate).toContain('--rate');
    }
    expect(existsSync(target)).toBe(false);
  });

  it('不认识的选项：退出码不是 0', () => {
    expect(run('--out', join(ROOT, 'no-such-output-dir-for-render-sounds-test'), '--bogus').status).not.toBe(0);
    expect(existsSync(join(ROOT, 'no-such-output-dir-for-render-sounds-test'))).toBe(false);
  });
});

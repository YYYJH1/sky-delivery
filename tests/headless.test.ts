import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runDays, runMetrics } from '../src/core/index.ts';
import { average, displayWidth, formatTable, parseSeeds } from '../tools/headless-lib.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function headless(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/headless.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('无头脚本的小工具', () => {
  it('解析种子列表', () => {
    expect(parseSeeds('42-46')).toEqual([42, 43, 44, 45, 46]);
    expect(parseSeeds('1,5,9')).toEqual([1, 5, 9]);
    expect(parseSeeds('42-44, 50,43')).toEqual([42, 43, 44, 50]);
    expect(() => parseSeeds('')).toThrow();
    expect(() => parseSeeds('a')).toThrow();
    expect(() => parseSeeds('9-3')).toThrow();
  });

  it('表格按显示宽度对齐，汉字占两格', () => {
    expect(displayWidth('准时%')).toBe(5);
    const text = formatTable(['种子', '准时%'], [['42', '80.0'], ['均值', '7.5']]);
    const widths = text.split('\n').map(displayWidth);
    expect(new Set(widths).size).toBe(1);
    expect(text.split('\n')[1]).toMatch(/^-+ +-+$/);
  });

  it('取平均时 NaN 不参与', () => {
    expect(average([1, Number.NaN, 3])).toBe(2);
    expect(average([Number.NaN])).toBeNaN();
  });
});

describe('npm run headless', () => {
  it('运行指定的场景和规则，打印每个种子一行加均值，并写出 JSON', () => {
    const file = join(ROOT, 'out', `test-headless-${process.pid}.json`);
    try {
      const r = headless([
        '--scenario', 'oldStreet', '--drones', '2', '--rate', '12', '--select', 'deadline', '--zone', 'global',
        '--gate', '1.2', '--days', '2', '--seeds', '42-44', '--detail', '--json', file,
      ]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const lines = r.stdout.split('\n');
      const rows = lines.filter((l) => /^(42|43|44|均值)\s/.test(l));
      expect(rows.length).toBe(4 * 3); // 主表、运行指标、高峰小结各四行
      expect(r.stdout).toContain('快超时的先送(deadline)');
      expect(r.stdout).toContain('指标取第 2 天起的平均');
      expect(r.stdout).toContain('高峰小结');

      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        config: { drones: number; rules: { select: string } };
        seeds: number[];
        mean: { day: { onTimeRate: number; districts: { onTimeRate: number | null }[] } };
        perSeed: { seed: number; mean: { day: { onTimeRate: number; revenue: number } } }[];
      };
      expect(json.seeds).toEqual([42, 43, 44]);
      expect(json.config.drones).toBe(2);
      expect(json.config.rules.select).toBe('deadline');
      expect(json.perSeed.map((p) => p.seed)).toEqual([42, 43, 44]);
      expect(json.mean.day.districts[1]?.onTimeRate).toBeNull(); // 没有订单的片区写成 null
      // 与直接调用核心的结果一致
      const direct = runMetrics(runDays({ scenario: 'oldStreet', drones: 2, peakRate: 12, gateInterval: 1.2, seed: 43, rules: { select: 'deadline', zone: 'global' } }, 2), 2);
      expect((json.perSeed[1] as { mean: { day: { onTimeRate: number; revenue: number } } }).mean.day.onTimeRate).toBeCloseTo(direct.mean.day.onTimeRate, 12);
      expect((json.perSeed[1] as { mean: { day: { onTimeRate: number; revenue: number } } }).mean.day.revenue).toBeCloseTo(direct.mean.day.revenue, 9);
      const seedMean = json.perSeed.reduce((a, p) => a + p.mean.day.onTimeRate, 0) / 3;
      expect(json.mean.day.onTimeRate).toBeCloseTo(seedMean, 12);
    } finally {
      rmSync(file, { force: true });
      try {
        rmdirSync(dirname(file)); // 空目录一并删掉；里面还有别的文件时保留
      } catch {
        // 目录非空或已不存在
      }
    }
  });

  it('--pool 和 --capacity 指定一趟送几单的卡和载量，输出里有每单飞行距离、空飞和同乘', () => {
    const file = join(ROOT, 'out', `test-headless-pool-${process.pid}.json`);
    try {
      const r = headless([
        '--scenario', 'threeDistricts', '--drones', '16', '--rate', '82', '--select', 'deadline', '--zone', 'hybrid',
        '--pool', 'any', '--capacity', '2', '--gate', '0.8', '--days', '2', '--seeds', '42-43', '--detail', '--json', file,
      ]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('顺路的一起送(any)');
      expect(r.stdout).toContain('等 10 秒再帮(hybrid)');
      expect(r.stdout).toContain('载量 2');
      expect(r.stdout).toContain('每单飞行距离');
      expect(r.stdout).toContain('空飞%');
      expect(r.stdout).toContain('同乘%');
      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        config: { capacity: number; rules: { pool: string; zone: string } };
        mean: { day: { distPerOrder: number; emptyShare: number; sharedRate: number; districts: { revenue: number }[] } };
      };
      expect(json.config.capacity).toBe(2);
      expect(json.config.rules.pool).toBe('any');
      expect(json.mean.day.distPerOrder).toBeGreaterThan(500);
      expect(json.mean.day.emptyShare).toBeGreaterThan(0.3);
      expect(json.mean.day.emptyShare).toBeLessThan(0.8);
      expect(json.mean.day.sharedRate).toBeGreaterThan(0.1);
      expect(json.mean.day.districts.every((d) => d.revenue > 0)).toBe(true);
    } finally {
      rmSync(file, { force: true });
      try {
        rmdirSync(dirname(file));
      } catch {
        // 目录非空或已不存在
      }
    }
  });

  it('各栏的可选值从注册表读：新卡不用改脚本就能用，帮助里列出全部卡', () => {
    const help = headless(['--help']).stdout;
    for (const id of ['roundtrip', 'prioOld', 'prioOffice', 'prioCampus', 'hybrid', 'same', 'any']) expect(help).toContain(id);
    for (const [select, zone, pool] of [['roundtrip', 'global', 'single'], ['prioOffice', 'hybrid', 'same'], ['prioCampus', 'strict', 'any']]) {
      const r = headless(['--scenario', 'threeDistricts', '--drones', '8', '--rate', '40', '--select', select as string, '--zone', zone as string, '--pool', pool as string, '--capacity', '2', '--days', '1', '--seeds', '42']);
      expect(r.stderr, `${select} ${zone} ${pool}`).toBe('');
      expect(r.status, `${select} ${zone} ${pool}`).toBe(0);
    }
  });

  it('参数不合法时给出提示，退出码为 2', () => {
    for (const args of [['--select', 'nope'], ['--layout', 'three'], ['--days', '0'], ['--seeds', 'x'], ['--drones', 'many'], ['--bogus'], ['--pool', 'nope'], ['--capacity', '0'], ['--capacity', 'two']]) {
      const r = headless(args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr.length).toBeGreaterThan(0);
    }
    expect(headless(['--scenario', 'oldStreet', '--layout', 'three']).status).toBe(2);
  });

  it('--help 打印用法', () => {
    const r = headless(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--scenario');
    expect(r.stdout).toContain('--seeds');
  });
});

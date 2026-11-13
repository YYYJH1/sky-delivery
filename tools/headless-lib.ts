// 无头脚本用的小工具：种子列表解析、取平均、表格排版。
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿＀-｠￠-￦]/;

/** 终端里的显示宽度：汉字和全角符号占两格。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

function pad(text: string, width: number, right: boolean): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return right ? fill + text : text + fill;
}

/** 等宽表格：第一列左对齐，其余右对齐，列间两个空格，表头下一条横线。 */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, c) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[c] ?? ''))));
  const line = (cells: readonly string[]): string =>
    cells.map((cell, c) => pad(cell, widths[c] as number, c > 0)).join('  ');
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), rule, ...rows.map(line)].join('\n');
}

/** 解析种子列表，写法如 "42,43,44" 或 "42-46" 或 "42-44,50"。 */
export function parseSeeds(text: string): number[] {
  const seeds: number[] = [];
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (hi < lo || hi - lo >= 1000) throw new RangeError(`bad seed range "${part}"`);
      for (let s = lo; s <= hi; s++) seeds.push(s);
    } else if (/^\d+$/.test(part)) {
      seeds.push(Number(part));
    } else {
      throw new RangeError(`bad seed "${part}"`);
    }
  }
  if (seeds.length === 0) throw new RangeError('no seeds given');
  return [...new Set(seeds)];
}

/** 平均，NaN 不参与；全是 NaN 时为 NaN。 */
export function average(values: readonly number[]): number {
  const valid = values.filter((v) => !Number.isNaN(v));
  return valid.length === 0 ? Number.NaN : valid.reduce((a, b) => a + b, 0) / valid.length;
}

export function percent(v: number): string {
  return Number.isNaN(v) ? '-' : (v * 100).toFixed(1);
}

export function fixed(v: number, digits = 1): string {
  return Number.isNaN(v) ? '-' : v.toFixed(digits);
}

/** JSON 里没有 NaN 和 Infinity，写成 null。 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}

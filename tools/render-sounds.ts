// 把游戏里的全部声音合成出来，存成 WAV 文件，方便用耳机试听，并打印每个声音的时长、峰值和响度。
// 声音全部由 src/audio 里的代码合成，不用任何音频文件。
//
// 用法：node --disable-warning=ExperimentalWarning tools/render-sounds.ts --out <目录> [--rate 44100] [--only takeoff,ambientDay]
//
// 每个音效存成 <名字>.wav。每条环境声存两份：<名字>.wav 是一遍循环，<名字>-x3.wav 是同一遍接了三次，用来听首尾的接缝。
// 响度栏：峰值是最大的采样（线性和分贝），均方根是整段的平均响度，有声段是只算比最响处低 40 分贝以内的那些 10 毫秒块，
// 首尾差是环境声第一个和最后一个采样的差，除以全程相邻采样差的均方根，接近 1 或更小说明接缝和别处一样平滑。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AMBIENT_RATE } from '../src/audio/ambient.ts';
import { AMBIENT_IDS, SOUND_IDS, renderAmbient, renderSound } from '../src/audio/catalog.ts';
import { activeRms, peakOf, rmsOf, toDecibels } from '../src/audio/dsp.ts';
import { encodeWav } from '../src/audio/wav.ts';

const HELP = `用法：node --disable-warning=ExperimentalWarning tools/render-sounds.ts --out <目录> [选项]

  --out <目录>     WAV 文件存到这里（必填，目录不存在时会建）
  --rate <赫兹>    音效的采样率，默认 44100。环境声固定用 ${AMBIENT_RATE}
  --only <名字,…>  只渲染这几个声音，用逗号隔开。名字见下
  --help           显示本说明

声音：${[...SOUND_IDS, ...AMBIENT_IDS].join('，')}
`;

interface Row {
  readonly id: string;
  readonly seconds: number;
  readonly peak: number;
  readonly rms: number;
  readonly active: number;
  readonly seam: number | null;
}

function db(value: number): string {
  return Number.isFinite(toDecibels(value)) ? toDecibels(value).toFixed(1) : '-inf';
}

/** 首尾两个采样的差，除以全程相邻采样差的均方根。 */
function seamRatio(samples: Float32Array): number {
  let sum = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = (samples[i] as number) - (samples[i - 1] as number);
    sum += d * d;
  }
  const typical = Math.sqrt(sum / Math.max(1, samples.length - 1));
  return typical === 0 ? 0 : Math.abs((samples[0] as number) - (samples[samples.length - 1] as number)) / typical;
}

function measure(id: string, samples: Float32Array, sampleRate: number, loop: boolean): Row {
  return {
    id,
    seconds: samples.length / sampleRate,
    peak: peakOf(samples),
    rms: rmsOf(samples),
    active: activeRms(samples, sampleRate),
    seam: loop ? seamRatio(samples) : null,
  };
}

/** 显示宽度：汉字和全角符号算两格。 */
function cells(text: string): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) as number) > 0x2e80 ? 2 : 1;
  return width;
}

function printTable(rows: readonly Row[]): void {
  const head = ['声音', '时长(秒)', '峰值', '峰值(dBFS)', '均方根(dBFS)', '有声段(dBFS)', '首尾差'];
  const lines = rows.map((r) => [r.id, r.seconds.toFixed(2), r.peak.toFixed(3), db(r.peak), db(r.rms), db(r.active), r.seam === null ? '-' : r.seam.toFixed(2)]);
  const widths = head.map((h, i) => Math.max(cells(h), ...lines.map((l) => cells(l[i] as string))));
  const pad = (row: readonly string[]): string => row.map((c, i) => c + ' '.repeat((widths[i] as number) - cells(c))).join('  ').trimEnd();
  console.log(pad(head));
  for (const line of lines) console.log(pad(line));
}

function main(): number {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, rate: { type: 'string' }, only: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help === true) {
    console.log(HELP);
    return 0;
  }
  if (values.out === undefined || values.out === '') {
    console.error('缺少 --out <目录>。\n');
    console.error(HELP);
    return 2;
  }
  const rate = values.rate === undefined ? 44100 : Number(values.rate);
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) {
    console.error(`--rate 要是 8000 到 192000 之间的整数，收到 ${values.rate ?? ''}`);
    return 2;
  }
  const known = new Set<string>([...SOUND_IDS, ...AMBIENT_IDS]);
  const only = values.only === undefined ? null : new Set(values.only.split(',').map((s) => s.trim()).filter((s) => s !== ''));
  if (only !== null) {
    const unknown = [...only].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      console.error(`不认识的声音：${unknown.join('，')}`);
      return 2;
    }
  }
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });

  const rows: Row[] = [];
  for (const id of SOUND_IDS) {
    if (only !== null && !only.has(id)) continue;
    const samples = renderSound(id, rate);
    writeFileSync(join(out, `${id}.wav`), encodeWav(samples, rate));
    rows.push(measure(id, samples, rate, false));
  }
  for (const id of AMBIENT_IDS) {
    if (only !== null && !only.has(id)) continue;
    const samples = renderAmbient(id);
    writeFileSync(join(out, `${id}.wav`), encodeWav(samples, AMBIENT_RATE));
    const joined = new Float32Array(samples.length * 3);
    for (let k = 0; k < 3; k++) joined.set(samples, k * samples.length);
    writeFileSync(join(out, `${id}-x3.wav`), encodeWav(joined, AMBIENT_RATE));
    rows.push(measure(id, samples, AMBIENT_RATE, true));
  }
  printTable(rows);
  console.log(`\n已写入 ${out}`);
  return 0;
}

process.exitCode = main();

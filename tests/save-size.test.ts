// 存档的大小：订单在状态里只增不减（首版不清理已结束的订单），存档随游戏天数一路变大。
// 写进存储的存档先压缩，网页版放在容量大得多的 IndexedDB 里。这个测试运行 10、20、30 个游戏日，
// 报告压缩前后的字节数和四份存档合计的大小，并检查存读往返之后状态的哈希相同。
// 不断言增长的快慢：以后清理订单、数字变小是预期的变化，不应该让这个测试失败。
import { describe, expect, it } from 'vitest';
import { DAY_STEPS, advance, createState, hashState } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import { MAX_SAVE_CHARS, MemoryStore, decodeSaveCode, encodeSaveCode, loadGame, parseStoredSave, saveGame, serializeSave } from '../src/save/index.ts';
import { playGame } from '../tools/autoplay-lib.ts';
import { CITY } from './helpers.ts';
import { WALL } from './save-helpers.ts';

/** localStorage 的容量，字符数。浏览器大多是 5M 个字符上下，这里取 5,000,000。 */
const LOCAL_STORAGE_CHARS = 5_000_000;

interface Row {
  days: number;
  orders: number;
  jsonChars: number;
  packedBytes: number;
  fourSlotChars: number;
  fourSlotRawChars: number;
  serializeMs: number;
  saveMs: number;
  loadMs: number;
}

/** 把状态存四次（主存档加三份备份都有了），量大小和耗时，再读回来核对哈希。 */
async function measure(state: SimState, days: number): Promise<Row> {
  const t0 = performance.now();
  const serialized = serializeSave(state, WALL);
  const serializeMs = performance.now() - t0;
  if (!serialized.ok) throw new Error(serialized.reason.message);

  const store = new MemoryStore();
  let packedBytes = 0;
  let saveMs = 0;
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    const outcome = await saveGame(store, state, WALL + i);
    saveMs = performance.now() - t;
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.packed).toBe(true);
    packedBytes = outcome.bytes;
  }
  let fourSlotChars = 0;
  for (const key of await store.keys()) fourSlotChars += ((await store.get(key)) as string).length;

  const t1 = performance.now();
  const loaded = await loadGame(store, WALL + 10);
  const loadMs = performance.now() - t1;
  expect(loaded.status).toBe('ok');
  expect(loaded.state && hashState(loaded.state)).toBe(hashState(state));

  // 导出码也走一遍：和存储里的主存档是同一种写法
  const code = await encodeSaveCode(state, WALL + 3);
  expect(code.ok && code.code).toBe(await store.get('sky-delivery.main'));
  const back = await decodeSaveCode(code.ok ? code.code : '');
  expect(back.ok && hashState(back.state)).toBe(hashState(state));
  const direct = await parseStoredSave(serialized.text);
  expect(direct.ok && hashState(direct.state)).toBe(hashState(state));

  return {
    days,
    orders: state.orders.length,
    jsonChars: serialized.text.length,
    packedBytes,
    fourSlotChars,
    fourSlotRawChars: serialized.text.length * 4,
    serializeMs,
    saveMs,
    loadMs,
  };
}

function format(row: Row): string {
  const mib = (n: number): string => (n / 1024 / 1024).toFixed(2);
  return (
    `第 ${String(row.days).padStart(2)} 天  订单 ${String(row.orders).padStart(5)} 张` +
    `  JSON ${String(row.jsonChars).padStart(8)} 字符（${mib(row.jsonChars)} MiB）` +
    `  压缩后 ${String(row.packedBytes).padStart(7)} 字节（${mib(row.packedBytes)} MiB，${(row.jsonChars / row.packedBytes).toFixed(1)} 倍）` +
    `  四份合计 ${String(row.fourSlotChars).padStart(8)} 字符（不压缩是 ${row.fourSlotRawChars}）` +
    `  序列化 ${row.serializeMs.toFixed(0)} 毫秒  保存 ${row.saveMs.toFixed(0)} 毫秒  读档 ${row.loadMs.toFixed(0)} 毫秒`
  );
}

describe('存档的大小', () => {
  it('经营模式，均衡玩法，运行 10、20、30 个游戏日：压缩前后的大小，四份合计的大小，存读往返哈希相同', { timeout: 120_000 }, async () => {
    const rows: Row[] = [];
    for (const days of [10, 20, 30]) {
      const { state } = playGame('balanced', 42, { days });
      expect(Math.floor(state.step / DAY_STEPS)).toBe(days);
      rows.push(await measure(state, days));
    }
    for (const row of rows) {
      expect(row.jsonChars).toBeGreaterThan(100_000);
      expect(row.jsonChars).toBeLessThan(MAX_SAVE_CHARS);
      // 压缩有明显的效果
      expect(row.jsonChars / row.packedBytes).toBeGreaterThan(3);
      // 压缩之后，四份存档合计放得进 localStorage 的容量，到 30 天都是
      expect(row.fourSlotChars).toBeLessThan(LOCAL_STORAGE_CHARS);
    }
    // 不压缩时，20 天以后四份合计就超过了 localStorage 的容量：这是改用 IndexedDB 的原因
    expect((rows[1] as Row).fourSlotRawChars).toBeGreaterThan(LOCAL_STORAGE_CHARS);
    console.log(`\n经营模式存档的大小（均衡玩法，订单种子 42）\n${rows.map(format).join('\n')}\n`);
  });

  it('沙盒模式，三片区、16 架飞机、每分钟 68 单：压缩比大于 3，四份存档合计小于 localStorage 的容量', { timeout: 120_000 }, async () => {
    const state = createState(CITY);
    expect(CITY.drones).toBe(16);
    expect(CITY.peakRate).toBe(68);
    const rows: Row[] = [];
    for (const days of [10, 20, 30]) {
      advance(state, days * DAY_STEPS - state.step);
      rows.push(await measure(state, days));
    }
    for (const row of rows) {
      expect(row.jsonChars / row.packedBytes).toBeGreaterThan(3);
      expect(row.fourSlotChars).toBeLessThan(LOCAL_STORAGE_CHARS);
    }
    console.log(`\n沙盒存档的大小（${CITY.scenario}，${CITY.drones} 架飞机，每分钟 ${CITY.peakRate} 单，时限优先，全站协同）\n${rows.map(format).join('\n')}\n`);
  });
});

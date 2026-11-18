// 存档的格式、校验和版本迁移。
import { describe, expect, it } from 'vitest';
import { CONTENT_VERSION as contentTableVersion } from '../src/content/version.ts';
import { createState, hashState } from '../src/core/index.ts';
import type { SimState } from '../src/core/index.ts';
import {
  CONTENT_VERSION,
  MAX_SAVE_CHARS,
  MIGRATIONS,
  NON_FINITE_ALLOWED,
  SAVE_FORMAT,
  SAVE_VERSION,
  SIM_STATE_SHAPE,
  fields,
  migrateSave,
  nullable,
  obj,
  parseSave,
  parseSaveData,
  serializeSave,
  validateSaveData,
} from '../src/save/index.ts';
import type { FailureCode, FormatOptions, Migration, MigrationTable, SaveData } from '../src/save/index.ts';
import { customWorld } from './helpers.ts';
import { BUSY, WALL, runState } from './save-helpers.ts';

const STATE: SimState = runState(BUSY, 3000);

function text(state: SimState = STATE, savedAt = WALL, options?: FormatOptions): string {
  const result = serializeSave(state, savedAt, options);
  if (!result.ok) throw new Error(`serialize failed: ${result.reason.message}`);
  return result.text;
}

/** 解析存档文本，改一下，再写回文本。 */
function tampered(edit: (save: Record<string, unknown>) => void): string {
  const save = JSON.parse(text()) as Record<string, unknown>;
  edit(save);
  return JSON.stringify(save);
}

function failCode(input: string, options?: FormatOptions): FailureCode {
  const result = parseSave(input, options);
  if (result.ok) throw new Error('expected the save to be rejected');
  return result.reason.code;
}

describe('存档格式', () => {
  it('开头依次是格式标识、版本号、内容版本、保存时间，然后是完整的状态', () => {
    const head = text().slice(0, 150);
    expect(head).toMatch(
      new RegExp(`^\\{"format":"${SAVE_FORMAT}","version":${SAVE_VERSION},"contentVersion":${CONTENT_VERSION},"savedAt":${WALL},"state":\\{"config":\\{`),
    );
    expect(SAVE_VERSION).toBe(4);
    expect(Number.isInteger(CONTENT_VERSION)).toBe(true);
    expect(Number.isInteger(SAVE_VERSION)).toBe(true);
  });

  it('写出去再读回来，状态完全相同，哈希也相同', () => {
    const result = parseSave(text());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual(STATE);
    expect(hashState(result.state)).toBe(hashState(STATE));
    expect(result.savedAt).toBe(WALL);
    expect(result.version).toBe(SAVE_VERSION);
    expect(result.contentVersion).toBe(CONTENT_VERSION);
    expect(result.contentChanged).toBe(false);
    expect(result.migratedFrom).toBeNull();
  });

  it('保存时间由调用方传入，同一个状态传不同的时间得到不同的文本，其余部分相同', () => {
    const a = text(STATE, WALL);
    const b = text(STATE, WALL + 5);
    expect(a).not.toBe(b);
    expect(a.replace(`"savedAt":${WALL}`, '')).toBe(b.replace(`"savedAt":${WALL + 5}`, ''));
  });

  it('保存时间不是数字时拒绝写出', () => {
    const result = serializeSave(STATE, Number.NaN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe('non-finite');
  });

  it('存档里的内容版本是内容表的版本号，一个整数', () => {
    expect(CONTENT_VERSION).toBe(contentTableVersion);
    const result = parseSave(text());
    expect(result.ok && result.contentVersion).toBe(contentTableVersion);
  });

  it('内容版本与当前不同时，照常读，读回来的结果里标出 contentChanged，状态原样', () => {
    const old = text(STATE, WALL, { contentVersion: 0 });
    const result = parseSave(old);
    expect(result.ok && result.contentVersion).toBe(0);
    expect(result.ok && result.contentChanged).toBe(true);
    expect(result.ok && result.state).toEqual(STATE);
    // 当前的内容版本也是 0 时，就没有变
    const same = parseSave(old, { contentVersion: 0 });
    expect(same.ok && same.contentChanged).toBe(false);
    // 比当前新的内容版本同样照常读
    const newer = parseSave(text(STATE, WALL, { contentVersion: contentTableVersion + 5 }));
    expect(newer.ok && newer.contentChanged).toBe(true);
  });

  it('超长的文本直接拒绝，不去解析', () => {
    expect(failCode('x'.repeat(MAX_SAVE_CHARS + 1))).toBe('size');
  });

  it('开局的新状态、手工摆的地图（累计权重为空）也能存能读', () => {
    const fresh = createState({ ...BUSY, seed: 5 });
    expect(parseSave(text(fresh)).ok).toBe(true);
    const custom = createState({ scenario: 'oldStreet' }, customWorld('oldStreet', [[100, 100]], [[300, 300]]));
    const back = parseSave(text(custom));
    expect(back.ok && back.state).toEqual(custom);
  });
});

describe('校验：字段表', () => {
  it('状态的每一个顶层字段缺失，都能指出缺的是哪一个', () => {
    for (const key of Object.keys(SIM_STATE_SHAPE)) {
      const input = tampered((save) => {
        delete (save.state as Record<string, unknown>)[key];
      });
      const result = parseSave(input);
      expect(result.ok, `缺 ${key}`).toBe(false);
      if (result.ok) continue;
      expect(result.reason.code).toBe('schema');
      expect(result.reason.issues[0]?.path).toBe(`state.${key}`);
    }
  });

  it('外层字段缺失或类型不对', () => {
    for (const key of ['format', 'version', 'contentVersion', 'savedAt', 'state']) {
      const input = tampered((save) => {
        delete save[key];
      });
      expect(parseSave(input).ok, `缺 ${key}`).toBe(false);
    }
    expect(failCode(tampered((save) => (save.contentVersion = 'v1')))).toBe('schema');
    expect(failCode(tampered((save) => (save.contentVersion = 1.5)))).toBe('schema');
    expect(failCode(tampered((save) => (save.savedAt = '昨天')))).toBe('schema');
    expect(failCode(tampered((save) => (save.state = [])))).toBe('schema');
  });

  // 路径、把它改成什么、期望的失败类型
  const FIELD_CASES: [string, unknown, FailureCode][] = [
    ['state.step', null, 'non-finite'],
    ['state.step', -1, 'schema'],
    ['state.step', 1.5, 'schema'],
    ['state.config.drones', '16', 'schema'],
    ['state.config.constantRate', 0, 'schema'],
    ['state.rules.select', 3, 'schema'],
    ['state.rng.orders.a', null, 'non-finite'],
    ['state.stations[0].bays', null, 'non-finite'],
    ['state.stations[0].queue', {}, 'schema'],
    ['state.drones[0].battery', null, 'non-finite'],
    ['state.drones[0].route', 'none', 'schema'],
    ['state.drones[0].returning', 'yes', 'schema'],
    ['state.orders[0].amount', null, 'non-finite'],
    ['state.orders[0].status', 'done', 'schema'],
    ['state.orders[0].early', null, 'schema'],
    ['state.pending', 7, 'schema'],
    ['state.stats.landWait[0][0]', null, 'non-finite'],
    ['state.stats.early', {}, 'schema'],
    ['state.world.digest', 9, 'schema'],
    ['state.world.merchants[0].x', null, 'non-finite'],
    ['state.world.cumWeights[0][0]', null, 'non-finite'],
  ];

  it.each(FIELD_CASES)('把 %s 改成 %j：不通过，类型是 %s，并指出这个字段', (path, value, code) => {
    const input = tampered((save) => {
      const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
      let node = save as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
      node[keys[keys.length - 1] as string] = value;
    });
    const result = parseSave(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.code).toBe(code);
    expect(result.reason.issues.map((issue) => issue.path)).toContain(path);
  });

  it('去掉订单、飞机、站点里的某个字段，指出是哪条记录的哪个字段', () => {
    const input = tampered((save) => {
      const state = save.state as { orders: Record<string, unknown>[]; drones: Record<string, unknown>[]; stations: Record<string, unknown>[] };
      delete state.orders[3]?.tDeliver;
      delete state.drones[1]?.battery;
      delete state.stations[0]?.gateFree;
    });
    const result = parseSave(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.issues.map((issue) => issue.path).sort()).toEqual(['state.drones[1].battery', 'state.orders[3].tDeliver', 'state.stations[0].gateFree'].sort());
  });

  it('字段表之外多出来的字段放行', () => {
    const input = tampered((save) => {
      (save.state as Record<string, unknown>).settings = { volume: 3 };
      ((save.state as { orders: Record<string, unknown>[] }).orders[0] as Record<string, unknown>).newField = 'x';
    });
    expect(parseSave(input).ok).toBe(true);
  });

  it('不检查编号和下标的对应：订单的编号可以不等于它在数组里的下标（清理已结束的订单之后就是这样）', () => {
    const input = tampered((save) => {
      const orders = (save.state as { orders: unknown[] }).orders;
      orders.splice(0, 5);
    });
    expect(parseSave(input).ok).toBe(true);
  });
});

describe('校验：深度扫描全部数字', () => {
  it('内存里的状态有 NaN：拒绝写出，指出字段', () => {
    const state = structuredClone(STATE);
    (state.drones[2] as { battery: number }).battery = Number.NaN;
    const result = serializeSave(state, WALL);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.code).toBe('non-finite');
    expect(result.reason.issues[0]?.path).toBe('state.drones[2].battery');
  });

  it('Infinity 和 -Infinity 同样拒绝，在深处的数组里也能找到', () => {
    const a = structuredClone(STATE);
    a.stats.flightTotal.push(Number.POSITIVE_INFINITY);
    const b = structuredClone(STATE);
    (b.stats.landWait[0] as number[])[3] = Number.NEGATIVE_INFINITY;
    for (const [state, path] of [
      [a, `state.stats.flightTotal[${a.stats.flightTotal.length - 1}]`],
      [b, 'state.stats.landWait[0][3]'],
    ] as const) {
      const result = serializeSave(state, WALL);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.issues.map((issue) => issue.path)).toContain(path);
    }
  });

  it('文本里的 1e999 解析出来是 Infinity，也要拦下来', () => {
    const input = text().replace(/"battery":[\d.]+/, '"battery":1e999');
    expect(input).toContain('1e999');
    const result = parseSave(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe('non-finite');
      expect(result.reason.issues[0]?.path).toMatch(/^state\.drones\[\d+\]\.battery$/);
    }
  });

  it('文本里直接写 NaN 不是合法的 JSON', () => {
    expect(failCode(text().replace(/"battery":[\d.]+/, '"battery":NaN'))).toBe('parse');
  });

  it('NaN 经过 JSON 变成 null，在数字字段里按数字坏了报告', () => {
    const state = structuredClone(STATE);
    (state.orders[4] as { amount: number }).amount = Number.NaN;
    const roundTripped = JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION, contentVersion: CONTENT_VERSION, savedAt: WALL, state });
    expect(roundTripped).toContain('"amount":null');
    const result = parseSave(roundTripped);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe('non-finite');
      expect(result.reason.message).toContain('state.orders[4].amount');
    }
  });

  it('字段表之外的字段里的 NaN 也能找到', () => {
    const state = structuredClone(STATE) as SimState & { extra?: unknown };
    state.extra = { deep: [{ x: 1 }, { x: Number.NaN }] };
    const result = serializeSave(state, WALL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.issues[0]?.path).toBe('state.extra.deep[1].x');
  });

  it('JSON 存不下的东西不让写：Map、Set、函数、BigInt、符号、数组里的 undefined', () => {
    const bad: [string, unknown][] = [
      ['map', new Map([[1, 2]])],
      ['set', new Set([1])],
      ['date', new Date(0)],
      ['fn', () => 1],
      ['big', 10n],
      ['sym', Symbol('x')],
      ['hole', [1, undefined, 3]],
      ['typed', new Float64Array(2)],
    ];
    for (const [name, value] of bad) {
      const state = structuredClone(STATE) as SimState & Record<string, unknown>;
      state[name] = value;
      expect(serializeSave(state, WALL).ok, name).toBe(false);
    }
  });

  it('对象里值为 undefined 的字段 JSON 会丢掉，等于没有这个字段，放行', () => {
    const state = structuredClone(STATE) as SimState & Record<string, unknown>;
    state.optionalThing = undefined;
    expect(serializeSave(state, WALL).ok).toBe(true);
  });

  it('嵌套太深或循环引用：按不通过处理，不会卡住或栈溢出', () => {
    const state = structuredClone(STATE) as SimState & Record<string, unknown>;
    state.self = state;
    const cyclic = serializeSave(state, WALL);
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.reason.issues.some((issue) => issue.message.includes('nested deeper'))).toBe(true);

    let deep: unknown = 1;
    for (let i = 0; i < 5000; i++) deep = [deep];
    const state2 = structuredClone(STATE) as SimState & Record<string, unknown>;
    state2.deep = deep;
    expect(serializeSave(state2, WALL).ok).toBe(false);
    // 文本里嵌套 5 万层：不论 JSON.parse 是解析失败还是解出来再被深度限制拦下，都是不通过，不抛出
    const nested = text().replace('"savedAt"', `"deep":${'['.repeat(50000)}${']'.repeat(50000)},"savedAt"`);
    expect(parseSave(nested).ok).toBe(false);
  });

  it('报告的问题条数有上限，整段数组都坏时也不会刷屏或拖慢', () => {
    const state = structuredClone(STATE);
    for (const order of state.orders) (order as { amount: unknown }).amount = 'x';
    const result = serializeSave(state, WALL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.issues.length).toBeLessThanOrEqual(20);
  });
});

describe('校验：放行的字段', () => {
  it('SimState 里没有合法的非有限数字，放行表是空的', () => {
    expect(NON_FINITE_ALLOWED).toEqual([]);
  });

  it('按路径放行：[*] 是任意下标，* 是任意一个键，别的字段仍然拦住', () => {
    const state = structuredClone(STATE);
    state.stats.flightTotal.push(Number.POSITIVE_INFINITY);
    (state.drones[0] as { battery: number }).battery = Number.NaN;
    const save = { format: SAVE_FORMAT, version: SAVE_VERSION, contentVersion: CONTENT_VERSION, savedAt: WALL, state } as unknown as SaveData;
    const paths = (options: FormatOptions): string[] => validateSaveData(save, options).map((issue) => issue.path);
    expect(paths({})).toHaveLength(2);
    expect(paths({ allowNonFinite: ['state.stats.flightTotal[*]'] })).toEqual(['state.drones[0].battery']);
    expect(paths({ allowNonFinite: ['state.drones[*].battery'] })).toEqual([expect.stringMatching(/^state\.stats\.flightTotal\[\d+\]$/)]);
    expect(paths({ allowNonFinite: ['state.stats.*[*]', 'state.drones[*].*'] })).toEqual([]);
    expect(paths({ allowNonFinite: ['state.stats.flightTotal'] })).toHaveLength(2);
  });
});

describe('校验：字段表可以扩充', () => {
  // 以后核心给 SimState 加新的顶层字段时，用同样的办法扩充字段表。这里用一个假的 settings 字段演示
  const settings = obj(fields({ natural: 'day', num: 'money' }));
  const extended = (required: boolean): FormatOptions => ({
    stateCheck: obj({ ...SIM_STATE_SHAPE, settings: required ? settings : nullable(settings) }),
  });
  const withSettings = (value: unknown): SimState => ({ ...structuredClone(STATE), settings: value }) as SimState;

  it('新字段通过检查，读回来原样保留', () => {
    const state = withSettings({ day: 3, money: 125.5 });
    const result = parseSave(text(state, WALL, extended(true)), extended(true));
    expect(result.ok && result.state).toEqual(state);
  });

  it('新字段的类型不对或缺了一项，指出路径', () => {
    const missing = serializeSave(withSettings({ day: 3 }), WALL, extended(true));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason.issues[0]?.path).toBe('state.settings.money');
    const wrong = serializeSave(withSettings({ day: -1, money: 1 }), WALL, extended(true));
    expect(wrong.ok).toBe(false);
  });

  it('字段表要求有这个字段时，没有它的存档不通过；可以为 null 的写法允许 null', () => {
    const bare = text(STATE);
    const required = parseSave(bare, extended(true));
    expect(required.ok).toBe(false);
    if (!required.ok) expect(required.reason.issues[0]?.path).toBe('state.settings');
    expect(parseSave(text(withSettings(null), WALL, extended(false)), extended(false)).ok).toBe(true);
  });

  it('没有扩充时，带新字段的存档照样能读，新字段里的 NaN 也照样被发现', () => {
    expect(parseSave(text(withSettings({ day: 1, money: 2 }), WALL, {})).ok).toBe(true);
    expect(serializeSave(withSettings({ day: 1, money: Number.NaN }), WALL).ok).toBe(false);
  });
});

describe('版本号', () => {
  it('版本号比当前的新：不认识，类型是 newer-version', () => {
    expect(failCode(tampered((save) => (save.version = SAVE_VERSION + 1)))).toBe('newer-version');
    expect(failCode(tampered((save) => (save.version = 99)))).toBe('newer-version');
  });

  it('版本号不是非负整数：类型是 version', () => {
    for (const bad of ['1', 1.5, -1, null, true, [1], {}]) {
      expect(failCode(tampered((save) => (save.version = bad))), JSON.stringify(bad)).toBe('version');
    }
    expect(failCode(tampered((save) => delete save.version))).toBe('version');
  });

  it('版本号降到 0，而正式的迁移表里没有 0 到 1 的一步：类型是 migrate', () => {
    expect(failCode(tampered((save) => (save.version = 0)))).toBe('migrate');
  });

  it('格式标识不对，或者根本不是对象：类型是 format', () => {
    for (const input of ['{}', '[]', '"text"', '5', 'null', '{"format":"other","version":1}', tampered((save) => (save.format = 'x'))]) {
      expect(failCode(input), input.slice(0, 30)).toBe('format');
    }
  });

  it('不是合法的 JSON，或者被截断：类型是 parse', () => {
    const full = text();
    for (const input of ['', 'not json', full.slice(0, 10), full.slice(0, Math.floor(full.length / 2)), full.slice(0, -1)]) {
      expect(failCode(input), input.slice(0, 20)).toBe('parse');
    }
  });

  it('parseSaveData 对不是对象的输入不抛出', () => {
    for (const input of [null, undefined, 3, 'x', [], () => 1]) {
      const result = parseSaveData(input);
      expect(result.ok).toBe(false);
    }
  });
});

describe('版本迁移', () => {
  /**
   * 假的版本 0：状态里的规则那一项叫 ruleSet，版本 1 改名为 rules。
   * 迁移表在测试里注入，正式的迁移表里不留这个假迁移。
   */
  const renameRules: Migration = (data) => {
    const state = data.state as Record<string, unknown>;
    state.rules = state.ruleSet;
    delete state.ruleSet;
    return data;
  };
  const v0 = (): string =>
    tampered((save) => {
      const state = save.state as Record<string, unknown>;
      state.ruleSet = state.rules;
      delete state.rules;
      save.version = 0;
    });

  it('正式的迁移表有 1 到 2、2 到 3、3 到 4 三步：版本 1 是最老的，没有更老的版本', () => {
    expect(Object.keys(MIGRATIONS)).toEqual(['1', '2', '3']);
    expect(SAVE_VERSION).toBe(4);
  });

  it('没有迁移函数时，版本 0 的存档读不进来', () => {
    expect(failCode(v0())).toBe('migrate');
  });

  it('读到版本 0 时先迁移再校验，读回来的状态和原来的完全相同', () => {
    const result = parseSave(v0(), { currentVersion: 1, migrations: { 0: renameRules } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(0);
    expect(result.version).toBe(1);
    expect(result.state).toEqual(STATE);
    expect(hashState(result.state)).toBe(hashState(STATE));
  });

  it('迁移之后仍要通过校验：迁移漏了一项，照样拒绝', () => {
    const lazy: Migration = (data) => data;
    const result = parseSave(v0(), { currentVersion: 1, migrations: { 0: lazy } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.issues.map((issue) => issue.path)).toContain('state.rules');
  });

  it('当前版本的存档不经过迁移', () => {
    const calls: number[] = [];
    const spy: Migration = (data) => {
      calls.push(0);
      return data;
    };
    expect(parseSave(text(), { migrations: { 0: spy } }).ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it('隔了几个版本：从存档的版本起，逐版往上迁，次序不乱', () => {
    const order: number[] = [];
    // 版本 2 才加上 rules.pool 的默认值：第二步依赖第一步已经把 ruleSet 改名
    const table: MigrationTable = {
      0: (data) => {
        order.push(0);
        return renameRules(data);
      },
      1: (data) => {
        order.push(1);
        const rules = (data.state as { rules: Record<string, string> }).rules;
        rules.pool ??= 'single';
        return data;
      },
    };
    const result = parseSave(v0(), { currentVersion: 2, migrations: table });
    expect(result.ok && result.migratedFrom).toBe(0);
    expect(order).toEqual([0, 1]);
    // 版本 1 的存档只走最后一步
    order.length = 0;
    const v1 = text(STATE, WALL, { currentVersion: 1 });
    const second = parseSave(v1, { currentVersion: 2, migrations: table });
    expect(second.ok && second.migratedFrom).toBe(1);
    expect(order).toEqual([1]);
  });

  it('缺少中间的一步、某一步抛出错误、某一步没有返回对象：都是 migrate 失败，不抛出', () => {
    expect(failCode(v0(), { currentVersion: 2, migrations: { 0: renameRules } })).toBe('migrate');
    expect(
      failCode(v0(), {
        migrations: {
          0: () => {
            throw new Error('boom');
          },
        },
      }),
    ).toBe('migrate');
    expect(failCode(v0(), { migrations: { 0: (() => null) as unknown as Migration } })).toBe('migrate');
    const failed = parseSave(v0(), { migrations: { 0: () => { throw new Error('boom'); } } });
    expect(!failed.ok && failed.reason.message).toContain('boom');
  });

  it('migrateSave 单独可用：设置版本号，缺一步时说明缺的是哪一步', () => {
    const data = { version: 0, state: { ruleSet: 1 } } as SaveData;
    const ok = migrateSave(data, 0, 1, { 0: (d) => ({ ...d, extra: true }) });
    expect(ok).toEqual({ ok: true, data: { version: 1, state: { ruleSet: 1 }, extra: true } });
    const missing = migrateSave(data, 0, 3, { 0: (d) => d, 2: (d) => d });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain('from version 1 to 2');
  });
});

// 经营模式的规矩卡表（内容表 rules_v1）：调度台每一栏玩家能选的卡。删掉了「一趟送一单」，
// 没买双层货箱时核心内部仍按一趟送一单运行（这一栏不开放），买下双层货箱时自动换成「顺路的一起送」，沙盒模式不变。
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_RULES_V1 } from '../src/content/rules_v1.ts';
import { createState, quoteCommand, ruleIds, ruleOffered, ruleOpen, setRules } from '../src/core/index.ts';
import type { RuleColumn } from '../src/core/index.ts';
import { campaignOf, expectRejected, must, quietState, withMoney } from './campaign-helpers.ts';
import { OPENING } from './helpers.ts';

describe('经营模式的规矩卡表：调度台里没有「一趟送一单」', () => {
  const COLUMNS: readonly RuleColumn[] = ['select', 'pool', 'zone'];

  it('表里列的是三栏玩家能选的卡：先送哪张单六个编号，一趟送几单只有两张，别的站帮不帮三张', () => {
    expect(CAMPAIGN_RULES_V1).toEqual({
      select: ['fifo', 'deadline', 'roundtrip', 'prioOld', 'prioOffice', 'prioCampus'],
      pool: ['same', 'any'],
      zone: ['global', 'hybrid', 'strict'],
    });
  });

  it('表里每一栏的卡都在核心的规则注册表里，注册表里多出来的只有「一趟送一单」：它仍在注册表里，沙盒模式还用它', () => {
    for (const column of COLUMNS) {
      const registered = ruleIds(column);
      for (const id of CAMPAIGN_RULES_V1[column]) expect(registered, `${column}.${id}`).toContain(id);
      expect(registered.filter((id) => !CAMPAIGN_RULES_V1[column].includes(id))).toEqual(column === 'pool' ? ['single'] : []);
    }
  });

  it('经营模式里只有表里的卡算调度台的卡，开放项全部打开也一样；沙盒模式的卡都算', () => {
    const state = quietState();
    for (const column of COLUMNS) {
      for (const id of ruleIds(column)) {
        const listed = CAMPAIGN_RULES_V1[column].includes(id);
        expect(ruleOffered(state, column, id), `offered ${column}.${id}`).toBe(listed);
        expect(ruleOpen(state, column, id), `open ${column}.${id}`).toBe(listed);
      }
    }
    const sandbox = createState({ ...OPENING });
    for (const column of COLUMNS) {
      for (const id of ruleIds(column)) {
        expect(ruleOffered(sandbox, column, id)).toBe(true);
        expect(ruleOpen(sandbox, column, id)).toBe(true);
      }
    }
  });

  it('开放项全部打开时，换成表里的每一张卡都成功', () => {
    for (const column of COLUMNS) {
      for (const id of CAMPAIGN_RULES_V1[column]) {
        const state = quietState();
        must(state, { type: 'setRules', rules: { [column]: id } });
        expect(state.rules[column], `${column}.${id}`).toBe(id);
      }
    }
  });

  it('换成「一趟送一单」：失败，原因是 ruleLocked，状态不变，只读的报价也一样。和别的栏一起换，整条命令都不执行', () => {
    const state = quietState();
    expectRejected(state, { type: 'setRules', rules: { pool: 'single' } }, 'ruleLocked');
    expect(quoteCommand(state, { type: 'setRules', rules: { pool: 'single' } })).toMatchObject({ ok: false, reason: 'ruleLocked', kind: 'free', price: 0 });
    expectRejected(state, { type: 'setRules', rules: { select: 'deadline', pool: 'single' } }, 'ruleLocked');
    expect(state.rules.select).toBe('fifo');
  });

  it('开局的规矩里这一栏就是 single：没买双层货箱时核心内部按一趟送一单运行，这一栏不开放，表里的两张卡也换不了', () => {
    const state = withMoney(quietState());
    campaignOf(state).unlocks.poolColumn = -1;
    expect(state.rules.pool).toBe('single');
    expect(ruleIds('pool').filter((id) => ruleOpen(state, 'pool', id))).toEqual([]);
    for (const id of ['same', 'any']) expectRejected(state, { type: 'setRules', rules: { pool: id } }, 'ruleLocked');
  });

  it('买下双层货箱：这一栏自动换成「顺路的一起送」，之后只有两张卡可选，换成「一趟送一单」仍然失败', () => {
    const state = withMoney(quietState());
    campaignOf(state).unlocks.poolColumn = -1;
    must(state, { type: 'buyDoubleBox' });
    expect(state.rules.pool).toBe('any');
    expect(ruleIds('pool').filter((id) => ruleOpen(state, 'pool', id))).toEqual(['same', 'any']);
    expectRejected(state, { type: 'setRules', rules: { pool: 'single' } }, 'ruleLocked');
    must(state, { type: 'setRules', rules: { pool: 'same' } });
    must(state, { type: 'setRules', rules: { pool: 'any' } });
    expect(state.rules.pool).toBe('any');
  });

  it('沙盒模式不变：setRules 仍能换成「一趟送一单」', () => {
    const sandbox = createState({ ...OPENING, rules: { pool: 'any' } });
    expect(sandbox.rules.pool).toBe('any');
    setRules(sandbox, { pool: 'single' });
    expect(sandbox.rules.pool).toBe('single');
    expect(sandbox.stats.ruleChanges.map((c) => [c.column, c.from, c.to])).toEqual([['pool', 'any', 'single']]);
  });
});

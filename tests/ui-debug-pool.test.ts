// 调试参数打开「一趟送几单」一栏：经营模式的调度台里没有「一趟送一单」，
// 所以这一栏打开的同时从「一趟送一单」换成「顺路的一起送」，和买下双层货箱一样，调度台才有选中的卡可写。
import { describe, expect, it } from 'vitest';
import { computeBoard } from '../src/ui/board.ts';
import { applyDebug, parseGameParams } from '../src/ui/debug-params.ts';
import { campaignState } from './campaign-helpers.ts';

function debugState(search: string, overrides: Parameters<typeof campaignState>[0] = {}) {
  const state = campaignState(overrides);
  applyDebug(state, parseGameParams(search));
  return state;
}

describe('调试参数打开「一趟送几单」一栏', () => {
  it('unlock=poolColumn：这一栏换成「顺路的一起送」，不记入换卡，调度台收起时写它，不写「一趟送一单」', () => {
    const state = debugState('?unlock=selectColumn,poolColumn');
    expect(state.rules).toEqual({ select: 'fifo', zone: 'global', pool: 'any' });
    expect(state.stats.ruleChanges).toEqual([]);
    expect(computeBoard(state, null)?.picked).toEqual(['先下单的先送', '顺路的一起送']);
  });

  it('unlock=all 也一样', () => {
    const state = debugState('?unlock=all');
    expect(state.rules.pool).toBe('any');
    const board = computeBoard(state, null);
    expect(board?.columns[1]?.cards.map((c) => [c.name, c.selected])).toEqual([['同一家店的一起送', false], ['顺路的一起送', true]]);
  });

  it('开通写字楼区分成两套之后，两套里这一栏都是「顺路的一起送」', () => {
    const state = debugState('?unlock=all&open=1');
    expect(state.campaign?.ruleSets).toEqual({
      noon: { select: 'fifo', zone: 'global', pool: 'any' },
      evening: { select: 'fifo', zone: 'global', pool: 'any' },
    });
  });

  it('没打开这一栏：规矩不动，核心内部仍按一趟送一单运行', () => {
    const state = debugState('?unlock=selectColumn,priceTags');
    expect(state.rules.pool).toBe('single');
    expect(computeBoard(state, null)?.columns[1]).toMatchObject({ locked: true, cards: [] });
    expect(computeBoard(state, null)?.picked).toEqual(['先下单的先送']);
  });

  it('这一栏本来就不是「一趟送一单」：不替玩家换', () => {
    const state = debugState('?unlock=all', { rules: { pool: 'same' } });
    expect(state.rules.pool).toBe('same');
  });

  it('没带调试参数时什么也不改', () => {
    const state = debugState('');
    expect(state.rules).toEqual({ select: 'fifo', zone: 'global', pool: 'single' });
  });
});

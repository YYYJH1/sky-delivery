// 规则注册表：新增一张卡，只需要在对应栏的表里加一项。
import type { RuleColumn } from '../types.ts';
import { POOL_RULES } from './pool.ts';
import { SELECT_RULES } from './select.ts';
import type { PoolRule, SelectRule, ZoneRule } from './types.ts';
import { ZONE_RULES } from './zone.ts';

export const RULE_REGISTRY = {
  select: SELECT_RULES,
  zone: ZONE_RULES,
  pool: POOL_RULES,
} as const;

export function ruleIds(column: RuleColumn): string[] {
  return Object.keys(RULE_REGISTRY[column]);
}

export function hasRule(column: RuleColumn, id: string): boolean {
  return Object.hasOwn(RULE_REGISTRY[column], id);
}

function lookup<T>(column: RuleColumn, table: Readonly<Record<string, T>>, id: string): T {
  const rule = Object.hasOwn(table, id) ? table[id] : undefined;
  if (rule === undefined) throw new RangeError(`column ${column} has no rule ${id}`);
  return rule;
}

export function getSelectRule(id: string): SelectRule {
  return lookup('select', SELECT_RULES, id);
}

export function getZoneRule(id: string): ZoneRule {
  return lookup('zone', ZONE_RULES, id);
}

export function getPoolRule(id: string): PoolRule {
  return lookup('pool', POOL_RULES, id);
}

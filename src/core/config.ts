// 配置：默认值、合并与检查。
import { DEFAULT_CHARGE_TIME, DEFAULT_GATE_INTERVAL } from './constants.ts';
import type { GameMode, LayoutId, ReturnRule, RuleSet, ScenarioId, SimConfig } from './types.ts';

export const SCENARIOS: readonly ScenarioId[] = ['oldStreet', 'threeDistricts', 'sparseOffice'];
export const LAYOUTS: readonly LayoutId[] = ['default', 'single', 'three', 'edge'];
export const MODES: readonly GameMode[] = ['sandbox', 'campaign'];
export const RETURN_RULES: readonly ReturnRule[] = ['home', 'nearest'];

/** 开局配置：老街，一座站，两架飞机。 */
export const DEFAULT_CONFIG: SimConfig = {
  scenario: 'oldStreet',
  layout: 'default',
  mapSeed: 7,
  seed: 42,
  drones: 2,
  extraBays: 0,
  peakRate: 12,
  gateInterval: DEFAULT_GATE_INTERVAL,
  chargeTime: DEFAULT_CHARGE_TIME,
  capacity: 1,
  constantRate: false,
  noonDestinations: false,
  rules: { select: 'fifo', zone: 'global', pool: 'single' },
  orderEndStep: null,
  mode: 'sandbox',
  returnRule: 'home',
};

export type ConfigOverrides = Partial<Omit<SimConfig, 'rules'>> & { rules?: Partial<RuleSet> };

/** 在默认值上合并覆盖项，并检查取值。 */
export function makeConfig(overrides: ConfigOverrides = {}): SimConfig {
  const { rules, ...rest } = overrides;
  const config: SimConfig = {
    ...DEFAULT_CONFIG,
    ...rest,
    rules: { ...DEFAULT_CONFIG.rules, ...rules },
  };
  validateConfig(config);
  return config;
}

function requireInt(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${String(value)}`);
  }
}

export function validateConfig(config: SimConfig): void {
  if (!SCENARIOS.includes(config.scenario)) throw new RangeError(`unknown scenario ${config.scenario}`);
  if (!LAYOUTS.includes(config.layout)) throw new RangeError(`unknown layout ${config.layout}`);
  if (!MODES.includes(config.mode)) throw new RangeError(`unknown mode ${String(config.mode)}`);
  if (!RETURN_RULES.includes(config.returnRule)) throw new RangeError(`unknown return rule ${String(config.returnRule)}`);
  if (config.scenario === 'oldStreet' && config.layout !== 'default' && config.layout !== 'single') {
    throw new RangeError('the old-street-only scenario has a single station: layout must be default or single');
  }
  requireInt('mapSeed', config.mapSeed, -2147483648);
  requireInt('seed', config.seed, -2147483648);
  requireInt('drones', config.drones, 1);
  requireInt('extraBays', config.extraBays, 0);
  requireInt('capacity', config.capacity, 1);
  if (typeof config.constantRate !== 'boolean') throw new RangeError('constantRate must be true or false');
  if (typeof config.noonDestinations !== 'boolean') throw new RangeError('noonDestinations must be true or false');
  if (!(config.peakRate >= 0) || !Number.isFinite(config.peakRate)) throw new RangeError('peakRate must be a finite number >= 0');
  if (!(config.gateInterval >= 0.1)) throw new RangeError('gateInterval must be at least 0.1 seconds');
  if (!(config.chargeTime > 0)) throw new RangeError('chargeTime must be positive');
  if (config.orderEndStep !== null) requireInt('orderEndStep', config.orderEndStep, 0);
}

// 经营模式的开局状态：老街开通，其余片区未开通。老街的第一座站建在开局屋顶上，
// 2 架飞机、2 个停机位，起降口 1 级，载量 1，余额 0，各片区一星。
// 口碑的计数、各项开放、日结和小结的记录、便签都是空的，价签、调度台的栏和卡、新片区都还没有开放。
import { CONTENT_VERSION } from '../../content/version.ts';
import { ECONOMY_V1 } from '../../content/economy_v1.ts';
import { MAP_V1 } from '../../content/map_v1.ts';
import { createRng } from '../rng.ts';
import { createDrones } from '../systems/drones.ts';
import { createStations } from '../systems/stations.ts';
import type { SimConfig, SimState } from '../types.ts';
import type { StationPlan } from '../world.ts';
import { emptyTally } from './fleet.ts';
import { buildCampaignWorld, refreshShops } from './map.ts';
import { lockedUnlocks } from './unlocks.ts';

export function createCampaignState(config: SimConfig): SimState {
  const world = buildCampaignWorld();
  const openingRoof = MAP_V1.roofs.findIndex((r) => r.opening);
  const roof = MAP_V1.roofs[openingRoof];
  if (roof === undefined) throw new Error('the map has no opening roof');
  const plans: StationPlan[] = [{ x: roof.x, y: roof.y, drones: ECONOMY_V1.openingDrones, bays: ECONOMY_V1.baysAtBuild }];
  // 新建的站起降口都是 1 级，间隔取内容表的值，不取配置里沙盒用的 gateInterval
  const stations = createStations(plans, { ...config, gateInterval: ECONOMY_V1.gateSeconds[0] as number });
  const none = { day: -1, paid: 0 };
  const state: SimState = {
    config,
    world,
    step: 0,
    rng: { orders: createRng(config.seed), dispatch: createRng(config.seed + 100000) },
    rules: { ...config.rules },
    capacity: config.capacity,
    returnRule: config.returnRule,
    stations,
    drones: createDrones(plans),
    orders: [],
    pending: [],
    openQueue: [],
    stats: {
      stranded: 0,
      landWait: stations.map(() => []),
      bayEmpty: stations.map(() => []),
      bayTotal: stations.map(() => []),
      early: [],
      ruleChanges: [],
      flightTotal: [],
      flightLoaded: [],
    },
    campaign: {
      contentVersion: CONTENT_VERSION,
      money: ECONOMY_V1.startMoney,
      spent: 0,
      refunded: 0,
      income: [],
      districts: MAP_V1.districts.map((_, k) => ({ open: k === 0, star: 1 })),
      shopOpen: [],
      cumWeights: [],
      roofStation: MAP_V1.roofs.map((_, i) => (i === openingRoof ? 0 : -1)),
      stations: [{ roof: openingRoof, gateLevel: 1, built: { ...none }, bays: [] }],
      drones: Array.from({ length: ECONOMY_V1.openingDrones }, () => ({ ...none })),
      opening: { orders: [], done: false },
      rating: MAP_V1.districts.map(() => ({ misses: 0, noUpgrade: 0 })),
      unlocks: lockedUnlocks(),
      ruleSets: null,
      days: [],
      peaks: [],
      tips: [],
      delivered: 0,
      ending: null,
      goals: null,
      away: [],
      nearestOwned: config.returnRule === 'nearest',
      tally: emptyTally(stations.length),
      forecast: { charges: 0 },
      effectWatches: [],
    },
  };
  refreshShops(state);
  return state;
}

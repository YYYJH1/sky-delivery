// 经营模式的地图：由内容表 map_v1 做成核心用的 World，以及开店之后重算抽店的累计权重。
import { MAP_V1 } from '../../content/map_v1.ts';
import { detExp, detLn } from '../detmath.ts';
import { Hasher } from '../hash.ts';
import type { Building, Merchant, SimState, World } from '../types.ts';
import { DISTANCE_SCALE, HEAT_EXPONENT, SAME_DISTRICT_BONUS, dist } from '../world.ts';

/**
 * 地图 v1 的 World：28 家店、42 栋楼、三个片区的范围。店的热度权重与沙盒相同，按热度名次算。
 * 抽店的累计权重随开张的店变化，放在 state.campaign.cumWeights 里，所以这里的 cumWeights 是空的。
 */
export function buildCampaignWorld(): World {
  const map = MAP_V1;
  const merchants: Merchant[] = map.shops.map((s) => ({
    x: s.x,
    y: s.y,
    district: s.district,
    rank: s.rank,
    weight: detExp(-HEAT_EXPONENT * detLn(s.rank)),
  }));
  const buildings: Building[] = map.buildings.map((b) => ({ x: b.x, y: b.y, district: b.district }));
  const buildingsByDistrict = map.districts.map((_, k) => {
    const idx: number[] = [];
    buildings.forEach((b, i) => {
      if (b.district === k) idx.push(i);
    });
    return idx;
  });
  const world: World = {
    width: map.width,
    height: map.height,
    districts: map.districts.map((d) => ({ ...d })),
    merchants,
    buildings,
    buildingsByDistrict,
    cumWeights: [],
    digest: '',
  };
  world.digest = digestCampaignWorld(world);
  return world;
}

function digestCampaignWorld(world: World): string {
  const h = new Hasher();
  h.str('campaign');
  h.num(MAP_V1.version);
  h.num(world.merchants.length);
  for (const m of world.merchants) {
    h.num(m.x);
    h.num(m.y);
    h.num(m.district);
    h.num(m.rank);
    h.num(m.weight);
  }
  h.num(world.buildings.length);
  for (const b of world.buildings) {
    h.num(b.x);
    h.num(b.y);
    h.num(b.district);
  }
  return h.digest();
}

/**
 * 按片区的开通情况和星级重算哪些店已开张，以及每栋楼对各店的累计抽取权重。
 * 店开张的条件：片区已开通，并且片区的星级不低于这家店的开张星级（地图 v1 的 opensAtStar）。
 * 开张之后不会关：片区掉星时已经开张的店照常营业。
 * 权重与沙盒相同：热度权重 × exp(-距离 / 700) × （同片区加倍），没开张的店权重为 0。
 * 开通片区时调用，日结让片区升星、新店开张时也调用。
 */
export function refreshShops(state: SimState): void {
  const campaign = state.campaign;
  if (campaign === null) throw new Error('refreshShops is only for the campaign mode');
  const { merchants, buildings } = state.world;
  const before = campaign.shopOpen;
  campaign.shopOpen = MAP_V1.shops.map((shop, i) => {
    const district = campaign.districts[shop.district];
    return before[i] === true || (district !== undefined && district.open && district.star >= shop.opensAtStar);
  });
  campaign.cumWeights = buildings.map((b) => {
    let total = 0;
    return merchants.map((s, i) => {
      if (campaign.shopOpen[i]) {
        const bonus = s.district === b.district ? SAME_DISTRICT_BONUS : 1;
        total += s.weight * detExp(-dist(s.x, s.y, b.x, b.y) / DISTANCE_SCALE) * bonus;
      }
      return total;
    });
  });
}

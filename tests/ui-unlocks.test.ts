// 按开放条件显示：价签、双层货箱、写字楼区和大学城的显示与开通价签，没开通的片区没有候选屋顶。
// 开放条件本身在核心里，测试用核心导出的 unlock 打开，不绕过核心。价格取自价格表（ECONOMY_V1），重新校准之后这里不用改。
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { MAP_V1 } from '../src/content/map_v1.ts';
import { applyCommand, isUnlocked, quoteCommand, refreshShops, refreshUnlocks, unlock } from '../src/core/index.ts';
import { worldToScreen } from '../src/render/camera.ts';
import { districtModes } from '../src/render/scene.ts';
import { pickDistrict } from '../src/ui/map-hit.ts';
import { MAP_PLAN, cameraFor, districtBoxes, shopIsOpen } from '../src/ui/map-state.ts';
import { candidateRoofs } from '../src/ui/roofs.ts';
import { openDistrictLabel, openDistrictTags } from '../src/ui/tags.ts';
import { computeUiData, upgradeRows } from '../src/ui/view-model.ts';
import { campaignOf, campaignState, withMoney } from './campaign-helpers.ts';

function data(state: ReturnType<typeof campaignState>): NonNullable<ReturnType<typeof computeUiData>> {
  const d = computeUiData(state);
  if (d === null) throw new Error('no ui data');
  return d;
}

/** 1920×1080 的窗口：地图的画板和镜头。 */
const SURFACE = { board: MAP_PLAN.board, camera: cameraFor({ width: 1920, height: 1080, dpr: 1, uiScale: 1 }) };

describe('价签和改装：开放之前不显示', () => {
  it('开局：整排价签和改装单都不显示，双层货箱的开放项也没打开', () => {
    const d = data(campaignState());
    expect(d.tagsShown).toBe(false);
    expect(d.doubleBoxShown).toBe(false);
  });

  it('价签开放（第一次日结之后余额达到内容表里价签开放的余额）：价签和改装单显示。双层货箱随价签开放，核心检查一次之后开放项就打开', () => {
    const state = campaignState();
    unlock(state, 'priceTags');
    expect(data(state).tagsShown).toBe(true);
    refreshUnlocks(state);
    expect(data(state).doubleBoxShown).toBe(true);
  });

  it('价签出现之后改装单总是列出双层货箱，不看双层货箱的开放项', () => {
    const state = campaignState();
    unlock(state, 'priceTags');
    const d = data(state);
    expect(d.doubleBoxShown).toBe(false);
    expect(upgradeRows(d, null).map((r) => r.key)).toContain('doubleBox');
  });

  it('双层货箱的开放项单独打开：状态跟着变', () => {
    const state = campaignState();
    unlock(state, 'priceTags');
    unlock(state, 'doubleBox');
    expect(data(state).doubleBoxShown).toBe(true);
  });

  it('显示与否只看开放项，跟余额无关：有钱也不显示', () => {
    const state = withMoney(campaignState(), 100_000);
    expect(data(state).tagsShown).toBe(false);
    expect(applyCommand(state, { type: 'buyBay', station: 0 })).toEqual({ ok: false, reason: 'priceTagsLocked' });
  });

  it('就近降落仍按「需要先建成第二个站点」显示，不另加开放条件：只有一座站时是 locked', () => {
    const state = campaignState();
    unlock(state, 'priceTags');
    expect(data(state).nearbyLanding.note).toBe('locked');
  });
});

describe('片区的显示', () => {
  it('开局地图上只有老街：写字楼区和大学城没显示（只露纸色），也没有开通价签', () => {
    const state = campaignState();
    expect(districtModes(state)).toEqual(['open', 'hidden', 'hidden']);
    expect(data(state).openTags).toEqual([]);
  });

  it('showOffice 之后写字楼区显示，仍是没开通的（画淡），大学城还不显示', () => {
    const state = campaignState();
    unlock(state, 'showOffice');
    expect(districtModes(state)).toEqual(['open', 'faded', 'hidden']);
    expect(districtBoxes(state).map((d) => d.open)).toEqual([true, false, false]);
  });

  it('showCampus 之后大学城也显示', () => {
    const state = campaignState();
    unlock(state, 'showOffice');
    unlock(state, 'showCampus');
    expect(districtModes(state)).toEqual(['open', 'faded', 'faded']);
  });

  it('没开通的片区没有候选屋顶，显示出来也一样', () => {
    const state = campaignState();
    unlock(state, 'showOffice');
    expect(candidateRoofs(state).every((c) => c.district === 0)).toBe(true);
    campaignOf(state).districts[1]!.open = true;
    expect(candidateRoofs(state).some((c) => c.district === 1)).toBe(true);
  });

  it('没开通的片区里的店不画：显示出来也不画，开通之后才有', () => {
    const state = campaignState();
    const openShopDistricts = (): number[] => MAP_V1.shops.flatMap((s, i) => (shopIsOpen(state, i) ? [s.district] : []));
    expect(openShopDistricts().every((d) => d === 0)).toBe(true);
    unlock(state, 'showOffice');
    expect(openShopDistricts().every((d) => d === 0)).toBe(true);
    campaignOf(state).districts[1]!.open = true;
    refreshShops(state);
    expect(openShopDistricts().some((d) => d === 1)).toBe(true);
  });

  it('点地图选片区：只认已开通的片区，没开通的和空白处都不是', () => {
    const state = campaignState();
    unlock(state, 'showOffice');
    const at = (x: number, y: number) => worldToScreen(SURFACE.board, SURFACE.camera, x, y);
    const old = at(600, 650);
    const office = at(1850, 520);
    expect(pickDistrict(SURFACE, districtBoxes(state), old.x, old.y)).toBe(0);
    expect(pickDistrict(SURFACE, districtBoxes(state), office.x, office.y)).toBeNull();
    expect(pickDistrict(SURFACE, districtBoxes(state), 2, 2)).toBeNull();
    // 老街和写字楼区之间的河上，不在任何片区里
    const river = at(1250, 650);
    expect(pickDistrict(SURFACE, districtBoxes(state), river.x, river.y)).toBeNull();
    campaignOf(state).districts[1]!.open = true;
    expect(pickDistrict(SURFACE, districtBoxes(state), office.x, office.y)).toBe(1);
  });
});

describe('开通价签', () => {
  it('显示之后、开通之前有一张价签，价格取自价格表，没钱不能开，文字变淡', () => {
    const state = campaignState();
    unlock(state, 'showOffice');
    const tags = openDistrictTags(state);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ district: 1, price: ECONOMY_V1.districtOpenPrice[1], ok: false, dim: true, command: { type: 'openDistrict', district: 1 } });
  });

  it('老街没到三星时，钱够了也不能开通：原因是 needStars，文字不变淡', () => {
    const state = withMoney(campaignState(), ECONOMY_V1.districtOpenPrice[1]! + 100);
    unlock(state, 'showOffice');
    expect(openDistrictTags(state)[0]).toMatchObject({ ok: false, dim: false, reason: 'needStars' });
  });

  it('老街三星、余额够：能开通，点了发 openDistrict，开通之后价签没有了，大学城的价签要等它显示', () => {
    const state = withMoney(campaignState(), ECONOMY_V1.districtOpenPrice[1]!);
    campaignOf(state).districts[0]!.star = 3;
    unlock(state, 'showOffice');
    const tag = openDistrictTags(state)[0]!;
    expect(tag).toMatchObject({ ok: true, dim: false, reason: null, price: ECONOMY_V1.districtOpenPrice[1] });
    expect(applyCommand(state, tag.command)).toEqual({ ok: true, id: 1 });
    expect(openDistrictTags(state)).toEqual([]);
    unlock(state, 'showCampus');
    expect(openDistrictTags(state).map((t) => [t.district, t.price])).toEqual([[2, ECONOMY_V1.districtOpenPrice[2]]]);
  });

  it('价格就是核心报的价', () => {
    const state = campaignState();
    unlock(state, 'showOffice');
    unlock(state, 'showCampus');
    for (const tag of openDistrictTags(state)) expect(tag.price).toBe(quoteCommand(state, tag.command).price);
  });

  it('没显示的片区没有价签：直接发开通命令，核心也拒绝', () => {
    const state = withMoney(campaignState(), 5000);
    campaignOf(state).districts[0]!.star = 3;
    expect(isUnlocked(state, 'showOffice')).toBe(false);
    expect(applyCommand(state, { type: 'openDistrict', district: 1 })).toEqual({ ok: false, reason: 'districtHidden' });
  });

  it('价签上的字：取自词表的「开通{片区} ¥{价格}」，价格取自价格表', () => {
    expect(openDistrictLabel(1, ECONOMY_V1.districtOpenPrice[1]!)).toBe(`开通写字楼区 ¥${ECONOMY_V1.districtOpenPrice[1]}`);
    expect(openDistrictLabel(2, ECONOMY_V1.districtOpenPrice[2]!)).toBe(`开通大学城 ¥${ECONOMY_V1.districtOpenPrice[2]}`);
  });

  it('界面数据里的价签带的就是核心的价格，价签上的字写的就是它', () => {
    const state = campaignState();
    unlock(state, 'showOffice');
    const tag = data(state).openTags[0]!;
    expect(openDistrictLabel(tag.district, tag.price)).toBe(`开通写字楼区 ¥${quoteCommand(state, tag.command).price}`);
  });
});

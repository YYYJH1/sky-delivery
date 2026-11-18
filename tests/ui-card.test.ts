// 站点小卡里新增的两块：最近一场高峰里这座站的一行，本站可购买的三项。
// 数字取自核心记录好的 campaign.peaks，价格取自价格表和核心的算价函数，不写死，价格表重新校准之后这里不用改。
import { describe, expect, it } from 'vitest';
import { ECONOMY_V1 } from '../src/content/economy_v1.ts';
import { UNLOCKS_V1 } from '../src/content/unlocks_v1.ts';
import { advance, bayPrice, dronePrice, gatePrice, hashState } from '../src/core/index.ts';
import type { PeakFleet, PeakRecord, PeakStationRow } from '../src/core/index.ts';
import { buyLines, stationRecent } from '../src/ui/card.ts';
import { gateItem, stationTags } from '../src/ui/tags.ts';
import { campaignOf, campaignState, must, quietState, runningState, withMoney } from './campaign-helpers.ts';

const fleet = (patch: Partial<PeakFleet> = {}): PeakFleet => ({ loaded: 20, empty: 36, work: 24, queue: 3, parked: 17, ...patch });

function row(patch: Partial<PeakStationRow> = {}): PeakStationRow {
  return { station: 0, gateWait: 8.34, landWaitAvg: 1.26, takeoffWaitPct: 22, queuePct: 30, sorties: 23, fleet: fleet(), ...patch };
}

function peak(patch: Partial<PeakRecord> = {}): PeakRecord {
  return {
    day: 0,
    peak: 'noon',
    step: 1800,
    orders: 100,
    onTime: 80,
    late: 15,
    lateOpen: 0,
    cancelled: 5,
    revenue: 500,
    districts: [],
    segments: null,
    select: 'fifo',
    early: 0,
    changedMidPeak: false,
    main: { id: 'noOrders' },
    extra: null,
    cleared: null,
    baseline: null,
    fleet: fleet(),
    fleetBack: 18,
    stations: [row()],
    ...patch,
  };
}

describe('站点小卡：最近一场高峰里这座站的一行', () => {
  it('还没有任何高峰记录：这一块只写暂无高峰记录', () => {
    expect(stationRecent(campaignState(), 0)).toEqual({ kind: 'none', text: '暂无高峰记录' });
  });

  it('有记录：标题是最近一场加高峰名，起降排队秒数和等待降落的平均架数各保留一位小数，派出架次是整数', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak());
    expect(stationRecent(state, 0)).toEqual({
      kind: 'row',
      title: '最近一场午高峰',
      gateWait: '起降排队　8.3 秒',
      landWait: '等待降落　平均 1.3 架',
      sorties: '派出架次　23',
      fleet: expect.objectContaining({ header: '机队时间构成' }),
    });
  });

  it('晚高峰的记录：标题写晚高峰', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak({ peak: 'evening' }));
    expect(stationRecent(state, 0)).toMatchObject({ kind: 'row', title: '最近一场晚高峰' });
  });

  it('保留一位小数：整数补零，不到 0.05 写 0.0，进位正常', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak({ stations: [row({ gateWait: 3, landWaitAvg: 0.04 })] }));
    expect(stationRecent(state, 0)).toMatchObject({ gateWait: '起降排队　3.0 秒', landWait: '等待降落　平均 0.0 架' });
    campaignOf(state).peaks.push(peak({ stations: [row({ gateWait: 12.96, landWaitAvg: 2.5 })] }));
    expect(stationRecent(state, 0)).toMatchObject({ gateWait: '起降排队　13.0 秒', landWait: '等待降落　平均 2.5 架' });
  });

  it('没有从这座站起飞、已经送达的订单：起降排队写无数据', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak({ stations: [row({ gateWait: null })] }));
    expect(stationRecent(state, 0)).toMatchObject({ kind: 'row', gateWait: '起降排队　无数据' });
  });

  it('机队时间构成：五段，文字与小结相同；这座站没有无人机时没有这一行', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak());
    const view = stationRecent(state, 0);
    expect(view.kind === 'row' ? view.fleet?.items.map((i) => i.text) : null).toEqual(['载货飞行 20%', '空载飞行 36%', '作业 24%', '排队 3%', '停放 17%']);
    campaignOf(state).peaks.push(peak({ stations: [row({ fleet: null })] }));
    expect(stationRecent(state, 0)).toMatchObject({ kind: 'row', fleet: null });
  });

  it('取最近一场：更早的记录不用，也不管是哪一天', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak({ day: 0, stations: [row({ sorties: 5 })] }), peak({ day: 3, peak: 'evening', stations: [row({ sorties: 41 })] }));
    expect(stationRecent(state, 0)).toMatchObject({ title: '最近一场晚高峰', sorties: '派出架次　41' });
  });

  it('各座站各取自己的一行', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak({ stations: [row({ station: 0, sorties: 10 }), row({ station: 1, sorties: 7, gateWait: null })] }));
    expect(stationRecent(state, 0)).toMatchObject({ sorties: '派出架次　10' });
    expect(stationRecent(state, 1)).toMatchObject({ sorties: '派出架次　7', gateWait: '起降排队　无数据' });
  });

  it('最近一场的记录里没有这座站（新建的站）：只写暂无高峰记录，不去翻更早的记录', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak({ day: 0, stations: [row({ station: 0 }), row({ station: 1 })] }), peak({ day: 1, stations: [row({ station: 0 })] }));
    expect(stationRecent(state, 1)).toEqual({ kind: 'none', text: '暂无高峰记录' });
    expect(stationRecent(state, 0).kind).toBe('row');
  });

  it('迁移来的旧记录各站的行是空的：只写暂无高峰记录', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak({ stations: [], fleet: null }));
    expect(stationRecent(state, 0)).toEqual({ kind: 'none', text: '暂无高峰记录' });
  });

  it('核心给出的数不是有限数时按 0 写，小卡上不出现 NaN', () => {
    const state = campaignState();
    campaignOf(state).peaks.push(peak({ stations: [row({ gateWait: Number.NaN, landWaitAvg: Number.POSITIVE_INFINITY })] }));
    const view = stationRecent(state, 0);
    expect(view.kind === 'row' ? `${view.gateWait}${view.landWait}` : '').not.toMatch(/NaN|Infinity/);
  });

  it('真实运行：第一场午高峰的小结生成之后，一号站这一行的数就是记录里的数', () => {
    const state = runningState(42);
    advance(state, 1801);
    const record = campaignOf(state).peaks[0]!;
    const own = record.stations.find((r) => r.station === 0)!;
    const view = stationRecent(state, 0);
    expect(view).toMatchObject({ kind: 'row', title: '最近一场午高峰', sorties: `派出架次　${own.sorties}` });
    expect(view.kind === 'row' ? view.landWait : '').toBe(`等待降落　平均 ${own.landWaitAvg.toFixed(1)} 架`);
  });

  it('只读：不改状态', () => {
    const state = runningState(42);
    advance(state, 1801);
    const before = hashState(state);
    const json = JSON.stringify(state);
    stationRecent(state, 0);
    stationRecent(state, 3);
    expect(hashState(state)).toBe(before);
    expect(JSON.stringify(state)).toBe(json);
  });
});

describe('站点小卡：本站可购买', () => {
  /** 这座站现在的三项购买。 */
  const lines = (state: ReturnType<typeof campaignState>, station = 0): ReturnType<typeof buyLines> => buyLines(state, station, stationTags(state, station), gateItem(state, station));

  it('三项：新增停机位、购买无人机、起降口的下一级，名称和价格照价签和改装', () => {
    const state = withMoney(quietState(), 10_000);
    expect(lines(state).map((l) => [l.key, l.text])).toEqual([
      ['bay', `新增停机位 ¥${bayPrice(ECONOMY_V1.baysAtBuild + 1)}`],
      ['drone', `购买无人机 ¥${dronePrice(ECONOMY_V1.openingDrones + 1)}`],
      ['gate', `起降口 2 级 ¥${gatePrice(2)}`],
    ]);
  });

  it('开局的站停机位满了：购买无人机不能买，原因是没有空闲停机位，另两项没有原因', () => {
    const state = withMoney(quietState(), 10_000);
    const [bay, drone, gate] = lines(state);
    expect(bay).toMatchObject({ dim: false, reason: null });
    expect(drone).toMatchObject({ dim: false, reason: '该站点没有空闲停机位' });
    expect(gate).toMatchObject({ dim: false, reason: null });
  });

  it('钱不够：只变淡，不写原因', () => {
    const state = withMoney(quietState(), 10);
    const [bay, drone, gate] = lines(state);
    expect(bay).toMatchObject({ dim: true, reason: null });
    expect(gate).toMatchObject({ dim: true, reason: null });
    // 购买无人机钱也不够，但不是钱的原因在前（停机位满了），变淡之外还写这个原因
    expect(drone).toMatchObject({ dim: true, reason: '该站点没有空闲停机位' });
  });

  it('新增了停机位：购买无人机能买了，没有原因；停机位的价格涨到下一档', () => {
    const state = withMoney(quietState(), 10_000);
    must(state, { type: 'buyBay', station: 0 });
    const [bay, drone] = lines(state);
    expect(bay.text).toBe(`新增停机位 ¥${bayPrice(ECONOMY_V1.baysAtBuild + 2)}`);
    expect(drone).toMatchObject({ dim: false, reason: null });
  });

  it('停机位到了屋顶的上限：新增停机位写已达上限，带上限数', () => {
    const state = withMoney(quietState(), 1_000_000);
    for (let i = ECONOMY_V1.baysAtBuild; i < ECONOMY_V1.bayCap.medium; i++) must(state, { type: 'buyBay', station: 0 }); // 开局的站在中屋顶上
    expect(lines(state)[0]).toMatchObject({ dim: false, reason: `停机位已达上限（${ECONOMY_V1.bayCap.medium} 个）` });
  });

  it('起降口升级之后列下一级；到了 3 级仍列 3 级，写已购买', () => {
    const state = withMoney(quietState(), 100_000);
    must(state, { type: 'upgradeGate', station: 0 });
    expect(lines(state)[2]).toMatchObject({ text: `起降口 3 级 ¥${gatePrice(3)}`, dim: false, reason: null });
    must(state, { type: 'upgradeGate', station: 0 });
    expect(lines(state)[2]).toMatchObject({ text: `起降口 3 级 ¥${gatePrice(3)}`, dim: false, reason: '已购买' });
  });

  it('各座站各算各的', () => {
    const state = withMoney(quietState(), 100_000);
    const second = must(state, { type: 'buildStation', roof: 1 });
    expect(lines(state, 0)[0]?.text).toBe(`新增停机位 ¥${bayPrice(ECONOMY_V1.baysAtBuild + 1)}`);
    expect(lines(state, second)[1]).toMatchObject({ key: 'drone', dim: false, reason: null }); // 新站有空闲停机位
  });

  it('价签还没开放：原因是价签没开放，带内容表里的余额。部件在价签开放之前不画这一块，数据里仍然给出', () => {
    const state = campaignState();
    const [bay, drone, gate] = lines(state);
    expect(bay?.reason).toBe(`第一天日结后、资金达到 ¥${UNLOCKS_V1.priceTagsBalance} 时解锁`);
    expect(drone?.reason).toBe(bay?.reason);
    expect(gate).toMatchObject({ key: 'gate', reason: null });
  });

  it('只读：不改状态', () => {
    const state = withMoney(quietState(), 600);
    const before = hashState(state);
    lines(state);
    expect(hashState(state)).toBe(before);
  });
});

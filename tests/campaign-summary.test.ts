// 高峰小结的记录和说明句：主句七条、附加句四条的选择规则（表驱动），四段时间的百分数，记录与 peakSummary 的口径一致，
// 与前一天同一场高峰的对比，调度台白板底部的小票条。
import { describe, expect, it } from 'vitest';
import { NOTES_V1 } from '../src/content/notes_v1.ts';
import {
  DAY_STEPS,
  PeakId,
  advance,
  createRng,
  lastPeakTicket,
  nextInt,
  peakRecord,
  peakSummary,
  pickExtra,
  pickMain,
  pickSentences,
  recordPeakSummary,
  setRules,
  sharesOf100,
  step,
} from '../src/core/index.ts';
import type { ExtraSentence, MainSentence, PeakName, SentenceInput, SimState } from '../src/core/index.ts';
import { campaignOf, campaignState, clickOpening, must, outcomeOrder, quietState, roofWhere, withMoney } from './campaign-helpers.ts';

const OLD_SMALL = roofWhere((r) => r.district === 0 && r.size === 'small');

// ---- 说明句：表驱动 ----

/** 一场平平常常的高峰：10 张订单都送达，准时 5 张，四段时间里等飞机最长，各站和各片区都没有异常。 */
const BASE: SentenceInput = {
  nOrders: 10,
  nDelivered: 10,
  nOnTime: 5,
  segments: { waitDrone: 5, waitGate: 1, waitPrep: 1, road: 3 },
  stations: [{ id: 0, landWaitAvg: 0, bayEmptyShare: 0.1 }],
  nonNearestRate: 0.1,
  districts: [{ district: 0, n: 10, onTime: 5 }],
};

function input(patch: Partial<SentenceInput>): SentenceInput {
  return { ...BASE, ...patch };
}

function seg(waitDrone: number, waitGate: number, waitPrep: number, road: number): SentenceInput['segments'] {
  return { waitDrone, waitGate, waitPrep, road };
}

describe('说明的主句：按条件表取第一个满足的', () => {
  const CASES: [string, Partial<SentenceInput>, MainSentence][] = [
    ['1 这一场没有订单', { nOrders: 0, nDelivered: 0, nOnTime: 0, segments: null, districts: [] }, { id: 'noOrders' }],
    ['2 有订单但没有送达的', { nOrders: 5, nDelivered: 0, nOnTime: 0, segments: null }, { id: 'noDelivered' }],
    ['2 没有送达的订单，即使统计里带着四段时间也按没有送达写', { nOrders: 5, nDelivered: 0, nOnTime: 0 }, { id: 'noDelivered' }],
    ['3 准时率 90%，恰好算', { nOrders: 10, nOnTime: 9 }, { id: 'onTimeHigh', onTime: 90 }],
    ['3 准时率 89.9%，不算：1000 张里准时 899 张', { nOrders: 1000, nDelivered: 1000, nOnTime: 899 }, { id: 'waitDrone' }],
    ['3 准时率 90.0%：1000 张里准时 900 张', { nOrders: 1000, nDelivered: 1000, nOnTime: 900 }, { id: 'onTimeHigh', onTime: 90 }],
    ['3 参数是下取整的百分数：1000 张里准时 957 张写 95', { nOrders: 1000, nDelivered: 1000, nOnTime: 957 }, { id: 'onTimeHigh', onTime: 95 }],
    ['3 退单也在分母里：10 张里准时 9 张、退单 1 张，准时率 90%', { nOrders: 10, nDelivered: 9, nOnTime: 9 }, { id: 'onTimeHigh', onTime: 90 }],
    ['3 准时率够高时，四段时间再偏也先写准时率', { nOrders: 10, nOnTime: 10, segments: seg(1, 9, 1, 1) }, { id: 'onTimeHigh', onTime: 100 }],
    ['4 等飞机最长', { segments: seg(9, 1, 1, 3) }, { id: 'waitDrone' }],
    ['5 等起降最长', { segments: seg(1, 9, 1, 3) }, { id: 'waitGate' }],
    ['6 路上最长', { segments: seg(1, 1, 1, 9) }, { id: 'road' }],
    ['7 等出餐最长', { segments: seg(1, 1, 9, 3) }, { id: 'waitPrep' }],
    ['并列最长取表中靠前的一段：等飞机和等起降并列，写等飞机', { segments: seg(5, 5, 1, 2) }, { id: 'waitDrone' }],
    ['并列最长：等飞机和路上并列，写等飞机', { segments: seg(5, 1, 1, 5) }, { id: 'waitDrone' }],
    ['并列最长：等飞机和等出餐并列，写等飞机', { segments: seg(5, 1, 5, 2) }, { id: 'waitDrone' }],
    ['并列最长：等起降和路上并列，写等起降', { segments: seg(1, 5, 1, 5) }, { id: 'waitGate' }],
    ['并列最长：等起降和等出餐并列，写等起降', { segments: seg(1, 5, 5, 2) }, { id: 'waitGate' }],
    ['并列最长：路上和等出餐并列，写路上（表里路上在等出餐前面）', { segments: seg(1, 1, 5, 5) }, { id: 'road' }],
    ['四段全部并列：写等飞机', { segments: seg(4, 4, 4, 4) }, { id: 'waitDrone' }],
    ['四段都是 0：并列，写等飞机', { segments: seg(0, 0, 0, 0) }, { id: 'waitDrone' }],
    ['差得极小的当作并列：路上比等飞机多 1e-12 秒，写等飞机', { segments: seg(5, 1, 1, 5 + 1e-12) }, { id: 'waitDrone' }],
    ['差得有一点就不是并列：路上比等飞机多 0.01 秒，写路上', { segments: seg(5, 1, 1, 5.01) }, { id: 'road' }],
  ];

  it.each(CASES)('%s', (_name, patch, expected) => {
    expect(pickMain(input(patch))).toEqual(expected);
  });

  it('90% 取自内容表', () => {
    expect(NOTES_V1.onTimeHigh).toBe(90);
  });
});

describe('说明的附加句：同时满足多条取靠前的一条，同一条有多座站或多个片区满足时取数值最大的', () => {
  const WAIT: MainSentence = { id: 'waitDrone' };
  const ROAD: MainSentence = { id: 'road' };
  const GATE: MainSentence = { id: 'waitGate' };

  it('1 某座站平均有不少于 1 架飞机等降落：恰好 1 架算，0.99 架不算', () => {
    const at = (avg: number): ExtraSentence | null => pickExtra(input({ stations: [{ id: 0, landWaitAvg: avg, bayEmptyShare: 0.1 }] }), GATE);
    expect(at(1)).toEqual({ id: 'landQueue', station: 0, count: 1 });
    expect(at(0.99)).toBeNull();
    expect(at(2.5)).toEqual({ id: 'landQueue', station: 0, count: 2.5 });
  });

  it('1 参数里的架数取一位小数：1.26 写 1.3，1.04 写 1', () => {
    const at = (avg: number): ExtraSentence | null => pickExtra(input({ stations: [{ id: 0, landWaitAvg: avg, bayEmptyShare: 0 }] }), GATE);
    expect(at(1.26)).toEqual({ id: 'landQueue', station: 0, count: 1.3 });
    expect(at(1.04)).toEqual({ id: 'landQueue', station: 0, count: 1 });
  });

  it('1 多座站满足时取平均最多的一座，相同取编号小的；不满足的站不参与', () => {
    const stations = [
      { id: 0, landWaitAvg: 0.5, bayEmptyShare: 0 },
      { id: 1, landWaitAvg: 1.2, bayEmptyShare: 0 },
      { id: 2, landWaitAvg: 1.7, bayEmptyShare: 0 },
      { id: 3, landWaitAvg: 1.7, bayEmptyShare: 0 },
    ];
    expect(pickExtra(input({ stations }), GATE)).toEqual({ id: 'landQueue', station: 2, count: 1.7 });
    expect(pickExtra(input({ stations: stations.slice(0, 2) }), GATE)).toEqual({ id: 'landQueue', station: 1, count: 1.2 });
  });

  it('1 排在最前：同时满足停机位空着、不是最近的站送的、片区准时率低，仍写等降落', () => {
    const busy = input({
      stations: [{ id: 0, landWaitAvg: 1.5, bayEmptyShare: 0.9 }],
      nonNearestRate: 0.9,
      nOnTime: 6,
      districts: [{ district: 1, n: 10, onTime: 1 }],
    });
    for (const main of [WAIT, ROAD, GATE]) expect(pickExtra(busy, main)?.id).toBe('landQueue');
  });

  it('2 主句是等飞机，并且某座站的停机位有一半以上的时间是空的：恰好一半算，差一点不算', () => {
    const at = (share: number): ExtraSentence | null => pickExtra(input({ stations: [{ id: 0, landWaitAvg: 0, bayEmptyShare: share }] }), WAIT);
    expect(at(0.5)).toEqual({ id: 'bayIdle', station: 0, percent: 50 });
    expect(at(0.499)).toBeNull();
    expect(at(0.58)).toEqual({ id: 'bayIdle', station: 0, percent: 58 }); // 0.58 乘 100 在浮点里是 57.99999999999999，参数仍是 58
    expect(at(1)).toEqual({ id: 'bayIdle', station: 0, percent: 100 });
  });

  it('2 主句不是等飞机时不写停机位：路上、等起降、等出餐、准时率高都不写，即使停机位全空', () => {
    const idle = input({ stations: [{ id: 0, landWaitAvg: 0, bayEmptyShare: 0.9 }] });
    for (const main of [ROAD, GATE, { id: 'waitPrep' } as MainSentence, { id: 'onTimeHigh', onTime: 95 } as MainSentence, { id: 'noDelivered' } as MainSentence]) {
      expect(pickExtra(idle, main)).toBeNull();
    }
  });

  it('2 多座站满足时取空着的时间最多的一座，相同取编号小的；没有停机位的站（比例不是数）不参与', () => {
    const stations = [
      { id: 0, landWaitAvg: 0, bayEmptyShare: 0.6 },
      { id: 1, landWaitAvg: 0, bayEmptyShare: 0.8 },
      { id: 2, landWaitAvg: 0, bayEmptyShare: 0.8 },
      { id: 3, landWaitAvg: 0, bayEmptyShare: Number.NaN },
    ];
    expect(pickExtra(input({ stations }), WAIT)).toEqual({ id: 'bayIdle', station: 1, percent: 80 });
  });

  it('3 主句是路上，并且不少于三成的订单不是最近的站送的：恰好三成算，差一点不算，没有已派出的订单不算', () => {
    const at = (rate: number): ExtraSentence | null => pickExtra(input({ nonNearestRate: rate }), ROAD);
    expect(at(0.3)).toEqual({ id: 'notNearest', percent: 30 });
    expect(at(3 / 10)).toEqual({ id: 'notNearest', percent: 30 });
    expect(at(0.299)).toBeNull();
    expect(at(0.58)).toEqual({ id: 'notNearest', percent: 58 });
    expect(at(1)).toEqual({ id: 'notNearest', percent: 100 });
    expect(at(Number.NaN)).toBeNull();
  });

  it('3 主句不是路上时不写：等飞机、等起降、等出餐，即使全部不是最近的站送的', () => {
    const far = input({ nonNearestRate: 1 });
    for (const main of [WAIT, GATE, { id: 'waitPrep' } as MainSentence, { id: 'onTimeHigh', onTime: 95 } as MainSentence]) {
      expect(pickExtra(far, main)).toBeNull();
    }
  });

  it('4 某个片区的准时率比全城低 20 个百分点以上：恰好 20 个点算，19 个点不算，参数是下取整的百分数', () => {
    // 全城 10 张里准时 6 张，60%
    const at = (n: number, onTime: number): ExtraSentence | null => pickExtra(input({ nOnTime: 6, districts: [{ district: 2, n, onTime }] }), GATE);
    expect(at(10, 4)).toEqual({ id: 'districtLow', district: 2, onTime: 40 });
    expect(at(100, 41)).toBeNull(); // 差 19 个点
    expect(at(100, 40)).toEqual({ id: 'districtLow', district: 2, onTime: 40 });
    expect(at(3, 0)).toEqual({ id: 'districtLow', district: 2, onTime: 0 });
    expect(at(7, 2)).toEqual({ id: 'districtLow', district: 2, onTime: 28 }); // 2 / 7 = 28.57%
  });

  it('4 与主句无关：准时率高时主句写准时率，附加句仍可以写某个片区比全城低 20 个点以上', () => {
    // 全城 97 / 100 = 97%，片区 1 是 7 / 10 = 70%，差 27 个点
    const high = input({ nOrders: 100, nDelivered: 100, nOnTime: 97, districts: [{ district: 0, n: 90, onTime: 90 }, { district: 1, n: 10, onTime: 7 }] });
    expect(pickSentences(high)).toEqual({ main: { id: 'onTimeHigh', onTime: 97 }, extra: { id: 'districtLow', district: 1, onTime: 70 } });
  });

  it('4 多个片区满足时取准时率最低的，相同取编号小的；没有订单的片区不参与', () => {
    // 全城 40 张里准时 30 张，75%
    const districts = [
      { district: 0, n: 10, onTime: 9 },
      { district: 1, n: 10, onTime: 3 },
      { district: 2, n: 20, onTime: 6 },
      { district: 3, n: 0, onTime: 0 },
    ];
    const city = { nOrders: 40, nDelivered: 40, nOnTime: 30 };
    // 片区 1 和片区 2 都是 30%，都比全城低 45 个点，输入按片区编号从小到大，相同取靠前的：片区 1
    expect(pickExtra(input({ ...city, districts }), GATE)).toEqual({ id: 'districtLow', district: 1, onTime: 30 });
    // 片区 2 更低一点（5 / 20 = 25%）就取片区 2
    expect(pickExtra(input({ ...city, districts: [districts[0], districts[1], { district: 2, n: 20, onTime: 5 }, districts[3]] as typeof districts }), GATE)).toEqual({ id: 'districtLow', district: 2, onTime: 25 });
    // 没有订单的片区不参与，也不会除零
    expect(pickExtra(input({ ...city, districts: [{ district: 3, n: 0, onTime: 0 }] }), GATE)).toBeNull();
  });

  it('优先级：停机位空着排在片区准时率低前面，不是最近的站送的排在片区准时率低前面，都没有时才写片区', () => {
    const low = { nOnTime: 6, districts: [{ district: 1, n: 10, onTime: 1 }] };
    expect(pickExtra(input({ ...low, stations: [{ id: 0, landWaitAvg: 0, bayEmptyShare: 0.7 }] }), WAIT)?.id).toBe('bayIdle');
    expect(pickExtra(input({ ...low, nonNearestRate: 0.5 }), ROAD)?.id).toBe('notNearest');
    expect(pickExtra(input({ ...low }), WAIT)?.id).toBe('districtLow');
    expect(pickExtra(input({ ...low }), ROAD)?.id).toBe('districtLow');
  });

  it('什么都没有：不写附加句', () => {
    for (const main of [WAIT, ROAD, GATE]) expect(pickExtra(BASE, main)).toBeNull();
  });

  it('一次选出主句和附加句：附加句看的是选出的主句', () => {
    expect(pickSentences(input({ stations: [{ id: 0, landWaitAvg: 0, bayEmptyShare: 0.9 }] }))).toEqual({ main: { id: 'waitDrone' }, extra: { id: 'bayIdle', station: 0, percent: 90 } });
    expect(pickSentences(input({ segments: seg(1, 1, 1, 9), nonNearestRate: 0.4 }))).toEqual({ main: { id: 'road' }, extra: { id: 'notNearest', percent: 40 } });
    expect(pickSentences(input({ nOrders: 0, nDelivered: 0, nOnTime: 0, segments: null, districts: [] }))).toEqual({ main: { id: 'noOrders' }, extra: null });
  });

  it('各条件取自内容表：1 架、一半、三成、20 个点', () => {
    expect([NOTES_V1.landQueueMin, NOTES_V1.bayIdleShare, NOTES_V1.notNearestShare, NOTES_V1.districtLowGap]).toEqual([1, 50, 30, 20]);
  });

  it('机队时间的三个数取自内容表：等待起飞 15%，空载飞行 35%，起降拥堵便签 10%', () => {
    expect([NOTES_V1.takeoffWaitPct, NOTES_V1.emptyFlightPct, NOTES_V1.gateBusyPct]).toEqual([15, 35, 10]);
  });

  // ---- 机队时间带来的两条附加句 ----

  /** 一座站，等待起飞的时间占 pct%，其余都不触发。 */
  const waiting = (pct: number, id = 0): SentenceInput['stations'][number] => ({ id, landWaitAvg: 0, bayEmptyShare: 0.1, takeoffWaitPct: pct });

  it('1 某座站至少有 1 架无人机等待起飞的时间不少于 15%：恰好 15 算，14 不算，参数是站的编号和百分数', () => {
    const at = (pct: number): ExtraSentence | null => pickExtra(input({ stations: [waiting(pct)] }), GATE);
    expect(at(15)).toEqual({ id: 'takeoffWait', station: 0, percent: 15 });
    expect(at(14)).toBeNull();
    expect(at(0)).toBeNull();
    expect(at(100)).toEqual({ id: 'takeoffWait', station: 0, percent: 100 });
    expect(pickExtra(input({ stations: [{ id: 3, landWaitAvg: 0, bayEmptyShare: 0.1, takeoffWaitPct: 22 }] }), GATE)).toEqual({ id: 'takeoffWait', station: 3, percent: 22 });
  });

  it('1 没有计数的输入（takeoffWaitPct 缺省）按 0 处理：不写', () => {
    expect(pickExtra(input({ stations: [{ id: 0, landWaitAvg: 0, bayEmptyShare: 0.1 }] }), GATE)).toBeNull();
  });

  it('1 多座站满足时取占比最大的一座，相同取编号小的，与输入的先后无关；不满足的站不参与', () => {
    const stations = [waiting(10, 0), waiting(20, 1), waiting(30, 2), waiting(30, 3)];
    expect(pickExtra(input({ stations }), GATE)).toEqual({ id: 'takeoffWait', station: 2, percent: 30 });
    expect(pickExtra(input({ stations: [...stations].reverse() }), GATE)).toEqual({ id: 'takeoffWait', station: 2, percent: 30 });
    expect(pickExtra(input({ stations: stations.slice(0, 2) }), GATE)).toEqual({ id: 'takeoffWait', station: 1, percent: 20 });
    expect(pickExtra(input({ stations: stations.slice(0, 1) }), GATE)).toBeNull();
  });

  it('1 排在最前：同时满足等降落、停机位空着、空载飞行多、不是最近的站送的、片区准时率低，仍写等待起飞，与主句无关', () => {
    const busy = input({
      stations: [{ id: 0, landWaitAvg: 1.5, bayEmptyShare: 0.9, takeoffWaitPct: 20 }],
      emptyFlightPct: 40,
      nonNearestRate: 0.9,
      nOnTime: 6,
      districts: [{ district: 1, n: 10, onTime: 1 }],
    });
    for (const main of [WAIT, ROAD, GATE, { id: 'waitPrep' } as MainSentence, { id: 'onTimeHigh', onTime: 95 } as MainSentence]) {
      expect(pickExtra(busy, main)).toEqual({ id: 'takeoffWait', station: 0, percent: 20 });
    }
  });

  it('4 全部无人机空载飞行的时间不少于 35%：恰好 35 算，34 不算，没有机队时间构成（null 或缺省）不写', () => {
    const at = (pct: number | null | undefined): ExtraSentence | null => pickExtra(input(pct === undefined ? {} : { emptyFlightPct: pct }), GATE);
    expect(at(35)).toEqual({ id: 'emptyFlight', percent: 35 });
    expect(at(34)).toBeNull();
    expect(at(100)).toEqual({ id: 'emptyFlight', percent: 100 });
    expect(at(null)).toBeNull();
    expect(at(undefined)).toBeNull();
  });

  it('4 与主句无关：主句是等飞机、路上、等起降、等出餐、准时率高，都可以写空载飞行', () => {
    const empty = input({ emptyFlightPct: 40 });
    for (const main of [WAIT, ROAD, GATE, { id: 'waitPrep' } as MainSentence, { id: 'onTimeHigh', onTime: 95 } as MainSentence, { id: 'noDelivered' } as MainSentence]) {
      expect(pickExtra(empty, main)).toEqual({ id: 'emptyFlight', percent: 40 });
    }
  });

  it('条件表的顺序：等待起飞，等降落，停机位空着（主句是等飞机时），空载飞行，不是最近的站送的（主句是路上时），片区准时率低', () => {
    const all = input({
      stations: [{ id: 0, landWaitAvg: 1.5, bayEmptyShare: 0.9, takeoffWaitPct: 20 }],
      emptyFlightPct: 40,
      nonNearestRate: 0.5,
      nOnTime: 6,
      districts: [{ district: 1, n: 10, onTime: 1 }],
    });
    // 主句是等飞机：每去掉最前面的一条，下一条接上
    expect(pickExtra(all, WAIT)?.id).toBe('takeoffWait');
    const noTakeoff = { ...all, stations: [{ id: 0, landWaitAvg: 1.5, bayEmptyShare: 0.9 }] };
    expect(pickExtra(noTakeoff, WAIT)?.id).toBe('landQueue');
    const noLand = { ...noTakeoff, stations: [{ id: 0, landWaitAvg: 0, bayEmptyShare: 0.9 }] };
    expect(pickExtra(noLand, WAIT)?.id).toBe('bayIdle');
    const noIdle = { ...noLand, stations: [{ id: 0, landWaitAvg: 0, bayEmptyShare: 0.1 }] };
    expect(pickExtra(noIdle, WAIT)).toEqual({ id: 'emptyFlight', percent: 40 });
    expect(pickExtra({ ...noIdle, emptyFlightPct: null }, WAIT)?.id).toBe('districtLow');
    // 主句是路上：空载飞行排在不是最近的站送的前面，没有空载飞行时写不是最近的站送的
    expect(pickExtra(noIdle, ROAD)?.id).toBe('emptyFlight');
    expect(pickExtra({ ...noIdle, emptyFlightPct: null }, ROAD)).toEqual({ id: 'notNearest', percent: 50 });
    expect(pickExtra({ ...noIdle, emptyFlightPct: null, nonNearestRate: 0.1 }, ROAD)?.id).toBe('districtLow');
  });

  it('一次选出主句和附加句：空载飞行排在不是最近的站送的前面', () => {
    expect(pickSentences(input({ segments: seg(1, 1, 1, 9), nonNearestRate: 0.4, emptyFlightPct: 38 }))).toEqual({ main: { id: 'road' }, extra: { id: 'emptyFlight', percent: 38 } });
  });
});

describe('一张订单的四段时间各占的百分数', () => {
  it('加起来是 100，按最大余数分配', () => {
    expect(sharesOf100([50, 30, 15, 5])).toEqual([50, 30, 15, 5]);
    expect(sharesOf100([1, 1, 1])).toEqual([34, 33, 33]); // 余数相同，靠前的先得
    expect(sharesOf100([1, 2, 3, 4])).toEqual([10, 20, 30, 40]);
    expect(sharesOf100([0.29, 0.71])).toEqual([29, 71]); // 100 × 0.29 在浮点里是 28.999999999999996，仍分到 29
    expect(sharesOf100([5, 0, 1, 0])).toEqual([83, 0, 17, 0]);
  });

  it('全是 0 或为负时都是 0，不出 NaN', () => {
    expect(sharesOf100([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
    expect(sharesOf100([-1, 0, 0, 0])).toEqual([0, 0, 0, 0]);
    expect(sharesOf100([])).toEqual([]);
  });

  it('随机的数：加起来始终是 100，每个数不超过它的上取整', () => {
    const rng = createRng(5);
    for (let i = 0; i < 300; i++) {
      const values = [nextInt(rng, 400) / 10, nextInt(rng, 400) / 10, nextInt(rng, 400) / 10, nextInt(rng, 400) / 10];
      const total = values.reduce((a, b) => a + b, 0);
      const out = sharesOf100(values);
      if (total === 0) {
        expect(out).toEqual([0, 0, 0, 0]);
        continue;
      }
      expect(out.reduce((a, b) => a + b, 0)).toBe(100);
      out.forEach((n, k) => {
        expect(n).toBeGreaterThanOrEqual(Math.floor((100 * (values[k] as number)) / total) - 0);
        expect(n).toBeLessThanOrEqual(Math.ceil((100 * (values[k] as number)) / total));
      });
    }
  });
});

// ---- 记录 ----

/** 一场高峰里的一张订单。 */
interface Item {
  district?: number;
  kind: 'on' | 'late' | 'open' | 'cancel';
  assignDelay?: number;
  departed?: number;
}

/** 放 n 张同样的订单。 */
function many(n: number, item: Item): Item[] {
  return Array.from({ length: n }, () => item);
}

/** 在第 day 天某场高峰的下单时段里放一批订单，把步数设到小结时刻，生成这一场的记录并返回。 */
function summarize(state: SimState, day: number, peak: PeakName, items: readonly Item[]): ReturnType<typeof recordPeakSummary> {
  const base = day * DAY_STEPS + (peak === 'noon' ? 700 : 2200);
  items.forEach((item, i) => {
    const t = base + i;
    const district = item.district ?? 0;
    if (item.kind === 'open') outcomeOrder(state, { district, tOrder: t });
    else if (item.kind === 'cancel') outcomeOrder(state, { district, tOrder: t, cancelled: t + 900 });
    else outcomeOrder(state, { district, tOrder: t, delivered: t + (item.kind === 'on' ? 290 : 400), assignDelay: item.assignDelay, departed: item.departed });
  });
  state.step = day * DAY_STEPS + (peak === 'noon' ? 1800 : 3400);
  return recordPeakSummary(state, day, peak);
}

/** 某座站在 [start, end) 步里平均有 avg 架飞机在上空等降落：统计按秒记，每秒是这十步的架数之和。 */
function setLandWait(state: SimState, station: number, start: number, end: number, avg: number): void {
  const row = state.stats.landWait[station] as number[];
  for (let sec = start / 10; sec < end / 10; sec++) row[sec] = avg * 10;
}

describe('小结的记录：口径沿用 peakSummary', () => {
  it('五个数：订单、准时、超时和其中未送达的、取消、收入，准时、超时、取消三项相加等于订单', () => {
    const state = quietState();
    const record = summarize(state, 0, 'noon', [...many(4, { kind: 'on' }), ...many(3, { kind: 'late' }), ...many(2, { kind: 'open' }), { kind: 'cancel' }]);
    const s = peakSummary(state, 0, 'noon');
    expect(record).toMatchObject({ day: 0, peak: 'noon', step: 1800, orders: 10, onTime: 4, late: 5, lateOpen: 2, cancelled: 1, revenue: 35 });
    expect([record.orders, record.onTime, record.late, record.lateOpen, record.cancelled, record.revenue]).toEqual([s.nOrders, s.nOnTime, s.nLate, s.nLateOpen, s.nCancelled, s.revenue]);
    expect(record.onTime + record.late + record.cancelled).toBe(record.orders);
    expect(campaignOf(state).peaks).toEqual([record]);
  });

  it('只统计这一场的下单时段里下的单：午高峰之外下的单不算', () => {
    const state = quietState();
    outcomeOrder(state, { district: 0, tOrder: 100, delivered: 300 }); // 上午
    outcomeOrder(state, { district: 0, tOrder: 1550, delivered: 1700 }); // 午后
    const record = summarize(state, 0, 'noon', many(2, { kind: 'on' }));
    expect(record.orders).toBe(2);
  });

  it('小结时刻的口径：到小结时刻还没送到的算超时，之后才送到的订单不改记录', () => {
    const state = quietState();
    const record = summarize(state, 0, 'noon', [{ kind: 'on' }, { kind: 'open' }]);
    expect([record.late, record.lateOpen]).toEqual([1, 1]);
    // 小结之后这张订单送到了：记录不变
    const order = state.orders.find((o) => o.tDeliver < 0) as NonNullable<SimState['orders'][number]>;
    state.pending.splice(state.pending.indexOf(order.id), 1);
    order.tDeliver = 1900;
    order.status = 3;
    expect(JSON.stringify(campaignOf(state).peaks[0])).toBe(JSON.stringify(record));
  });

  it('各片区的准时率：只列开通的片区，下取整的百分数', () => {
    const state = quietState();
    campaignOf(state).districts[1]!.open = true;
    const record = summarize(state, 0, 'noon', [...many(2, { kind: 'on' }), { kind: 'late' }, ...many(3, { district: 1, kind: 'on' })]);
    expect(record.districts).toEqual([
      { district: 0, n: 3, onTime: 2, pct: 66, delta: null, line: null, met: null },
      { district: 1, n: 3, onTime: 3, pct: 100, delta: null, line: null, met: null },
    ]);
    const single = summarize(quietState(), 0, 'noon', many(2, { kind: 'on' }));
    expect(single.districts.map((d) => d.district)).toEqual([0]);
  });

  it('没有订单的片区：准时率为 null', () => {
    const state = quietState();
    campaignOf(state).districts[1]!.open = true;
    const record = summarize(state, 0, 'noon', many(3, { kind: 'on' }));
    expect(record.districts[1]).toEqual({ district: 1, n: 0, onTime: 0, pct: null, delta: null, line: null, met: null });
  });

  it('与前一天同一场高峰相比的变化：单位是百分点，第一天为空，午高峰对午高峰，晚高峰对晚高峰', () => {
    const state = quietState();
    campaignOf(state).districts[1]!.open = true;
    // 第 0 天午高峰：老街 6 / 10 = 60%，写字楼区 3 / 10 = 30%。晚高峰：老街 5 / 10 = 50%
    summarize(state, 0, 'noon', [...many(6, { kind: 'on' }), ...many(4, { kind: 'late' }), ...many(3, { district: 1, kind: 'on' }), ...many(7, { district: 1, kind: 'late' })]);
    summarize(state, 0, 'evening', [...many(5, { kind: 'on' }), ...many(5, { kind: 'late' })]);
    // 第 1 天午高峰：老街 7 / 10 = 70%，写字楼区 5 / 10 = 50%。晚高峰：老街 4 / 10 = 40%
    const noon = summarize(state, 1, 'noon', [...many(7, { kind: 'on' }), ...many(3, { kind: 'late' }), ...many(5, { district: 1, kind: 'on' }), ...many(5, { district: 1, kind: 'late' })]);
    const evening = summarize(state, 1, 'evening', [...many(4, { kind: 'on' }), ...many(6, { kind: 'late' })]);
    expect(noon.districts.map((d) => [d.district, d.pct, d.delta])).toEqual([[0, 70, 10], [1, 50, 20]]);
    expect(evening.districts.map((d) => [d.district, d.pct, d.delta])).toEqual([[0, 40, -10], [1, null, null]]);
    // 第一天（第 0 天）的两场都没有变化
    expect(campaignOf(state).peaks.slice(0, 2).every((p) => p.districts.every((d) => d.delta === null))).toBe(true);
  });

  it('变化按显示的数字相减：前一天 7 / 9（77%）、今天 8 / 9（88%），变化是 11', () => {
    const state = quietState();
    summarize(state, 0, 'noon', [...many(7, { kind: 'on' }), ...many(2, { kind: 'late' })]);
    const today = summarize(state, 1, 'noon', [...many(8, { kind: 'on' }), { kind: 'late' }]);
    expect(today.districts[0]).toEqual({ district: 0, n: 9, onTime: 8, pct: 88, delta: 11, line: null, met: null });
  });

  it('前一天这一场没有订单，或者这个片区前一天还没开通：变化为空', () => {
    const state = quietState();
    summarize(state, 0, 'noon', []); // 前一天没有订单
    campaignOf(state).districts[1]!.open = true; // 写字楼区是第 1 天才开通的
    const today = summarize(state, 1, 'noon', [...many(3, { kind: 'on' }), ...many(3, { district: 1, kind: 'on' })]);
    expect(today.districts.map((d) => [d.district, d.pct, d.delta])).toEqual([[0, 100, null], [1, 100, null]]);
  });

  it('一张订单的四段时间：各占的百分数加起来是 100，只统计已经送达的订单', () => {
    const state = quietState();
    // 每张订单：等飞机 100 步，等起降 0，等出餐 10 步，总用时 290 步，路上 180 步
    const record = summarize(state, 0, 'noon', [...many(5, { kind: 'on', assignDelay: 100 }), ...many(3, { kind: 'open' })]);
    // 100 / 290 = 34.48%，10 / 290 = 3.45%，180 / 290 = 62.07%，下取整加起来是 99，多出的 1 按最大余数给 34.48% 的那一项
    expect(record.segments).toEqual({ waitDrone: 35, waitGate: 0, waitPrep: 3, road: 62 });
    const s = record.segments as NonNullable<typeof record.segments>;
    expect(s.waitDrone + s.waitGate + s.waitPrep + s.road).toBe(100);
  });

  it('没有送达的订单时四段时间为空，主句写没有送达的订单', () => {
    const state = quietState();
    const record = summarize(state, 0, 'noon', many(3, { kind: 'open' }));
    expect(record.segments).toBeNull();
    expect(record.main).toEqual({ id: 'noDelivered' });
    const empty = summarize(quietState(), 0, 'evening', []);
    expect(empty.segments).toBeNull();
    expect(empty.main).toEqual({ id: 'noOrders' });
    expect(empty.extra).toBeNull();
  });

  it('提前派出的订单数：沿用 peakSummary，没换过卡时是个数，这一场中途换过「调度策略」时为 null 并记一个标记，记下当时的卡', () => {
    const plain = quietState();
    const a = summarize(plain, 0, 'noon', many(3, { kind: 'on' }));
    expect(a).toMatchObject({ early: 0, changedMidPeak: false, select: 'fifo' });
    const changed = quietState();
    advance(changed, 900);
    setRules(changed, { select: 'deadline' });
    const b = summarize(changed, 0, 'noon', many(3, { kind: 'on' }));
    expect(b).toMatchObject({ early: null, changedMidPeak: true, select: 'deadline' });
    const s = peakSummary(changed, 0, 'noon');
    expect(s.early).toMatchObject({ count: null, changedMidPeak: true });
  });

  it('提前派出的订单：记录里的个数就是 peakSummary 给的个数', () => {
    const state = quietState();
    state.stats.early.push({ step: 800, order: 0, rule: 'deadline', day: 0, peak: PeakId.Noon });
    const record = summarize(state, 0, 'noon', many(3, { kind: 'on' }));
    expect(record.early).toBe(1);
    expect(record.early).toBe(peakSummary(state, 0, 'noon').early.count);
    // 晚高峰没有这样的记录
    expect(summarize(state, 0, 'evening', many(3, { kind: 'on' })).early).toBe(0);
  });
});

describe('小结的说明句：来自这一场的统计', () => {
  it('主句是等飞机，并且站的停机位有一半以上的时间是空的：附加句写这座站，百分数取自真实的统计', () => {
    const state = withMoney(quietState());
    for (let i = 0; i < 4; i++) must(state, { type: 'buyBay', station: 0 }); // 6 个停机位，2 架飞机停着，空着的是 4 / 6
    advance(state, 1800); // 真实地走过午高峰，统计里有每秒的停机位数
    const record = summarize(state, 0, 'noon', [...many(6, { kind: 'on', assignDelay: 240 }), ...many(4, { kind: 'late', assignDelay: 240 })]);
    expect(record.main).toEqual({ id: 'waitDrone' });
    expect(record.extra).toEqual({ id: 'bayIdle', station: 0, percent: 66 });
  });

  it('某座站平均有不少于 1 架飞机等降落：附加句写等降落，站的编号是 0 起的编号', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: OLD_SMALL });
    setLandWait(state, second, 600, 1500, 1.4);
    setLandWait(state, 0, 600, 1500, 0.4);
    const record = summarize(state, 0, 'noon', [...many(6, { kind: 'on' }), ...many(4, { kind: 'late' })]);
    expect(record.extra).toEqual({ id: 'landQueue', station: second, count: 1.4 });
  });

  it('某座站有无人机等待起飞的时间不少于 15%：附加句写等待起飞，写占比最大的站，百分数取自当场高峰的计数，排在等降落前面', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: OLD_SMALL });
    Object.assign(campaignOf(state).tally.peak, { steps: 900, takeoffWait: [100, 135] }); // 11%，15%
    setLandWait(state, second, 600, 1500, 1.4); // 等降落也满足，但排在后面
    const record = summarize(state, 0, 'noon', [...many(6, { kind: 'on' }), ...many(4, { kind: 'late' })]);
    expect(record.extra).toEqual({ id: 'takeoffWait', station: second, percent: 15 });
    expect(record.stations.map((r) => r.takeoffWaitPct)).toEqual([11, 15]);
  });

  it('全部无人机空载飞行的时间不少于 35%：附加句写空载飞行，百分数就是记录里机队时间构成的空载飞行', () => {
    const state = quietState();
    Object.assign(campaignOf(state).tally.peak, { steps: 900, fleet: [[300, 350, 200, 0, 50]] });
    const record = summarize(state, 0, 'noon', [...many(6, { kind: 'on' }), ...many(4, { kind: 'late' })]);
    expect(record.fleet).toEqual({ loaded: 33, empty: 39, work: 22, queue: 0, parked: 6 });
    expect(record.extra).toEqual({ id: 'emptyFlight', percent: 39 });
    // 空载飞行占 34% 时不写
    const below = quietState();
    Object.assign(campaignOf(below).tally.peak, { steps: 900, fleet: [[330, 306, 200, 0, 64]] });
    const lower = summarize(below, 0, 'noon', [...many(6, { kind: 'on' }), ...many(4, { kind: 'late' })]);
    expect(lower.fleet?.empty).toBe(34);
    expect(lower.extra).toBeNull();
  });

  it('没有机队时间构成（这一场没有计数）：不写空载飞行', () => {
    const record = summarize(quietState(), 0, 'noon', [...many(6, { kind: 'on' }), ...many(4, { kind: 'late' })]);
    expect(record.fleet).toBeNull();
    expect(record.extra).toBeNull();
  });

  it('已退回的站不算：这座站的等降落记录很高，退回之后附加句不再写它', () => {
    const state = withMoney(quietState());
    const second = must(state, { type: 'buildStation', roof: OLD_SMALL });
    setLandWait(state, second, 600, 1500, 3);
    must(state, { type: 'refundStation', station: second });
    const record = summarize(state, 0, 'noon', [...many(6, { kind: 'on' }), ...many(4, { kind: 'late' })]);
    expect(record.extra).toBeNull();
  });

  it('主句是路上，并且不少于三成的订单不是离店最近的站配送的：写不是最近的站送的', () => {
    const state = quietState();
    const items: Item[] = [...many(3, { kind: 'on', departed: 1 }), ...many(3, { kind: 'on' }), ...many(4, { kind: 'late' })];
    const record = summarize(state, 0, 'noon', items);
    expect(record.main).toEqual({ id: 'road' });
    expect(record.extra).toEqual({ id: 'notNearest', percent: 30 });
    const fewer = summarize(quietState(), 0, 'noon', [...many(2, { kind: 'on', departed: 1 }), ...many(4, { kind: 'on' }), ...many(4, { kind: 'late' })]);
    expect(fewer.extra).toBeNull();
  });

  it('某个片区的准时率比全城低 20 个百分点以上：写这个片区', () => {
    const state = quietState();
    campaignOf(state).districts[1]!.open = true;
    const record = summarize(state, 0, 'noon', [...many(9, { kind: 'on' }), { kind: 'late' }, ...many(5, { district: 1, kind: 'on' }), ...many(5, { district: 1, kind: 'late' })]);
    // 全城 14 / 20 = 70%，写字楼区 50%，差 20 个点
    expect(record.main.id).toBe('road');
    expect(record.extra).toEqual({ id: 'districtLow', district: 1, onTime: 50 });
  });
});

describe('真实的运行：每场高峰在小结时刻生成一条记录', () => {
  /** 跑两个游戏日再多一步（第二天的日结），只跑一次，几个用例共用。 */
  let cached: SimState | null = null;
  function realRun(): SimState {
    if (cached === null) {
      const state = campaignState({ seed: 42 });
      for (let i = 0; i < 2 * DAY_STEPS + 1; i++) {
        clickOpening(state);
        step(state);
      }
      cached = state;
    }
    return cached;
  }

  it('四场高峰，生成的步是高峰结束 30 秒后：第 1800、3400、5400、7000 步', () => {
    const peaks = campaignOf(realRun()).peaks;
    expect(peaks.map((p) => [p.day, p.peak, p.step])).toEqual([[0, 'noon', 1800], [0, 'evening', 3400], [1, 'noon', 5400], [1, 'evening', 7000]]);
  });

  it('记录里的数字与现在重算的 peakSummary 相同：小结口径只算到生成的那一刻，之后的变化不改它', () => {
    const state = realRun();
    for (const p of campaignOf(state).peaks) {
      const s = peakSummary(state, p.day, p.peak);
      expect([p.orders, p.onTime, p.late, p.lateOpen, p.cancelled]).toEqual([s.nOrders, s.nOnTime, s.nLate, s.nLateOpen, s.nCancelled]);
      expect(p.revenue).toBeCloseTo(s.revenue, 9);
      expect(p.onTime + p.late + p.cancelled).toBe(p.orders);
      expect(p.orders).toBeGreaterThan(5);
      p.districts.forEach((row) => {
        const d = s.districts[row.district] as NonNullable<(typeof s.districts)[number]>;
        expect([row.n, row.onTime]).toEqual([d.nOrders, d.nOnTime]);
      });
      expect(p.early).toBe(s.early.count);
      expect(p.changedMidPeak).toBe(s.early.changedMidPeak);
      expect(p.select).toBe('fifo');
    }
  });

  it('第一天没有变化，第二天有：变化等于两天的百分数相减', () => {
    const peaks = campaignOf(realRun()).peaks;
    expect(peaks[0]?.districts[0]?.delta).toBeNull();
    expect(peaks[1]?.districts[0]?.delta).toBeNull();
    const [d0n, d0e, d1n, d1e] = peaks;
    expect(d1n?.districts[0]?.delta).toBe((d1n?.districts[0]?.pct as number) - (d0n?.districts[0]?.pct as number));
    expect(d1e?.districts[0]?.delta).toBe((d1e?.districts[0]?.pct as number) - (d0e?.districts[0]?.pct as number));
  });

  it('找一场的记录：peakRecord 按天和高峰取', () => {
    const state = realRun();
    const peaks = campaignOf(state).peaks;
    expect(peakRecord(state, 1, 'evening')).toBe(peaks[3]);
    expect(peakRecord(state, 0, 'noon')).toBe(peaks[0]);
    expect(peakRecord(state, 5, 'noon')).toBeNull();
  });
});

describe('调度台白板底部的小票条：前一天同一场高峰的准时率、退单数和进账', () => {
  function twoDays(): SimState {
    const state = quietState();
    summarize(state, 0, 'noon', [...many(6, { kind: 'on' }), ...many(3, { kind: 'late' }), { kind: 'cancel' }]); // 进账 (6 + 3) × 5 = 45
    summarize(state, 0, 'evening', [...many(2, { kind: 'on' }), ...many(2, { kind: 'cancel' })]);
    summarize(state, 1, 'noon', many(4, { kind: 'on' }));
    return state;
  }

  it('第一天没有记录：null，界面写「暂无昨日同场高峰记录」', () => {
    const state = twoDays();
    expect(lastPeakTicket(state, 'noon', 0)).toBeNull();
    expect(lastPeakTicket(state, 'evening', 0)).toBeNull();
  });

  it('第二天：午高峰一栏取前一天的午高峰，晚高峰一栏取前一天的晚高峰', () => {
    const state = twoDays();
    expect(lastPeakTicket(state, 'noon', 1)).toEqual({ day: 0, peak: 'noon', onTimePct: 60, cancelled: 1, revenue: 45 });
    expect(lastPeakTicket(state, 'evening', 1)).toEqual({ day: 0, peak: 'evening', onTimePct: 50, cancelled: 2, revenue: 10 });
  });

  it('第三天取第二天的，不取第一天的；前一天的晚高峰还没生成时是 null', () => {
    const state = twoDays();
    expect(lastPeakTicket(state, 'noon', 2)).toEqual({ day: 1, peak: 'noon', onTimePct: 100, cancelled: 0, revenue: 20 });
    expect(lastPeakTicket(state, 'evening', 2)).toBeNull(); // 第 1 天的晚高峰小结还没有生成
  });

  it('今天缺省为现在的游戏日；前一天这一场没有订单时准时率为 null', () => {
    const state = twoDays();
    state.step = DAY_STEPS + 2000;
    expect(lastPeakTicket(state, 'noon')).toMatchObject({ day: 0, onTimePct: 60 });
    const empty = quietState();
    summarize(empty, 0, 'noon', []);
    expect(lastPeakTicket(empty, 'noon', 1)).toEqual({ day: 0, peak: 'noon', onTimePct: null, cancelled: 0, revenue: 0 });
  });

  it('沙盒或还没生成任何记录：null', () => {
    const state = quietState();
    expect(lastPeakTicket(state, 'noon', 1)).toBeNull();
  });
});

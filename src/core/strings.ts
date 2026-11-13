// 面向玩家的名称。规则卡的名称在这里，核心的其他文件不写中文字符串。

export const RULE_NAMES: Readonly<Record<string, string>> = {
  fifo: '先下单的先送',
  deadline: '快超时的先送',
  roundtrip: '来回快的先送',
  prioOld: '老街的先送',
  prioOffice: '写字楼区的先送',
  prioCampus: '大学城的先送',
  global: '哪座站都能送',
  hybrid: '等 10 秒再帮',
  strict: '只由最近的站送',
  single: '一趟送一单',
  same: '同一家店的一起送',
  any: '顺路的一起送',
};

export const DISTRICT_NAMES: readonly string[] = ['老街', '写字楼区', '大学城'];

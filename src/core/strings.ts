// 面向玩家的名称。规则卡的名称在这里，核心的其他文件不写中文字符串。

export const RULE_NAMES: Readonly<Record<string, string>> = {
  fifo: '先到先送',
  deadline: '时限优先',
  roundtrip: '短程优先',
  prioOld: '老街优先',
  prioOffice: '写字楼区优先',
  prioCampus: '大学城优先',
  global: '全站协同',
  hybrid: '延迟支援',
  strict: '仅限最近站点',
  single: '单独配送',
  same: '同店合并',
  any: '顺路合并',
};

export const DISTRICT_NAMES: readonly string[] = ['老街', '写字楼区', '大学城'];

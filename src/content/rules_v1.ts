// 经营模式的规矩卡 v1：调度台上每一栏玩家能选的卡。只放数据，判断的函数在核心里（campaign/unlocks.ts 的 ruleOffered）。
// 规则编号就是核心规则注册表里的编号，顺序就是调度台上的顺序。
//
// 「一趟送几单」一栏没有「一趟送一单」。把全部规则组合都遍历一遍，它没有任何不劣的情形，全城统计三项都最差，所以经营模式删掉这张卡。
// 没买双层货箱时这一栏不开放，核心内部仍按一趟送一单运行（开局的规矩就是 single）。买下双层货箱时这一栏开放，自动换成「顺路的一起送」（any）。
// 沙盒模式不受这张表约束，single 仍在核心的规则注册表里，照常能用。
// 先送哪张单这一栏列的是核心的六个编号，其中 prioOld、prioOffice、prioCampus 在界面上合成一张「某一片的先送」，选中之后再选片区。
import type { CampaignRulesV1 } from './table_types.ts';

export const CAMPAIGN_RULES_V1: CampaignRulesV1 = {
  select: ['fifo', 'deadline', 'roundtrip', 'prioOld', 'prioOffice', 'prioCampus'],
  pool: ['same', 'any'],
  zone: ['global', 'hybrid', 'strict'],
};

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

# 楼顶外卖站

在楼顶开无人机外卖站。饭点忙起来，先送哪张由你来定。

**在浏览器里玩：<https://yyyjh1.github.io/sky-delivery/>**

<p align="center">
<a href="https://github.com/YYYJH1/sky-delivery/actions/workflows/pages.yml"><img alt="构建和部署" src="https://github.com/YYYJH1/sky-delivery/actions/workflows/pages.yml/badge.svg"></a>
<a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-2a3770"></a>
</p>

<p align="center"><img alt="第 7 天的午高峰。左边是老街，河对岸是写字楼区，两边各有一个站点。左上角按片区列出本场的准时、超时、取消和目标准时率。店门口的票杆上挂着等待派出的订单小票，红色的快要超时或已经超时。右边是收起的调度台，写着午高峰用的两张策略卡。" src="docs/screenshot.png" width="880"></p>

- 在楼顶新建站点，购买无人机，订单自动派出。
- 每天有午高峰和晚高峰。高峰开始时，按近两日的成绩和星级线给开通的片区算出本场的目标准时率，数据不足或准时率已经够了时不设。高峰结束后出一张小结，列出订单耗时的构成。这一场用的调度策略或协同策略和开局不同时，小结还会在同一批订单上和开局策略对照。
- 调整调度台上的策略，在下一场高峰检验结果。游戏可以开着自动运行。

城里有三个片区：老街、写字楼区和大学城。一开始只有老街。写字楼区的订单集中在午高峰，大学城和老街的订单集中在晚高峰。每天结束时有一张日结小票。片区按近两日的准时率和取消率评星，达到下一档就升一星。三星以上的片区连续两天没守住，会降一星。星级越高，第二天的订单越多，顾客也越没有耐心，等得太久的订单会被取消。老街到三星后，写字楼区出现在地图上。写字楼区到四星后，大学城出现。片区要花钱开通才能建站，新开通的片区头两天订单少一些。三个片区都到四星时，会出一张结局便签，写着一共送了多少单、用了多少天。

调度台有三栏策略：调度策略、合单策略和协同策略。每栏有几张策略卡，随进度逐步解锁。开通写字楼区以后，午高峰和晚高峰可以分别设置。

空格键暂停。数字键 1、2、3 换速度。右键或 Esc 一层层取消。关掉页面也没关系。下次打开时，按近两日收入的三成结算离线收益，离线时间最多计 30 分钟。存档放在浏览器里。菜单里可以把存档导出成一段文字，换个浏览器再导入。

游戏里的文字只有中文。画面按电脑浏览器和不小于 1280 × 720 的窗口设计，窗口更小时页面会出现滚动条。

## 自己运行

需要 Node 22.18 或更新的版本。在仓库根目录运行：

```bash
npm ci
npm run dev
```

Vite 会打印要打开的地址。`npm test` 运行测试，`npm run build` 构建网页版，产物在 `dist/`。

## 许可

游戏以 MIT 许可发布，见 [LICENSE](LICENSE)。画面和界面全部由代码绘制，用到了 [PixiJS](https://pixijs.com)（MIT）、[Preact](https://preactjs.com)（MIT）和 @preact/signals（MIT）。字体是思源宋体、思源黑体、缝合像素字体和小赖字体的子集，都以 SIL Open Font License 1.1 发布，来源和许可证全文见 [public/fonts/SOURCES_zh.md](public/fonts/SOURCES_zh.md)。[THIRD_PARTY_NOTICES_zh.md](THIRD_PARTY_NOTICES_zh.md) 列出了全部第三方组件和它们的许可证。

<p align="center"><a href="SOURCES.md">English</a> · <b>简体中文</b></p>

# 字体来源和许可

游戏附带四种字体。这里的 woff2 都是子集：只含游戏文字（src/content/strings.zh.ts）里用到的字，加上半角可打印字符和几个版式符号。四种字体都是 SIL Open Font License 1.1，许可证全文在本目录的 OFL-*.txt。游戏代码不因此改许可证（OFL FAQ 1.3），只有字体文件本身适用 OFL。

| 文件 | 字体 | 版本 | 大小 |
|---|---|---|---|
| sky-serif-bold.woff2 | 思源宋体 Noto Serif SC，取 wght=700 的实例 | 2.003-H1 | 约 41 KB |
| sky-pixel.woff2 | 缝合像素字体 Fusion Pixel 12px 比例版 zh_hans | 2026.11.10 | 约 19 KB |
| sky-hand.woff2 | 小赖字体 Xiaolai Regular | 3.126 | 约 87 KB |
| sky-sans.woff2 | 思源黑体 Noto Sans SC，可变字体，字重轴取 400 到 700 | 2.004-H2 | 约 149 KB |

CSS 里的名字是 SkySerif、SkyPixel、SkyHand、SkySans，见 fonts.css。

## 来源

| 字体 | 下载地址 | 版权 | 许可证全文 |
|---|---|---|---|
| 思源宋体 Noto Serif SC | <https://github.com/google/fonts/tree/main/ofl/notoserifsc> 里的 NotoSerifSC[wght].ttf，Google Fonts 版，可变字体。字体的正式上游是 <https://github.com/notofonts/noto-cjk> | (c) 2017-2024 Adobe。Google Fonts 版的 OFL.txt 首行是 Copyright 2012 Google Inc. | OFL-NotoSerifSC.txt。名称表里没有保留字体名 |
| 缝合像素字体 Fusion Pixel | <https://github.com/TakWolf/fusion-pixel-font> ，发布包 <https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.11.10/fusion-pixel-font-12px-proportional-ttf-v2026.11.10.zip> 里的 fusion-pixel-12px-proportional-zh_hans.ttf | Copyright (c) 2022, TakWolf | OFL-FusionPixel.txt。没有保留字体名。它合并了几款上游字体，上游的许可证随发布包附带，复制在 LICENSES-FusionPixel-upstream/（方舟像素字体 OFL、俐方体 OFL、Galmuri） |
| 小赖字体 Xiaolai | <https://github.com/lxgw/kose-font> ，<https://github.com/lxgw/kose-font/releases/download/v3.126/Xiaolai-Regular.ttf> | Copyright 2020-2024 LXGW，Copyright 2014 Nozomi Seto | OFL-Xiaolai.txt。没有保留字体名 |
| 思源黑体 Noto Sans SC | <https://github.com/google/fonts/tree/main/ofl/notosanssc> 里的 NotoSansSC[wght].ttf，Google Fonts 版，可变字体 | Copyright 2014-2021 Adobe，带保留字体名 Source | OFL-NotoSansSC.txt |

## 改动

子集化，取实例（思源宋体取 wght=700，思源黑体把字重轴限在 400 到 700），去掉字形提示，把名称表里的字体名加后缀 Sky Subset。OFL 允许这样改，并且要求改过的版本仍用 OFL，所以本目录带着许可证全文。版权、许可证和许可证网址的名称表条目没有改。

思源黑体的版权行写了保留字体名 Source，所以改过的字体名里不出现 Source（现在是 Noto Sans SC Sky Subset）。另外三款没有保留字体名，加后缀只是为了不和原字体混淆。

缝合像素字体的 OS/2 嵌入标志位 fsType 是 4（仅限预览和打印嵌入），子集后没有改，保持原值。浏览器加载 @font-face 的网页字体时不看这个标志。OFL 本身允许随软件嵌入。

## 原件

子集用 fontTools 做：按上面「来源」一节的下载地址取得原件，只留游戏用到的字，可变字体取上表写的实例，去掉字形提示，名称表里的字体名加后缀 Sky Subset，再压缩成 woff2。下表是原件的大小和 SHA-256，可以核对下载的是不是同一份。

| 原件 | 大小（字节） | SHA-256 |
|---|---|---|
| NotoSerifSC[wght].ttf | 25,125,512 | 050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9 |
| fusion-pixel-12px-proportional-zh_hans.ttf | 7,316,996 | 7e93fedda2c55bb37badb2262aaf43b08e3cb5976a0e3de2d90986ce59fe902e |
| Xiaolai-Regular.ttf | 22,220,806 | e2f68daf0e72777a8cf58bc83de1b98634b251e537ddbfca24b0ae50d1802da2 |
| NotoSansSC[wght].ttf | 17,772,300 | a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da |

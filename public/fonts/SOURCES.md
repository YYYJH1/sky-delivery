<p align="center"><b>English</b> · <a href="SOURCES_zh.md">简体中文</a></p>

# Font sources and licenses

The game ships four fonts. The woff2 files here are subsets: each keeps only the characters used by the game text (src/content/strings.zh.ts), plus the printable ASCII range and a few typographic symbols. All four fonts are under the SIL Open Font License 1.1, and the full license texts are the OFL-*.txt files in this folder. The license of the game code does not change because of them (OFL FAQ 1.3). The OFL applies to the font files only.

| File | Font | Version | Size |
|---|---|---|---|
| sky-serif-bold.woff2 | Noto Serif SC, instance at wght=700 | 2.003-H1 | about 41 KB |
| sky-pixel.woff2 | Fusion Pixel Font 12px proportional, zh_hans | 2026.11.10 | about 19 KB |
| sky-hand.woff2 | Xiaolai Regular | 3.126 | about 87 KB |
| sky-sans.woff2 | Noto Sans SC, variable, weight axis kept from 400 to 700 | 2.004-H2 | about 149 KB |

The CSS names are SkySerif, SkyPixel, SkyHand and SkySans, see fonts.css.

## Sources

| Font | Download | Copyright | License text |
|---|---|---|---|
| Noto Serif SC | NotoSerifSC[wght].ttf from <https://github.com/google/fonts/tree/main/ofl/notoserifsc>, the Google Fonts build, variable. The upstream of the font is <https://github.com/notofonts/noto-cjk> | (c) 2017-2024 Adobe. The OFL.txt of the Google Fonts build starts with Copyright 2012 Google Inc. | OFL-NotoSerifSC.txt. The name table declares no Reserved Font Name |
| Fusion Pixel Font | <https://github.com/TakWolf/fusion-pixel-font>, the file fusion-pixel-12px-proportional-zh_hans.ttf in the release package <https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.11.10/fusion-pixel-font-12px-proportional-ttf-v2026.11.10.zip> | Copyright (c) 2022, TakWolf | OFL-FusionPixel.txt. No Reserved Font Name. It merges several upstream fonts, and their licenses, which come with the release package, are copied into LICENSES-FusionPixel-upstream/ (Ark Pixel Font OFL, Cubic 11 OFL, Galmuri) |
| Xiaolai | <https://github.com/lxgw/kose-font>, <https://github.com/lxgw/kose-font/releases/download/v3.126/Xiaolai-Regular.ttf> | Copyright 2020-2024 LXGW, Copyright 2014 Nozomi Seto | OFL-Xiaolai.txt. No Reserved Font Name |
| Noto Sans SC | NotoSansSC[wght].ttf from <https://github.com/google/fonts/tree/main/ofl/notosanssc>, the Google Fonts build, variable | Copyright 2014-2021 Adobe, with Reserved Font Name Source | OFL-NotoSansSC.txt |

## Changes

The fonts are subset, the variable fonts are instantiated (Noto Serif SC at wght=700, Noto Sans SC with the weight axis limited to 400 to 700), glyph hinting is removed, and the family names in the name tables get the suffix Sky Subset. The OFL allows these changes and requires the changed versions to stay under the OFL, so this folder carries the full license texts. The copyright, license and license URL entries of the name tables are unchanged.

The copyright line of Noto Sans SC declares the Reserved Font Name Source, so the changed font name does not contain Source (it is now Noto Sans SC Sky Subset). The other three fonts declare no Reserved Font Name, and the suffix only keeps them apart from the original fonts.

The OS/2 embedding flag fsType of Fusion Pixel Font is 4 (preview and print embedding). The subset keeps the original value. Browsers do not read this flag when they load @font-face web fonts. The OFL itself allows the fonts to be embedded with software.

## Original files

The subsets are made with fontTools: the original files are downloaded from the addresses in the Sources section above, only the characters the game uses are kept, the variable fonts are instantiated as described above, glyph hinting is removed, the family names get the suffix Sky Subset, and the result is compressed to woff2. The table gives the size and SHA-256 of each original file, to check that a download is the same file.

| Original file | Size (bytes) | SHA-256 |
|---|---|---|
| NotoSerifSC[wght].ttf | 25,125,512 | 050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9 |
| fusion-pixel-12px-proportional-zh_hans.ttf | 7,316,996 | 7e93fedda2c55bb37badb2262aaf43b08e3cb5976a0e3de2d90986ce59fe902e |
| Xiaolai-Regular.ttf | 22,220,806 | e2f68daf0e72777a8cf58bc83de1b98634b251e537ddbfca24b0ae50d1802da2 |
| NotoSansSC[wght].ttf | 17,772,300 | a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da |

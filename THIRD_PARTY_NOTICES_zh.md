<p align="center"><a href="THIRD_PARTY_NOTICES.md">English</a> · <b>简体中文</b></p>

# 第三方许可说明

本仓库的游戏代码以 MIT 许可发布，见 `LICENSE`。网页版的构建产物里含有或附带下列第三方软件和字体。每一项写名称、版本、许可证和版权行，以及随包或随字体附带的许可证原文。

## npm 包

下表是 `package-lock.json` 里标为非开发依赖的包，版本是锁定的版本：`package.json` 里的三个运行时依赖（`@preact/signals`、`pixi.js`、`preact`）和它们依赖的全部包。开发工具（Vite、Vitest、TypeScript 和它们的依赖）不进构建产物，不列在这里。下面的许可证原文从 `node_modules` 里各包自带的 `LICENSE` 文件原样复制。

最后一列写代码是否进入构建产物。游戏页面打包了 preact、两个 signals 包、渲染库 pixi.js，以及 pixi.js 带进来的六个包。gifuct-js、js-binary-schema-parser 和 @xmldom/xmldom 游戏用不到，没有进入构建产物。

| 包 | 版本 | 许可证 | 版权 | 是否进入构建产物 |
|---|---|---|---|---|
| preact | 11.1.0 | MIT | Copyright (c) 2015-present Jason Miller | 游戏页面 |
| @preact/signals | 2.11.4 | MIT | Copyright (c) 2022-present Preact Team | 游戏页面 |
| @preact/signals-core | 1.14.5 | MIT | Copyright (c) 2022-present Preact Team | 游戏页面 |
| pixi.js | 8.22.0 | MIT | Copyright (c) 2013-2023 Mathew Groves, Chad Engler | 游戏页面 |
| @pixi/colord | 2.9.6 | MIT | Copyright (c) Vlad Shilov <omgovich@ya.ru> | 游戏页面 |
| earcut | 3.2.4 | ISC | Copyright (c) 2026, Mapbox | 游戏页面 |
| eventemitter3 | 5.0.4 | MIT | Copyright (c) 2014 Arnout Kazemier | 游戏页面 |
| ismobilejs | 1.1.1 | MIT | Copyright (c) 2019 Kai Mallea | 游戏页面 |
| parse-svg-path | 0.2.0 | MIT | Copyright (c) 2013 Jake Rosoman <jkroso@gmail.com> | 游戏页面 |
| tiny-lru | 11.4.7 | BSD-3-Clause | Copyright (c) 2026, Jason Mulligan | 游戏页面 |
| gifuct-js | 2.1.2 | MIT | Copyright (c) 2015 Matt Way | pixi.js 的依赖，没有打包 |
| js-binary-schema-parser | 2.0.3 | MIT | Copyright (c) 2015 Matt Way | gifuct-js 的依赖，没有打包 |
| @xmldom/xmldom | 0.8.15 | MIT | Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors<br>Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors | pixi.js 的依赖，没有打包 |
| @types/earcut | 3.0.0 | MIT | Copyright (c) Microsoft Corporation. | 只有类型声明，没有打包 |
| @webgpu/types | 0.1.74 | BSD-3-Clause | Copyright 2022 WebGPU Developers | 只有类型声明，没有打包 |

### 许可证原文

#### preact 11.1.0

许可证：MIT。版权：Copyright (c) 2015-present Jason Miller

```text
The MIT License (MIT)

Copyright (c) 2015-present Jason Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### @preact/signals 2.11.4, @preact/signals-core 1.14.5

许可证：MIT。版权：Copyright (c) 2022-present Preact Team

```text
The MIT License (MIT)

Copyright (c) 2022-present Preact Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### pixi.js 8.22.0

许可证：MIT。版权：Copyright (c) 2013-2023 Mathew Groves, Chad Engler

```text
The MIT License

Copyright (c) 2013-2023 Mathew Groves, Chad Engler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### @pixi/colord 2.9.6

许可证：MIT。版权：Copyright (c) Vlad Shilov <omgovich@ya.ru>

这个包没有附带许可证文件。它的 package.json 声明了 MIT，并写了上面的作者（没有写年份），所以这里给出标准的 MIT 文本，版权人写这个名字。

```text
The MIT License (MIT)

Copyright (c) Vlad Shilov <omgovich@ya.ru>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### earcut 3.2.4

许可证：ISC。版权：Copyright (c) 2026, Mapbox

```text
ISC License

Copyright (c) 2026, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

#### eventemitter3 5.0.4

许可证：MIT。版权：Copyright (c) 2014 Arnout Kazemier

```text
The MIT License (MIT)

Copyright (c) 2014 Arnout Kazemier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### ismobilejs 1.1.1

许可证：MIT。版权：Copyright (c) 2019 Kai Mallea

```text
MIT License

Copyright (c) 2019 Kai Mallea

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### parse-svg-path 0.2.0

许可证：MIT。版权：Copyright (c) 2013 Jake Rosoman <jkroso@gmail.com>

```text
The MIT License

Copyright (c) 2013 Jake Rosoman <jkroso@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### tiny-lru 11.4.7

许可证：BSD-3-Clause。版权：Copyright (c) 2026, Jason Mulligan

```text
Copyright (c) 2026, Jason Mulligan
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of tiny-lru nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

#### gifuct-js 2.1.2, js-binary-schema-parser 2.0.3

许可证：MIT。版权：Copyright (c) 2015 Matt Way

```text
The MIT License (MIT)

Copyright (c) 2015 Matt Way

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### @xmldom/xmldom 0.8.15

许可证：MIT。版权：Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors / Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors

```text
Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors
Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### @types/earcut 3.0.0

许可证：MIT。版权：Copyright (c) Microsoft Corporation.

```text
    MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```

#### @webgpu/types 0.1.74

许可证：BSD-3-Clause。版权：Copyright 2022 WebGPU Developers

```text
Copyright 2022 WebGPU Developers

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

   1. Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.

   2. Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

   3. Neither the name of the copyright holder nor the names of its
      contributors may be used to endorse or promote products derived from this
      software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## 字体

`public/fonts/` 里的四种字体是 SIL Open Font License 1.1（OFL）字体的子集。每种字体的许可证原文放在字体文件旁边，网页版在 `fonts/` 下一起提供。OFL 只适用于字体文件本身，不改变游戏代码的许可证。

| 文件 | 字体 | 版本 | 来源 | 版权（字体文件里记的） | 许可证原文 |
|---|---|---|---|---|---|
| `sky-serif-bold.woff2` | 思源宋体 Noto Serif SC，取 wght=700 的实例 | 2.003-H1 | <https://github.com/google/fonts/tree/main/ofl/notoserifsc> （`NotoSerifSC[wght].ttf`，Google Fonts 版）。正式上游：<https://github.com/notofonts/noto-cjk> | (c) 2017-2024 Adobe (http://www.adobe.com/). | `public/fonts/OFL-NotoSerifSC.txt` |
| `sky-pixel.woff2` | 缝合像素字体 Fusion Pixel 12px 比例版 zh_hans | 2026.11.10 | <https://github.com/TakWolf/fusion-pixel-font>，发布版 2026.11.10 里的 `fusion-pixel-12px-proportional-zh_hans.ttf` | Copyright (c) 2022, TakWolf (https://takwolf.com) | `public/fonts/OFL-FusionPixel.txt` |
| `sky-hand.woff2` | 小赖字体 Xiaolai Regular | 3.126 | <https://github.com/lxgw/kose-font>，发布版 v3.126 里的 `Xiaolai-Regular.ttf` | Copyright 2020-2024 LXGW (https://github.com/lxgw/kose-font)<br>Copyright 2014 Nozomi Seto (https://ja.osdn.net/projects/setofont/) | `public/fonts/OFL-Xiaolai.txt` |
| `sky-sans.woff2` | 思源黑体 Noto Sans SC，可变字体，字重轴限在 400 到 700 | 2.004-H2 | <https://github.com/google/fonts/tree/main/ofl/notosanssc> （`NotoSansSC[wght].ttf`，Google Fonts 版） | (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. | `public/fonts/OFL-NotoSansSC.txt` |

Google Fonts 版附带的许可证文件开头有各自的版权行：`OFL-NotoSerifSC.txt` 是「Copyright 2012 Google Inc. All Rights Reserved.」，`OFL-NotoSansSC.txt` 是「Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'」。表里写的是字体文件里记的版权行。

缝合像素字体合并了几款上游字体，它们的许可证原文放在 `public/fonts/LICENSES-FusionPixel-upstream/`：

- 方舟像素字体（Ark Pixel Font）：SIL OFL 1.1，Copyright (c) 2021, TakWolf（`ark-pixel/OFL.txt`）。
- 俐方体（Cubic 11）：SIL OFL 1.1，附有它所基于的 M+ 字体的声明，Copyright(c) 2005 M+ FONTS PROJECT 和 Copyright (C) 2002-2004 COZ（`cubic-11/OFL.txt`）。
- Galmuri：SIL OFL 1.1，Copyright (c) 2019–2025 Lee Minseo（`galmuri/LICENSE.txt`）。

### 对字体做的改动

OFL 允许修改，改过的版本仍用 OFL。这里的字体文件都是子集：只留游戏用到的字，加上半角可打印字符和几个版式符号。字形提示去掉了。可变字体取了实例，思源宋体取 wght=700，思源黑体把字重轴限在 400 到 700。每种字体的字体名加了后缀「Sky Subset」。思源黑体声明了保留字体名「Source」，所以新名字里不含它，另外三种没有保留字体名。名称表里的版权、许可证和许可证网址条目没有改。OS/2 的嵌入标志 fsType 没有改，缝合像素字体是 4，即仅限预览和打印嵌入。`public/fonts/SOURCES_zh.md` 写了子集是怎样做的，以及每个原件的大小和 SHA-256。

<p align="center"><b>English</b> · <a href="THIRD_PARTY_NOTICES_zh.md">简体中文</a></p>

# Third-party notices

The game code in this repository is released under the MIT License (see `LICENSE`). The web build also contains or ships the third-party software and fonts listed here. For each one this file gives the name, version, license and copyright line, and the license text as it ships with the package or font.

## npm packages

These are the packages that `package-lock.json` marks as non-development, at the pinned versions: the three runtime dependencies in `package.json` (`@preact/signals`, `pixi.js`, `preact`) and everything they depend on. The development tools (Vite, Vitest, TypeScript and their dependencies) are not part of the build output and are not listed. The license texts below are copied unchanged from the `LICENSE` file of each package in `node_modules`.

The last column says whether the code ends up in the build output. The game page bundles preact, the two signals packages, pixi.js (the rendering library) and the six packages that pixi.js brings in with it. gifuct-js, js-binary-schema-parser and @xmldom/xmldom are not used by the game and are left out of the build.

| Package | Version | License | Copyright | In the build output |
|---|---|---|---|---|
| preact | 11.1.0 | MIT | Copyright (c) 2015-present Jason Miller | game page |
| @preact/signals | 2.11.4 | MIT | Copyright (c) 2022-present Preact Team | game page |
| @preact/signals-core | 1.14.5 | MIT | Copyright (c) 2022-present Preact Team | game page |
| pixi.js | 8.22.0 | MIT | Copyright (c) 2013-2023 Mathew Groves, Chad Engler | game page |
| @pixi/colord | 2.9.6 | MIT | Copyright (c) Vlad Shilov <omgovich@ya.ru> | game page |
| earcut | 3.2.4 | ISC | Copyright (c) 2026, Mapbox | game page |
| eventemitter3 | 5.0.4 | MIT | Copyright (c) 2014 Arnout Kazemier | game page |
| ismobilejs | 1.1.1 | MIT | Copyright (c) 2019 Kai Mallea | game page |
| parse-svg-path | 0.2.0 | MIT | Copyright (c) 2013 Jake Rosoman <jkroso@gmail.com> | game page |
| tiny-lru | 11.4.7 | BSD-3-Clause | Copyright (c) 2026, Jason Mulligan | game page |
| gifuct-js | 2.1.2 | MIT | Copyright (c) 2015 Matt Way | dependency of pixi.js, not bundled |
| js-binary-schema-parser | 2.0.3 | MIT | Copyright (c) 2015 Matt Way | dependency of gifuct-js, not bundled |
| @xmldom/xmldom | 0.8.15 | MIT | Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors<br>Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors | dependency of pixi.js, not bundled |
| @types/earcut | 3.0.0 | MIT | Copyright (c) Microsoft Corporation. | type declarations only, not bundled |
| @webgpu/types | 0.1.74 | BSD-3-Clause | Copyright 2022 WebGPU Developers | type declarations only, not bundled |

### License texts

#### preact 11.1.0

License: MIT. Copyright (c) 2015-present Jason Miller

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

License: MIT. Copyright (c) 2022-present Preact Team

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

License: MIT. Copyright (c) 2013-2023 Mathew Groves, Chad Engler

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

License: MIT. Copyright (c) Vlad Shilov <omgovich@ya.ru>

The package ships no license file. Its package.json declares MIT and names the author above (no year is stated), so the standard MIT text is given with that name.

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

License: ISC. Copyright (c) 2026, Mapbox

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

License: MIT. Copyright (c) 2014 Arnout Kazemier

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

License: MIT. Copyright (c) 2019 Kai Mallea

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

License: MIT. Copyright (c) 2013 Jake Rosoman <jkroso@gmail.com>

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

License: BSD-3-Clause. Copyright (c) 2026, Jason Mulligan

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

License: MIT. Copyright (c) 2015 Matt Way

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

License: MIT. Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors / Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors

```text
Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors
Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### @types/earcut 3.0.0

License: MIT. Copyright (c) Microsoft Corporation.

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

License: BSD-3-Clause. Copyright 2022 WebGPU Developers

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

## Fonts

The four fonts in `public/fonts/` are subsets of fonts licensed under the SIL Open Font License 1.1 (OFL). Each font keeps its own license text next to the font files, and the web build serves them under `fonts/`. The OFL applies to the font files only. It does not change the license of the game code.

| File | Font | Version | Source | Copyright (from the font) | License text |
|---|---|---|---|---|---|
| `sky-serif-bold.woff2` | Noto Serif SC (Source Han Serif SC), instance at wght=700 | 2.003-H1 | <https://github.com/google/fonts/tree/main/ofl/notoserifsc> (`NotoSerifSC[wght].ttf`, Google Fonts build). Upstream: <https://github.com/notofonts/noto-cjk> | (c) 2017-2024 Adobe (http://www.adobe.com/). | `public/fonts/OFL-NotoSerifSC.txt` |
| `sky-pixel.woff2` | Fusion Pixel Font 12px proportional, zh_hans | 2026.11.10 | <https://github.com/TakWolf/fusion-pixel-font>, release 2026.11.10, `fusion-pixel-12px-proportional-zh_hans.ttf` | Copyright (c) 2022, TakWolf (https://takwolf.com) | `public/fonts/OFL-FusionPixel.txt` |
| `sky-hand.woff2` | Xiaolai Regular | 3.126 | <https://github.com/lxgw/kose-font>, release v3.126, `Xiaolai-Regular.ttf` | Copyright 2020-2024 LXGW (https://github.com/lxgw/kose-font)<br>Copyright 2014 Nozomi Seto (https://ja.osdn.net/projects/setofont/) | `public/fonts/OFL-Xiaolai.txt` |
| `sky-sans.woff2` | Noto Sans SC (Source Han Sans SC), variable weight axis limited to 400 to 700 | 2.004-H2 | <https://github.com/google/fonts/tree/main/ofl/notosanssc> (`NotoSansSC[wght].ttf`, Google Fonts build) | (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. | `public/fonts/OFL-NotoSansSC.txt` |

The license files that ship with the Google Fonts builds start with their own copyright lines: `OFL-NotoSerifSC.txt` with "Copyright 2012 Google Inc. All Rights Reserved." and `OFL-NotoSansSC.txt` with "Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'". The table gives the copyright line stored in each font file.

Fusion Pixel Font merges several upstream fonts. Their license texts are kept in `public/fonts/LICENSES-FusionPixel-upstream/`:

- Ark Pixel Font: SIL OFL 1.1, Copyright (c) 2021, TakWolf (`ark-pixel/OFL.txt`).
- Cubic 11: SIL OFL 1.1, together with the notices of the M+ fonts it builds on, Copyright(c) 2005 M+ FONTS PROJECT and Copyright (C) 2002-2004 COZ (`cubic-11/OFL.txt`).
- Galmuri: SIL OFL 1.1, Copyright (c) 2019–2025 Lee Minseo (`galmuri/LICENSE.txt`).

### Changes made to the fonts

The OFL allows modified versions under the same license. The font files here are subsets: each keeps only the characters the game uses, plus the printable ASCII range and a few typographic symbols, glyph hinting is removed, and the variable fonts are instantiated (Noto Serif SC at wght=700, Noto Sans SC with the weight axis limited to 400 to 700). The family name in each font is extended with the suffix "Sky Subset". Noto Sans SC declares the Reserved Font Name "Source", so its new name does not contain it. The other three fonts declare no Reserved Font Name. Copyright, license and license URL entries of the name tables are unchanged. The OS/2 `fsType` embedding flag is unchanged (Fusion Pixel Font sets it to 4, preview and print embedding). `public/fonts/SOURCES.md` records how the subsets were made and the size and SHA-256 of each original file.

<p align="center"><b>English</b> · <a href="README_zh.md">简体中文</a></p>

# 楼顶外卖站

You run a drone takeout station on the city's rooftops. Mealtimes get busy, and you decide which order goes first.

**Play in the browser: <https://yyyjh1.github.io/sky-delivery/>**

<p align="center">
<a href="https://github.com/YYYJH1/sky-delivery/actions/workflows/pages.yml"><img alt="Build and deploy" src="https://github.com/YYYJH1/sky-delivery/actions/workflows/pages.yml/badge.svg"></a>
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2a3770"></a>
</p>

<p align="center"><img alt="The lunch rush on day 18, with all three districts open. The top left lists this rush's on-time, late and cancelled orders and the on-time target for each district, and under the timeline at the top is a band showing how busy the fleet was through the previous day. Station 2 is selected. Its card shows the last rush's takeoff queue, landing wait, sorties and how its drones spent their time. Above the card, a forecast for upgrading the station's gate to level 2 came out better in 14 of 16 order sequences, with 6.2 more on-time orders on average. The folded dispatch board is on the right." src="docs/screenshot.png" width="880"></p>

- Build stations on rooftops and buy drones and upgrades. Orders are dispatched automatically. The upgrade list says when each upgrade helps and which number to watch.
- There is a rush at lunch and another at dinner. When a rush starts, each open district gets an on-time target worked out from the last two days and the star line, unless there is too little data or the rate is already safe. After the rush a summary shows what the delivery time was made of and how the fleet spent its time. If the rush used dispatch or cooperation cards other than the starting ones, the summary also compares the result with the starting strategy on the same orders, and says so when the difference is within the usual swing of a single rush.
- Soon after the start a data clerk joins. Before you add a bay, buy a drone or an upgrade, or change a card, the clerk can run a forecast: the game is played on 16 sets of future orders up to the second rush summary from now, with and without the change, and the sheet counts how often it came out better. After you upgrade a gate, buy the double box or buy nearest landing, three of the following daily receipts each show the matching number next to what the same rush would have given without it, as long as the page stays open.
- Adjust the strategies on the dispatch board and check the result in the next rush. The game keeps running on its own.

The city has three districts: Old Street, the Office District and University Town. At first there is only Old Street. Office District orders peak at lunch, while University Town and Old Street orders peak at dinner. Each day ends with a daily receipt. A district is rated on its on-time and cancellation rates over the last two days, and it gains a star when it reaches the next level. A district at three stars or more loses one if it falls short two days running. A district with more stars gets more orders the next day, and its customers are less patient, so orders that wait too long are cancelled. The Office District appears on the map when Old Street reaches three stars, and University Town appears when the Office District reaches four. A district has to be paid for before you can build stations there, and a newly opened district gets fewer orders for its first two days. When all three districts reach four stars, a closing note shows how many orders you delivered and how many days it took.

The dispatch board has three columns of strategy: dispatch order, order batching and station cooperation. Each column has a few strategy cards that unlock as you play. Once the Office District is open, the lunch rush and the dinner rush can each have their own settings.

Space pauses. The keys 1, 2 and 3 change the speed. A right click or Esc backs out one step at a time. You can close the page. When you come back, you receive offline earnings at 30% of your income rate over the last two days, counting at most 30 minutes away. The save stays in the browser, and the menu can export it as a line of text to import in another browser.

The game is in Chinese only. It is made for a desktop browser and a window of 1280 × 720 or larger. In a smaller window the page scrolls.

## Run it yourself

You need Node 22.18 or later. In the root of the repository:

```bash
npm ci
npm run dev
```

Vite prints the address to open. `npm test` runs the tests, and `npm run build` builds the web version into `dist/`.

## License

The game is under the MIT License, see [LICENSE](LICENSE). Everything on screen is drawn by code, with [PixiJS](https://pixijs.com) (MIT), [Preact](https://preactjs.com) (MIT) and @preact/signals (MIT). The fonts are subsets of Noto Serif SC, Noto Sans SC, Fusion Pixel Font and Xiaolai, all under the SIL Open Font License 1.1, and [public/fonts/SOURCES.md](public/fonts/SOURCES.md) gives their sources and license texts. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists every third-party component with its license.

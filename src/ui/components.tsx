// 常驻界面的部件：小票、日程纸条（右端贴便签）、速度纸条、价签、改装面板、站点小卡、系统提示、菜单。
// 片区纸条、地图上的开通价签、结局在 note-panels.tsx，调度台在 board-panel.tsx，高峰小结和日结在 ticket-panels.tsx。
// 部件只读 state.ts 里的界面数据和界面状态，点击交给 actions，不碰游戏状态。文字全部取自词表。
// 界面是直角，纸白底，蓝黑细边，没有纸纹、阴影和动画。
import { STR, fmt, peakName, reasonText, stationNumeral } from '../content/strings.zh.ts';
import { BoardPanel } from './board-panel.tsx';
import { cardPlacement } from './map-layout.ts';
import { DistrictNote, EndingNote, OpenTags, TipNote } from './note-panels.tsx';
import { PEAK_BANDS, TICK_MARKS } from './schedule.ts';
import {
  actions,
  anchor,
  blocked,
  buildMode,
  exportCode,
  importOpen,
  menuOpen,
  roofLabels,
  run,
  selected,
  toast,
  tooltip,
  uiData,
  upgradesOpen,
  windowView,
} from './state.ts';
import type { UpgradeItem } from './tags.ts';
import { DayEndTicket, SummaryTicket } from './ticket-panels.tsx';
import type { StationCard, UiData } from './view-model.ts';

// ---- 左上：小票 ----
export function Ticket({ d }: { d: UiData }) {
  return (
    <div class="corner tl">
      <div class="block receipt" data-part="ticket">
        {fmt(STR.hud.ticket, { balance: d.balance, earned: d.earned })}
      </div>
    </div>
  );
}

// ---- 顶部正中：日程纸条 ----
const RULER_WIDTH = 520;
const RULER_HEIGHT = 62;

export function Schedule({ d }: { d: UiData }) {
  const markerX = d.dayFraction * RULER_WIDTH;
  return (
    <div class="corner tc">
      <div class="block paper schedule" data-part="schedule">
        <div class="clock">{fmt(STR.hud.schedule.dayTime, { day: d.day, time: d.clock })}</div>
        <svg class="ruler" width={RULER_WIDTH} height={RULER_HEIGHT} viewBox={`0 0 ${RULER_WIDTH} ${RULER_HEIGHT}`}>
          <defs>
            <pattern id="peak-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line class="hatch-line" x1="0" y1="0" x2="0" y2="6" />
            </pattern>
          </defs>
          {PEAK_BANDS.map((band) => (
            <g key={band.key}>
              <rect
                class={d.peak === band.key ? 'band on' : 'band'}
                x={band.from * RULER_WIDTH}
                y="18"
                width={(band.to - band.from) * RULER_WIDTH}
                height="12"
              />
              <text class="band-name" x={((band.from + band.to) / 2) * RULER_WIDTH} y="13" text-anchor="middle">
                {peakName(band.key)}
              </text>
            </g>
          ))}
          <line class="ruler-line" x1="0" y1="33" x2={RULER_WIDTH} y2="33" />
          {TICK_MARKS.map((t) => (
            <g key={t.hour}>
              <line class="ruler-line" x1={t.at * RULER_WIDTH} y1="33" x2={t.at * RULER_WIDTH} y2="38" />
              <text class="tick-name" x={t.at * RULER_WIDTH} y="57" text-anchor="middle">
                {t.hour}
              </text>
            </g>
          ))}
          <line class="now-line" x1={markerX} y1="17" x2={markerX} y2="35" />
          <polygon class="now-mark" points={`${markerX - 6},46 ${markerX + 6},46 ${markerX},35`} />
        </svg>
      </div>
      <TipNote d={d} />
    </div>
  );
}

// ---- 右上：速度纸条 ----
export function SpeedStrip() {
  const { paused, speed } = run.value;
  const item = (name: string, label: string, on: boolean, onClick: () => void) => (
    <span class={on ? 'word on' : 'word'} data-part={name} onClick={onClick}>
      {label}
    </span>
  );
  return (
    <div class="corner tr">
      <div class="block paper speed" data-part="speed">
        {item('pause', STR.hud.speed.pause, paused, () => actions.togglePause())}
        {item('x1', STR.hud.speed.x1, !paused && speed === 1, () => actions.setSpeed(1))}
        {item('x2', STR.hud.speed.x2, !paused && speed === 2, () => actions.setSpeed(2))}
        {item('x3', STR.hud.speed.x3, !paused && speed === 3, () => actions.setSpeed(3))}
        {item('menu', STR.hud.speed.menu, menuOpen.value, () => (menuOpen.value ? actions.closeMenu() : actions.openMenu()))}
      </div>
    </div>
  );
}

// ---- 左下：价签和改装面板 ----
function Tag(props: { part: string; text: string; dim?: boolean; on?: boolean; onClick: () => void }) {
  const cls = `tag${props.dim === true ? ' dim' : ''}${props.on === true ? ' on' : ''}`;
  return (
    <span class={cls} data-part={props.part} onClick={props.onClick}>
      {props.text}
    </span>
  );
}

/** 没选中站点时，两张价签参照编号最小的站。 */
function targetCard(d: UiData): StationCard | undefined {
  const sel = selected.value;
  const id = sel ?? d.fallbackStation;
  return d.stations.find((s) => s.id === id);
}

export function PriceTags({ d }: { d: UiData }) {
  if (!d.tagsShown) return null; // 第一次日结之后余额达到内容表里的数才开放，之前整排价签都不出现
  const card = targetCard(d);
  return (
    <div class="tags" data-part="tags">
      <Tag
        part="tag-build"
        text={fmt(STR.hud.price.buildStation, { price: d.build.tag.price })}
        dim={d.build.tag.dim}
        on={buildMode.value}
        onClick={() => actions.clickBuild()}
      />
      {card === undefined ? null : (
        <Tag
          part="tag-bay"
          text={fmt(STR.hud.price.addBay, { price: card.tags.addBay.price })}
          dim={card.tags.addBay.dim}
          onClick={() => actions.clickAddBay()}
        />
      )}
      {card === undefined ? null : (
        <Tag
          part="tag-drone"
          text={fmt(STR.hud.price.addDrone, { price: card.tags.addDrone.price })}
          dim={card.tags.addDrone.dim}
          onClick={() => actions.clickAddDrone()}
        />
      )}
      <Tag part="tag-upgrades" text={STR.hud.price.upgrades} on={upgradesOpen.value} onClick={() => actions.clickUpgrades()} />
    </div>
  );
}

/** 改装的第二行：说明，已经买过，没开放的提示，或者要先选一座站。文字都取自词表。 */
function upgradeLine(item: UpgradeItem): string {
  switch (item.note) {
    case 'desc':
      return STR.upgrades[item.key].desc;
    case 'owned':
      return reasonText('alreadyOwned');
    case 'locked':
      return STR.upgrades.nearbyLanding.locked;
    case 'needStation':
      return reasonText('noStationSelected');
  }
}

function UpgradeRow({ item }: { item: UpgradeItem }) {
  const name = fmt(STR.upgrades[item.key].name, { price: item.price });
  const cls = `upgrade${item.note !== 'desc' ? ' quiet' : ''}${item.dim ? ' dim' : ''}`;
  return (
    <div class={cls} data-part={`upgrade-${item.key}`} onClick={() => actions.clickUpgrade(item)}>
      <div class="upgrade-name">{name}</div>
      <div class="upgrade-line">{upgradeLine(item)}</div>
    </div>
  );
}

export function UpgradePanel({ d }: { d: UiData }) {
  if (!d.tagsShown || !upgradesOpen.value) return null;
  const sel = selected.value;
  const card = sel === null ? undefined : d.stations.find((s) => s.id === sel);
  const gate = card === undefined ? d.gateWithoutStation : card.gate;
  return (
    <div class="block paper upgrades" data-part="upgrades">
      {d.doubleBoxShown ? <UpgradeRow item={d.doubleBox} /> : null}
      <UpgradeRow item={gate} />
      <UpgradeRow item={d.nearbyLanding} />
    </div>
  );
}

// ---- 站点小卡 ----
export function StationCardView({ d }: { d: UiData }) {
  const sel = selected.value;
  const at = anchor.value;
  if (sel === null || at === null || buildMode.value) return null; // 选屋顶时不显示小卡，免得盖住候选屋顶
  const card = d.stations.find((s) => s.id === sel);
  if (card === undefined) return null;
  const view = windowView.value;
  const place = cardPlacement(at, view.width, view.height, view.scale);
  const style = `left:${place.left}px;top:${place.top}px;transform:scale(${view.scale})${place.flip ? ' translateX(-100%)' : ''}`;
  return (
    <div class="block paper card" data-part="card" style={style}>
      <div class="card-title">{fmt(STR.hud.card.title, { station: stationNumeral(card.number) })}</div>
      <div>{fmt(STR.hud.card.bays, { count: card.bays, limit: card.bayLimit })}</div>
      <div>{fmt(STR.hud.card.drones, { count: card.drones })}</div>
      <div>{fmt(STR.hud.card.gate, { level: card.gateLevel })}</div>
      <div>{fmt(STR.hud.holding, { count: card.holding })}</div>
      {card.refund === null ? null : (
        <div class="refund" data-part="refund" onClick={() => actions.clickRefund()}>
          {fmt(STR.system.refundAvailable, { refund: card.refund.amount })}
        </div>
      )}
    </div>
  );
}

// ---- 地图上：选屋顶时候选屋顶旁边的两行字，鼠标停在小票上的提示 ----
// 位置由 game.ts 算好，放在窗口坐标里，不挡鼠标：点击穿过它们落到地图上。
export function RoofLabels() {
  const list = roofLabels.value;
  if (list.length === 0) return null;
  return (
    <>
      {list.map((label) => (
        <div
          key={label.roof}
          class={label.ok ? 'roof-label' : 'roof-label dim'}
          data-part={`roof-label-${label.roof}`}
          style={`left:${label.x}px;top:${label.y}px;font-size:${label.px}px`}
        >
          {label.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ))}
    </>
  );
}

export function OrderTooltip() {
  const t = tooltip.value;
  if (t === null) return null;
  return (
    <div class="map-tooltip" data-part="order-tooltip" style={`left:${t.left}px;top:${t.top}px;font-size:${t.px}px`}>
      {t.text}
    </div>
  );
}

// ---- 下方：系统提示 ----
export function Toast() {
  const t = toast.value;
  if (t === null) return null;
  return (
    <div class="corner bc">
      <div class="block paper toast" data-part="toast" key={t.id}>
        {t.text}
      </div>
    </div>
  );
}

// ---- 菜单 ----
export function Menu() {
  if (!menuOpen.value) return null;
  const code = exportCode.value;
  const importing = importOpen.value;
  return (
    <div class="menu-corner">
      <div class="block paper menu" data-part="menu-panel">
        <div class="menu-item" data-part="menu-resume" onClick={() => actions.closeMenu()}>
          {STR.hud.menu.resume}
        </div>
        <div class="menu-item" data-part="menu-export" onClick={() => actions.exportSave()}>
          {STR.hud.menu.exportSave}
        </div>
        <div class="menu-item" data-part="menu-import" onClick={() => actions.toggleImport()}>
          {STR.hud.menu.importSave}
        </div>
        {importing ? (
          <textarea
            class="export-code"
            data-part="import-code"
            placeholder={STR.hud.menu.importHint}
            ref={(el) => el?.focus()}
            onPaste={(e) => {
              // 粘贴进来的整段文字直接读，不放进输入框
              const pasted = e.clipboardData?.getData('text') ?? '';
              if (pasted !== '') {
                e.preventDefault();
                actions.importSave(pasted);
              }
            }}
          />
        ) : null}
        <div class="menu-item" data-part="menu-quit" onClick={() => actions.quit()}>
          {STR.hud.menu.quit}
        </div>
        {code === null ? null : <textarea class="export-code" data-part="export-code" readOnly value={code} onFocus={(e) => e.currentTarget.select()} />}
      </div>
    </div>
  );
}

// ---- 同一个浏览器里另有页面在运行 ----
export function BlockedNotice() {
  return (
    <div class="blocked">
      <div class="block paper toast" data-part="blocked">
        {STR.system.otherPage}
      </div>
    </div>
  );
}

// ---- 全部 ----
export function Hud() {
  if (blocked.value) return <BlockedNotice />;
  const d = uiData.value;
  if (d === null) return null;
  return (
    <>
      <Ticket d={d} />
      <Schedule d={d} />
      <SpeedStrip />
      <div class="corner bl">
        <UpgradePanel d={d} />
        <PriceTags d={d} />
      </div>
      <OpenTags d={d} />
      <RoofLabels />
      <StationCardView d={d} />
      <DistrictNote d={d} />
      <BoardPanel d={d} />
      <SummaryTicket d={d} />
      <DayEndTicket d={d} />
      <EndingNote d={d} />
      <OrderTooltip />
      <Toast />
      <Menu />
    </>
  );
}

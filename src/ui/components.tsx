// 常驻界面的部件：小票（高峰进行中下面跟着各片区的结果）、日程纸条、速度纸条、价签、改装面板、站点小卡、系统提示、菜单。
// 片区纸条、便签、地图上的开通价签、结局在 note-panels.tsx，调度台在 board-panel.tsx，高峰小结和日结在 ticket-panels.tsx。
// 部件只读 state.ts 里的界面数据和界面状态，点击交给 actions，不碰游戏状态。文字全部取自词表。
// 物件是纸做的：小票是点阵字加锯齿的下沿，纸条是纸白底加蓝黑细边，价签切角打孔，都配一张代码画的背景图（Sheet）。
import { Fragment } from 'preact';
import { STR, fmt, peakName, reasonText, stationNumeral } from '../content/strings.zh.ts';
import { BoardPanel } from './board-panel.tsx';
import { cardPlacement } from './map-layout.ts';
import { DistrictNote, EndingNote, OpenTags, TipNote } from './note-panels.tsx';
import { PEAK_BANDS, TICK_MARKS } from './schedule.ts';
import { MarkUnderline, Sheet, TagText } from './sheets.tsx';
import {
  actions,
  anchor,
  blocked,
  buildMode,
  exportCode,
  importOpen,
  mapFailed,
  menuOpen,
  roofLabels,
  run,
  selected,
  soundOn,
  toast,
  tooltip,
  uiData,
  upgradesOpen,
  windowView,
} from './state.ts';
import type { UpgradeItem } from './tags.ts';
import { DayEndTicket, SummaryTicket } from './ticket-panels.tsx';
import type { StationCard, UiData } from './view-model.ts';

// ---- 左上：小票，高峰进行中它下面是各片区的结果和这一场的目标 ----
// 小票的文字是一句话，几段之间隔着全角空格。这里按全角空格拆成几行：标签、金额（36 像素的大字）、今日收入。
// 全角空格仍然留在页面里（.gap，不占位置），所以整张小票的文字和原来的一句话一样。
const SPLIT = String.fromCodePoint(0x3000);

export function Ticket({ d }: { d: UiData }) {
  const parts = fmt(STR.hud.ticket, { balance: d.balance, earned: d.earned }).split(SPLIT);
  return (
    <div class="corner tl">
      <Sheet kind="slip" seed={11} depth={4} class="block slip receipt" part="ticket">
        {parts.map((text, i) => (
          <Fragment key={i}>
            {i === 0 ? null : <span class="gap">{SPLIT}</span>}
            <span class={i === 1 ? 'px-row px-big' : 'px-row'}>{text}</span>
          </Fragment>
        ))}
      </Sheet>
      <LivePanel d={d} />
    </div>
  );
}

// 高峰进行中各片区已有的结果和这一场的目标：每个开通的片区一行，目标写在下面一行的小字里。
// 离目标线最远的一行加粗，下面画一道手写的线。
// 放在左上角的小票下面：那里没有地图，三个片区都开通时也不会盖住屋顶和店。高峰之外不显示。
export function LivePanel({ d }: { d: UiData }) {
  const live = d.live;
  if (live === null) return null;
  return (
    <Sheet kind="strip" seed={12} class="block paper live" part="live">
      {live.rows.map((r) => (
        <div key={r.district} class={r.farthest ? 'live-row far' : 'live-row'} data-part={`live-${r.name}`}>
          <span class="live-counts">
            {r.counts}
            {r.farthest ? <MarkUnderline seed={30 + r.district} /> : null}
          </span>
          {r.goal === null ? null : <span class="live-goal">{r.goal}</span>}
        </div>
      ))}
    </Sheet>
  );
}

// ---- 顶部正中：日程纸条 ----
const RULER_WIDTH = 520;
const RULER_HEIGHT = 62;

export function Schedule({ d }: { d: UiData }) {
  const markerX = d.dayFraction * RULER_WIDTH;
  return (
    <div class="corner tc">
      <Sheet kind="strip" seed={13} class="block paper schedule" part="schedule">
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
      </Sheet>
    </div>
  );
}

// ---- 右上：速度纸条 ----
export function SpeedStrip() {
  const { paused, speed } = run.value;
  const item = (name: string, label: string, on: boolean, onClick: () => void, seed: number) => (
    <span class={on ? 'word on' : 'word'} data-part={name} onClick={onClick}>
      {label}
      {on ? <MarkUnderline seed={seed} /> : null}
    </span>
  );
  return (
    <div class="corner tr">
      <Sheet kind="strip" seed={14} class="block paper speed" part="speed">
        {item('pause', STR.hud.speed.pause, paused, () => actions.togglePause(), 41)}
        {item('x1', STR.hud.speed.x1, !paused && speed === 1, () => actions.setSpeed(1), 42)}
        {item('x2', STR.hud.speed.x2, !paused && speed === 2, () => actions.setSpeed(2), 43)}
        {item('x3', STR.hud.speed.x3, !paused && speed === 3, () => actions.setSpeed(3), 44)}
        {item('menu', STR.hud.speed.menu, menuOpen.value, () => (menuOpen.value ? actions.closeMenu() : actions.openMenu()), 45)}
      </Sheet>
    </div>
  );
}

// ---- 左下：价签和改装面板，右边紧跟着片区纸条 ----
// 价签的价格越买越高，四张价签合起来的宽度会变。片区纸条排在价签后面（同一行，底边对齐），价签变宽时它跟着往右让，不会被压住。
function Tag(props: { part: string; text: string; seed: number; dim?: boolean; on?: boolean; onClick: () => void }) {
  const cls = `tag${props.dim === true ? ' dim' : ''}${props.on === true ? ' on' : ''}`;
  return (
    <Sheet kind="tag" seed={props.seed} class={cls} part={props.part} onClick={props.onClick}>
      <span class="tag-text">
        <TagText text={props.text} />
        {props.on === true ? <MarkUnderline seed={props.seed} /> : null}
      </span>
    </Sheet>
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
        seed={20}
        dim={d.build.tag.dim}
        on={buildMode.value}
        onClick={() => actions.clickBuild()}
      />
      {card === undefined ? null : (
        <Tag
          part="tag-bay"
          text={fmt(STR.hud.price.addBay, { price: card.tags.addBay.price })}
          seed={21}
          dim={card.tags.addBay.dim}
          onClick={() => actions.clickAddBay()}
        />
      )}
      {card === undefined ? null : (
        <Tag
          part="tag-drone"
          text={fmt(STR.hud.price.addDrone, { price: card.tags.addDrone.price })}
          seed={22}
          dim={card.tags.addDrone.dim}
          onClick={() => actions.clickAddDrone()}
        />
      )}
      <Tag part="tag-upgrades" text={STR.hud.price.upgrades} seed={23} on={upgradesOpen.value} onClick={() => actions.clickUpgrades()} />
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
    <Sheet kind="strip" seed={15} class="block paper upgrades" part="upgrades">
      {d.doubleBoxShown ? <UpgradeRow item={d.doubleBox} /> : null}
      <UpgradeRow item={gate} />
      <UpgradeRow item={d.nearbyLanding} />
    </Sheet>
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
  const style = { left: `${place.left}px`, top: `${place.top}px`, transform: `scale(${view.scale})${place.flip ? ' translateX(-100%)' : ''}` };
  return (
    <Sheet kind="strip" seed={16} class="block paper card" part="card" style={style}>
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
    </Sheet>
  );
}

// ---- 地图上：选屋顶时候选屋顶旁边的几行字，鼠标停在小票上的提示 ----
// 位置由 game.ts 算好，放在窗口坐标里，不挡鼠标：点击穿过它们落到地图上。文字离开屋顶时，一条细线连回屋顶。
export function RoofLabels() {
  const list = roofLabels.value;
  if (list.length === 0) return null;
  return (
    <>
      <svg class="roof-leaders" data-part="roof-leaders">
        {list.map((label) =>
          label.leader === null ? null : (
            <g key={label.roof} data-part={`roof-leader-${label.roof}`}>
              <line class="roof-leader" x1={label.leader.x1} y1={label.leader.y1} x2={label.leader.x2} y2={label.leader.y2} />
              <circle class="roof-leader-dot" cx={label.leader.x1} cy={label.leader.y1} r="2.5" />
            </g>
          ),
        )}
      </svg>
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
      <Sheet key={t.id} kind="strip" seed={17} class="block paper toast" part="toast">
        {t.text}
      </Sheet>
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
      <Sheet kind="strip" seed={18} class="block paper menu" part="menu-panel">
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
        <div class="menu-item" data-part="menu-sound" onClick={() => actions.toggleSound()}>
          {soundOn.value ? STR.hud.menu.soundOn : STR.hud.menu.soundOff}
        </div>
        <div class="menu-item" data-part="menu-quit" onClick={() => actions.quit()}>
          {STR.hud.menu.quit}
        </div>
        {code === null ? null : <textarea class="export-code" data-part="export-code" readOnly value={code} onFocus={(e) => e.currentTarget.select()} />}
      </Sheet>
    </div>
  );
}

// ---- 同一个浏览器里另有页面在运行 ----
export function BlockedNotice() {
  return (
    <div class="blocked">
      <Sheet kind="strip" seed={19} class="block paper toast" part="blocked">
        {STR.system.otherPage}
      </Sheet>
    </div>
  );
}

// ---- 地图画不出来 ----
export function MapFailedNotice() {
  return (
    <div class="blocked">
      <Sheet kind="strip" seed={19} class="block paper toast" part="map-failed">
        {STR.system.noWebGl}
      </Sheet>
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
        <div class="bl-stack">
          <UpgradePanel d={d} />
          <PriceTags d={d} />
        </div>
        <DistrictNote d={d} />
      </div>
      <OpenTags d={d} />
      <RoofLabels />
      <StationCardView d={d} />
      <BoardPanel d={d} />
      <SummaryTicket d={d} />
      <DayEndTicket d={d} />
      <TipNote d={d} />
      <EndingNote d={d} />
      <OrderTooltip />
      <Toast />
      <Menu />
      {mapFailed.value ? <MapFailedNotice /> : null}
    </>
  );
}

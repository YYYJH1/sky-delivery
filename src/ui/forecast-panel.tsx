// 数据员的推演在界面上的两样东西：入口处的「推演」按钮，和点了之后打开的推演单。
// 按钮是文字本身（加下划线），在改装单的节点旁、站点小卡的「本站可购买」旁、调度台的磁贴上。数据员没到岗时没有按钮。
// 推演单是一张纸条：标题，每套订单序列一个记号（更好是实心的向上三角，更差是空心的向下三角，持平是一小段横线），
// 更好和更差的次数，准时订单一行，收入一行，差别不明显时加一行，最后一行小字写统计范围。
// 推演单贴在按钮所在的物件旁边，不压住改装单、站点小卡、调度台和别的纸条，贴的办法与便签相同（note-panels.tsx）。
// 点推演单收起，右键和 Esc 也收起。部件只读 state.ts 里的界面数据，点击交给 actions。文字全部取自词表。
import { useLayoutEffect, useState } from 'preact/hooks';
import { forecastButton } from './forecast.ts';
import type { ForecastInfo, ForecastMark, ForecastOption, ForecastSheetState } from './forecast.ts';
import type { Rect } from './map-layout.ts';
import { hudRects } from './note-panels.tsx';
import { usePaper } from './paper-use.ts';
import { actions, forecastSheet, windowView } from './state.ts';
import type { WindowView } from './state.ts';
import { placeTip } from './tip-anchor.ts';
import type { UiData } from './view-model.ts';

/**
 * 一个「推演」按钮。option 为 null（这个入口没有可推演的选项）或数据员没到岗（info 为 null）时不画。
 * 推演进行中所有按钮都写「推演中」，不能再点。次数用完时按钮变淡，点了提示推演次数不足。
 * 点击不再往外传，免得同时点中按钮所在的那一行（买东西、换卡）。host 是推演单要贴在哪个物件旁边。
 */
export function ForecastButton({ info, option, host, part }: { info: ForecastInfo | null; option: ForecastOption | null; host: string; part: string }) {
  const busy = forecastSheet.value?.view.phase === 'running';
  const view = forecastButton(info, option, busy);
  if (view === null || option === null) return null;
  const cls = `forecast-btn${view.dim ? ' dim' : ''}${view.busy ? ' busy' : ''}`;
  return (
    <span
      class={cls}
      data-part={part}
      onClick={(event) => {
        event.stopPropagation();
        actions.clickForecast(option, host);
      }}
    >
      {view.text}
    </span>
  );
}

// ---- 推演单 ----

/** 记号的间隔和高度，设计像素。 */
const MARK_STEP = 18;
const MARK_HEIGHT = 18;

/** 一个记号的路径，cx 是它的中心。更好是向上的三角，更差是向下的三角，持平是一小段横线。 */
function markPath(mark: ForecastMark, cx: number): string {
  switch (mark) {
    case 'better':
      return `M${cx - 6},14 L${cx},3 L${cx + 6},14 Z`;
    case 'worse':
      return `M${cx - 6},4 L${cx + 6},4 L${cx},15 Z`;
    case 'tie':
      return `M${cx - 5},9 L${cx + 5},9`;
  }
}

/** 每套订单序列一个记号，排成一行。形状和填充不同，不靠颜色区分。 */
function Marks({ marks }: { marks: readonly ForecastMark[] }) {
  const width = marks.length * MARK_STEP;
  return (
    <svg class="forecast-marks" data-part="forecast-marks" width={width} height={MARK_HEIGHT} viewBox={`0 0 ${width} ${MARK_HEIGHT}`} aria-hidden="true">
      {marks.map((mark, i) => (
        <path key={i} class={`mk ${mark}`} data-mark={mark} d={markPath(mark, i * MARK_STEP + MARK_STEP / 2)} />
      ))}
    </svg>
  );
}

function SheetBody({ state }: { state: ForecastSheetState }) {
  const v = state.view;
  return (
    <>
      <div class="forecast-title" data-part="forecast-title">
        {v.title}
      </div>
      {v.phase === 'running' ? (
        <div class="forecast-line" data-part="forecast-running">
          {v.running}
        </div>
      ) : null}
      {v.phase === 'failed' ? (
        <div class="forecast-line" data-part="forecast-failed">
          {v.failed}
        </div>
      ) : null}
      {v.phase === 'done' ? (
        <>
          <Marks marks={v.marks} />
          <div class="forecast-line" data-part="forecast-tally">
            {v.tally}
          </div>
          <div class="forecast-line" data-part="forecast-ontime">
            {v.onTime}
          </div>
          <div class="forecast-line" data-part="forecast-revenue">
            {v.revenue}
          </div>
          {v.unclear === null ? null : (
            <div class="forecast-line" data-part="forecast-unclear">
              {v.unclear}
            </div>
          )}
          <div class="forecast-scope" data-part="forecast-scope">
            {v.scope}
          </div>
        </>
      ) : null}
    </>
  );
}

/** 推演单在窗口里的位置，左上角。 */
interface Place {
  readonly left: number;
  readonly top: number;
}

/**
 * 推演单现在该在哪里：贴在按钮所在的物件旁边，不压页面上别的纸条、小票、白板、价签和小卡（包括按钮所在的那个物件）。
 * 那个物件不在页面上时（关掉了改装单或取消了选中的站），贴在日程纸条旁边。位置夹在窗口里。
 */
function placeSheet(el: HTMLElement, host: string | null, view: WindowView): Place | null {
  const hud = el.parentElement;
  if (hud === null) return null;
  const origin = hud.getBoundingClientRect();
  const s = view.scale;
  const w = el.offsetWidth * s;
  const h = el.offsetHeight * s;
  if (w <= 0 || h <= 0) return null;
  const target = (host === null ? null : hud.querySelector(`[data-part="${host}"]`)) ?? hud.querySelector('[data-part="schedule"]');
  if (target === null) return { left: Math.max(12, (view.width - w) / 2), top: 110 * s };
  const r = target.getBoundingClientRect();
  const anchor: Rect = { x: r.x - origin.x, y: r.y - origin.y, w: r.width, h: r.height };
  const bounds: Rect = { x: 12, y: 12, w: view.width - 24, h: view.height - 24 };
  // 纸条的投影在框外面，留出这一圈再挑位置
  const grow = 8 * s;
  const p = placeTip(w + grow, h + grow, anchor, hudRects(hud, origin, [el]), [], bounds);
  return { left: p.left, top: p.top };
}

function ForecastPaper({ sheet }: { sheet: ForecastSheetState; d: UiData }) {
  const view = windowView.value;
  const paper = usePaper<HTMLDivElement>('strip', 32);
  const [place, setPlace] = useState<Place | null>(null);
  // 每次渲染之后重新量：改装单、小卡、调度台变了大小或位置，推演单跟着让开
  useLayoutEffect(() => {
    const el = paper.ref.current;
    if (el === null) return;
    const next = placeSheet(el, sheet.host, view);
    setPlace((prev) => (prev !== null && next !== null && prev.left === next.left && prev.top === next.top ? prev : next));
  });
  const style: Record<string, string> = {
    ...paper.style,
    left: `${place === null ? 0 : place.left}px`,
    top: `${place === null ? 0 : place.top}px`,
    transform: `scale(${view.scale})`,
    visibility: place === null ? 'hidden' : 'visible',
  };
  return (
    <div class="block paper forecast sheet" data-part="forecast" data-phase={sheet.view.phase} ref={paper.ref} style={style} onClick={() => actions.closeForecast()}>
      <SheetBody state={sheet} />
    </div>
  );
}

/**
 * 开着的推演单。界面数据 d（每秒最多更新十次）也作为属性传进去：它每次都是新的，推演单就每次都重新量一遍位置，
 * 买了东西、小卡变高、调度台展开之后它会让开。
 */
export function ForecastSheet({ d }: { d: UiData }) {
  const sheet = forecastSheet.value;
  if (sheet === null) return null;
  return <ForecastPaper key={sheet.id} sheet={sheet} d={d} />;
}

// 高峰小结和日结的长小票。右侧，宽约 400，全部黑白，分隔用一行短横线，底部的操作是带下划线的文字。
// 布局：标题居中，各片区一行是片区名、准时率、比昨天、十格的条，
// 四段时间下面有一条四种密度拼成的横杠，说明点名的那一段画圈。调度台开放之后，小票停在白板的左边，不盖住它。
// 高峰小结生成时从右侧送出，只露出标题和时段，不打断游戏。点一下展开并暂停，「继续」恢复，十几秒不点就收起，
// 收起之后右边缘留一个小标签，日结出现之前都可以再点开。日结一出现就展开，游戏照常走，点「继续」收起。
// 部件只读 state.ts 里的界面数据，点击交给 actions。
import { actions, boardOpen, dayEndOpen, summaryPhase } from './state.ts';
import type { SegmentItem, SummaryDistrictLine, TicketRow } from './tickets.ts';
import type { UiData } from './view-model.ts';

function Rows({ rows }: { rows: readonly TicketRow[] }) {
  return (
    <>
      {rows.map((r) => (
        <div key={r.label} class={r.indent ? 'trow indent' : 'trow'}>
          <span>{r.label}</span>
          <span class="tval">{r.value}</span>
        </div>
      ))}
    </>
  );
}

function Sep() {
  return <div class="sep" />;
}

function DistrictLines({ lines, withDelta }: { lines: readonly SummaryDistrictLine[]; withDelta: boolean }) {
  return (
    <>
      {lines.map((line) => (
        <div key={line.name} class={withDelta ? 'drow' : 'drow no-delta'} data-part={`summary-district-${line.name}`}>
          <span class="dname">{line.name}</span>
          {line.noOrders ? (
            // 这一场没有订单：只写「没有订单」，没有比昨天，也没有十格的条
            <span class="dpct none">{line.pct}</span>
          ) : (
            <>
              <span class="dpct">{line.pct}</span>
              {withDelta ? <span class="ddelta">{line.delta}</span> : null}
              <span class="dbar">{line.bar}</span>
            </>
          )}
        </div>
      ))}
    </>
  );
}

/** 四段时间拼成的横杠：等飞机实心，等起降竖线密，等出餐竖线疏，路上是点。宽度按百分数分。 */
const BAR_WIDTH = 356;
const BAR_HEIGHT = 12;

function SegmentBar({ items }: { items: readonly SegmentItem[] }) {
  let x = 0;
  return (
    <svg class="segbar" data-part="segment-bar" width="100%" viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}>
      <defs>
        <pattern id="seg-dense" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect class="ink" width="2" height="4" />
        </pattern>
        <pattern id="seg-sparse" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect class="ink" width="1" height="4" />
        </pattern>
        <pattern id="seg-dots" width="4" height="4" patternUnits="userSpaceOnUse">
          <circle class="ink" cx="2" cy="2" r="0.9" />
        </pattern>
      </defs>
      {items.map((item) => {
        const width = (item.share * BAR_WIDTH) / 100;
        const left = x;
        x += width;
        const fill = item.id === 'waitDrone' ? 'ink' : item.id === 'waitGate' ? 'url(#seg-dense)' : item.id === 'waitPrep' ? 'url(#seg-sparse)' : 'url(#seg-dots)';
        return fill === 'ink' ? (
          <rect key={item.id} class="ink" x={left} y="0" width={width} height={BAR_HEIGHT} />
        ) : (
          <rect key={item.id} x={left} y="0" width={width} height={BAR_HEIGHT} fill={fill} />
        );
      })}
      <rect class="frame" x="0.5" y="0.5" width={BAR_WIDTH - 1} height={BAR_HEIGHT - 1} />
    </svg>
  );
}

function Segments({ items }: { items: readonly SegmentItem[] }) {
  return (
    <>
      <div class="segs">
        {items.map((item) => (
          <span key={item.id} class={item.longest ? 'seg longest' : 'seg'} data-part={`segment-${item.id}`}>
            {item.text}
          </span>
        ))}
      </div>
      <SegmentBar items={items} />
    </>
  );
}

export function SummaryTicket({ d }: { d: UiData }) {
  const s = d.summary;
  if (s === null) return null;
  const phase = summaryPhase.value;
  // 调度台开放之后，展开的小票停在白板的左边
  const beside = d.board !== null;
  if (phase === 'closed') {
    // 白板展开时，小标签挪到白板的左边，免得压在白板的标题栏上
    return (
      <div class="corner rt">
        <div class={boardOpen.value ? 'block ticket-tab shifted' : 'block ticket-tab'} data-part="summary-tab" onClick={() => actions.clickSummary()}>
          {s.title}
        </div>
      </div>
    );
  }
  if (phase === 'peek') {
    return (
      <div class="corner rt">
        <div class="block ticket-peek" data-part="summary-peek" onClick={() => actions.clickSummary()}>
          <div class="ticket-title">{s.title}</div>
          <div class="ticket-sub">{s.period}</div>
        </div>
      </div>
    );
  }
  return (
    <div class={beside ? 'corner rt beside' : 'corner rt'}>
      <div class="block long-ticket" data-part="summary">
        <div class="ticket-title" data-part="summary-title">
          {s.title}
        </div>
        <div class="ticket-sub">{s.period}</div>
        <Sep />
        <Rows rows={s.rows} />
        <Sep />
        <div class="thead">
          <span>{s.districtHeader}</span>
          {s.deltaHeader === null ? null : <span class="dh" data-part="summary-delta-header">{s.deltaHeader}</span>}
        </div>
        <DistrictLines lines={s.districts} withDelta={s.deltaHeader !== null} />
        {s.segments === null ? null : (
          <>
            <Sep />
            <div class="thead plain">{s.timeHeader}</div>
            <Segments items={s.segments} />
          </>
        )}
        {s.early === null ? null : (
          <>
            <Sep />
            <div data-part="summary-early">
              {s.early.name === null ? null : <div class="early-name">{s.early.name}</div>}
              {s.early.lines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </>
        )}
        <Sep />
        <div class="sentences" data-part="summary-sentences">
          {s.sentences.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
        <div class="actions">
          {s.openBoard === null ? null : (
            <span class="link" data-part="summary-board" onClick={() => actions.clickSummaryBoard()}>
              {s.openBoard}
            </span>
          )}
          <span class="link" data-part="summary-continue" onClick={() => actions.clickSummaryContinue()}>
            {s.next}
          </span>
        </div>
      </div>
    </div>
  );
}

export function DayEndTicket({ d }: { d: UiData }) {
  const e = d.dayEnd;
  if (!dayEndOpen.value || e === null) return null;
  return (
    <div class={d.board !== null ? 'corner rt beside' : 'corner rt'}>
      <div class="block long-ticket" data-part="dayend">
        <div class="ticket-title" data-part="dayend-title">
          {e.title}
        </div>
        <div class="ticket-sub">{e.day}</div>
        <Sep />
        <Rows rows={e.rows} />
        <Sep />
        <div class="sentences" data-part="dayend-lines">
          {e.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
        <div class="actions">
          <span class="link" data-part="dayend-continue" onClick={() => actions.clickDayEndContinue()}>
            {e.next}
          </span>
        </div>
      </div>
    </div>
  );
}

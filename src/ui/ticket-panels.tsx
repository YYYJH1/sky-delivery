// 高峰小结和日结的长小票。右侧，宽约 400，点阵字，全部黑白，下沿锯齿，分隔用一行短横线，底部的操作是带下划线的文字。
// 布局：标题居中，各片区一行是片区名、准时率、十格的条、达标，目标写在下面一行的小字里，数后面可以有纪录的小字，
// 四段时间下面有一条四种密度拼成的横杠，说明点名的那一段用手画的红圈圈起来，再下面是与开局策略的对照。
// 调度台开放之后，小票停在白板的左边，不盖住它。
// 高峰小结生成时从右侧送出，只露出标题和时段，不打断游戏。点一下展开并暂停，「继续」恢复，十几秒不点就收起，
// 收起之后右边缘留一个小标签，日结出现之前都可以再点开。日结一出现就展开，游戏照常走，点「继续」收起。
// 部件只读 state.ts 里的界面数据，点击交给 actions。
import { MarkCircle, Sheet } from './sheets.tsx';
import { actions, boardOpen, dayEndOpen, summaryPhase } from './state.ts';
import type { CompareBlock, RecordNote, SegmentItem, SummaryDistrictLine, TicketRow } from './tickets.ts';
import type { UiData } from './view-model.ts';

/** 有一行带纪录的小字时，所有行都留出放它的一列，数还是对齐的。 */
function Rows({ rows }: { rows: readonly TicketRow[] }) {
  const withRecord = rows.some((r) => r.record !== null);
  return (
    <>
      {rows.map((r) => (
        <div key={r.label} class={`trow${r.indent ? ' indent' : ''}${withRecord ? ' rec' : ''}`}>
          <span>{r.label}</span>
          <span class="tval">{r.value}</span>
          {withRecord ? <RecordText note={r.record} /> : null}
        </div>
      ))}
    </>
  );
}

/** 数后面的纪录。新破的纪录加下划线。 */
function RecordText({ note }: { note: RecordNote | null }) {
  if (note === null) return <span class="record" />;
  return (
    <span class={note.fresh ? 'record fresh' : 'record'} data-part={note.fresh ? 'record-new' : 'record-best'}>
      {note.text}
    </span>
  );
}

function Sep() {
  return <div class="sep" />;
}

function DistrictLines({ lines, part }: { lines: readonly SummaryDistrictLine[]; part: string }) {
  return (
    <>
      {lines.map((line, i) => (
        <div key={line.name} class="dblock" data-part={`${part}-${line.name}`}>
          <div class="drow">
            <span class="dname">{line.name}</span>
            {line.noOrders ? (
              // 这一场没有订单：只写「无订单」，没有十格的条，也没有目标
              <span class="dpct none">{line.pct}</span>
            ) : (
              <>
                <span class="dpct">{line.pct}</span>
                <span class="dbar">{line.bar}</span>
                {line.mark === null ? (
                  <span class="dmark" />
                ) : (
                  <span class={line.mark.met ? 'dmark met' : 'dmark missed'}>
                    {line.mark.text}
                    {line.mark.met ? null : <MarkCircle red seed={100 + i} />}
                  </span>
                )}
              </>
            )}
          </div>
          {line.goal === null ? null : <div class="dgoal">{line.goal}</div>}
        </div>
      ))}
    </>
  );
}

/** 与开局策略的对照：开局策略下的结果，比它多准时或少准时几单，各片区一行。 */
function Compare({ block }: { block: CompareBlock }) {
  return (
    <div data-part="summary-compare">
      <div class="early-name">{block.header}</div>
      <div class="dgoal">{block.cards}</div>
      <div>{block.row}</div>
      <div class="gain-row">
        <span data-part="summary-gain">{block.gain}</span>
        {block.record === null ? null : (
          <span class={block.record.fresh ? 'record fresh' : 'record'} data-part={block.record.fresh ? 'record-new' : 'record-best'}>
            {block.record.text}
          </span>
        )}
      </div>
      <DistrictLines lines={block.districts} part="compare-district" />
    </div>
  );
}

/** 四段时间拼成的横杠：等无人机实心，起降排队竖线密，等出餐竖线疏，在途是点。宽度按百分数分。 */
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
            {item.longest ? <MarkCircle red seed={110} /> : null}
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
        <Sheet
          kind="slip"
          seed={63}
          depth={4}
          class={boardOpen.value ? 'block slip ticket-tab shifted' : 'block slip ticket-tab'}
          part="summary-tab"
          onClick={() => actions.clickSummary()}
        >
          {s.title}
        </Sheet>
      </div>
    );
  }
  if (phase === 'peek') {
    return (
      <div class="corner rt">
        <Sheet kind="slip" seed={62} depth={4} class="block slip ticket-peek" part="summary-peek" onClick={() => actions.clickSummary()}>
          <div class="ticket-title">{s.title}</div>
          <div class="ticket-sub">{s.period}</div>
        </Sheet>
      </div>
    );
  }
  return (
    <div class={beside ? 'corner rt beside' : 'corner rt'}>
      <Sheet kind="slip" seed={61} depth={5} class="block slip long-ticket" part="summary">
        <div class="ticket-title" data-part="summary-title">
          {s.title}
        </div>
        <div class="ticket-sub">{s.period}</div>
        <Sep />
        <Rows rows={s.rows} />
        <Sep />
        <div class="thead plain">{s.districtHeader}</div>
        <DistrictLines lines={s.districts} part="summary-district" />
        {s.cleared === null ? null : (
          <div class="stamp" data-part="summary-cleared">
            <span class="stamp-text">
              {s.cleared}
              <MarkCircle seed={120} />
            </span>
          </div>
        )}
        {s.streak === null ? null : (
          <div class="dgoal" data-part="summary-streak">
            {s.streak}
          </div>
        )}
        {s.segments === null ? null : (
          <>
            <Sep />
            <div class="thead plain">{s.timeHeader}</div>
            <Segments items={s.segments} />
          </>
        )}
        {s.compare === null ? null : (
          <>
            <Sep />
            <Compare block={s.compare} />
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
      </Sheet>
    </div>
  );
}

export function DayEndTicket({ d }: { d: UiData }) {
  const e = d.dayEnd;
  if (!dayEndOpen.value || e === null) return null;
  return (
    <div class={d.board !== null ? 'corner rt beside' : 'corner rt'}>
      <Sheet kind="slip" seed={61} depth={5} class="block slip long-ticket" part="dayend">
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
        {e.metrics.length === 0 ? null : (
          <>
            <Sep />
            <div class="sentences" data-part="dayend-metrics">
              {e.metrics.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </>
        )}
        <div class="actions">
          <span class="link" data-part="dayend-continue" onClick={() => actions.clickDayEndContinue()}>
            {e.next}
          </span>
        </div>
      </Sheet>
    </div>
  );
}

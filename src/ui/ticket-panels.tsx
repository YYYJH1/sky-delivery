// 高峰小结和日结的长小票。右侧，宽约 400，点阵字，全部黑白，下沿锯齿，分隔用一行短横线，底部的操作是带下划线的文字。
// 布局：标题居中，各片区一行是片区名、准时率、十格的条、达标，目标写在下面一行的小字里，数后面可以有纪录的小字，
// 四段时间下面有一条四种密度拼成的横杠，说明点名的那一段用手画的红圈圈起来，再下面是机队时间构成（五段，样式相同，最长的一段圈起来），
// 再下面是与开局策略的对照。
// 调度台开放之后，小票停在白板的左边，不盖住它。
// 高峰小结生成时从右侧送出，只露出标题和时段，不打断游戏。点一下展开并暂停，「继续」恢复，十几秒不点就收起，
// 收起之后右边缘留一个小标签，日结出现之前都可以再点开。日结一出现就展开，游戏照常走，点「继续」收起。
// 高峰小结比窗口高时内容滚动，底部的操作固定在小票下沿。部件只读 state.ts 里的界面数据，点击交给 actions。
import { MarkCircle, Sheet } from './sheets.tsx';
import { actions, boardOpen, dayEndOpen, summaryPhase } from './state.ts';
import { sentenceLines } from './tickets.ts';
import type { CompareBlock, FleetBlock, RecordNote, SummaryDistrictLine, TicketRow } from './tickets.ts';
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

/** 拼成横杠的一段：单均耗时构成的四段和机队时间构成的五段都用它。longest 为真时是最长的一段，画圈。 */
interface BarItem {
  readonly id: string;
  readonly text: string;
  /** 这一段占的百分数，各段加起来是 100。横杠按它分宽度。 */
  readonly share: number;
  readonly longest: boolean;
}

/** 一段用哪种密度：实心，竖线密，竖线疏，点，空白（只有外框）。 */
type Fill = 'ink' | 'dense' | 'sparse' | 'dots' | 'blank';

/**
 * 单均耗时构成：等无人机实心，起降排队竖线密，等出餐竖线疏，在途是点。
 * 机队时间构成：载货飞行实心，空载飞行竖线密，作业竖线疏，排队是点，停放空白。
 */
const FILL_OF: Readonly<Record<string, Fill>> = {
  waitDrone: 'ink',
  waitGate: 'dense',
  waitPrep: 'sparse',
  road: 'dots',
  loaded: 'ink',
  empty: 'dense',
  work: 'sparse',
  queue: 'dots',
  parked: 'blank',
};

/** 拼成的横杠的宽高，宽度按百分数分。 */
const BAR_WIDTH = 356;
const BAR_HEIGHT = 12;

/** prefix 是这条横杠里密度图案的名字前缀：同一页里有几条横杠时，各用各的图案名，不重名。 */
function SegmentBar({ items, prefix, part }: { items: readonly BarItem[]; prefix: string; part: string }) {
  let x = 0;
  const pattern = (name: string): string => `${prefix}-${name}`;
  return (
    <svg class="segbar" data-part={part} width="100%" viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}>
      <defs>
        <pattern id={pattern('dense')} width="4" height="4" patternUnits="userSpaceOnUse">
          <rect class="ink" width="2" height="4" />
        </pattern>
        <pattern id={pattern('sparse')} width="4" height="4" patternUnits="userSpaceOnUse">
          <rect class="ink" width="1" height="4" />
        </pattern>
        <pattern id={pattern('dots')} width="4" height="4" patternUnits="userSpaceOnUse">
          <circle class="ink" cx="2" cy="2" r="0.9" />
        </pattern>
      </defs>
      {items.map((item) => {
        const width = (item.share * BAR_WIDTH) / 100;
        const left = x;
        x += width;
        const fill = FILL_OF[item.id] ?? 'blank';
        if (fill === 'blank') return null;
        return fill === 'ink' ? (
          <rect key={item.id} class="ink" x={left} y="0" width={width} height={BAR_HEIGHT} />
        ) : (
          <rect key={item.id} x={left} y="0" width={width} height={BAR_HEIGHT} fill={`url(#${pattern(fill)})`} />
        );
      })}
      <rect class="frame" x="0.5" y="0.5" width={BAR_WIDTH - 1} height={BAR_HEIGHT - 1} />
    </svg>
  );
}

/**
 * 几段时间：上面是各段的文字，两列排，下面是拼成的横杠。part 是 data-part 的前缀，
 * 每段叫「前缀-段名」，横杠叫「前缀-bar」。marks 为假时不给最长的一段画圈（站点小卡里不画红圈）。
 */
export function Segments({ items, prefix, part, marks = true }: { items: readonly BarItem[]; prefix: string; part: string; marks?: boolean }) {
  return (
    <>
      <div class="segs">
        {items.map((item) => (
          <span key={item.id} class={marks && item.longest ? 'seg longest' : 'seg'} data-part={`${part}-${item.id}`}>
            {item.text}
            {marks && item.longest ? <MarkCircle red seed={110} /> : null}
          </span>
        ))}
      </div>
      <SegmentBar items={items} prefix={prefix} part={`${part}-bar`} />
    </>
  );
}

/**
 * 机队时间构成的五段文字和拼成的横杠（标题由调用的地方写）。小结和站点小卡各用各的前缀和部件名，
 * 两处同时在页面上时图案名不重名，截图脚本和测试也分得清。
 */
export function FleetSegments({ block, marks, prefix, part }: { block: FleetBlock; marks: boolean; prefix: string; part: string }) {
  return <Segments items={block.items} prefix={prefix} part={part} marks={marks} />;
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
  // 内容比窗口高时（三个片区都开通，又有与开局策略的对照），ticket-scroll 里的内容可以滚动，底部的操作固定在小票下沿
  return (
    <div class={beside ? 'corner rt beside' : 'corner rt'}>
      <Sheet kind="slip" seed={61} depth={5} class="block slip long-ticket scrolls" part="summary">
        <div class="ticket-scroll" data-part="summary-scroll">
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
              <Segments items={s.segments} prefix="seg" part="segment" />
            </>
          )}
          {s.fleet === null ? null : (
            <>
              {/* 四段时间没有（没有送达的订单）时，这一块自己前面补一行分隔线 */}
              {s.segments === null ? <Sep /> : null}
              <div class="fleet-block" data-part="summary-fleet">
                <div class="thead plain" data-part="summary-fleet-header">
                  {s.fleet.header}
                </div>
                <FleetSegments block={s.fleet} marks prefix="fleet" part="fleet" />
              </div>
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
        {e.effects.length === 0 ? null : (
          // 效果记录接在星级的几行后面，同一段里，隔一点距离。每笔按句分行：名称一行，现在的数和不购买时的数一行
          <div class="sentences effects" data-part="dayend-effects">
            {e.effects.map((line) => (
              <div key={line} class="effect">
                {sentenceLines(line).map((part) => (
                  <div key={part}>{part}</div>
                ))}
              </div>
            ))}
          </div>
        )}
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

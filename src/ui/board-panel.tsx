// 调度台（右侧白板）的部件：收起时是标题、一行小字和当前选中的卡名，展开后是三栏的卡、两套策略的页签、底部的小票条。
// 布局：每栏的磁贴排成两列，说明在磁贴下面，页签和标题在同一行。
// 部件只读 state.ts 里的界面数据，点击交给 actions。文字全部取自词表。
// 样式：白板白，铝框灰的边，圆角 6，标题和栏目名是手写体。磁贴圆角 3，选中的蓝黑实心配纸白手写字，没选中的白底细边，没开放的虚线边。
// 底部用一段胶带贴着一张小票条，写上一场同类高峰的结果。
import { actions, boardOpen, pickingDistrict } from './state.ts';
import type { BoardCard, BoardColumn, BoardView } from './board.ts';
import type { ForecastInfo } from './forecast.ts';
import { ForecastButton } from './forecast-panel.tsx';
import { paperImage } from './paper.ts';
import { MarkCircle, MarkUnderline, Sheet } from './sheets.tsx';
import type { UiData } from './view-model.ts';

/** 小票条的文字是一句话，几段之间隔着全角空格。第一段（昨日的高峰）写一行，后面几段合在第二行，全角空格留在页面里但不占位置。 */
const SPLIT = String.fromCodePoint(0x3000);

function Picker({ board }: { board: BoardView }) {
  return (
    <div class="picker" data-part="picker">
      <div class="picker-prompt">{board.pickPrompt}</div>
      <div class="picker-choices">
        {board.picker.map((choice) => (
          <span
            key={choice.district}
            class={choice.selected ? 'word on' : 'word'}
            data-part={`pick-${choice.district}`}
            onClick={() => actions.clickPickDistrict(choice.rule)}
          >
            {choice.name}
            {choice.selected ? <MarkCircle seed={70 + choice.district} /> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 一张磁贴：名称在贴上，一句说明在贴下面，悬停时在白板左边显示代价。没开放的画虚线框，说明的位置写开放的条件。
 * 数据员到岗之后，不是当前选中的、已经开放的磁贴右边有「推演」按钮，推演把这一栏改成这张卡。
 */
function Magnet({ card, info }: { card: BoardCard; info: ForecastInfo | null }) {
  const cls = `magnet${card.selected ? ' on' : ''}${card.locked ? ' locked' : ''}`;
  return (
    <div class={card.wide ? 'magnet-wrap wide' : 'magnet-wrap'}>
      <div class={cls} data-part={`card-${card.key}`} onClick={() => actions.clickCard(card)}>
        <div class="magnet-name">{card.name}</div>
        {card.locked ? null : (
          <div class={card.col === 1 ? 'magnet-cost right' : 'magnet-cost'} data-part={`cost-${card.key}`}>
            {card.cost}
          </div>
        )}
        <ForecastButton info={info} option={card.forecast} host="board" part={`forecast-board-${card.key}`} />
      </div>
      <div class={card.locked ? 'magnet-desc locked' : 'magnet-desc'}>{card.lockText ?? card.desc}</div>
    </div>
  );
}

function Column({ column, board, index, info }: { column: BoardColumn; board: BoardView; index: number; info: ForecastInfo | null }) {
  return (
    <div class="board-col" data-part={`column-${column.key}`}>
      <div class="board-col-title">
        {column.title}
        <MarkUnderline seed={80 + index} />
      </div>
      {column.locked ? (
        <div class="magnet locked block-lock" data-part={`locked-${column.key}`}>
          {column.lockText}
        </div>
      ) : (
        <div class="cards">
          {column.cards.flatMap((card) => [
            <Magnet key={card.key} card={card} info={info} />,
            card.pick && pickingDistrict.value ? <Picker key={`${card.key}-picker`} board={board} /> : null,
          ])}
        </div>
      )}
    </div>
  );
}

/** 白板底部的小票条，一段胶带贴在上沿。 */
function BoardTicket({ text }: { text: string }) {
  const [first = '', ...rest] = text.split(SPLIT);
  return (
    <Sheet kind="slip" seed={51} depth={4} class="slip board-ticket" part="board-ticket">
      <span class="tape" style={{ backgroundImage: paperImage('tape', 68, 15, 0) }} />
      <span class="board-ticket-line">{first}</span>
      {rest.length === 0 ? null : (
        <>
          <span class="gap">{SPLIT}</span>
          <span class="board-ticket-line">{rest.join(SPLIT)}</span>
        </>
      )}
    </Sheet>
  );
}

export function BoardPanel({ d }: { d: UiData }) {
  const board = d.board;
  if (board === null) return null;
  if (!boardOpen.value) {
    return (
      <div class="corner rm">
        <Sheet kind="board" seed={41} class="block board collapsed" part="board" attrs={{ 'data-state': 'collapsed' }} onClick={() => actions.clickBoard()}>
          <div class="board-title" data-part="board-title">
            {board.title}
          </div>
          <div class="board-sub" data-part="board-sub">
            {board.sub}
          </div>
          {board.picked.map((name) => (
            <div key={name} class="board-picked">
              {name}
            </div>
          ))}
        </Sheet>
      </div>
    );
  }
  return (
    <div class="corner rm open">
      <Sheet kind="board" seed={41} class="block board expanded" part="board" attrs={{ 'data-state': 'expanded' }}>
        <div class="board-head">
          <div class="board-title clickable" data-part="board-title" onClick={() => actions.clickBoard()}>
            {board.title}
          </div>
          {board.tabs === null ? null : (
            <div class="board-tabs" data-part="board-tabs">
              {board.tabs.map((tab) => (
                <span key={tab.peak} class={tab.on ? 'word on' : 'word'} data-part={`board-tab-${tab.peak}`} onClick={() => actions.clickBoardTab(tab.peak)}>
                  {tab.name}
                  {tab.on ? <MarkCircle seed={90} /> : null}
                </span>
              ))}
            </div>
          )}
        </div>
        {board.columns.map((column, index) => (
          <Column key={column.key} column={column} board={board} index={index} info={d.forecast} />
        ))}
        <BoardTicket text={board.ticket} />
      </Sheet>
    </div>
  );
}

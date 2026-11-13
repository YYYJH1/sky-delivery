// 调度台（右侧白板）的部件：收起时是标题、一行小字和当前选中的卡名，展开后是三栏的卡、两套规矩的页签、底部的小票条。
// 布局：每栏的磁贴排成两列，说明在磁贴下面，页签和标题在同一行。
// 部件只读 state.ts 里的界面数据，点击交给 actions。文字全部取自词表。
// 样式：白板白，铝框灰的边，选中的磁贴蓝黑实心，没开放的磁贴虚线框。
import { actions, boardOpen, pickingDistrict } from './state.ts';
import type { BoardCard, BoardColumn, BoardView } from './board.ts';
import type { UiData } from './view-model.ts';

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
          </span>
        ))}
      </div>
    </div>
  );
}

/** 一张磁贴：名称在贴上，一句说明在贴下面，悬停时在白板左边显示代价。没开放的画虚线框，说明的位置写开放的条件。 */
function Magnet({ card }: { card: BoardCard }) {
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
      </div>
      <div class={card.locked ? 'magnet-desc locked' : 'magnet-desc'}>{card.lockText ?? card.desc}</div>
    </div>
  );
}

function Column({ column, board }: { column: BoardColumn; board: BoardView }) {
  return (
    <div class="board-col" data-part={`column-${column.key}`}>
      <div class="board-col-title">{column.title}</div>
      {column.locked ? (
        <div class="magnet locked block-lock" data-part={`locked-${column.key}`}>
          {column.lockText}
        </div>
      ) : (
        <div class="cards">
          {column.cards.flatMap((card) => [
            <Magnet key={card.key} card={card} />,
            card.pick && pickingDistrict.value ? <Picker key={`${card.key}-picker`} board={board} /> : null,
          ])}
        </div>
      )}
    </div>
  );
}

export function BoardPanel({ d }: { d: UiData }) {
  const board = d.board;
  if (board === null) return null;
  if (!boardOpen.value) {
    return (
      <div class="corner rm">
        <div class="block board collapsed" data-part="board" data-state="collapsed" onClick={() => actions.clickBoard()}>
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
        </div>
      </div>
    );
  }
  return (
    <div class="corner rm open">
      <div class="block board expanded" data-part="board" data-state="expanded">
        <div class="board-head">
          <div class="board-title clickable" data-part="board-title" onClick={() => actions.clickBoard()}>
            {board.title}
          </div>
          {board.tabs === null ? null : (
            <div class="board-tabs" data-part="board-tabs">
              {board.tabs.map((tab) => (
                <span key={tab.peak} class={tab.on ? 'word on' : 'word'} data-part={`board-tab-${tab.peak}`} onClick={() => actions.clickBoardTab(tab.peak)}>
                  {tab.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {board.columns.map((column) => (
          <Column key={column.key} column={column} board={board} />
        ))}
        <div class="board-ticket" data-part="board-ticket">
          {board.ticket}
        </div>
      </div>
    </div>
  );
}

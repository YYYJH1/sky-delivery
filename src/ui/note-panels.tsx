// 片区纸条、便签、结局的提示、地图上的开通价签。
// 部件只读 state.ts 里的界面数据，点击交给 actions。文字全部取自词表。
import { starsText } from './note.ts';
import { actions, districtAnchors, endingOpen, windowView } from './state.ts';
import { openDistrictLabel } from './tags.ts';
import { endingLines } from './tips.ts';
import type { UiData } from './view-model.ts';

// ---- 底部正中：片区纸条 ----
// 一行字从片区名写起，片区名和星画在一起，后面接升星的条件和当前值。有几个片区开通时，点片区名换看下一个。
export function DistrictNote({ d }: { d: UiData }) {
  const n = d.note;
  const canSwitch = d.noteChoices.length > 1;
  return (
    <div class="corner bn">
      <div class="block paper note" data-part="district-note">
        <span class={canSwitch ? 'note-name switch' : 'note-name'} data-part="note-name" onClick={canSwitch ? () => actions.clickNoteName() : undefined}>
          {n.name}
        </span>
        <span class="stars" data-part="stars">
          {starsText(n.star)}
        </span>
        <span data-part="note-text">{n.rest}</span>
      </div>
    </div>
  );
}

// ---- 日程纸条右端：便签 ----
// 同一时刻只贴最早的一张，点一下标成已读，下一张才贴出来。位置在日程纸条下面，跟着它缩放。
export function TipNote({ d }: { d: UiData }) {
  const tip = d.tip;
  if (tip === null) return null;
  return (
    <div class="tip" data-part="tip" data-tip={tip.id} key={tip.id} onClick={() => actions.clickTip()}>
      {tip.text}
    </div>
  );
}

// ---- 屏幕中间偏上：结局 ----
export function EndingNote({ d }: { d: UiData }) {
  if (!endingOpen.value || d.ending === null) return null;
  return (
    <div class="corner mc">
      <div class="block paper ending" data-part="ending" onClick={() => actions.clickEnding()}>
        {endingLines(d.ending).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
    </div>
  );
}

// ---- 地图上：还没开通的片区的开通价签 ----
export function OpenTags({ d }: { d: UiData }) {
  const view = windowView.value;
  const anchors = districtAnchors.value;
  return (
    <>
      {d.openTags.map((tag) => {
        const at = anchors.find((a) => a.district === tag.district);
        if (at === undefined) return null;
        const style = `left:${at.x + at.w / 2}px;top:${at.y + at.h / 2}px;transform:translate(-50%,-50%) scale(${view.scale})`;
        return (
          <div
            key={tag.district}
            class={tag.dim ? 'tag open-tag dim' : 'tag open-tag'}
            data-part={`open-tag-${tag.district}`}
            style={style}
            onClick={() => actions.clickOpenDistrict(tag.district)}
          >
            {openDistrictLabel(tag.district, tag.price)}
          </div>
        );
      })}
    </>
  );
}

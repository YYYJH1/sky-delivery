// 片区纸条、便签、结局的提示、地图上的开通价签。
// 部件只读 state.ts 里的界面数据，点击交给 actions。文字全部取自词表。
import { useLayoutEffect, useState } from 'preact/hooks';
import { starsText } from './note.ts';
import type { Rect } from './map-layout.ts';
import { MarkUnderline, Sheet, Stars, TagText } from './sheets.tsx';
import { usePaper } from './paper-use.ts';
import { actions, districtAnchors, endingOpen, windowView } from './state.ts';
import type { WindowView } from './state.ts';
import { openDistrictLabel } from './tags.ts';
import { placeTip, tipSpot, tipTarget, tipTilt, tipWidth } from './tip-anchor.ts';
import type { TipSpot } from './tip-anchor.ts';
import { endingLines } from './tips.ts';
import type { UiData } from './view-model.ts';

// ---- 底部：片区纸条，排在价签的右边 ----
// 一行字从片区名写起，片区名和五颗手画的星画在一起，后面接升星的条件和当前值。有几个片区开通时，点片区名换看下一个。
// 有余量或还差几单可写时，下面再加一行小字。星的文字写法留在页面里（看不见），给读屏和复制用。
// 位置由左下角那一行（components.tsx 的 .bl）排，这里只管纸条本身。
export function DistrictNote({ d }: { d: UiData }) {
  const n = d.note;
  const canSwitch = d.noteChoices.length > 1;
  return (
    <Sheet kind="strip" seed={24} class="block paper note" part="district-note">
      <div data-part="note-line">
        <span class={canSwitch ? 'note-name switch' : 'note-name'} data-part="note-name" onClick={canSwitch ? () => actions.clickNoteName() : undefined}>
          {n.name}
          {canSwitch ? <MarkUnderline seed={60 + n.district} /> : null}
        </span>
        <span class="stars" data-part="stars">
          <Stars filled={n.star} label={starsText(n.star)} />
        </span>
        <span data-part="note-text">{n.rest}</span>
      </div>
      {n.extra === null ? null : (
        <div class="note-extra" data-part="note-extra">
          {n.extra}
        </div>
      )}
    </Sheet>
  );
}

// ---- 便签：贴在它说的东西旁边 ----
// 同一时刻只贴最早的一张，点一下标成已读，下一张才贴出来。
// 点订单和订单变红的便签贴在地图上那张小票旁边（位置由地图场景给，见 tip-anchor.ts），
// 调度台、价签、开通价签的便签贴在页面上那个物件旁边，用它排出来的位置。找不到要贴的东西时，贴在日程纸条右端的下面。
export function TipNote({ d }: { d: UiData }) {
  const tip = d.tip;
  if (tip === null) return null;
  return <TipSticky key={tip.id} id={tip.id} text={tip.text} d={d} />;
}

/** 便签在窗口里的位置，左上角。 */
interface TipPlace {
  readonly left: number;
  readonly top: number;
}

/** 页面上能挡住便签和推演单的物件：纸条、小票、白板、价签、小卡，位置相对 #hud。skip 里的元素，以及包含它们或被它们包含的元素不算。 */
export function hudRects(hud: HTMLElement, origin: DOMRect, skip: readonly Element[]): Rect[] {
  const out: Rect[] = [];
  for (const node of hud.querySelectorAll('.block, .tag')) {
    if (skip.some((s) => s === node || node.contains(s) || s.contains(node))) continue;
    const r = node.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x: r.x - origin.x, y: r.y - origin.y, w: r.width, h: r.height });
  }
  return out;
}

/** 便签现在该在哪里：贴在目标旁边，目标不在页面上时贴在日程纸条右端的下面。 */
function placeTipNote(el: HTMLElement, id: string, spot: TipSpot | null, view: WindowView): TipPlace | null {
  const hud = el.parentElement;
  if (hud === null) return null;
  const origin = hud.getBoundingClientRect();
  const s = view.scale;
  const w = el.offsetWidth * s;
  const h = el.offsetHeight * s;
  if (w <= 0 || h <= 0) return null;
  // 便签歪着放，占的地方比它的框大一圈，投影也在框外面：留出这一圈再挑位置
  const grow = 14 * s;
  const near = (anchor: Rect, avoid: readonly Rect[], soft: readonly Rect[], bounds: Rect): TipPlace => {
    const p = placeTip(w + grow, h + grow, anchor, avoid, soft, bounds);
    return { left: p.left + grow / 2, top: p.top + grow / 2 };
  };
  const target = tipTarget(id);
  if (target !== null && target.kind === 'order' && spot !== null) {
    // 地图上的小票：不压站和别的小票，不钻到顶部和底部的纸条下面
    const bounds: Rect = { x: 12, y: 104 * s, w: view.width - 24, h: view.height - 104 * s - 96 * s };
    return near(spot.anchor, [...spot.avoid, ...hudRects(hud, origin, [el])], spot.soft, bounds);
  }
  if (target !== null && target.kind === 'part') {
    const part = hud.querySelector(`[data-part="${target.part}"]`);
    const r = part === null ? null : part.getBoundingClientRect();
    if (part !== null && r !== null && r.width > 0 && r.height > 0) {
      const anchor: Rect = { x: r.x - origin.x, y: r.y - origin.y, w: r.width, h: r.height };
      const bounds: Rect = { x: 12, y: 12, w: view.width - 24, h: view.height - 24 };
      return near(anchor, hudRects(hud, origin, [el, part]), [], bounds);
    }
  }
  const schedule = hud.querySelector('[data-part="schedule"]');
  if (schedule !== null) {
    const r = schedule.getBoundingClientRect();
    return { left: r.right - origin.x - 80 * s - w, top: r.bottom - origin.y + 10 * s };
  }
  return { left: view.width - w - 24 * s, top: 110 * s };
}

/**
 * 一张便签。读了信号的部件只在信号或属性变了时才重新渲染，所以界面数据 d（每秒最多更新十次）也作为属性传进来，
 * 它每次都是新的，便签就每次都重新量一遍位置。
 */
function TipSticky({ id, text }: { id: string; text: string; d: UiData }) {
  const view = windowView.value;
  const spot = tipSpot.value;
  // 开通价签跟着镜头挪，它旁边的便签也要重新贴
  void districtAnchors.value;
  const paper = usePaper<HTMLDivElement>('sticky', 31);
  const [place, setPlace] = useState<TipPlace | null>(null);
  // 每次渲染之后重新量：调度台展开收起，价签变宽，窗口变了大小，字体载入完了，便签都跟着挪
  useLayoutEffect(() => {
    const el = paper.ref.current;
    if (el === null) return;
    const next = placeTipNote(el, id, spot, view);
    setPlace((prev) => (prev !== null && next !== null && prev.left === next.left && prev.top === next.top ? prev : next));
  });
  const style: Record<string, string> = {
    ...paper.style,
    width: `${tipWidth(text)}px`,
    left: `${place === null ? 0 : place.left}px`,
    top: `${place === null ? 0 : place.top}px`,
    transform: `scale(${view.scale}) rotate(${tipTilt(id)}deg)`,
    visibility: place === null ? 'hidden' : 'visible',
  };
  return (
    <div class="tip sheet" data-part="tip" data-tip={id} ref={paper.ref} style={style} onClick={() => actions.clickTip()}>
      {text}
    </div>
  );
}

// ---- 屏幕中间偏上：结局 ----
export function EndingNote({ d }: { d: UiData }) {
  if (!endingOpen.value || d.ending === null) return null;
  return (
    <div class="corner mc">
      <Sheet kind="strip" seed={22} class="block paper ending" part="ending" onClick={() => actions.clickEnding()}>
        {endingLines(d.ending).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </Sheet>
    </div>
  );
}

// ---- 地图上：还没开通的片区的开通价签 ----
function OpenTag({ district, price, dim, style }: { district: number; price: number; dim: boolean; style: Record<string, string> }) {
  return (
    <Sheet kind="tag" seed={25 + district} class={dim ? 'tag open-tag dim' : 'tag open-tag'} part={`open-tag-${district}`} style={style} onClick={() => actions.clickOpenDistrict(district)}>
      <span class="tag-text">
        <TagText text={openDistrictLabel(district, price)} />
      </span>
    </Sheet>
  );
}

export function OpenTags({ d }: { d: UiData }) {
  const view = windowView.value;
  const anchors = districtAnchors.value;
  return (
    <>
      {d.openTags.map((tag) => {
        const at = anchors.find((a) => a.district === tag.district);
        if (at === undefined) return null;
        const style = { left: `${at.x + at.w / 2}px`, top: `${at.y + at.h / 2}px`, transform: `translate(-50%,-50%) scale(${view.scale})` };
        return <OpenTag key={tag.district} district={tag.district} price={tag.price} dim={tag.dim} style={style} />;
      })}
    </>
  );
}

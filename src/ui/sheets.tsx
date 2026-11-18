// 纸和手画的记号。纸（Sheet）是一个配好背景图的容器：量出自己的大小，按大小画一张纸（paper.ts），放进 --sheet 变量。
// 记号是下划线、圈、五颗星，都是 SVG，没有文字，画在父元素的范围里，宽高跟着父元素。
// 路径按种子生成，同一个种子画出同一笔。线的粗细和颜色由样式表给（.mark），拉伸时线宽不变。
import type { ComponentChildren } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { handStar, stretchCircle, stretchUnderline } from './hand.ts';
import type { PaperKind } from './paper.ts';
import { usePaper } from './paper-use.ts';

// 点阵字体在小票出现之前就开始载入，免得小票先是空的，字体到了才出字。载入失败时小票用后备字体，不拦着页面。
if (typeof document !== 'undefined' && document.fonts !== undefined) {
  document.fonts.load('24px SkyPixel', '0').catch(() => undefined);
}

const underlines = new Map<number, string>();
const circles = new Map<number, string>();

function memo(cache: Map<number, string>, seed: number, make: (seed: number) => string): string {
  const hit = cache.get(seed);
  if (hit !== undefined) return hit;
  const path = make(seed);
  cache.set(seed, path);
  return path;
}

export interface SheetProps {
  /** 纸的种类：小票、便签、白板、价签、纸条。 */
  readonly kind: PaperKind;
  /** 纸颗粒和毛边的种子，不同的物件用不同的数。 */
  readonly seed: number;
  /** 小票下沿锯齿的深度。 */
  readonly depth?: number;
  /** 样式类，不含 sheet。 */
  readonly class: string;
  /** 截图脚本和测试用的 data-part。 */
  readonly part: string;
  /** 另加的样式：位置、缩放。纸的背景图由 Sheet 自己加进去。 */
  readonly style?: Record<string, string>;
  /** 另加的属性，如 data-state。 */
  readonly attrs?: Record<string, string>;
  readonly onClick?: () => void;
  /** 物件排出来的大小量出来或者变了的时候调用，宽高是布局像素，不含缩放。站点小卡按它的高度摆放。 */
  readonly onSize?: (size: { readonly w: number; readonly h: number }) => void;
  readonly children?: ComponentChildren;
}

/** 一张纸：直接当一个物件的外壳用。背景图画在 .sheet::before 上，物件的大小变了就重新画。 */
export function Sheet(props: SheetProps) {
  const paper = usePaper<HTMLDivElement>(props.kind, props.seed, { depth: props.depth });
  const { w, h } = paper.size;
  const { onSize } = props;
  // 量出大小之后马上告诉调用者，在浏览器画出这一帧之前
  useLayoutEffect(() => {
    if (onSize !== undefined && w > 0 && h > 0) onSize({ w, h });
  }, [onSize, w, h]);
  return (
    <div class={`${props.class} sheet`} data-part={props.part} ref={paper.ref} style={{ ...props.style, ...paper.style }} onClick={props.onClick} {...props.attrs}>
      {props.children}
    </div>
  );
}

/** 手画的下划线：贴着父元素的下沿，宽度和父元素一样。父元素要是定位元素。 */
export function MarkUnderline({ seed }: { seed: number }) {
  return (
    <svg class="mark mark-underline" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
      <path d={memo(underlines, seed, stretchUnderline)} />
    </svg>
  );
}

/** 手画的圈：把父元素圈在里面，比父元素略大。red 为真时画成急红，只用在小结上圈出的问题项。父元素要是定位元素。 */
export function MarkCircle({ seed, red = false }: { seed: number; red?: boolean }) {
  return (
    <svg class={red ? 'mark mark-circle red' : 'mark mark-circle'} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={memo(circles, seed, stretchCircle)} />
    </svg>
  );
}

/** 价签上的字：第一个空格之前是名称，加粗，后面是价格。没有空格时整段加粗。 */
export function TagText({ text }: { text: string }) {
  const at = text.indexOf(' ');
  if (at < 0) return <b>{text}</b>;
  return (
    <>
      <b>{text.slice(0, at)}</b>
      {text.slice(at)}
    </>
  );
}

const STAR_COUNT = 5;
const STAR_SIZE = 22;

/** 五颗手画的星，前 filled 颗涂满，其余只有轮廓。label 是文字写法，给读屏和复制用，看不见。 */
export function Stars({ filled, label }: { filled: number; label: string }) {
  return (
    <>
      <svg class="stars-art" width={STAR_COUNT * STAR_SIZE} height={STAR_SIZE} viewBox={`0 0 ${STAR_COUNT * STAR_SIZE} ${STAR_SIZE}`} aria-hidden="true">
        {Array.from({ length: STAR_COUNT }, (_, i) => (
          <path key={i} class={i < filled ? 'star on' : 'star'} d={handStar(STAR_SIZE / 2 + i * STAR_SIZE, STAR_SIZE / 2 + 0.5, STAR_SIZE / 2 - 1.5, 90 + i)} />
        ))}
      </svg>
      <span class="sr">{label}</span>
    </>
  );
}

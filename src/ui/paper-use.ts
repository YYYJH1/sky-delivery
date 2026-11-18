// 给界面里的一个物件配上纸：量它排出来的大小，按大小画一张纸（paper.ts），把背景图放进它的 --sheet 变量。
// 物件的样式表里用伪元素把 --sheet 画在它后面（图比物件大出一圈投影的位置，不被物件的边框盒裁掉）。
// 物件的大小变了（文字换了，字体载入完了）就重新量，重新取图。图只在大小或种子变了时才重画，同样的大小从缓存取。
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { paperImage } from './paper.ts';
import type { PaperKind } from './paper.ts';

export interface PaperOptions {
  /** 小票下沿锯齿的深度，默认 4。 */
  readonly depth?: number;
}

export interface UsedPaper<T extends HTMLElement> {
  readonly ref: RefObject<T | null>;
  /** 放进物件 style 里的样式，含 --sheet。物件还没量过大小时为空对象。 */
  readonly style: Record<string, string>;
  /** 物件排出来的大小，布局像素，不含缩放。还没量过时宽高都是 0。 */
  readonly size: { readonly w: number; readonly h: number };
}

const NONE: Record<string, string> = {};
const UNMEASURED = { w: 0, h: 0 } as const;

/** 一个物件排出来的大小（布局像素，不含缩放），变了才换新的对象，免得白白重新渲染。 */
function useBoxSize<T extends HTMLElement>(): { ref: RefObject<T | null>; w: number; h: number } {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const read = (): void => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, w: size.w, h: size.h };
}

export function usePaper<T extends HTMLElement>(kind: PaperKind, seed: number, options: PaperOptions = {}): UsedPaper<T> {
  const { ref, w, h } = useBoxSize<T>();
  if (w <= 0 || h <= 0) return { ref, style: NONE, size: UNMEASURED };
  return { ref, style: { '--sheet': paperImage(kind, w, h, seed, options.depth) }, size: { w, h } };
}

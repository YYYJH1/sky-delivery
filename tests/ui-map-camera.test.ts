// 镜头的调度：开局和读档直接框住已经显示的片区，有片区第一次显示时镜头缓动到新的外框，窗口大小变了进行中的挪动作废。
// 调度器不读时钟，时间由测试传进去，所以这里按毫秒一步一步走。
import { describe, expect, it } from 'vitest';
import { CAMERA_MOVE_MS, boardToScreen } from '../src/render/camera.ts';
import type { DistrictMode } from '../src/render/districts.ts';
import { CameraDirector } from '../src/ui/map-camera.ts';
import { MAP_PLAN, cameraFor, contentFor, framedOf } from '../src/ui/map-state.ts';
import type { WindowGeometry } from '../src/ui/map-state.ts';

const VIEW: WindowGeometry = { width: 1920, height: 1080, dpr: 1, uiScale: 1 };
const OLD_ONLY: readonly DistrictMode[] = ['open', 'hidden', 'hidden'];
const OLD_OFFICE: readonly DistrictMode[] = ['open', 'faded', 'hidden'];
const ALL: readonly DistrictMode[] = ['open', 'open', 'faded'];

describe('开局和读档：直接框住已经显示的片区', () => {
  it('开局只有老街：镜头就是只框老街的镜头，没有挪动', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    expect(director.camera).toEqual(cameraFor(VIEW, framedOf(OLD_ONLY)));
    expect(director.content).toEqual(contentFor(framedOf(OLD_ONLY)));
    expect(director.moving).toBe(false);
    const step = director.update(OLD_ONLY, 1000);
    expect(step).toEqual({ camera: director.camera, content: director.content, moved: false, started: null, finished: false });
  });

  it('读档时三个片区都显示：直接是三个片区的镜头，没有动画', () => {
    const director = new CameraDirector(VIEW, ALL);
    expect(director.camera).toEqual(cameraFor(VIEW));
    const step = director.update(ALL, 0);
    expect(step.moved).toBe(false);
    expect(step.started).toBeNull();
    expect(director.moving).toBe(false);
  });

  it('显示状态没变就一直不动，不管过了多久', () => {
    const director = new CameraDirector(VIEW, OLD_OFFICE);
    for (const ms of [0, 16, 5000, 100000]) expect(director.update(OLD_OFFICE, ms).moved).toBe(false);
  });
});

describe('片区第一次显示：镜头缓动到新的外框', () => {
  it('这一帧开始挪，镜头还在原来的位置，要挪到的是框住两个片区的镜头', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    const before = director.camera;
    const step = director.update(OLD_OFFICE, 2000);
    expect(step.moved).toBe(true);
    expect(step.started).toEqual(cameraFor(VIEW, framedOf(OLD_OFFICE)));
    expect(step.finished).toBe(false);
    expect(step.camera).toEqual(before);
    expect(step.content).toEqual(contentFor(framedOf(OLD_OFFICE)));
    expect(director.moving).toBe(true);
  });

  it('之后每帧都在动，缩放从老街的缩放逐渐降到两个片区的缩放，用 CAMERA_MOVE_MS 挪完', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    const from = director.camera;
    const to = cameraFor(VIEW, framedOf(OLD_OFFICE));
    director.update(OLD_OFFICE, 2000);
    let last = from.scale;
    let started = 0;
    for (let ms = 16; ms < CAMERA_MOVE_MS; ms += 16) {
      const step = director.update(OLD_OFFICE, 2000 + ms);
      expect(step.moved).toBe(true);
      expect(step.finished).toBe(false);
      expect(step.started).toBeNull();
      expect(step.camera.scale).toBeLessThanOrEqual(last + 1e-12);
      expect(step.camera.scale).toBeGreaterThanOrEqual(to.scale - 1e-12);
      last = step.camera.scale;
      started += 1;
    }
    expect(started).toBeGreaterThan(40);
    const end = director.update(OLD_OFFICE, 2000 + CAMERA_MOVE_MS);
    expect(end.finished).toBe(true);
    expect(end.moved).toBe(true);
    expect(end.camera).toEqual(to);
    expect(director.moving).toBe(false);
    // 挪完之后不再动
    expect(director.update(OLD_OFFICE, 2000 + CAMERA_MOVE_MS + 16).moved).toBe(false);
  });

  it('挪动过程中，界面物件要跟的镜头每帧都在变：写字楼区的中心在窗口里的位置从右边的外面挪进窗口', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    const center = MAP_PLAN.board.toBoard(1850, 525);
    const x0 = boardToScreen(director.camera, center.x, center.y).x;
    director.update(OLD_OFFICE, 0);
    const xs: number[] = [x0];
    for (let ms = 100; ms <= CAMERA_MOVE_MS; ms += 100) xs.push(boardToScreen(director.update(OLD_OFFICE, ms).camera, center.x, center.y).x);
    // 写字楼区一开始在窗口右边的外面，挪完在窗口里面，位置一路向左
    expect(xs[0]).toBeGreaterThan(1920);
    expect(xs[xs.length - 1]).toBeLessThan(1920);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThanOrEqual((xs[i - 1] as number) + 1e-9);
  });

  it('两个片区之后第三个片区显示：同样缓动，终点是三个片区的镜头', () => {
    const director = new CameraDirector(VIEW, OLD_OFFICE);
    const step = director.update(ALL, 9000);
    expect(step.started).toEqual(cameraFor(VIEW));
    expect(director.update(ALL, 9000 + CAMERA_MOVE_MS).camera).toEqual(cameraFor(VIEW));
  });

  it('挪动没完时又有片区显示：从现在挪到的位置接着挪向新的终点，不跳', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    director.update(OLD_OFFICE, 0);
    const mid = director.update(OLD_OFFICE, CAMERA_MOVE_MS / 2).camera;
    const restart = director.update(ALL, CAMERA_MOVE_MS / 2 + 16);
    expect(restart.started).toEqual(cameraFor(VIEW));
    // 新的一次从上一帧的位置起，所以这一帧和上一帧的镜头只差一点
    expect(Math.abs(restart.camera.scale - mid.scale)).toBeLessThan(1e-9);
    expect(Math.abs(restart.camera.x - mid.x)).toBeLessThan(1e-6);
    expect(director.update(ALL, CAMERA_MOVE_MS / 2 + 16 + CAMERA_MOVE_MS).camera).toEqual(cameraFor(VIEW));
  });

  it('挪动开始之后重新计时：准备花的时间不算，镜头从重新计时的这一刻起走', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    const from = director.camera;
    const to = cameraFor(VIEW, framedOf(OLD_OFFICE));
    director.update(OLD_OFFICE, 1000);
    // 准备花了 600 毫秒，不重新计时的话这时已经走了大半
    director.restartClock(1600);
    const justAfter = director.update(OLD_OFFICE, 1616);
    expect(Math.abs(justAfter.camera.scale - from.scale)).toBeLessThan(0.01 * (from.scale - to.scale));
    const half = director.update(OLD_OFFICE, 1600 + CAMERA_MOVE_MS / 2).camera;
    expect(half.scale).toBeCloseTo((from.scale + to.scale) / 2, 9);
    const end = director.update(OLD_OFFICE, 1600 + CAMERA_MOVE_MS);
    expect(end.finished).toBe(true);
    expect(end.camera).toEqual(to);
  });

  it('没有在挪的时候重新计时什么也不做', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    director.restartClock(500);
    expect(director.moving).toBe(false);
    expect(director.update(OLD_ONLY, 600).moved).toBe(false);
  });

  it('正在挪向的镜头：没在挪时没有，挪的过程中是终点的镜头，挪完又没有了', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    expect(director.target).toBeNull();
    director.update(OLD_OFFICE, 0);
    expect(director.target).toEqual(cameraFor(VIEW, framedOf(OLD_OFFICE)));
    director.update(OLD_OFFICE, CAMERA_MOVE_MS / 2);
    expect(director.target).toEqual(cameraFor(VIEW, framedOf(OLD_OFFICE)));
    director.update(OLD_OFFICE, CAMERA_MOVE_MS);
    expect(director.target).toBeNull();
  });

  it('框住的片区没变，只是淡画变成开通，镜头不动', () => {
    const director = new CameraDirector(VIEW, OLD_OFFICE);
    expect(director.update(['open', 'open', 'hidden'], 100).moved).toBe(false);
  });
});

describe('窗口大小变了', () => {
  it('没有挪动时：镜头换成新窗口里框住同样片区的镜头', () => {
    const director = new CameraDirector(VIEW, OLD_OFFICE);
    const next: WindowGeometry = { width: 1400, height: 800, dpr: 1, uiScale: 1400 / 1920 };
    director.resize(next);
    expect(director.camera).toEqual(cameraFor(next, framedOf(OLD_OFFICE)));
    expect(director.moving).toBe(false);
  });

  it('挪动进行中：作废，直接是新窗口里新外框的镜头，之后不再挪', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    director.update(OLD_OFFICE, 0);
    director.update(OLD_OFFICE, 300);
    expect(director.moving).toBe(true);
    const next: WindowGeometry = { width: 1600, height: 900, dpr: 1, uiScale: 1600 / 1920 };
    director.resize(next);
    expect(director.moving).toBe(false);
    expect(director.camera).toEqual(cameraFor(next, framedOf(OLD_OFFICE)));
    expect(director.update(OLD_OFFICE, 400).moved).toBe(false);
    expect(director.camera).toEqual(cameraFor(next, framedOf(OLD_OFFICE)));
  });

  it('换了窗口之后再有片区显示，挪向新窗口里的外框', () => {
    const director = new CameraDirector(VIEW, OLD_ONLY);
    const next: WindowGeometry = { width: 1280, height: 720, dpr: 2, uiScale: 2 / 3 };
    director.resize(next);
    const step = director.update(OLD_OFFICE, 0);
    expect(step.started).toEqual(cameraFor(next, framedOf(OLD_OFFICE)));
  });
});

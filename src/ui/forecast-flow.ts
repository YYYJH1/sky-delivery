// 推演的流程：点「推演」之后发出请求，同时打开推演单写「推演中」，出了结果才发 useForecast 命令扣一次次数，再显示结果。
// 推演被取消（推演单在算的时候被关掉）不扣次数，选项在这个状态下无法推演（资金之外的原因不能执行）也不扣，推演单写无法推演和原因。
// 同一时刻只有一个推演在算，算的时候再点「推演」不响应，按钮也写「推演中」。
// 流程不碰 DOM，也不直接读写游戏状态：状态、请求、扣次数、提示和推演单的显示都由 game.ts 传进来，测试里换成假的。
import { ForecastCancelled } from '../app/index.ts';
import type { ForecastHandle } from '../app/index.ts';
import { reasonText } from '../content/strings.zh.ts';
import { FORECAST_V1 } from '../core/index.ts';
import type { Command, SimState } from '../core/index.ts';
import { doneView, failedView, forecastCommand, runningView } from './forecast.ts';
import type { ForecastOption, ForecastSheetState, ForecastSheetView } from './forecast.ts';
import { failureContext, failureText } from './reasons.ts';

export interface ForecastFlowDeps {
  /** 现在的游戏状态。请求时取一次，后台线程拿到的是复制出去的一份，之后游戏接着走不影响推演。 */
  readonly state: () => SimState;
  /** 发出推演请求，返回可以取消的句柄。游戏页面传应用层的 requestForecast，测试里换成假的。 */
  readonly request: (state: SimState, option: Command, params: { readonly sequences: number }) => ForecastHandle;
  /** 开始之前问一下能不能推演：数据员到岗，次数够。不能时返回提示文字，能时返回 null。 */
  readonly refuse: () => string | null;
  /** 出了结果之后扣一次次数，也就是执行核心的 useForecast 命令。失败时返回提示文字，成功返回 null。 */
  readonly charge: () => string | null;
  /** 显示推演单，null 是收起。 */
  readonly show: (sheet: ForecastSheetState | null) => void;
  /** 系统提示。 */
  readonly toast: (text: string) => void;
}

export interface ForecastFlow {
  /** 点了一个「推演」按钮。host 是按钮所在的物件，推演单贴在它旁边。 */
  click(option: ForecastOption, host: string | null): void;
  /** 关掉推演单。推演还在算时取消它，不扣次数。 */
  close(): void;
  /** 有推演在算。 */
  busy(): boolean;
}

export function createForecastFlow(deps: ForecastFlowDeps): ForecastFlow {
  let serial = 0;
  /** 在算的推演。关掉推演单或者出了结果之后为 null。 */
  let active: { readonly id: number; readonly handle: ForecastHandle } | null = null;

  const show = (id: number, host: string | null, view: ForecastSheetView): void => deps.show({ id, host, view });

  function click(option: ForecastOption, host: string | null): void {
    if (active !== null) return;
    const refused = deps.refuse();
    if (refused !== null) {
      deps.toast(refused);
      return;
    }
    serial += 1;
    const id = serial;
    const command = forecastCommand(option);
    // 后台线程出了错，不是推演不了这个选项：写一句通用的提示
    const broken = (): ForecastSheetView => failedView(option, reasonText('generic'));
    show(id, host, runningView(option));
    let handle: ForecastHandle;
    try {
      handle = deps.request(deps.state(), command, { sequences: FORECAST_V1.sequences });
    } catch {
      show(id, host, broken());
      return;
    }
    active = { id, handle };
    /** 这个推演还是在算的那一个：推演单关掉之后，迟到的结果和取消的通知都不再处理。 */
    const settle = (): boolean => {
      if (active === null || active.id !== id) return false;
      active = null;
      return true;
    };
    void handle.promise.then(
      (result) => {
        if (!settle()) return;
        if (!result.ok) {
          show(id, host, failedView(option, failureText(result.reason, failureContext(deps.state(), command, result.reason))));
          return;
        }
        const refusedCharge = deps.charge();
        show(id, host, refusedCharge === null ? doneView(option, result) : failedView(option, refusedCharge));
      },
      (error: unknown) => {
        if (!settle()) return;
        if (error instanceof ForecastCancelled) deps.show(null);
        else show(id, host, broken());
      },
    );
  }

  function close(): void {
    const current = active;
    active = null;
    deps.show(null);
    current?.handle.cancel();
  }

  return { click, close, busy: () => active !== null };
}

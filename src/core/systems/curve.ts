// 订单量曲线：控制点之间线性插值。沙盒的到达曲线和经营模式各片区的曲线都用它。
import { DAY_STEPS, DT } from '../constants.ts';

/** 控制点是天内的秒数和相对来单率。t 在第一个点之前或最后一个点之后时取端点的值。 */
export function interpolateCurve(seconds: readonly number[], rates: readonly number[], t: number): number {
  const last = seconds.length - 1;
  if (t <= (seconds[0] as number)) return rates[0] as number;
  if (t >= (seconds[last] as number)) return rates[last] as number;
  let i = 0;
  while (t >= (seconds[i + 1] as number)) i++;
  const x0 = seconds[i] as number;
  const x1 = seconds[i + 1] as number;
  const y0 = rates[i] as number;
  const y1 = rates[i + 1] as number;
  if (t === x0) return y0;
  return ((y1 - y0) / (x1 - x0)) * (t - x0) + y0;
}

/** 一天里每一步的相对来单率。 */
export function curveSteps(seconds: readonly number[], rates: readonly number[]): number[] {
  return Array.from({ length: DAY_STEPS }, (_, tick) => interpolateCurve(seconds, rates, tick * DT));
}

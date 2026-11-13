// 只用加减乘除实现的 exp 和 ln。
// 原因：Math.exp、Math.log、Math.pow 的末位在不同浏览器和 Node 之间可能不同，
// 而订单概率和店铺权重要在任何平台上得到逐位相同的结果。

const LN2 = 0.6931471805599453;

/** e 的 x 次方。参数先折半缩小，做泰勒展开后再连续平方。 */
export function detExp(x: number): number {
  if (x === 0) return 1;
  let y = x;
  let halvings = 0;
  while (Math.abs(y) > 0.25) {
    y /= 2;
    halvings++;
  }
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= 14; i++) {
    term = (term * y) / i;
    sum += term;
  }
  for (let i = 0; i < halvings; i++) sum *= sum;
  return sum;
}

/** 自然对数，x 必须大于 0。先用乘除 2 把 x 折到 [0.75, 1.5)，再用 atanh 级数。 */
export function detLn(x: number): number {
  if (!(x > 0)) throw new RangeError('detLn requires x > 0');
  let m = x;
  let e = 0;
  while (m >= 1.5) {
    m /= 2;
    e++;
  }
  while (m < 0.75) {
    m *= 2;
    e--;
  }
  const y = (m - 1) / (m + 1);
  const y2 = y * y;
  let term = y;
  let sum = 0;
  for (let k = 1; k <= 27; k += 2) {
    sum += term / k;
    term *= y2;
  }
  return 2 * sum + e * LN2;
}

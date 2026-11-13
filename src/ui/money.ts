// 钱的显示：界面上的钱都是整数。纯函数。

/** 把有小数的钱显示成整数：向下取整，浮点误差留一点余量。显示的数够买什么，就真的能买。 */
export function wholeMoney(value: number): number {
  return Math.max(0, Math.floor(value + 1e-9));
}

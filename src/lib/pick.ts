/**
 * 从一口里挑几样,拼进还按扁平形状收的接线函数(它们的类型只列用到的那几样,架构终态 A6)。挑出来的就是同一个函数:
 * adapter 的方法不靠 this;可选的那几样(onMediaSent …)没有 ⇒ 挑出来是 undefined,调用方本来就按可选判。
 */
export function pick<T, K extends keyof T>(o: T, ...keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) out[k] = o[k]
  return out
}

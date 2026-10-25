/**
 * paused.ts —— 便宜模型「此刻不让问」不是失败。
 *
 * 两种:网络守护不安全(NetworkUnprotectedError),和服务方拒绝后的退避期(provider-registry 的 cheapEval 被拒,
 * 码 region_unavailable,#627)。这两种都是系统在按规矩停手,下一轮自己会再来。以前 ingest 的每个 catch 把它们和
 * 真失败记成同一句 `… failed (retry next cycle)`,按联系人循环的那两处还每个联系人各记一条:10-23 一轮记 6 条、
 * 两天 13 条「失败」,`self discover` 把它排在候选前面,其实什么都没坏。
 *
 * 这里只认出来、给一句不带「失败」字样的原因;调用方记一条「这一轮跳过」,按联系人的循环直接停(剩下的联系人问也是同一个答案)。
 */
import { isNetworkUnprotectedError } from '../../../lib/network-gate'
import { providerErrorCodeOf } from '../../../lib/provider-error-code'

/** 是「此刻不让问」⇒ 回一句原因;否则 null(照旧当失败记)。 */
export function pausedReason(err: unknown): string | null {
  if (isNetworkUnprotectedError(err)) return '网络守护没开好,用到海外模型的这一步先停'
  if (providerErrorCodeOf(err) === 'region_unavailable') return '便宜模型被服务方拒绝,退避期内不问'
  return null
}

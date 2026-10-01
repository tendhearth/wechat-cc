/**
 * pair-check.ts — 配对核对码(plan 7a,Task 9 fix round 1)。桌面出码时显示、手机确认卡上显示,两边一致才连。
 *
 * 为什么要:官方中继 relay.tendhearth.com 是所有人共用的,确认卡上只看主机名分不出「我的电脑」和「别人的码」。
 * 核对码由码里的 daemon id 派生:换一台电脑的码,核对码就不一样。
 *
 * 派生(v1,定下就别改 —— 桌面与手机、新旧版本要算出同一个):
 *   h = sha256(UTF-8 `wechat-cc/pair-check/v1:<daemonId>`)
 *   取 h 的前 20 位,高位在前,每 5 位一个字符,查 PAIR_CHECK_ALPHABET ⇒ 4 个字符。
 * 字母表 32 个:数字 2–9 + 大写字母去掉 I、O(没有 0/O、1/I 这两对容易看错的)。
 * 只有约 100 万种,够人眼核对「是不是同一台」,不是密码学上的认证。
 *
 * 纯净约束同 relay.ts(protocol-purity 守卫)。
 */
import { sha256 } from '@noble/hashes/sha2.js'

export const PAIR_CHECK_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const PAIR_CHECK_RE = /^[2-9A-HJ-NP-Z]{4}$/

export function pairCheckCode(daemonId: string): string {
  const h = sha256(new TextEncoder().encode(`wechat-cc/pair-check/v1:${daemonId}`))
  const bits = ((h[0]! << 12) | (h[1]! << 4) | (h[2]! >>> 4)) >>> 0
  let out = ''
  for (let i = 3; i >= 0; i--) out += PAIR_CHECK_ALPHABET[(bits >>> (i * 5)) & 31]
  return out
}

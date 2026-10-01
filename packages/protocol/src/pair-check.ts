/**
 * pair-check.ts — 配对核对码(plan 7a)。桌面出码时显示、手机确认卡上显示,两边一致才连。
 *
 * 为什么要:官方中继 relay.tendhearth.com 是所有人共用的,确认卡上只看主机名分不出「我的电脑」和「别人的码」。
 * 核对码由码里的 daemon id 派生:换一台电脑的码,核对码就不一样。它标识的是「哪台电脑」,不是「哪一次配对」。
 *
 * 派生(v2,定下就别改 —— 桌面与手机、新旧版本要算出同一个):
 *   h = sha256(UTF-8 `wechat-cc/pair-check/v2:<daemonId>`)
 *   取 h 的前 30 位,高位在前,每 5 位一个字符,查 PAIR_CHECK_ALPHABET ⇒ 6 个字符,显示成 XXX-XXX。
 * 字母表 32 个:数字 2–9 + 大写字母去掉 I、O(没有 0/O、1/I 这两对容易看错的)。
 * (v1 是前 20 位 / 4 个字符,约 100 万种;太容易被人试出撞码的 id,7a 终修换成 v2。)
 *
 * 30 位 ≈ 10 亿种:是给人眼做的交叉核对(「手机上显示的和我电脑上的一样吗」),不是密码学上的认证 ——
 * 真正把手机绑到电脑的是链接里的一次性令牌;核对码只帮主人发现「这不是我的电脑」。
 *
 * 纯净约束同 relay.ts(protocol-purity 守卫)。
 */
import { sha256 } from '@noble/hashes/sha2.js'

export const PAIR_CHECK_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const PAIR_CHECK_RE = /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/

export function pairCheckCode(daemonId: string): string {
  const h = sha256(new TextEncoder().encode(`wechat-cc/pair-check/v2:${daemonId}`))
  // 前 30 位:4 个字节拼成 32 位再右移 2(>>> 0 保持无符号)
  const bits = (((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 2) >>> 0
  let out = ''
  for (let i = 5; i >= 0; i--) out += PAIR_CHECK_ALPHABET[(bits >>> (i * 5)) & 31]
  return `${out.slice(0, 3)}-${out.slice(3)}`
}

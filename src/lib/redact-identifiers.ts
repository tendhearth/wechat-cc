/**
 * 话题记忆写进去之前去掉明显的身份号 / 账号尾号 / 密钥位置 / 令牌(话题 T1–T3 后续,整合者 2026-11-05 第 2 条)。
 *
 * 写的那一刻就去掉(条目的 line / body、话题的摘要):存下来的、调进对话的、交给执行者的简报都是同一份去过的文字。
 * 只认「长得很像」的那几种,宁可漏一个也不把正常的数字改坏;改成一眼看得懂的占位。
 */
const RULES: Array<[RegExp, string]> = [
  // 令牌 / 密钥原文:sk-…、ghp_…、xoxb-…、AKIA…、Bearer …、JWT
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[令牌]'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[令牌]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[令牌]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[令牌]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [令牌]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[令牌]'],
  // 密钥文件:~/.private_keys/ 底下的、任何 .p8
  [/(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+|\$HOME)\/\.private_keys(?:\/[^\s,，;；)）'"`]*)?/g, '[密钥文件]'],
  [/[^\s,，;；(（'"`]*\.p8\b/g, '[密钥文件]'],
  // 美国 EIN(12-3456789)
  [/(?<![\d-])\d{2}-\d{7}(?![\d-])/g, '[EIN]'],
  // 卡号 / 账号尾号 1234
  [/尾号\s*[:：]?\s*\d{3,6}/g, '尾号 ****'],
  [/(?:ending in|last 4)\s*[:：]?\s*\d{4}\b/gi, 'ending in ****'],
]

export function redactIdentifiers(text: string): string {
  let out = text
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}

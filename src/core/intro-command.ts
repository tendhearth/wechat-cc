/** 「认识 <ref>」「同意 <ref>」「不了 <ref>」—— 介绍的三个主人动作,和 派/取消 同一套确定性解析。 */
const RE = /^\s*(认识|同意|不了)\s+#?([0-9a-fA-F]{2,8})\s*$/
export function parseIntroCommand(text: string): { kind: 'request' | 'accept' | 'decline'; ref: string } | null {
  const m = RE.exec(text)
  if (!m) return null
  const kind = m[1] === '认识' ? 'request' : m[1] === '同意' ? 'accept' : 'decline'
  return { kind, ref: m[2]!.toLowerCase() }
}

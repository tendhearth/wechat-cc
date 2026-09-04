/**
 * envelope.ts — 社交信封:密封明文里的**唯一**结构(架构重构 §2.1)。
 *
 * 此前每个社交功能自带一条路由;串门为了不加路由,往信件明文里塞了一行
 * `⟪visit …⟫` 头部 —— 能用,但再来礼物、明信片、茶话会,每个都得再发明
 * 一种头部,而解析散在各处。这里把它收成一种:`⟪env⟫` + JSON,只在
 * correspondent **一处**解析,按 kind 分发。
 *
 * `kind='letter'` 例外:明文就是信本身,不包信封。这是向后兼容的要害 ——
 * 旧对端解出明文直接给主人看,一封真信在旧对端上必须仍然是一封真信。
 * 反过来,旧对端收到 `⟪env⟫{…}` 会原样显示;所以自动串门只去证明过的对端
 * (wire-visit.ts),这条规则不因为信封化而放松。
 *
 * 不认识的 kind:记日志、忽略(向前兼容,新版本发的类型老版本不炸)。
 */

export interface Envelope<P = unknown> { kind: string; payload: P }

const PREFIX = '⟪env⟫'

export function sealEnvelope(env: Envelope): string {
  return PREFIX + JSON.stringify(env)
}

/**
 * 明文 → 信封。不是信封(没有前缀,或前缀后不是合法 JSON)⇒ 当成一封信。
 * 坏 JSON 也当成信而不是抛:一封被截断的信封最坏是让主人看到一串 JSON,
 * 抛出去则是整条接收路径断掉。
 */
export function openEnvelope(plaintext: string): Envelope | { kind: 'letter'; payload: { text: string } } {
  if (!plaintext.startsWith(PREFIX)) return { kind: 'letter', payload: { text: plaintext } }
  try {
    const j = JSON.parse(plaintext.slice(PREFIX.length)) as Partial<Envelope>
    if (typeof j.kind === 'string' && j.kind !== '' && 'payload' in j) return { kind: j.kind, payload: j.payload }
  } catch { /* 落到下面 */ }
  return { kind: 'letter', payload: { text: plaintext } }
}

export function isEnvelopeText(plaintext: string): boolean {
  return plaintext.startsWith(PREFIX)
}

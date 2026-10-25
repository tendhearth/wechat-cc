/**
 * companion-topics — 主人不希望 CC **主动**提起的话题(对标 ChatGPT「可以主动聊的话题」,2026-10-20)。
 * 只管 CC 自己开口的那几种(到点跟进、问候、打猎);主人自己提起时照常聊。词表固定,不让模型猜「算不算健康」。
 */
export const AVOID_TOPICS = [
  { key: 'health', label: '健康', aliases: ['health', '健康', '身体', '病'] },
  { key: 'family', label: '家人', aliases: ['family', '家人', '家庭', '父母'] },
  { key: 'money', label: '钱', aliases: ['money', '钱', '财务', '理财', '收入'] },
  { key: 'work', label: '工作', aliases: ['work', '工作', '上班'] },
  { key: 'love', label: '感情', aliases: ['love', '感情', '恋爱', '婚姻'] },
  { key: 'looks', label: '外貌', aliases: ['looks', '外貌', '身材', '体重'] },
] as const

export type AvoidTopic = (typeof AVOID_TOPICS)[number]['key']

const CLEAR = new Set(['none', 'off', '无', '清空', '都可以'])

export function parseAvoidTopics(raw: string): { ok: true; topics: AvoidTopic[] } | { ok: false; error: string } {
  const parts = raw.split(/[,，、/\s;；]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 1 && CLEAR.has(parts[0]!)) return { ok: true, topics: [] }
  const picked = new Set<AvoidTopic>()
  for (const p of parts) {
    const t = AVOID_TOPICS.find(x => (x.aliases as readonly string[]).includes(p))
    if (!t) return { ok: false, error: `不认识「${p}」。能选的:${AVOID_TOPICS.map(x => x.label).join('、')};清空写 无` }
    picked.add(t.key)
  }
  return { ok: true, topics: AVOID_TOPICS.filter(x => picked.has(x.key)).map(x => x.key) }
}

export function topicLabels(topics: readonly AvoidTopic[]): string {
  return AVOID_TOPICS.filter(x => topics.includes(x.key)).map(x => x.label).join('、')
}

/** 主动消息信封里加的那一句;没设 / 都不认识 ⇒ ''。 */
export function avoidTopicsLine(topics: readonly AvoidTopic[] | undefined): string {
  const labels = topics ? topicLabels(topics) : ''
  return labels ? `\n主人不希望你主动提起这些话题:${labels}。这次别主动提(主人自己提起时照常聊)。` : ''
}

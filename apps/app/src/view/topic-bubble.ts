import type { TopicDetailT } from '../backend/types'
const merge = <T extends { id: string }>(a: T[], b: T[]) => [...new Map([...a, ...b].map(x => [x.id, x])).values()]
export function appendTopicPage(old: TopicDetailT, next: TopicDetailT, section: 'entries' | 'matters' | 'messages'): TopicDetailT | null {
  if (old.topic.id !== next.topic.id || old.revision !== next.revision) return null
  const pages = { ...old.pages, [section]: next.pages[section] }
  if (section === 'entries') return { ...old, entries: merge(old.entries, next.entries), pages }
  if (section === 'matters') return { ...old, matters: merge(old.matters, next.matters), pages }
  return { ...old, messages: merge(old.messages, next.messages), pages }
}

export function topicStatus(state: string): import('./status').StatusKey | null {
  if (state === 'waiting' || state === 'awaiting_approval' || state === 'awaiting_answer') return 'waiting'
  if (state === 'running' || state === 'open' || state === 'working') return 'working'
  if (state === 'replied') return 'replied'
  if (state === 'done' || state === 'completed') return 'done'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled' || state === 'interrupted') return 'stopped'
  return null
}

import type { Backend, TopicDetailT } from '../backend/types'
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

/** Display only the daemon's counts; client state never reclassifies seen or running. */
export function topicActivityLabel(topic: { title: string; activity?: { waiting: number; running: number; unread: number } }, zh: boolean): string {
  const a=topic.activity
  return [topic.title,a?.waiting ? (zh ? `${a.waiting} 个等你` : `${a.waiting} waiting for you`) : '',a?.running ? (zh ? `${a.running} 个在跑` : `${a.running} running`) : '',a?.unread ? (zh ? `${a.unread} 个做完未看` : `${a.unread} completed, unread`) : ''].filter(Boolean).join(zh?'，':', ')
}

/** Rebuild the visible range from this revision's first page and fresh cursors. */
export async function retainTopicMatters(initial: TopicDetailT, read: Backend['topicDetail'], target: number, active: () => boolean): Promise<TopicDetailT | null> {
  let result=initial
  const cursors=new Set<string>()
  while(active() && result.matters.length<target && result.pages.matters.nextCursor){
    const cursor=result.pages.matters.nextCursor
    if(cursors.has(cursor))throw Error('repeated_cursor')
    cursors.add(cursor)
    const next=await read({id:initial.topic.id,section:'matters',cursor,limit:20})
    if(!active())return null
    const merged=appendTopicPage(result,next,'matters')
    if(!merged || merged.matters.length<=result.matters.length)throw Error('topic_revision_changed')
    result=merged
  }
  return active()?result:null
}

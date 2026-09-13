import { createHash } from 'node:crypto'
import type { StoredTask, TaskEvent } from './store'

export interface RestartPreview {
  token: string
  context: string
  eventCount: number
  includedEventCount: number
  truncated: boolean
}
export type Continuation = { mode: 'new' | 'resume'; restart?: never } | { mode: 'restart_required'; restart: RestartPreview }

/** Keep the newest conversation, including part of an oversized event with its role intact. */
export function restartPreview(task: StoredTask, events: TaskEvent[]): RestartPreview {
  const source=events.filter(event => event.kind==='user' || event.kind==='text')
  const selected=source.slice(-12)
  const parts:string[]=[]
  let remaining=24_000, partial=false
  for (const event of [...selected].reverse()) {
    const prefix=`${event.kind}: `
    const available=remaining-(parts.length ? 1 : 0)
    if (available<=prefix.length) break
    const text=event.text.slice(-(available-prefix.length))
    partial ||= text.length<event.text.length
    const part=prefix+text
    parts.unshift(part)
    remaining=available-part.length
    if (partial) break
  }
  const context=parts.join('\n')
  // Bind original source IDs and full text, including omitted history, so edits and
  // added history invalidate a preview even if the visible suffix stays identical.
  const token=createHash('sha256').update(JSON.stringify({
    taskId:task.id,path:task.path,providerId:task.providerId,sessionId:task.sessionId,
    source:source.map(({id,kind,text}) => ({id,kind,text})),context,
  })).digest('hex')
  return {token,context,eventCount:source.length,includedEventCount:parts.length,truncated:partial || parts.length<source.length}
}

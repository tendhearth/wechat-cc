import { createHash } from 'node:crypto'
import type { StoredTask, TaskEvent } from './store'

export interface RestartPreview {
  token: string
  context: string
  eventCount: number
  includedEventCount: number
  truncated: boolean
  attachments?:import('./attachments').Attachment[]
  omittedAttachmentCount?:number
}
export type Continuation = { mode: 'new' | 'resume'; restart?: never } | { mode: 'restart_required'; restart: RestartPreview }

/** Keep the newest conversation, including part of an oversized event with its role intact. */
export function restartPreview(task: StoredTask, events: TaskEvent[]): RestartPreview {
  const source=events.filter(event => event.kind==='user' || event.kind==='text')
  const selected=source.slice(-12)
  const parts:string[]=[]
  let remaining=source.some(e=>e.attachments?.length)?21_000:24_000, partial=false
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
  const covered=parts.length?selected.slice(-parts.length):[],attachments:NonNullable<RestartPreview['attachments']>=[]
  let bytes=0,omittedAttachmentCount=0
  const seen=new Set<string>()
  for(const event of [...source].reverse())for(const attachment of [...(event.attachments??[])].reverse()){
    if(seen.has(attachment.id))continue
    seen.add(attachment.id)
    if(!covered.includes(event)||attachments.length>=8||bytes+attachment.size>24*1024*1024){omittedAttachmentCount++;continue}
    attachments.unshift({...attachment});bytes+=attachment.size
  }
  const material=seen.size?'\n\n保留的原始附件：\n'+attachments.map(a=>JSON.stringify({name:a.name,sha256:a.sha256})).join('\n')+`\n未带入的历史附件：${omittedAttachmentCount} 件。`:''
  // Bind original source IDs and full text, including omitted history, so edits and
  // added history invalidate a preview even if the visible suffix stays identical.
  const token=createHash('sha256').update(JSON.stringify({
    taskId:task.id,path:task.path,providerId:task.providerId,sessionId:task.sessionId,
    source:source.map(({id,kind,text,attachments}) => ({id,kind,text,attachments})),context,attachments,
  })).digest('hex')
  return {token,context:context+material,eventCount:source.length,includedEventCount:parts.length,truncated:partial || parts.length<source.length || omittedAttachmentCount>0,...(seen.size?{attachments,omittedAttachmentCount}:{})}
}

import { join } from 'node:path'
import type { MessageRecord } from '../../lib/messages-store'
import { parseExtras, phoneExtrasFields, incomingUploadAttachments, recordedFileCanonical } from '../app-reply'

/** Project only durable, public metadata; never expose stored paths or invent upload references. */
export function ownerChatReadingEvent(row: MessageRecord, inboxDir?:string) {
  const incoming=incomingUploadAttachments(row,inboxDir)
  const replyExtras = row.direction === 'out' ? phoneExtrasFields(row.extras) : incoming.length?{attachments:incoming.map(({name})=>({kind:'file' as const,name}))}:{}
  return { kind: row.direction === 'in' ? 'user' : 'text', text: row.text, createdAt: Date.parse(row.ts), source: row.source,
    messageId: row.id, ...(Object.keys(replyExtras).length ? { replyExtras } : {}) }
}
export type OwnerChatFileInput = { id:string; i:number; offset:number; sha256?:string; size?:number }
export type OwnerChatFileResult = {status:number;body:Record<string,unknown>}
/** The caller supplies message identity only. Authority comes from the stored owner's outgoing attachment or validated incoming app upload. */
export function makeOwnerChatFileReader(deps:{ownerChatId():string|null;stickerDir?:string;inboxDir?:string;readChunk(path:string,name:string,offset:number):Response;message(chatId:string,id:string):Promise<MessageRecord|null>}) {
  return async (input:OwnerChatFileInput):Promise<OwnerChatFileResult> => {
    const fail=(status:number,error:string)=>({status,body:{error}})
    const owner=deps.ownerChatId();if(!owner)return fail(404,'not_found')
    const row=await deps.message(owner,input.id)
    if(!row||row.id!==input.id||row.chatId!==owner)return fail(404,'not_found')
    const attachment=(row.direction==='out'?parseExtras(row.extras)?.attachments:incomingUploadAttachments(row,deps.inboxDir))?.[input.i]
    if(!attachment)return fail(404,'not_found')
    const path=attachment.kind==='file'?attachment.path:attachment.kind==='sticker'&&attachment.file&&deps.stickerDir?join(deps.stickerDir,attachment.file):null
    const name=attachment.kind==='file'?attachment.name:attachment.kind==='sticker'?attachment.file??'': ''
    if(!path)return fail(404,'not_found')
    // A recorded path is authority for that file (symlinked parent directories included), not a symlink to a replacement elsewhere.
    if(!recordedFileCanonical(path))return fail(404,'not_found')
    const response=deps.readChunk(path,name,input.offset)
    const body=await response.json() as Record<string,unknown>
    if(response.ok&&((input.sha256!==undefined&&body.sha256!==input.sha256)||(input.size!==undefined&&body.size!==input.size)))return fail(409,'file_changed')
    return {status:response.status,body}
  }
}

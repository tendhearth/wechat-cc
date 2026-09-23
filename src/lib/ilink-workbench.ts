import { botTextMessage, ILINK_BASE_INFO, ilinkPost } from './ilink'

export type WorkbenchNoticeOutcome = {
  status: 'accepted' | 'deferred' | 'unknown' | 'blocked'
  reason?: string
}
export type ArtifactTransportOutcome={status:'accepted'}|{status:'deferred'|'unknown'|'blocked';reason:string}
export interface WorkbenchEncryptedMedia {encrypt_query_param:string;aes_key:string;encrypt_type:1}
export type WorkbenchMediaItem=
  | {type:2;image_item:{media:WorkbenchEncryptedMedia;mid_size?:number}}
  | {type:4;file_item:{media:WorkbenchEncryptedMedia;file_name:string;len:string}}
  | {type:5;video_item:{media:WorkbenchEncryptedMedia;video_size?:number}}

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const exact=(value:Record<string,unknown>,required:string[],optional:string[]=[])=>Object.keys(value).every(key=>required.includes(key)||optional.includes(key))&&required.every(key=>Object.hasOwn(value,key))
const media=(value:unknown):value is WorkbenchEncryptedMedia=>record(value)&&exact(value,['encrypt_query_param','aes_key','encrypt_type'])&&typeof value.encrypt_query_param==='string'&&value.encrypt_query_param.length>0&&typeof value.aes_key==='string'&&value.aes_key.length>0&&value.encrypt_type===1
export function isWorkbenchMediaItem(value:unknown):value is WorkbenchMediaItem {
  if(!record(value)||typeof value.type!=='number')return false
  if(value.type===2&&exact(value,['type','image_item'])&&record(value.image_item)&&exact(value.image_item,['media'],['mid_size']))return media(value.image_item.media)&&(value.image_item.mid_size===undefined||(Number.isInteger(value.image_item.mid_size)&&Number(value.image_item.mid_size)>=0))
  if(value.type===4&&exact(value,['type','file_item'])&&record(value.file_item)&&exact(value.file_item,['media','file_name','len']))return media(value.file_item.media)&&typeof value.file_item.file_name==='string'&&value.file_item.file_name.length>0&&typeof value.file_item.len==='string'&&/^\d+$/.test(value.file_item.len)
  if(value.type===5&&exact(value,['type','video_item'])&&record(value.video_item)&&exact(value.video_item,['media'],['video_size']))return media(value.video_item.media)&&(value.video_item.video_size===undefined||(Number.isInteger(value.video_item.video_size)&&Number(value.video_item.video_size)>=0))
  return false
}

export interface IlinkWorkbenchTextRequest {
  baseUrl: string
  token: string
  clientId: string
  ownerChatId: string
  text: string
  contextToken: string
  signal?: AbortSignal
  /** Narrow test seam; production uses ilinkPost's standard timeout. */
  timeoutMs?: number
}
export type IlinkWorkbenchItemRequest=Omit<IlinkWorkbenchTextRequest,'text'> & {item:WorkbenchMediaItem}

function classify(raw: string): WorkbenchNoticeOutcome {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { status: 'unknown', reason: 'ambiguous_response' } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'unknown', reason: 'ambiguous_response' }
  const response = value as Record<string, unknown>
  const present = ['errcode', 'ret'].filter(field => Object.hasOwn(response, field))
  if (present.length === 0 || present.some(field => typeof response[field] !== 'number')) {
    return { status: 'unknown', reason: 'ambiguous_response' }
  }
  const codes = present.map(field => response[field] as number)
  if (codes.every(code => code === 0)) return { status: 'accepted' }
  const distinctCodes = new Set(codes)
  if (distinctCodes.size !== 1) return { status: 'unknown', reason: 'ambiguous_response' }
  const code = codes[0]
  if (code === -2) return { status: 'deferred', reason: 'window_closed' }
  if (code === -14 || code === -6) return { status: 'blocked', reason: 'account_unavailable' }
  return { status: 'unknown', reason: 'server_rejected' }
}

/** Strict single-attempt text transport for persistent workbench notices. */
export async function sendIlinkWorkbenchText(request: IlinkWorkbenchTextRequest): Promise<WorkbenchNoticeOutcome> {
  const body = {
    msg: {
      from_user_id: '',
      client_id: request.clientId,
      ...botTextMessage(request.ownerChatId, request.text, request.contextToken),
    },
    base_info: ILINK_BASE_INFO,
  }
  try {
    const raw = await ilinkPost(
      request.baseUrl,
      'ilink/bot/sendmessage',
      body,
      request.token,
      request.timeoutMs,
      request.signal,
    )
    return classify(raw)
  } catch {
    return { status: 'unknown', reason: 'transport_uncertain' }
  }
}

export async function sendIlinkWorkbenchItem(request:IlinkWorkbenchItemRequest):Promise<ArtifactTransportOutcome>{
  if(!isWorkbenchMediaItem(request.item))return{status:'blocked',reason:'invalid_item'}
  const body={msg:{from_user_id:'',client_id:request.clientId,to_user_id:request.ownerChatId,message_type:2,message_state:2,item_list:[request.item],context_token:request.contextToken},base_info:ILINK_BASE_INFO}
  try{
    const raw=await ilinkPost(request.baseUrl,'ilink/bot/sendmessage',body,request.token,request.timeoutMs,request.signal)
    const outcome=classify(raw)
    return outcome.status==='accepted'?{status:'accepted'}:{status:outcome.status,reason:outcome.reason??'transport_uncertain'}
  }catch{return{status:'unknown',reason:'transport_uncertain'}}
}

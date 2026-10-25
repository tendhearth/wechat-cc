import {createHash,randomUUID} from 'node:crypto'
import type {Db} from '../../../lib/db'
import type {ChatMessage} from './api-model'

/**
 * OpenAI 兼容会话的持久化(B2,2026-10-25:对话和工作台同一份)。整段协议历史存一行,`revision` 乐观锁,
 * `state`:active = 有一个会话在用它;ready = 可以续接;interrupted = 半截停下,不续接。
 *  - 工作台:`workbench_api_sessions`(v58),绑任务 / 主人 / 文件夹身份 / 连接;
 *  - 对话:`openai_chat_sessions`(v86),绑对话 / 项目别名 / 文件夹 / 连接(钉的模型不算:换模型照样续接)。
 */
export type ApiSessionState='active'|'ready'|'interrupted'
export interface ApiSessionBinding{taskId:string;owner:string;path:string;directoryIdentity:string;configHash:string}
export interface ApiSession{id:string;revision:number;messages:ChatMessage[];state:ApiSessionState;binding:ApiSessionBinding}
export interface ChatSessionBinding{chatId:string;alias:string;path:string;configHash:string}
export interface ChatSession{id:string;revision:number;messages:ChatMessage[];state:ApiSessionState;binding:ChatSessionBinding}

/** 对话这一侧的存取口(DB 一份、没有 DB 时内存一份,形状相同)。 */
export interface ChatSessionStore{
  create(binding:ChatSessionBinding,messages:ChatMessage[]):ChatSession
  acquire(id:string,binding:ChatSessionBinding):ChatSession
  save(id:string,revision:number,messages:ChatMessage[],state:ApiSessionState):ChatSession
  canResume(id:string,path:string,configHash:string):boolean
  get(id:string):ChatSession|null
  /** 不落盘(没有 DB):会话的历史只在它自己的内存里,存取口什么都不留。 */
  readonly ephemeral?:true
}

const MAX_MESSAGES=10_000,MAX_BYTES=16*1024*1024
/**
 * 对话续接的上限:存下来的历史超过它就不续,起新会话(和续接之前一样从头来)。OpenAI 兼容这条路没有自动压缩,
 * 无限续下去迟早撑爆上下文、每一轮都回 invalid_request。192 KiB ≈ 5–6 万 token。
 */
export const CHAT_RESUME_MAX_BYTES=192*1024
/** 不再续接的老对话会话留多久(session-manager 的续接期限是 7 天)。 */
const CHAT_KEEP_MS=8*24*60*60_000
const SELECT=`SELECT id,revision,messages_json AS messagesJson,state,task_id AS taskId,owner,path,directory_identity AS directoryIdentity,config_hash AS configHash FROM workbench_api_sessions WHERE id=?`
const CHAT_SELECT=`SELECT id,revision,messages_json AS messagesJson,state,chat_id AS chatId,alias,path,config_hash AS configHash FROM openai_chat_sessions WHERE id=?`
type Row={id:string;revision:number;messagesJson:string;state:string;taskId:string;owner:string;path:string;directoryIdentity:string;configHash:string}
type ChatRow={id:string;revision:number;messagesJson:string;state:string;chatId:string;alias:string;path:string;configHash:string}

export {initializeApiSessionSchema} from '../../../lib/db'

/** 连接身份:base URL + 密钥(+ 模型:工作台绑模型、对话不绑,钉的模型换了照样续接)的摘要。只存摘要,不存密钥。 */
export function openAiConnectionHash(value:{baseURL:string;apiKey:string;model?:string}):string{
  const url=new URL(value.baseURL)
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!value.apiKey)throw Error('invalid_api_model')
  const parts=[url.href.replace(/\/$/,''),value.apiKey,...(value.model!==undefined?[value.model.trim()]:[])]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype
function jsonValue(value:unknown,seen:Set<object>):boolean{
  if(value===null||typeof value==='string'||typeof value==='boolean')return true
  if(typeof value==='number')return Number.isFinite(value)
  if(typeof value!=='object')return false
  if(seen.has(value))return false
  seen.add(value)
  const valid=Array.isArray(value)?value.every(item=>jsonValue(item,seen)):plain(value)&&Object.values(value).every(item=>jsonValue(item,seen))
  seen.delete(value);return valid
}
function encode(messages:ChatMessage[]):string{
  if(!Array.isArray(messages)||messages.length>MAX_MESSAGES||messages.some(message=>!plain(message)||!['system','user','assistant','tool'].includes(String(message.role))||!Object.hasOwn(message,'content')||(typeof message.content!=='string'&&!Array.isArray(message.content))||!jsonValue(message,new Set())))throw Error('invalid_api_messages')
  const json=JSON.stringify(messages)
  if(Buffer.byteLength(json)>MAX_BYTES)throw Error('api_messages_too_large')
  return json
}
function decode(json:string):ChatMessage[]{
  try{const value=JSON.parse(json);encode(value);return value as ChatMessage[]}catch{throw Error('invalid_api_session')}
}
const validState=(state:string):state is ApiSessionState=>['active','ready','interrupted'].includes(state)
const fields=(values:unknown[])=>values.every(value=>typeof value==='string'&&value.length>0&&value.length<=4096)
function validBinding(binding:ApiSessionBinding):void{
  if(!binding||!fields([binding.taskId,binding.owner,binding.path,binding.directoryIdentity,binding.configHash]))throw Error('api_session_binding')
}
function validChatBinding(binding:ChatSessionBinding):void{
  if(!binding||!fields([binding.chatId,binding.alias,binding.path,binding.configHash]))throw Error('api_session_binding')
}
function session(row:Row):ApiSession{
  if(!Number.isSafeInteger(row.revision)||row.revision<0||!validState(row.state))throw Error('invalid_api_session')
  return{id:row.id,revision:row.revision,messages:decode(row.messagesJson),state:row.state,binding:{taskId:row.taskId,owner:row.owner,path:row.path,directoryIdentity:row.directoryIdentity,configHash:row.configHash}}
}
function chatSession(row:ChatRow):ChatSession{
  if(!Number.isSafeInteger(row.revision)||row.revision<0||!validState(row.state))throw Error('invalid_api_session')
  return{id:row.id,revision:row.revision,messages:decode(row.messagesJson),state:row.state,binding:{chatId:row.chatId,alias:row.alias,path:row.path,configHash:row.configHash}}
}
function checkSave(revision:number,state:string){
  if(!Number.isSafeInteger(revision)||revision<0||!validState(state))throw Error('api_session_conflict')
}

export function makeApiSessionStore(db:Db){
  const raw=(id:string)=>db.query<Row,[string]>(SELECT).get(id)
  const get=(id:string):ApiSession|null=>{const row=raw(id);return row?session(row):null}
  const verifyTask=(binding:ApiSessionBinding)=>{
    const task=db.query<{path:string;ownerChatId:string|null},[string]>('SELECT path,owner_chat_id AS ownerChatId FROM workbench_tasks WHERE id=?').get(binding.taskId)
    const effectiveOwner=task?.ownerChatId??(task?`workbench:${binding.taskId}`:'')
    if(!task||task.path!==binding.path||effectiveOwner!==binding.owner)throw Error('api_session_binding')
  }
  return{
    create(binding:ApiSessionBinding,messages:ChatMessage[]):ApiSession{
      validBinding(binding);const json=encode(messages),id=randomUUID(),now=Date.now()
      db.transaction(()=>{verifyTask(binding);db.query('INSERT INTO workbench_api_sessions(id,task_id,owner,path,directory_identity,config_hash,revision,messages_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,\'active\',?,?)').run(id,binding.taskId,binding.owner,binding.path,binding.directoryIdentity,binding.configHash,json,now,now)})()
      return get(id)!
    },
    acquire(id:string,binding:ApiSessionBinding):ApiSession{
      validBinding(binding)
      db.transaction(()=>{
        verifyTask(binding)
        const result=db.query("UPDATE workbench_api_sessions SET state='active',revision=revision+1,updated_at=? WHERE id=? AND state='ready' AND task_id=? AND owner=? AND path=? AND directory_identity=? AND config_hash=?").run(Date.now(),id,binding.taskId,binding.owner,binding.path,binding.directoryIdentity,binding.configHash)
        if(result.changes!==1)throw Error('api_session_conflict')
      })()
      return get(id)!
    },
    save(id:string,revision:number,messages:ChatMessage[],state:ApiSessionState):ApiSession{
      checkSave(revision,state)
      const json=encode(messages)
      db.transaction(()=>{
        const current=raw(id);if(!current)throw Error('api_session_conflict')
        const binding={taskId:current.taskId,owner:current.owner,path:current.path,directoryIdentity:current.directoryIdentity,configHash:current.configHash}
        verifyTask(binding)
        const result=db.query('UPDATE workbench_api_sessions SET messages_json=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND state=\'active\' AND revision=?').run(json,state,Date.now(),id,revision)
        if(result.changes!==1)throw Error('api_session_conflict')
      })()
      return get(id)!
    },
    canResume(id:string,path:string,directoryIdentity:string,configHash:string):boolean{
      try{
        const found=get(id);if(!found||found.state!=='ready'||found.binding.path!==path||found.binding.directoryIdentity!==directoryIdentity||found.binding.configHash!==configHash)return false
        verifyTask(found.binding);return true
      }catch{return false}
    },
    get,
  }
}

export function makeChatSessionStore(db:Db):ChatSessionStore{
  const raw=(id:string)=>db.query<ChatRow,[string]>(CHAT_SELECT).get(id)
  const get=(id:string):ChatSession|null=>{const row=raw(id);return row?chatSession(row):null}
  return{
    create(binding,messages){
      validChatBinding(binding);const json=encode(messages),id=randomUUID(),now=Date.now()
      db.transaction(()=>{
        // 同一个对话 + 项目只留正在用的那一份(一个文件夹一个活会话);过了续接期限的(含崩溃留下的 active)顺手清掉。
        db.query("DELETE FROM openai_chat_sessions WHERE (state!='active' AND chat_id=? AND alias=?) OR updated_at<?").run(binding.chatId,binding.alias,now-CHAT_KEEP_MS)
        db.query('INSERT INTO openai_chat_sessions(id,chat_id,alias,path,config_hash,revision,messages_json,state,created_at,updated_at) VALUES(?,?,?,?,?,0,?,\'active\',?,?)').run(id,binding.chatId,binding.alias,binding.path,binding.configHash,json,now,now)
      })()
      return get(id)!
    },
    acquire(id,binding){
      validChatBinding(binding)
      const result=db.query("UPDATE openai_chat_sessions SET state='active',revision=revision+1,updated_at=? WHERE id=? AND state='ready' AND chat_id=? AND alias=? AND path=? AND config_hash=?").run(Date.now(),id,binding.chatId,binding.alias,binding.path,binding.configHash)
      if(result.changes!==1)throw Error('api_session_conflict')
      return get(id)!
    },
    save(id,revision,messages,state){
      checkSave(revision,state)
      const json=encode(messages)
      const result=db.query('UPDATE openai_chat_sessions SET messages_json=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND state=\'active\' AND revision=?').run(json,state,Date.now(),id,revision)
      if(result.changes!==1)throw Error('api_session_conflict')
      return get(id)!
    },
    canResume(id,path,configHash){
      try{
        const row=db.query<{state:string;path:string;configHash:string;bytes:number},[string]>('SELECT state,path,config_hash AS configHash,length(CAST(messages_json AS BLOB)) AS bytes FROM openai_chat_sessions WHERE id=?').get(id)
        return !!row&&row.state==='ready'&&row.path===path&&row.configHash===configHash&&row.bytes<=CHAT_RESUME_MAX_BYTES
      }catch{return false}
    },
    get,
  }
}

/**
 * 没有 DB 的地方(委派的光杆 peer、测试):什么都不留 —— 历史只在那条会话自己的内存里(委派每次 spawn 一条,
 * 留在这里就是一直涨的内存),不续接。
 */
export function makeMemoryChatSessionStore():ChatSessionStore{
  const gone=()=>{throw Error('api_session_conflict')}
  return{
    ephemeral:true,
    create(binding,messages){validChatBinding(binding);return{id:randomUUID(),revision:0,messages:[...messages],state:'active',binding:{...binding}}},
    acquire:gone,
    save:gone,
    canResume:()=>false,
    get:()=>null,
  }
}

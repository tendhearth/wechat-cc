import {randomUUID} from 'node:crypto'
import type {Db} from '../../lib/db'
import type {ChatMessage} from './api-model'

export interface ApiSessionBinding{taskId:string;owner:string;path:string;directoryIdentity:string;configHash:string}
export interface ApiSession{id:string;revision:number;messages:ChatMessage[];state:'active'|'ready'|'interrupted';binding:ApiSessionBinding}

const MAX_MESSAGES=10_000,MAX_BYTES=16*1024*1024
const SELECT=`SELECT id,revision,messages_json AS messagesJson,state,task_id AS taskId,owner,path,directory_identity AS directoryIdentity,config_hash AS configHash FROM workbench_api_sessions WHERE id=?`
type Row={id:string;revision:number;messagesJson:string;state:string;taskId:string;owner:string;path:string;directoryIdentity:string;configHash:string}

export {initializeApiSessionSchema} from '../../lib/db'

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
function validBinding(binding:ApiSessionBinding):void{
  if(!binding||![binding.taskId,binding.owner,binding.path,binding.directoryIdentity,binding.configHash].every(value=>typeof value==='string'&&value.length>0&&value.length<=4096))throw Error('api_session_binding')
}
function session(row:Row):ApiSession{
  if(!Number.isSafeInteger(row.revision)||row.revision<0||!['active','ready','interrupted'].includes(row.state))throw Error('invalid_api_session')
  return{id:row.id,revision:row.revision,messages:decode(row.messagesJson),state:row.state as ApiSession['state'],binding:{taskId:row.taskId,owner:row.owner,path:row.path,directoryIdentity:row.directoryIdentity,configHash:row.configHash}}
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
    save(id:string,revision:number,messages:ChatMessage[],state:'active'|'ready'|'interrupted'):ApiSession{
      if(!Number.isSafeInteger(revision)||revision<0||!['active','ready','interrupted'].includes(state))throw Error('api_session_conflict')
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

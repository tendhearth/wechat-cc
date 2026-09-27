import {randomBytes} from 'node:crypto'
import type {Db} from '../../lib/db'

/**
 * matters/store.ts — "一件事"(matter)的存储面。
 *
 * 主人心里的一件事:一个工作台任务、一段闲聊、一次陪伴事件。它跨表面(微信 / 桌面 /
 * 手机 / 终端,`matter_bindings`)、跨供应商会话(`matter_sessions`)。事件本身仍在各自的
 * 表里(workbench_events / messages),这里只是把它们归到同一件事名下。
 * 设计:docs/cc-workbench.md「一件事」(2026-09-16);迁移 v60。
 */
export type MatterKind='chat'|'task'|'companion'
export type MatterStatus='open'|'replied'|'done'|'archived'
export type MatterSurface='wechat'|'desktop'|'phone'|'cli'
export type MatterSessionRole='main'|'review'|'handoff'
export interface Matter {id:string;kind:MatterKind;title:string;projectPath:string|null;status:MatterStatus;ownerChatId:string|null;originMatterId:string|null;originMessageId:string|null;createdAt:number;updatedAt:number}
export interface MatterBinding {matterId:string;surface:MatterSurface;surfaceKey:string;lastSeenAt:number}
export interface MatterSession {matterId:string;providerId:string;sessionId:string;role:MatterSessionRole;createdAt:number}
export interface CreateMatter {id?:string;kind:MatterKind;title:string;projectPath?:string|null;ownerChatId?:string|null;status?:MatterStatus;originMatterId?:string|null;originMessageId?:string|null}
export interface ListMatters {kind?:MatterKind;statuses?:MatterStatus[];since?:number;limit?:number;/** 只要在这个表面露过面的 */surface?:MatterSurface}

const KINDS=new Set<string>(['chat','task','companion']),STATUSES=new Set<string>(['open','replied','done','archived']),SURFACES=new Set<string>(['wechat','desktop','phone','cli']),ROLES=new Set<string>(['main','review','handoff'])
const ID=/^[a-f0-9]{8}$/
type Row={id:string;kind:MatterKind;title:string;project_path:string|null;status:MatterStatus;owner_chat_id:string|null;origin_matter_id:string|null;origin_message_id:string|null;created_at:number;updated_at:number}
const SELECT='SELECT id,kind,title,project_path,status,owner_chat_id,origin_matter_id,origin_message_id,created_at,updated_at FROM matters'
const toMatter=(r:Row):Matter=>({id:r.id,kind:r.kind,title:r.title,projectPath:r.project_path,status:r.status,ownerChatId:r.owner_chat_id,originMatterId:r.origin_matter_id,originMessageId:r.origin_message_id,createdAt:r.created_at,updatedAt:r.updated_at})

export interface MatterStore {
  create(input:CreateMatter):Matter
  get(id:string):Matter|null
  list(filter?:ListMatters):Matter[]
  setStatus(id:string,status:MatterStatus):void
  rename(id:string,title:string):void
  touch(id:string):void
  bind(id:string,surface:MatterSurface,surfaceKey:string):void
  bindings(id:string):MatterBinding[]
  findBySurface(surface:MatterSurface,surfaceKey:string):Matter|null
  addSession(id:string,providerId:string,sessionId:string,role:MatterSessionRole):void
  sessions(id:string):MatterSession[]
  /** 一个微信 chat 对应一条 kind='chat' 的 matter:有就刷新露面时间,没有就建。 */
  ensureChat(chatId:string,title?:string):Matter
  /** 工作台任务与 matter 一对一、id 相同:把 workbench_tasks.matter_id 补上(新任务;存量靠 v60 回填)。 */
  linkTask(taskId:string):void
}

export function makeMatterStore(db:Db,now:()=>number=()=>Date.now()):MatterStore {
  const require=(id:string):Matter=>{const m=get(id);if(!m)throw new Error('matter_not_found');return m}
  const get=(id:string):Matter|null=>{const r=db.query<Row,[string]>(SELECT+' WHERE id=?').get(id);return r?toMatter(r):null}
  function create(input:CreateMatter):Matter {
    if(!KINDS.has(input.kind))throw new Error('invalid_matter_kind')
    const status=input.status??'open';if(!STATUSES.has(status))throw new Error('invalid_matter_status')
    if(typeof input.title!=='string')throw new Error('invalid_matter_title')
    const id=input.id??randomBytes(4).toString('hex');if(!ID.test(id))throw new Error('invalid_matter_id')
    const ts=now()
    db.query('INSERT INTO matters(id,kind,title,project_path,status,owner_chat_id,origin_matter_id,origin_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,input.kind,input.title,input.projectPath??null,status,input.ownerChatId??null,input.originMatterId??null,input.originMessageId??null,ts,ts)
    return require(id)
  }
  function list(filter:ListMatters={}):Matter[] {
    const where:string[]=[],params:(string|number)[]=[]
    if(filter.kind){if(!KINDS.has(filter.kind))throw new Error('invalid_matter_kind');where.push('kind=?');params.push(filter.kind)}
    if(filter.statuses?.length){for(const s of filter.statuses)if(!STATUSES.has(s))throw new Error('invalid_matter_status');where.push(`status IN (${filter.statuses.map(()=>'?').join(',')})`);params.push(...filter.statuses)}
    if(filter.since!==undefined){where.push('updated_at>=?');params.push(filter.since)}
    if(filter.surface){if(!SURFACES.has(filter.surface))throw new Error('invalid_matter_surface');where.push('id IN (SELECT matter_id FROM matter_bindings WHERE surface=?)');params.push(filter.surface)}
    const limit=Math.min(Math.max(1,filter.limit??100),500)
    return db.query<Row,(string|number)[]>(`${SELECT}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY updated_at DESC, id LIMIT ${limit}`).all(...params).map(toMatter)
  }
  const bump=(id:string)=>db.query('UPDATE matters SET updated_at=? WHERE id=?').run(now(),id)
  return {
    create,get,list,
    setStatus(id,status){if(!STATUSES.has(status))throw new Error('invalid_matter_status');require(id);db.query('UPDATE matters SET status=?,updated_at=? WHERE id=?').run(status,now(),id)},
    rename(id,title){require(id);db.query('UPDATE matters SET title=?,updated_at=? WHERE id=?').run(title,now(),id)},
    touch(id){require(id);bump(id)},
    bind(id,surface,surfaceKey){
      if(!SURFACES.has(surface))throw new Error('invalid_matter_surface');require(id)
      db.query('INSERT INTO matter_bindings(matter_id,surface,surface_key,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(matter_id,surface,surface_key) DO UPDATE SET last_seen_at=excluded.last_seen_at').run(id,surface,surfaceKey,now())
    },
    bindings:id=>db.query<{matter_id:string;surface:MatterSurface;surface_key:string;last_seen_at:number},[string]>('SELECT matter_id,surface,surface_key,last_seen_at FROM matter_bindings WHERE matter_id=? ORDER BY last_seen_at DESC, surface, surface_key').all(id).map(b=>({matterId:b.matter_id,surface:b.surface,surfaceKey:b.surface_key,lastSeenAt:b.last_seen_at})),
    findBySurface(surface,surfaceKey){
      const r=db.query<Row,[string,string]>(`${SELECT} WHERE id IN (SELECT matter_id FROM matter_bindings WHERE surface=? AND surface_key=?) ORDER BY updated_at DESC LIMIT 1`).get(surface,surfaceKey)
      return r?toMatter(r):null
    },
    addSession(id,providerId,sessionId,role){
      if(!ROLES.has(role))throw new Error('invalid_matter_session_role');require(id)
      db.query('INSERT OR IGNORE INTO matter_sessions(matter_id,provider_id,session_id,role,created_at) VALUES(?,?,?,?,?)').run(id,providerId,sessionId,role,now())
    },
    sessions:id=>db.query<{matter_id:string;provider_id:string;session_id:string;role:MatterSessionRole;created_at:number},[string]>('SELECT matter_id,provider_id,session_id,role,created_at FROM matter_sessions WHERE matter_id=? ORDER BY created_at, provider_id, session_id').all(id).map(s=>({matterId:s.matter_id,providerId:s.provider_id,sessionId:s.session_id,role:s.role,createdAt:s.created_at})),
    linkTask(taskId){require(taskId);db.query('UPDATE workbench_tasks SET matter_id=? WHERE id=? AND matter_id IS NULL').run(taskId,taskId)},
    ensureChat(chatId,title){
      const existing=db.query<Row,[string]>(`${SELECT} WHERE kind='chat' AND id IN (SELECT matter_id FROM matter_bindings WHERE surface='wechat' AND surface_key=?) ORDER BY updated_at DESC LIMIT 1`).get(chatId)
      const matter=existing?toMatter(existing):create({kind:'chat',title:title??'聊天',ownerChatId:chatId})
      db.query('INSERT INTO matter_bindings(matter_id,surface,surface_key,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(matter_id,surface,surface_key) DO UPDATE SET last_seen_at=excluded.last_seen_at').run(matter.id,'wechat',chatId,now())
      return matter
    },
  }
}

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
/**
 * 一件事从哪个表面来的(v77,2026-10-19):创建时写一次,此后永不更新(库里有触发器拦着)。
 * 与 MatterSurface(在哪露过面,matter_bindings)不是一回事:app = 原生手机 App(中继 v2 密封帧),
 * web = 浏览器 /m 页(局域网直连或 v1 隧道),cli = 从终端会话导入,companion = CC 自己起的。
 * 不知道 ⇒ 不写(null),界面就不画 —— 旧行一律 null,不回填、不猜。
 */
export type MatterOrigin='wechat'|'desktop'|'app'|'web'|'cli'|'companion'
export const MATTER_ORIGINS:readonly MatterOrigin[]=Object.freeze(['wechat','desktop','app','web','cli','companion'])
export interface Matter {id:string;kind:MatterKind;title:string;projectPath:string|null;status:MatterStatus;ownerChatId:string|null;originMatterId:string|null;originMessageId:string|null;createdAt:number;updatedAt:number;/** 出生地(只在知道时带)。 */origin?:MatterOrigin;/** 参与过这件事的执行者(列表才带):正在做的在前,其余按最近 —— 手机/桌面画成叠在一起的圆头像。 */agents?:string[];/** 执行者 id → 正式名字(收敛清单 ⑥):服务层按 registry 填,三端不存名字表。 */agentNames?:Record<string,string>}
export interface MatterBinding {matterId:string;surface:MatterSurface;surfaceKey:string;lastSeenAt:number}
export interface MatterSession {matterId:string;providerId:string;sessionId:string;role:MatterSessionRole;createdAt:number}
export interface CreateMatter {id?:string;kind:MatterKind;title:string;projectPath?:string|null;ownerChatId?:string|null;status?:MatterStatus;originMatterId?:string|null;originMessageId?:string|null;/** 出生地:只在建行时写这一次;不知道就别给(null)。 */origin?:MatterOrigin|null}
export interface ListMatters {kind?:MatterKind;statuses?:MatterStatus[];since?:number;limit?:number;/** 只要在这个表面露过面的 */surface?:MatterSurface}

const ORIGINS=new Set<string>(MATTER_ORIGINS)
const KINDS=new Set<string>(['chat','task','companion']),STATUSES=new Set<string>(['open','replied','done','archived']),SURFACES=new Set<string>(['wechat','desktop','phone','cli']),ROLES=new Set<string>(['main','review','handoff'])
const ID=/^[a-f0-9]{8}$/
type Row={id:string;kind:MatterKind;title:string;project_path:string|null;status:MatterStatus;owner_chat_id:string|null;origin_matter_id:string|null;origin_message_id:string|null;origin_surface:string|null;created_at:number;updated_at:number}
const SELECT='SELECT id,kind,title,project_path,status,owner_chat_id,origin_matter_id,origin_message_id,origin_surface,created_at,updated_at FROM matters'
/** 库里读出来的出生地也要在册才认(手改过库 / 未来的新值 ⇒ 当没有,不画)。 */
export const matterOrigin=(value:unknown):MatterOrigin|null=>typeof value==='string'&&ORIGINS.has(value)?value as MatterOrigin:null
const toMatter=(r:Row):Matter=>{const origin=matterOrigin(r.origin_surface);return {id:r.id,kind:r.kind,title:r.title,projectPath:r.project_path,status:r.status,ownerChatId:r.owner_chat_id,originMatterId:r.origin_matter_id,originMessageId:r.origin_message_id,createdAt:r.created_at,updatedAt:r.updated_at,...(origin?{origin}:{})}}

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
  /** ensureChat 的只读半边:只查这个微信 chat 的 kind='chat' matter,不建、不刷新露面时间(读路径用)。 */
  findChat(chatId:string):Matter|null
  /** 一个微信 chat 对应一条 kind='chat' 的 matter:有就刷新露面时间,没有就建(origin 只在这次建行时写)。 */
  ensureChat(chatId:string,title?:string,origin?:MatterOrigin|null):Matter
  /** 工作台任务与 matter 一对一、id 相同:把 workbench_tasks.matter_id 补上(新任务;存量靠 v60 回填)。 */
  linkTask(taskId:string):void
  /** 每件事有哪些执行者参与过(2026-10-19 头像叠):任务本身的执行者在前,再按最近的审阅 / 返工交接、会话。没有的 id 不出现。 */
  agents(ids:string[]):Map<string,string[]>
  /** 一页里每件事的出生地(工作台列表一次查完);不知道的 id 不出现。 */
  origins(ids:string[]):Map<string,MatterOrigin>
}

export function makeMatterStore(db:Db,now:()=>number=()=>Date.now()):MatterStore {
  const require=(id:string):Matter=>{const m=get(id);if(!m)throw new Error('matter_not_found');return m}
  const get=(id:string):Matter|null=>{const r=db.query<Row,[string]>(SELECT+' WHERE id=?').get(id);return r?toMatter(r):null}
  function create(input:CreateMatter):Matter {
    if(!KINDS.has(input.kind))throw new Error('invalid_matter_kind')
    const status=input.status??'open';if(!STATUSES.has(status))throw new Error('invalid_matter_status')
    if(typeof input.title!=='string')throw new Error('invalid_matter_title')
    const id=input.id??randomBytes(4).toString('hex');if(!ID.test(id))throw new Error('invalid_matter_id')
    const origin=input.origin??null;if(origin!==null&&!ORIGINS.has(origin))throw new Error('invalid_matter_origin')
    const ts=now()
    db.query('INSERT INTO matters(id,kind,title,project_path,status,owner_chat_id,origin_matter_id,origin_message_id,origin_surface,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,input.kind,input.title,input.projectPath??null,status,input.ownerChatId??null,input.originMatterId??null,input.originMessageId??null,origin,ts,ts)
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
  const findChat=(chatId:string):Matter|null=>{
    const r=db.query<Row,[string]>(`${SELECT} WHERE kind='chat' AND id IN (SELECT matter_id FROM matter_bindings WHERE surface='wechat' AND surface_key=?) ORDER BY updated_at DESC LIMIT 1`).get(chatId)
    return r?toMatter(r):null
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
    agents(ids){
      const out=new Map<string,string[]>()
      const want=[...new Set(ids.filter(id=>ID.test(id)))]
      if(!want.length)return out
      const marks=want.map(()=>'?').join(',')
      // 一条一条往里放:先放的排前;同一家只记一次。
      const add=(id:string,provider:string)=>{const list=out.get(id)??[];if(provider&&!list.includes(provider))list.push(provider);out.set(id,list)}
      const rows=<T,>(sql:string,params:string[]):T[]=>{try{return db.query<T,string[]>(sql).all(...params)}catch{return[]}}
      for(const r of rows<{mid:string;provider_id:string}>(`SELECT COALESCE(matter_id,id) AS mid,provider_id FROM workbench_tasks WHERE id IN (${marks}) OR matter_id IN (${marks})`,[...want,...want]))add(r.mid,r.provider_id)
      // 审阅 / 返工:两头的任务互相算参与者(谁交给谁都一样),新的在前
      const peers=rows<{mid:string;provider_id:string;at:number}>(
        `SELECT h.source_task_id AS mid,t.provider_id,h.created_at AS at FROM workbench_handoffs h JOIN workbench_tasks t ON t.id=h.target_task_id WHERE h.source_task_id IN (${marks})
         UNION ALL SELECT h.target_task_id AS mid,t.provider_id,h.created_at AS at FROM workbench_handoffs h JOIN workbench_tasks t ON t.id=h.source_task_id WHERE h.target_task_id IN (${marks})
         UNION ALL SELECT matter_id AS mid,provider_id,created_at AS at FROM matter_sessions WHERE matter_id IN (${marks})`,[...want,...want,...want])
      for(const r of peers.sort((a,b)=>b.at-a.at))add(r.mid,r.provider_id)
      return out
    },
    origins(ids){
      const out=new Map<string,MatterOrigin>()
      const want=[...new Set(ids.filter(id=>ID.test(id)))]
      if(!want.length)return out
      for(const r of db.query<{id:string;origin_surface:string|null},string[]>(`SELECT id,origin_surface FROM matters WHERE origin_surface IS NOT NULL AND id IN (${want.map(()=>'?').join(',')})`).all(...want)){
        const origin=matterOrigin(r.origin_surface);if(origin)out.set(r.id,origin)
      }
      return out
    },
    linkTask(taskId){require(taskId);db.query('UPDATE workbench_tasks SET matter_id=? WHERE id=? AND matter_id IS NULL').run(taskId,taskId)},
    findChat,
    ensureChat(chatId,title,origin){
      const matter=findChat(chatId)??create({kind:'chat',title:title??'聊天',ownerChatId:chatId,origin:origin??null})
      db.query('INSERT INTO matter_bindings(matter_id,surface,surface_key,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(matter_id,surface,surface_key) DO UPDATE SET last_seen_at=excluded.last_seen_at').run(matter.id,'wechat',chatId,now())
      return matter
    },
  }
}

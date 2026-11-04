import {randomBytes} from 'node:crypto'
import type {Db} from '../../lib/db'
import {hintWrite} from '../../lib/write-hints'
import type {CreateMatter,ListMatters,Matter,MatterBinding,MatterKind,MatterOrigin,MatterSession,MatterSessionRole,MatterState,MatterStore,MatterSurface,MatterTurnStatus} from '../../ports/matters'
import {legacyStatus,type LegacyTaskStatus} from '../../domain/matters/legacy-status'

/**
 * matters/store.ts — "一件事"(matter)的存储面。
 *
 * 主人心里的一件事:一个工作台任务、一段闲聊、一次陪伴事件。它跨表面(微信 / 桌面 /
 * 手机 / 终端,`matter_bindings`)、跨供应商会话(`matter_sessions`)。事件本身仍在各自的
 * 表里(一起做的时间线在 matter_items,经 MatterLog 写;对话正文在 messages),这里只是把它们归到同一件事名下。
 * 设计:docs/cc-workbench.md「一件事」(2026-09-16);迁移 v60。
 */
export const MATTER_ORIGINS:readonly MatterOrigin[]=Object.freeze(['wechat','desktop','app','web','cli','companion'])

const ORIGINS=new Set<string>(MATTER_ORIGINS)
const KINDS=new Set<string>(['chat','task','terminal','act']),INITIATORS=new Set<string>(['owner','cc','peer']),STATUSES=new Set<string>(['open','replied','done','archived']),SURFACES=new Set<string>(['wechat','desktop','phone','cli']),ROLES=new Set<string>(['main','review','handoff'])
const ID=/^[a-f0-9]{8}$/
type Row={id:string;kind:MatterKind;title:string;project_path:string|null;state:MatterState;archived_at:number|null;latest_turn:MatterTurnStatus|null;task_status:LegacyTaskStatus|null;stored_replied:number;owner_chat_id:string|null;origin_matter_id:string|null;origin_message_id:string|null;origin_surface:string|null;created_at:number;updated_at:number}
/**
 * 读这一侧(M6b):旧 status 列只再读「是不是 replied」这一位(settleQuiet 的「答完了、闲着」没别处落库),其余由 legacyStatus 从统一状态 + 归档 + 最近一轮(+ 任务自己的状态)现算。
 * 列表的 `statuses` 筛选要在 SQL 里做(LIMIT 之前),所以同一个式子这里有一份 SQL 版本 —— matters-store.test.ts 逐格对过 legacyStatus。
 */
const DERIVED=`SELECT m.*,
  (SELECT t.status FROM matter_turns t WHERE t.matter_id=m.id ORDER BY t.seq DESC LIMIT 1) AS latest_turn,
  (SELECT w.status FROM workbench_tasks w WHERE w.id=m.id) AS task_status,
  (m.status='replied') AS stored_replied FROM matters m`
export const LEGACY_STATUS_SQL=`CASE WHEN archived_at IS NOT NULL THEN 'archived'
  WHEN kind<>'task' THEN 'open'
  WHEN task_status IS NULL THEN CASE WHEN state IN ('done','failed','cancelled') THEN 'done' WHEN stored_replied AND state='open' AND latest_turn='completed' THEN 'replied' ELSE 'open' END
  WHEN task_status='interrupted' THEN 'open'
  WHEN task_status IN ('completed','failed','cancelled') THEN 'done'
  WHEN task_status='running' AND stored_replied AND state='open' AND latest_turn='completed' THEN 'replied'
  ELSE 'open' END`
const SELECT=`SELECT id,kind,title,project_path,state,archived_at,latest_turn,task_status,stored_replied,owner_chat_id,origin_matter_id,origin_message_id,origin_surface,created_at,updated_at FROM (SELECT d.*,${LEGACY_STATUS_SQL} AS legacy_status FROM (${DERIVED}) d)`
/** 库里读出来的出生地也要在册才认(手改过库 / 未来的新值 ⇒ 当没有,不画)。 */
export const matterOrigin=(value:unknown):MatterOrigin|null=>typeof value==='string'&&ORIGINS.has(value)?value as MatterOrigin:null
const toMatter=(r:Row):Matter=>{const origin=matterOrigin(r.origin_surface);return {id:r.id,kind:r.kind,title:r.title,projectPath:r.project_path,status:legacyStatus({kind:r.kind,state:r.state,archivedAt:r.archived_at,latestTurn:r.latest_turn,taskStatus:r.task_status,storedReplied:!!r.stored_replied}),state:r.state,archivedAt:r.archived_at,ownerChatId:r.owner_chat_id,originMatterId:r.origin_matter_id,originMessageId:r.origin_message_id,createdAt:r.created_at,updatedAt:r.updated_at,...(origin?{origin}:{})}}

export function makeMatterStore(db:Db,now:()=>number=()=>Date.now()):MatterStore {
  const require=(id:string):Matter=>{const m=get(id);if(!m)throw new Error('matter_not_found');return m}
  const get=(id:string):Matter|null=>{const r=db.query<Row,[string]>(SELECT+' WHERE id=?').get(id);return r?toMatter(r):null}
  function create(input:CreateMatter):Matter {
    if(!KINDS.has(input.kind))throw new Error('invalid_matter_kind')
    const status=input.status??'open';if(!STATUSES.has(status))throw new Error('invalid_matter_status')
    if(typeof input.title!=='string')throw new Error('invalid_matter_title')
    const id=input.id??randomBytes(4).toString('hex');if(!ID.test(id))throw new Error('invalid_matter_id')
    const origin=input.origin??null;if(origin!==null&&!ORIGINS.has(origin))throw new Error('invalid_matter_origin')
    const initiator=input.initiator??'owner';if(!INITIATORS.has(initiator))throw new Error('invalid_matter_initiator')
    const ts=now()
    db.query('INSERT INTO matters(id,kind,initiator,title,project_path,state,archived_at,status,owner_chat_id,origin_matter_id,origin_message_id,origin_surface,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,input.kind,initiator,input.title,input.projectPath??null,status==='done'?'done':'open',status==='archived'?ts:null,status,input.ownerChatId??null,input.originMatterId??null,input.originMessageId??null,origin,ts,ts)
    hinted(id)
    return require(id)
  }
  function list(filter:ListMatters={}):Matter[] {
    const where:string[]=[],params:(string|number)[]=[]
    if(filter.kind){if(!KINDS.has(filter.kind))throw new Error('invalid_matter_kind');where.push('kind=?');params.push(filter.kind)}
    if(filter.statuses?.length){for(const s of filter.statuses)if(!STATUSES.has(s))throw new Error('invalid_matter_status');where.push(`legacy_status IN (${filter.statuses.map(()=>'?').join(',')})`);params.push(...filter.statuses)}
    if(filter.since!==undefined){where.push('updated_at>=?');params.push(filter.since)}
    if(filter.surface){if(!SURFACES.has(filter.surface))throw new Error('invalid_matter_surface');where.push('id IN (SELECT matter_id FROM matter_bindings WHERE surface=?)');params.push(filter.surface)}
    const limit=Math.min(Math.max(1,filter.limit??100),500)
    return db.query<Row,(string|number)[]>(`${SELECT}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY updated_at DESC, id LIMIT ${limit}`).all(...params).map(toMatter)
  }
  const findChat=(chatId:string):Matter|null=>{
    const r=db.query<Row,[string]>(`${SELECT} WHERE kind='chat' AND id IN (SELECT matter_id FROM matter_bindings WHERE surface='wechat' AND surface_key=?) ORDER BY updated_at DESC LIMIT 1`).get(chatId)
    return r?toMatter(r):null
  }
  // matters 行自己的变化(状态 / 标题 / updated_at)不进 MatterLog 的游标:落笔后给手机主题一声提示(write-hints.ts)
  const hinted=(id:string)=>hintWrite(db,{kind:'matter',matterId:id})
  const bump=(id:string)=>{db.query('UPDATE matters SET updated_at=? WHERE id=?').run(now(),id);hinted(id)}
  return {
    create,get,list,
    setStatus(id,status){
      if(!STATUSES.has(status))throw new Error('invalid_matter_status');require(id)
      const ts=now()
      // 归档 ⇒ 记一次归档时间(已归档的不挪);其余 ⇒ 取消归档。做完 ⇒ 统一状态 done(没做成 / 停下了不改写);
      // 重新打开 ⇒ 结局清回 open。working / waiting 只有 MatterLog 知道,这里不碰。
      db.query(`UPDATE matters SET status=?1,updated_at=?2,
        archived_at=CASE WHEN ?1='archived' THEN COALESCE(archived_at,?2) ELSE NULL END,
        state=CASE WHEN ?1='done' AND state NOT IN ('failed','cancelled') THEN 'done'
                   WHEN ?1 IN ('open','replied') AND state IN ('done','failed','cancelled') THEN 'open'
                   ELSE state END
        WHERE id=?3`).run(status,ts,id)
      hinted(id)
    },
    rename(id,title){require(id);db.query('UPDATE matters SET title=?,updated_at=? WHERE id=?').run(title,now(),id);hinted(id)},
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
    findChat,
    ensureChat(chatId,title,origin){
      const matter=findChat(chatId)??create({kind:'chat',title:title??'聊天',ownerChatId:chatId,origin:origin??null})
      db.query('INSERT INTO matter_bindings(matter_id,surface,surface_key,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(matter_id,surface,surface_key) DO UPDATE SET last_seen_at=excluded.last_seen_at').run(matter.id,'wechat',chatId,now())
      return matter
    },
  }
}

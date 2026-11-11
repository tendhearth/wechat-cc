import type { Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { type MatterSeen } from '../../adapters/store/matter-seen'
import { projectActivities, projectSeen, projectActivityRevision, type ProjectActivity } from './project-activity'
import type { ProjectTaskActivitySource } from '../../ports/topic-activity'
import { makeTopicBubbles, topicMatters, topicRevision } from '../../lib/topic-bubbles'
import { topicMetadata, type TopicMetadata } from './topic-metadata'
import { TopicBubbleEntry } from '../../../packages/protocol/src/topic-bubbles'

export function topicsRevision(db: Db, owner: string): string {
  return String(db.query<{ revision: number }, [string]>('SELECT revision FROM topic_bubble_revisions WHERE chat_id=?').get(owner)?.revision ?? 0)
}
const RECENT_ORDER = "MAX(COALESCE(b.last_recalled_at,''),COALESCE(b.last_opened_by_owner_at,'')) DESC,t.id"
const FROM = 'FROM threads t LEFT JOIN topic_bubbles b ON b.thread_id=t.id WHERE t.chat_id=?'
export async function topicSummary(db: Db, owner: string, id: string, activities?: Map<string, ProjectActivity>) {
  const t = await makeThreadsStore(db).get(id)
  if (!t || t.chatId !== owner) return null
  const bubble = makeTopicBubbles(db).get(id), matters = topicMatters(db, owner, id)
  return {
    id, mergedInto: null, title: t.title.slice(0, 160), description: t.description.slice(0, 600), summary: t.summary.slice(0, 600),
    bubbleState: bubble?.state ?? 'closed' as const,
    lastRecalledAt: bubble?.last_recalled_at ?? null, lastOpenedByOwnerAt: bubble?.last_opened_by_owner_at ?? null,
    activityRevision: bubble?.activity_revision ?? 0,
    activity: { ...(activities?.get(id)?.activity ?? { running: 0, waiting: 0, unread: 0 }), lastActiveAt: Math.max(activities?.get(id)?.activity.lastActiveAt ?? 0,Date.parse(t.lastActive)||0)||null },
    matterSummary: { waiting: matters.filter(m => m.archived_at === null && m.state === 'waiting').length, running: matters.filter(m => m.archived_at === null && m.state === 'working').length, total: matters.length },
  }
}
/** Hub/list reads metadata in batches; unchanged pushes and pages reuse this snapshot. */
type TopicsPage = { view: 'recent' | 'all'; offset: number; limit: number; q?: string }
async function buildProjection(db:Db,owner:string,activities:Map<string,ProjectActivity>,baseRevision:string,metadata:TopicMetadata) {
  const links=metadata.links
  const all=[...metadata.topics.values()].map(t=>{
      const activity=activities.get(t.id)?.activity
      return {id:t.id,mergedInto:null,title:t.title.slice(0,160),description:t.description.slice(0,600),summary:t.summary.slice(0,600),bubbleState:t.bubbleState,
        lastRecalledAt:t.lastRecalledAt,lastOpenedByOwnerAt:t.lastOpenedByOwnerAt,activityRevision:t.activityRevision,
        activity:{running:activity?.running??0,waiting:activity?.waiting??0,unread:activity?.unread??0,lastActiveAt:Math.max(activity?.lastActiveAt??0,Date.parse(t.lastActive)||0)||null},
        matterSummary:metadata.counts.get(t.id)??{waiting:0,running:0,total:0}}
    })
  const at=(t:typeof all[number])=>Math.max(t.activity.lastActiveAt??0,Date.parse(t.lastRecalledAt??'')||0,Date.parse(t.lastOpenedByOwnerAt??'')||0)
  all.sort((a,b)=>Number(b.activity.waiting>0)-Number(a.activity.waiting>0)||Number(b.activity.running>0)-Number(a.activity.running>0)||at(b)-at(a)||a.id.localeCompare(b.id))
  const recentIds=all.slice(0,8).map(t=>t.id),openIds=all.filter(t=>t.bubbleState==='open').map(t=>t.id).sort()
  // Session digests are computed once per changed project, never again for pagination.
  const revision=topicRevision([baseRevision,all,[...metadata.linkRevisions],[...activities].map(([id,a])=>[id,projectActivityRevision(a)])])
  const pageOf=(p:TopicsPage)=>{
    const filtered=p.view==='recent'?all.slice(0,8):p.q?all.filter(t=>`${t.title}\n${t.description}\n${t.summary}`.toLocaleLowerCase().includes(p.q!.toLocaleLowerCase())):all
    return {topics:filtered.slice(p.offset,p.offset+p.limit),total:filtered.length}
  }
  const matterRows=new Map<string,Array<{id:string;kind:string;detailRoute:string;title:string;state:string;archivedAt:number|null;session?:import('../../../packages/protocol/src/topic-bubbles').TopicSessionT}>>()
  return {revision,pageOf,all,byId:new Map(all.map(t=>[t.id,t])),activities,links,matterRows,
    summary:{revision,recentIds,openIds:openIds.slice(0,64),hasMoreOpen:openIds.length>64}}
}
type Projection=Awaited<ReturnType<typeof buildProjection>>
const projections=new WeakMap<Map<string,ProjectActivity>,{owner:string;revision:string;metadata:TopicMetadata;value:Promise<Projection>}>()
export async function topicsProjection(db:Db,owner:string,page?:TopicsPage,seen:MatterSeen=projectSeen(db),taskActivity?:ProjectTaskActivitySource,executorName?:(id:string)=>string) {
  const activities=await projectActivities(db,owner,seen,undefined,taskActivity,executorName),metadata=topicMetadata(db,owner),revision=topicsRevision(db,owner)
  let cached=projections.get(activities)
  if(!cached||cached.owner!==owner||cached.revision!==revision||cached.metadata!==metadata){cached={owner,revision,metadata,value:buildProjection(db,owner,activities,revision,metadata)};projections.set(activities,cached)}
  const snapshot=await cached.value
  return {...snapshot,...(page?snapshot.pageOf(page):{topics:[],total:0})}
}
export type TopicSection = 'entries' | 'matters' | 'messages'
export async function topicDetailPage(db: Db, owner: string, id: string, offsets: Record<TopicSection, number>, limits: Record<TopicSection, number>, seen: MatterSeen = projectSeen(db), snapshot?: Awaited<ReturnType<typeof topicsProjection>>) {
  snapshot??=await topicsProjection(db,owner,undefined,seen)
  const activities=snapshot.activities
  const topic=snapshot.byId.get(id)
  if (!topic) return null
  const store = makeThreadsStore(db), t = (await store.get(id))!
  const ref = db.query<{ entry_ids: string }, [string, string]>('SELECT entry_ids FROM topic_recall_refs WHERE thread_id=? AND chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id, owner)
  const recalled = ref?.entry_ids ?? '[]'
  const entries = db.query<Record<string, unknown>, [string, string, number, number]>(`SELECT id,thread_id AS threadId,kind,line,body,due,status,source,matter_id AS matterId,superseded_by AS supersededBy,created_ts AS createdTs,updated_ts AS updatedTs,
    id IN (SELECT value FROM json_each(?1)) AS recalled FROM topic_entries WHERE thread_id=?2 AND status='live'
    ORDER BY kind='commitment' DESC,recalled DESC,updated_ts DESC,id LIMIT ?3 OFFSET ?4`).all(recalled, id, limits.entries, offsets.entries)
    .map(e => TopicBubbleEntry.parse({ ...e, recalled: !!e.recalled }))
  let allMatters=snapshot.matterRows.get(id)
  if(!allMatters){
    const linkedMatters=[...(snapshot.links.get(id)?.values()??[])].map(m=>({id:m.id,kind:m.kind,detailRoute:`/v1/matter?id=${encodeURIComponent(m.id)}`,title:m.title.slice(0,160),state:m.state,archivedAt:m.archived_at}))
      .sort((a,b)=>Number(b.state==='waiting')-Number(a.state==='waiting')||Number(b.state==='working')-Number(a.state==='working')||a.id.localeCompare(b.id))
    const sessions=activities.get(id)?.sessions??[],sessionIds=new Set(sessions.map(s=>s.id))
    allMatters=[...sessions.map(session=>({id:session.id,kind:session.kind,detailRoute:`/v1/matter?id=${encodeURIComponent(session.id)}`,title:session.title,state:session.activity,archivedAt:null,session})),...linkedMatters.filter(m=>!sessionIds.has(m.id))]
    snapshot.matterRows.set(id,allMatters)
  }
  const related = `FROM messages m WHERE m.chat_id=?1 AND (
    EXISTS(SELECT 1 FROM topic_recall_refs r,json_each(r.message_ids) j WHERE r.chat_id=?1 AND r.thread_id=?2 AND j.value=m.id)
    OR EXISTS(SELECT 1 FROM json_each(?3) ep WHERE m.ts>=json_extract(ep.value,'$.from_ts') AND m.ts<=json_extract(ep.value,'$.to_ts')))`
  const messages = db.query<{ id: string; ts: string; direction: string; text: string; recalled: number }, [string, string, string, number, number]>(`SELECT m.id,m.ts,m.direction,substr(m.text,1,1000) AS text,
    EXISTS(SELECT 1 FROM topic_recall_refs r,json_each(r.message_ids) j WHERE r.chat_id=?1 AND r.thread_id=?2 AND j.value=m.id) AS recalled
    ${related} ORDER BY m.ts DESC,m.id LIMIT ?4 OFFSET ?5`).all(owner, id, JSON.stringify(t.episodes), limits.messages, offsets.messages)
    .map(m => ({ id: m.id, ts: m.ts, speaker: m.direction === 'in' ? 'owner' : 'cc', excerpt: m.text.replace(/\s+/g, ' ').slice(0, 240), source: m.recalled ? 'recall' : 'episode' }))
  const totals = {
    entries: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM topic_entries WHERE thread_id=? AND status='live'").get(id)!.n,
    matters: allMatters.length,
    messages: db.query<{ n: number }, [string, string, string]>(`SELECT COUNT(*) AS n ${related}`).get(owner, id, JSON.stringify(t.episodes))!.n,
  }
  return { topic, entries, matters: allMatters.slice(offsets.matters, offsets.matters + limits.matters), messages, totals }
}

import { temporary, topicMatterAccess, readableTopicMetadata, localTopicContext } from '../../lib/topic-provenance'
/** Cached topic/link metadata. A tool step refreshes one matter, not all linked history. */
import type { Db } from '../../lib/db'
import { topicRevision, type TopicMatter } from '../../lib/topic-bubbles'
import { onWriteHint } from '../../lib/write-hints'
import { matterFeed } from '../../adapters/store/matter-feed'
export type TopicRow={id:string;title:string;description:string;summary:string;lastActive:string;bubbleState:'open'|'closed';lastRecalledAt:string|null;lastOpenedByOwnerAt:string|null;activityRevision:number}
type Links=Map<string,TopicMatter>
export type TopicMetadata={topics:Map<string,TopicRow>;links:Map<string,Links>;counts:Map<string,{waiting:number;running:number;total:number}>;linkRevisions:Map<string,string>}
const readers=new WeakMap<Db,Map<string,()=>TopicMetadata>>()
const token=(db:Db)=>db.query<{n:number;v:number},[]>('SELECT total_changes() AS n,(SELECT data_version FROM pragma_data_version) AS v').get()!
function makeReader(db:Db,owner:string) {
  let value:TopicMetadata={topics:new Map(),links:new Map(),counts:new Map(),linkRevisions:new Map()},stamp={n:-1,v:-1},full=true,allTopics=false,signal=false
  const matters=new Set<string>(),topics=new Set<string>(),reverse=new Map<string,Set<string>>()
  matterFeed(db).onChange(id=>{matters.add(id);signal=true})
  onWriteHint(db,h=>{
    if(h.kind==='matter'){matters.add(h.matterId);signal=true}
    else if(h.kind==='topics'&&h.chatId===owner){signal=true;if(h.mapping!==false)full=true;else if(h.topicId)topics.add(h.topicId);else allTopics=true}
    else if(h.kind==='messages'&&h.chatId===owner)signal=true
  })
  return ()=>{
    const current=token(db)
    if(stamp.v!==current.v||(stamp.n!==current.n&&!signal))full=true
    signal=false
    if(!full&&!allTopics&&!topics.size&&!matters.size){stamp=current;return value}
    const next:TopicMetadata={topics:full?new Map():new Map(value.topics),links:full?new Map():new Map(value.links),counts:full?new Map():new Map(value.counts),linkRevisions:full?new Map():new Map(value.linkRevisions)}
    const ids=[...matters],topicIds=[...topics]
    if(ids.length)allTopics=true
    if(full||allTopics||topicIds.length){
      const rows=db.query<TopicRow,[string,string]>(`SELECT t.id,t.title,t.description,t.summary,t.last_active AS lastActive,COALESCE(b.state,'closed') AS bubbleState,
        b.last_recalled_at AS lastRecalledAt,b.last_opened_by_owner_at AS lastOpenedByOwnerAt,COALESCE(b.activity_revision,0) AS activityRevision
        FROM threads t LEFT JOIN topic_bubbles b ON b.thread_id=t.id WHERE t.chat_id=?1 ${full||allTopics?'AND ?2 IS NOT NULL':'AND t.id IN (SELECT value FROM json_each(?2))'}`).all(owner,JSON.stringify(topicIds))
      if(allTopics)next.topics.clear()
      for(const t of rows)next.topics.delete(t.id)
      for(const t of readableTopicMetadata(db,localTopicContext(owner),rows))next.topics.set(t.id,t)
    }
    const touched=new Set<string>()
    const bucket=(id:string)=>{
      if(!touched.has(id)){next.links.set(id,new Map(next.links.get(id)));next.counts.set(id,{...(next.counts.get(id)??{waiting:0,running:0,total:0})});touched.add(id)}
      return next.links.get(id)!
    }
    const adjust=(topic:string,m:TopicMatter,delta:number)=>{
      if(m.kind==='act')return
      const c=next.counts.get(topic)!;c.total+=delta
      if(m.archived_at===null){if(m.state==='waiting')c.waiting+=delta;if(m.state==='working')c.running+=delta}
    }
    if(full)reverse.clear()
    const found=full||ids.length?db.query<TopicMatter&{topicId:string},[string,string]>(`SELECT l.thread_id AS topicId,m.id,m.title,m.state,m.archived_at,m.kind,m.project_path,m.owner_chat_id
      FROM matter_topics l JOIN matters m ON m.id=l.matter_id JOIN threads t ON t.id=l.thread_id
      WHERE t.chat_id=?1 AND m.owner_chat_id=t.chat_id AND m.kind IN ('task','terminal','act') ${full?'AND ?2 IS NOT NULL':'AND m.id IN (SELECT value FROM json_each(?2))'} ORDER BY m.id`).all(owner,JSON.stringify(ids)):[]
    const allowed=topicMatterAccess(db,localTopicContext(owner),found.map(m=>m.id)).allowed
    const incoming=new Map<string,Map<string,TopicMatter>>()
    for(const m of found.filter(m=>allowed.has(m.id)&&!temporary(m.project_path))){const links=incoming.get(m.id)??new Map();links.set(m.topicId,m);incoming.set(m.id,links)}
    for(const id of full?[...incoming.keys()]:ids){
      const before=reverse.get(id)??new Set<string>(),after=incoming.get(id)??new Map<string,TopicMatter>()
      for(const topic of new Set([...before,...after.keys()])){
        const old=next.links.get(topic)?.get(id),m=after.get(topic)
        if(JSON.stringify(old)===JSON.stringify(m))continue
        const links=bucket(topic)
        if(old){adjust(topic,old,-1);links.delete(id)}
        if(m){links.set(id,m);adjust(topic,m,1)}
      }
      if(after.size)reverse.set(id,new Set(after.keys()));else reverse.delete(id)
    }
    for(const id of touched)next.linkRevisions.set(id,topicRevision([...(next.links.get(id)?.values()??[])]))
    value=next;stamp=current;full=false;allTopics=false;topics.clear();matters.clear()
    return value
  }
}
export function topicMetadata(db:Db,owner:string):TopicMetadata {
  let owners=readers.get(db);if(!owners){owners=new Map();readers.set(db,owners)}
  let read=owners.get(owner);if(!read){read=makeReader(db,owner);owners.set(owner,read)}
  return read()
}

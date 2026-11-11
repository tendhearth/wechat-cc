import { WelcomeGate } from '../ui/WelcomeGate'
import { BusyIndicator } from '../ui/motion'
import { t } from '../i18n'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BackendError, type TopicDetailT } from '../backend/types'
import { useBackendCtx } from '../state/BackendProvider'
import { isFresh } from '../state/store'
import { useConnection, useQuery } from '../state/hooks'
import { useTopicsRevision } from '../state/useTopics'
import { useLang } from '../i18n/useLang'
import { uuid } from '../net/uuid'
import { appendTopicPage, retainTopicMatters, topicStatus } from '../view/topic-bubble'
import { rememberReference } from '../state/conversation-references'
import { TopBar } from '../ui/TopBar'
import { LinkRow } from '../ui/Rows'
import { Button } from '../ui/Button'
import { relAgo } from '../view/terminal'
import { Sheet, Expansion } from '../ui/Sheet'
import { Txt } from '../ui/Txt'
import { TextField } from '../ui/TextField'
import { componentAppearance, space } from '../ui/tokens'
import { AgentAvatar } from '../ui/AgentAvatars'
import { useTheme } from '../ui/useTheme'

export default function Topic() { return <WelcomeGate><TopicBubble /></WelcomeGate> }

export function TopicBubble() {
  const { id = '', open } = useLocalSearchParams<{ id?: string; open?: string }>()
  const router = useRouter(), { c } = useTheme(), lang = useLang(), zh = lang === 'zh-Hans'
  const { backend, store } = useBackendCtx(), conn = useConnection()
  const revoked=conn.state==='revoked'
  const enabled = conn.topics === 'v1' && conn.state === 'online'
  const matterRange=useRef({backend,id,target:0})
  if(matterRange.current.backend!==backend||matterRange.current.id!==id)matterRange.current={backend,id,target:0}
  const query = useQuery(`topic:${id}`, () => backend.topicDetail({ id }), { enabled, refreshOnMount: true })
  useTopicsRevision(enabled, query.refresh)
  const [stored, setData] = useState<TopicDetailT>()
  const dataBackend = useRef(backend)
  const data = !revoked && conn.topics === 'v1' && query.error !== 'not_found' && stored?.topic.id === id && dataBackend.current === backend ? stored : undefined
  useEffect(() => { const into=query.data?.topic.mergedInto; if(into && into!==id)router.replace({pathname:'/topic',params:{id:into,open:'1'}}) },[query.data?.topic.mergedInto,id,router])
  const folded = useRef(false)
  const [opened, setOpened] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [rangeError, setRangeError] = useState(false)
  const [editing, setEditing] = useState(false), [name, setName] = useState(''), [targets, setTargets] = useState<Array<{id:string;title:string}>>([]), [deleting, setDeleting] = useState(false)
  const edit = async (action: 'rename'|'merge'|'delete'|'wrong', input: {id:string;title?:string;into?:string}) => {
    if (!enabled || lock.current) return
    const gen=generation.current
    lock.current=true;setBusy(true)
    try { await backend.topicEdit(action,input);if(gen!==generation.current)return;if(action==='delete'||action==='merge')back();else { await query.refresh();setNote(zh?'记下了。':'Updated.') } }
    catch { setNote(zh?'结果待核对，请刷新查看。':'Check the result by refreshing.') }
    finally {lock.current=false;setBusy(false)}
  }
  const loadTargets = async () => { const gen=generation.current;const result:Array<{id:string;title:string}>=[];let cursor:string|undefined;do{const page=await backend.topics({view:'all',limit:50,cursor});result.push(...page.topics.filter(t=>t.id!==id));cursor=page.nextCursor??undefined}while(cursor);if(gen===generation.current&&dataBackend.current===backend)setTargets(result) }
  const [busy, setBusy] = useState(false)
  const generation = useRef(0), lock = useRef(false)
  useEffect(()=>{setEditing(false);setTargets([]);setDeleting(false);setName('')},[backend,id])
  const request = useRef({ id, requestId: uuid() })
  useEffect(() => {
    const gen=++generation.current, range=matterRange.current
    setRangeError(false)
    const sameBackend=dataBackend.current===backend
    dataBackend.current=backend
    if(!sameBackend)setData(undefined)
    if(revoked||['not_found','forbidden','unauthorized','revoked'].includes(query.error??'')){range.target=0;setData(undefined);return}
    if(query.error){setData(old=>sameBackend&&old?.topic.id===id?old:undefined);return}
    const initial=query.data
    if(!initial){setData(undefined);return}
    if(initial.topic.id!==id||initial.topic.mergedInto){range.target=0;setData(initial);return}
    let active=true
    void retainTopicMatters(initial,p=>backend.topicDetail(p),range.target,()=>active&&gen===generation.current&&matterRange.current===range).then(next=>{
      if(!next)return
      range.target=Math.max(range.target,next.matters.length);setData(next);setRangeError(false);setNote(null)
    }).catch(error=>{
      if(!active||gen!==generation.current)return
      if(error instanceof BackendError&&['not_found','forbidden','unauthorized','revoked'].includes(error.code)){range.target=0;setData(undefined)}
      setRangeError(true);setNote(zh?'尚未同步 · 暂时读不到，重试':'Not synced. Retry')
    })
    return()=>{active=false}
  }, [backend,id,query.data,query.error,zh,revoked])
  useEffect(() => {
    if (!enabled || open !== '1') return
    let active = true
    // Same click retries with the same request id; reading and closing never writes closed.
    if (request.current.id !== id) request.current = { id, requestId: uuid() }
    folded.current = false
    setOpened(false)
    void (async () => {
      try {
        await backend.topicOpen(id, request.current.requestId)
        // An older read may still be in flight. Only a read issued after the click's
        // receipt can establish the open state we later fold after successful sleep.
        const since = store.clock(), current = store.query(`topic:${id}`, () => backend.topicDetail({ id }))
        await current.revalidate(since)
        const read = current.get()
        if (active && isFresh(read, since) && !read.error && read.data?.topic.bubbleState === 'open') setOpened(true)
      } catch { if (active) setNote(zh ? '尚未同步' : 'Not synced') }
    })()
    return () => { active = false }
  }, [backend, store, id, open, enabled, zh])
  const more = async (section: 'entries' | 'matters' | 'messages') => {
    const cursor = data?.pages[section].nextCursor
    if (!enabled || !cursor || lock.current) return
    lock.current = true; setBusy(true); setNote(null)
    const gen = generation.current
    try {
      const next = await backend.topicDetail({ id, section, cursor, limit:20 })
      if (gen !== generation.current) return
      if (next.revision !== data?.revision) { await query.refresh(); return }
      setData(old => {
        const merged=old?appendTopicPage(old,next,section):next
        if(!merged)return old
        if(section==='matters')matterRange.current.target=Math.max(matterRange.current.target,merged.matters.length)
        return merged
      })
    } catch { setNote(zh ? '暂时读不到，重试' : 'Cannot read right now. Retry') }
    finally { lock.current = false; setBusy(false) }
  }
  const back = () => { folded.current = true; if (router.canGoBack()) router.back(); else router.replace('/') }
  useFocusEffect(useCallback(() => {
    // A background revision must not pop the matter the owner is reading above
    // this sheet. Fold only when this selection itself is focused again.
    if (opened && !folded.current && !query.error && data?.topic.bubbleState === 'closed') {
      folded.current = true
      matterRange.current.target=0
      if (router.canGoBack()) router.back(); else router.replace('/')
    }
  }, [opened, query.error, data?.topic.bubbleState, data?.revision, router]))
  const sessions=data?.matters.filter(m=>m.session)??[]
  const active=sessions.filter(m=>m.session!.activity==='waiting'||m.session!.activity==='running').sort((a,b)=>Number(a.session!.activity!=='waiting')-Number(b.session!.activity!=='waiting'))
  const rest=sessions.filter(m=>!active.includes(m))
  const sessionSection=(items:TopicDetailT['matters'],title:string)=>(
    <View><Txt accessibilityRole="header">{title}</Txt>
          {!items.length?<Txt role="small" tone="inkSoft">{zh?'这个项目还没有会话':'No sessions in this project yet'}</Txt>:null}
          {items.map(m=>{const s=m.session!,name=s.displayName||s.executor,time=relAgo(s.updatedAt,Date.now(),lang);return <View key={m.id} testID={`topic-matter-${m.id}`}>
            <Pressable testID={`topic-session-${m.id}`} accessibilityRole="button" accessibilityLabel={[s.title,name,s.latestStep,time].filter(Boolean).join(', ')} onPress={()=>{rememberReference(backend,m.id);router.push(`/matter/${encodeURIComponent(m.id)}`)}} style={({pressed})=>({flexDirection:'row',alignItems:'center',gap:space.m,minHeight:componentAppearance.matterRow.minHeight.phone,paddingVertical:space.m,opacity:pressed?0.7:1})}>
              <AgentAvatar id={s.executor} names={{[s.executor]:name}} size={componentAppearance.identity.agentSize.phone} />
              <View style={{flex:1,gap:space.xs}}><Txt role="body" content="user">{s.title}</Txt><Txt role="small" tone="inkSoft" content="user">{name} · {s.latestStep}</Txt><Txt role="caption" tone="inkSoft">{time}</Txt></View>
            </Pressable>
            {s.activity==='waiting'?<Button testID={`topic-session-respond-${m.id}`} kind="secondary" label={s.requestId?(zh?'回应':'Respond'):(zh?'查看回应':'View response')} disabled={!enabled} onPress={()=>router.push(s.kind==='task'&&s.requestId?`/matter/${encodeURIComponent(m.id)}/decide?request=${encodeURIComponent(s.requestId)}`:`/matter/${encodeURIComponent(m.id)}`)} />:null}
          </View>})}
        </View>
  )
  return <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
    <TopBar title={data?.topic.title ?? (zh ? '话题' : 'Topic')} onBack={back} />
    <ScrollView testID="topic-sheet" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
      {!data && query.loading ? <BusyIndicator testID="topic-loading" label={zh ? '正在读取' : 'Loading'} /> : null}
      {!enabled || query.error || note ? <Txt testID="topic-note" role="meta" tone="inkSoft">{query.error === 'not_found' ? (zh ? '这个话题已不可用' : 'This topic is unavailable') : note ?? (zh ? '尚未同步' : 'Not synced')}</Txt> : null}
      {query.error || rangeError ? <Button testID="topic-retry" kind="secondary" label={zh ? '暂时读不到，重试' : 'Cannot read right now. Retry'} onPress={() => void query.refresh()} /> : null}
      {data && conn.topics === 'v1' ? <>
        {active.length?sessionSection(active,zh?'这个项目的会话':'Sessions in this project'):null}
        {data.topic.description ? <Txt content="user">{data.topic.description}</Txt> : null}
        {data.topic.summary ? <Txt content="user">{data.topic.summary}</Txt> : null}
        {!active.length||rest.length?sessionSection(rest,active.length?(zh?'其他会话':'Other sessions'):(zh?'这个项目的会话':'Sessions in this project')):null}
        {data.matters.some(m=>!m.session) ? <View><Txt accessibilityRole="header">{zh ? '相关事项' : 'Related work'}</Txt>
          {data.matters.filter(m=>!m.session).map(m => <LinkRow key={m.id} testID={`topic-matter-${m.id}`} label={m.title} detail={topicStatus(m.state) ? t(lang, `status.${topicStatus(m.state)!}`) : (zh ? '尚未同步' : 'Not synced')} onPress={() => { rememberReference(backend, m.id); router.push(`/matter/${encodeURIComponent(m.id)}`) }} />)}
        </View> : null}
        {data.entries.length ? <View><Txt accessibilityRole="header">{zh ? 'CC 记得' : 'CC remembers'}</Txt>
          {data.entries.map(e => <Sheet key={e.id} testID={`topic-entry-${e.id}`} title={`${e.line}${e.status==='superseded'?(zh?' · 不再采用':' · No longer used'):''}${e.recalled ? (zh ? ' · 这次想起' : ' · Recalled this time') : ''}`}><Txt content="user">{e.body}</Txt><Txt role="caption" tone="inkSoft">{e.source} · {relAgo(Date.parse(e.createdTs),Date.now(),lang)}</Txt>{e.status==='live'?<Button kind="secondary" label={zh?'这条不对':'This is wrong'} disabled={!enabled||busy} onPress={()=>void edit('wrong',{id:e.id})} />:null}</Sheet>)}
        </View> : null}
        {data.messages.length ? <View><Txt accessibilityRole="header">{zh ? '最近聊到' : 'Recently discussed'}</Txt>
          {data.messages.map(m => <LinkRow key={m.id} testID={`topic-message-${m.id}`} label={`${m.speaker === 'owner' ? (zh ? '你' : 'You') : 'CC'} · ${m.excerpt}`} detail={`${relAgo(Date.parse(m.ts),Date.now(),lang)}${m.source === 'episode' ? (zh ? ' · 相关记录' : ' · Related record') : ''}`} onPress={() => { router.dismissTo({ pathname: '/', params: { message: m.id, reference: '', locate: uuid() } }) }} />)}
        </View> : null}
        {!data.entries.length && !data.matters.length && !data.messages.length ? <Txt>{zh ? '还没有记下内容' : 'Nothing recorded yet'}</Txt> : null}
        {(['matters', 'entries', 'messages'] as const).map(s => data.pages[s].nextCursor ? <Button key={s} testID={`topic-more-${s}`} kind="secondary" busy={busy} label={`${zh ? '更多' : 'More'} · ${s === 'matters' ? (zh ? '相关事项' : 'Work') : s === 'entries' ? (zh ? '记忆' : 'Memories') : (zh ? '对话' : 'Messages')} (${data.pages[s].total})`} onPress={() => void more(s)} /> : null)}
        <Pressable testID="topic-manage" accessibilityRole="button" accessibilityLabel={zh?'管理话题':'Manage topic'} accessibilityState={{expanded:editing}} disabled={!enabled||busy} onPress={() => {setEditing(!editing);setName(data.topic.title);if(!editing)void loadTargets().catch(()=>setNote(zh?'暂时读不到，重试':'Cannot read right now'))}} style={{minHeight:48,justifyContent:'center'}}><Txt role="small" tone="inkSoft">{zh?'管理话题':'Manage topic'}</Txt></Pressable>
        <Expansion open={editing}><View style={{gap:space.m}}>
          <TextField accessibilityLabel={zh?'话题名称':'Topic name'} value={name} onChangeText={setName} maxLength={120} />
          <Button kind="secondary" label={zh?'改名':'Rename'} disabled={!enabled||busy||!name.trim()} onPress={()=>void edit('rename',{id,title:name.trim()})} />
          <Txt>{zh?'并到…':'Merge into…'}</Txt>
          {targets.map(t=><Button key={t.id} kind="secondary" label={t.title} disabled={!enabled||busy} onPress={()=>void edit('merge',{id,into:t.id})} />)}
          <Button kind="secondary" label={zh?'删话题':'Delete topic'} onPress={()=>setDeleting(!deleting)} />
          {deleting?<><Txt>{zh?'删除这个话题和记下的内容？':'Delete this topic and its memories?'}</Txt><Button kind="secondary" label={zh?'确认删除':'Confirm deletion'} disabled={!enabled||busy} onPress={()=>void edit('delete',{id})} /></>:null}
        </View></Expansion>
        <LinkRow testID="topic-memory" label={zh ? '更多 · 管理记忆' : 'More · Manage memory'} onPress={() => router.push('/memory')} />
      </> : null}
    </ScrollView>
  </SafeAreaView>
}

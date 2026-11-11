// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { color, componentAppearance } from '@wechat-cc/design-tokens'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend } from '../backend/types'
import { cleanup, focus, mount } from '../ui/native-motion.test-support'
import { withProviders } from './providers.test-support'
import { TopicRow } from '../ui/TopicRow'
import { TopicBubble as Topic } from '../app/topic'
const host = vi.hoisted(() => ({ params: {} as { id?: string; open?: string }, push: vi.fn(), back: vi.fn() }))
vi.mock('react-native', async () => {const native=(await import('../ui/native-motion.test-support')).nativeBoundary();return {...native,ActivityIndicator:native.View,TextInput:({value,accessibilityLabel}:any)=>createElement('input',{value,'aria-label':accessibilityLabel,readOnly:true})}})
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('react-native-safe-area-context', async () => { const { createElement } = await import('react'); return { SafeAreaView: ({ children }: any) => createElement('main', null, children) } })
vi.mock('expo-router', async () => ({ ...(await (await import('../ui/native-motion.test-support')).routerBoundary()), useLocalSearchParams: () => host.params, useRouter: () => ({ push: host.push, back: host.back, canGoBack: () => true }) }))
afterEach(async () => { await cleanup(); host.params = {}; host.push.mockClear(); host.back.mockClear() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
describe('native topic surfaces', () => {
  it('hides topics on a routes-only/old connection without issuing topic reads or subscriptions', async () => {
    const demo = makeDemoBackend(), topics = vi.fn(demo.topics), subscribe = vi.fn(demo.subscribe)
    const backend: Backend = { ...demo, topics, subscribe, connection: () => ({ state: 'online', epoch: 1, lastSyncedAt: 1 }), onConnection: cb => { cb({ state: 'online', epoch: 1, lastSyncedAt: 1 }); return () => {} } }
    const ui = await mount(withProviders(createElement(TopicRow), { backend })); await flush()
    expect(ui.byId('topic-row')).toBeNull(); expect(topics).not.toHaveBeenCalled()
    expect(subscribe.mock.calls.filter(([name]) => name === 'topics')).toEqual([])
  })
  it('renders six recent topics; clicking navigates, while reads and closing never write closed', async () => {
    const demo = makeDemoBackend(), topics = vi.fn(demo.topics), open = vi.fn(demo.topicOpen)
    const backend = { ...demo, topics, topicOpen: open }
    const ui = await mount(withProviders(createElement(TopicRow), { backend, lang: 'zh-Hans' })); await flush()
    expect(ui.container.querySelectorAll('[data-testid^="topic-demo-"]')).toHaveLength(6)
    expect(topics).toHaveBeenCalledWith({ limit: 6 }); expect(open).not.toHaveBeenCalled()
    expect(ui.style('topic-demo-backup')).toMatchObject({ borderRadius: componentAppearance.topic.radius, borderColor: color.hair, minHeight: 44, minWidth: 44, backgroundColor: 'transparent' })
    await act(() => ui.byId('topic-demo-backup').click())
    expect(host.push).toHaveBeenCalledWith('/topic?id=demo-backup&open=1'); expect(open).not.toHaveBeenCalled()
    expect(ui.byId('topic-demo-backup').getAttribute('aria-selected')).toBe('true')
    expect(ui.style('topic-demo-backup').borderColor).toBe(color.ink)
    await focus(false); await focus(true)
    expect(ui.byId('topic-demo-backup').getAttribute('aria-selected')).toBe('false')
    expect(ui.style('topic-demo-backup').borderColor).toBe(color.hair)
  })
  it('retains a trailing read when a newer revision arrives during an older in-flight read', async () => {
    const demo = makeDemoBackend(), old = await demo.topics({})
    const fresh = { ...old, revision: 'r3', topics: [{ ...old.topics[0]!, title: '最新的备份' }] }
    let resolve!: (v: typeof old) => void, update: ((data: unknown) => void) | undefined
    const topics = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue(fresh)
    const backend: Backend = { ...demo, topics, subscribe: (name, cb) => {
      if (name !== 'topics') return demo.subscribe(name, cb)
      update = cb as (data: unknown) => void; return () => { update = undefined }
    } }
    const ui = await mount(withProviders(createElement(TopicRow), { backend })); await flush()
    await act(() => { update?.({ revision: 'r2' }); update?.({ revision: 'r3' }) })
    await act(() => resolve(old)); await flush(); await flush()
    expect(topics).toHaveBeenCalledTimes(2); expect(ui.container.textContent).toContain('最新的备份')
    await act(() => update?.({ revision: 'r3' })); await flush(); expect(topics).toHaveBeenCalledTimes(2)
  })

  it('folds a successfully slept selection on return, without popping an overlaid matter or writing closed', async () => {
    const demo = makeDemoBackend(), open = vi.fn(demo.topicOpen)
    let closed = false, update: ((data: unknown) => void) | undefined
    const backend: Backend = { ...demo, topicOpen: open, topicDetail: async p => {
      const d = await demo.topicDetail(p)
      return { ...d, topic: { ...d.topic, bubbleState: closed ? 'closed' : 'open' }, revision: closed ? 'sleep-2' : 'open-1' }
    }, subscribe: (name, cb) => {
      if (name !== 'topics') return demo.subscribe(name, cb)
      update = cb as (data: unknown) => void; return () => { update = undefined }
    } }
    host.params = { id: 'demo-backup', open: '1' }
    await mount(withProviders(createElement(Topic), { backend })); await flush(); await flush()
    await focus(false)
    closed = true; await act(() => update?.({ revision: 'sleep-2' })); await flush()
    expect(host.back).not.toHaveBeenCalled()
    await focus(true)
    expect(host.back).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce()
  })

  it('opens only an explicit click, shows source-backed memory, refreshes in place, and clears a deleted selection', async () => {
    const demo = makeDemoBackend({ lang: 'zh-Hans' }), open = vi.fn(demo.topicOpen)
    let title = '原话题', gone = false, update: ((data: unknown) => void) | undefined
    const backend: Backend = { ...demo, topicOpen: open, topicDetail: async p => { if (gone) throw new BackendError('not_found'); const d = await demo.topicDetail(p); return { ...d, topic: { ...d.topic, title } } }, subscribe: (name, cb) => {
      if (name !== 'topics') return demo.subscribe(name, cb)
      update = cb as (data: unknown) => void; return () => { update = undefined }
    } }
    host.params = { id: 'demo-backup', open: '1' }
    const ui = await mount(withProviders(createElement(Topic), { backend, lang: 'zh-Hans' })); await flush(); await flush()
    expect(open).toHaveBeenCalledOnce(); expect(ui.container.textContent).toContain('原话题')
    await act(() => ui.byId('topic-entry-demo-entry').click()); expect(ui.container.textContent).toContain('每周核验一次备份。')
    title = '新的话题'; await act(() => update?.({ revision: 'r2' })); await flush()
    expect(ui.container.textContent).toContain('新的话题'); expect(open).toHaveBeenCalledOnce()
    gone = true; await act(() => update?.({ revision: 'r3' })); await flush()
    expect(ui.container.textContent).not.toContain('新的话题'); expect(ui.container.textContent).toContain('这个话题已不可用')
    await act(() => ui.byId('topbar-back').click()); expect(host.back).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce()
  })
})

it('reads all activity counts, shows only the priority mark, and leaves zero activity unmarked',async()=>{
  const demo=makeDemoBackend(), data=await demo.topics({})
  const backend:Backend={...demo,topics:async()=>({...data,topics:data.topics.map((topic,i)=>({...topic,activity:i===0?{waiting:1,running:2,unread:1,lastActiveAt:100}:{waiting:0,running:0,unread:0,lastActiveAt:null}}))})}
  const ui=await mount(withProviders(createElement(TopicRow),{backend,lang:'zh-Hans'}));await flush()
  expect(ui.byId('topic-demo-backup').getAttribute('aria-label')).toBe('服务器，1 个等你，2 个在跑，1 个做完未看')
  expect(ui.byId('topic-activity-demo-backup').textContent).toContain('1')
  expect(ui.byId('topic-activity-demo-trip')).toBeNull()
})

it('lists project sessions before memory and reuses original detail and decision routes',async()=>{
  const demo=makeDemoBackend(), backend:Backend={...demo,topicDetail:async p=>{
    const detail=await demo.topicDetail(p)
    return{...detail,matters:[...detail.matters,{id:'project-task',title:'检查文件',state:'waiting',archivedAt:null,session:{id:'project-task',kind:'task',title:'检查文件',executor:'codex',activity:'waiting',latestStep:'需要读取文件',updatedAt:100,requestId:'permission'}},{id:'project-terminal',title:'终端备份',state:'running',archivedAt:null,session:{id:'shell',kind:'terminal',title:'终端备份',executor:'claude',activity:'running',latestStep:'正在核对文件',updatedAt:90,requestId:null}}]}
  }}
  host.params={id:'demo-backup'}
  const ui=await mount(withProviders(createElement(Topic),{backend,lang:'zh-Hans'}));await flush();await flush()
  expect(ui.container.textContent).toContain('这个项目的会话')
  expect(ui.container.textContent).toContain('需要读取文件')
  await act(()=>ui.byId('topic-session-project-task').click())
  expect(host.push).toHaveBeenCalledWith('/matter/project-task')
  await act(()=>ui.byId('topic-session-respond-project-task').click())
  expect(host.push).toHaveBeenCalledWith('/matter/project-task/decide?request=permission')
  await act(()=>ui.byId('topic-session-project-terminal').click())
  expect(host.push).toHaveBeenCalledWith('/matter/project-terminal')
})

it('keeps expanded project sessions when an activity revision reloads the default page',async()=>{
  const demo=makeDemoBackend(), base=await demo.topicDetail({id:'demo-backup'})
  let revision='r1', failPage=false, update:((data:unknown)=>void)|undefined
  const reads:Array<{cursor?:string;limit?:number}>=[]
  const rows=Array.from({length:26},(_,i)=>({id:`session-${i+1}`,title:`会话 ${i+1}`,state:'running',archivedAt:null,session:{id:`session-${i+1}`,kind:'task' as const,title:`会话 ${i+1}`,executor:'codex',activity:'running' as const,latestStep:'正在核对',updatedAt:100,requestId:null}}))
  const backend:Backend={...demo,topicDetail:async p=>{
    reads.push(p)
    if(p.cursor&&failPage)throw Error('offline')
    const offset=Number(p.cursor?.split(':')[1]??0),size=p.section?20:3
    if(p.cursor)expect(p.cursor.startsWith(revision+':')).toBe(true)
    return{...base,revision,matters:rows.slice(offset,offset+size),pages:{...base.pages,matters:{total:26,nextCursor:offset+size<26?`${revision}:${offset+size}`:null}}}
  },subscribe:(name,cb)=>{if(name!=='topics')return demo.subscribe(name,cb);update=cb as (data:unknown)=>void;return()=>{update=undefined}}}
  host.params={id:'demo-backup'}
  const ui=await mount(withProviders(createElement(Topic),{backend,lang:'zh-Hans'}));await flush();await flush()
  for(let i=0;i<2;i++){await act(()=>ui.byId('topic-more-matters').click());await flush()}
  expect(ui.byId('topic-session-session-26')).not.toBeNull()
  revision='r2';reads.length=0;await act(()=>update?.({revision}));await flush();await flush();await flush()
  expect(ui.byId('topic-session-session-4')).not.toBeNull()
  expect(ui.byId('topic-session-session-26')).not.toBeNull()
  expect(reads).toHaveLength(3)
  expect(reads.slice(1).every(p=>p.limit===20)).toBe(true)
  revision='r3';failPage=true;await act(()=>update?.({revision}));await flush();await flush()
  expect(ui.byId('topic-session-session-26')).not.toBeNull()
  expect(ui.byId('topic-retry')).not.toBeNull()
  failPage=false;await act(()=>ui.byId('topic-retry').click());await flush();await flush();await flush()
  expect(ui.byId('topic-session-session-26')).not.toBeNull()
  expect(ui.byId('topic-retry')).toBeNull()
})

it.each(['zh-Hans','en'] as const)('polishes sheet order, names, dates, management and interface copy in %s',async lang=>{
  const zh=lang==='zh-Hans', demo=makeDemoBackend({lang}), ts=Date.now()-7_200_000, iso=new Date(ts).toISOString()
  const backend:Backend={...demo,topicDetail:async p=>{
    const base=await demo.topicDetail(p)
    return{...base,topic:{...base.topic,description:'项目说明',summary:'项目摘要'},matters:(['idle','running','waiting'] as const).map(activity=>({id:activity,title:`会话${activity}`,state:activity,archivedAt:null,session:{id:activity,kind:activity==='idle'?'terminal' as const:'task' as const,title:`会话${activity}`,executor:'codex',displayName:'Codex',activity,latestStep:activity==='idle'?'答完了':'核对文件',updatedAt:ts,requestId:activity==='waiting'?'approval':null}})),messages:[{id:'msg',speaker:'cc' as const,ts:iso,excerpt:'最近的消息',source:'recall' as const}]}
  }}
  host.params={id:'demo-backup'}
  const ui=await mount(withProviders(createElement(Topic),{backend,lang}));await flush();await flush()
  const text=ui.container.textContent!
  expect.soft([...ui.container.querySelectorAll('[data-testid^="topic-session-"]')].filter(el=>!el.getAttribute('data-testid')!.includes('respond')).map(el=>el.getAttribute('data-testid'))).toEqual(['topic-session-waiting','topic-session-running','topic-session-idle'])
  expect.soft(text.indexOf('会话waiting')).toBeLessThan(text.indexOf('项目说明'))
  expect.soft(text.indexOf(zh?'回应':'Respond')).toBeLessThan(text.indexOf('会话running'))
  expect.soft(text.indexOf('会话running')).toBeLessThan(text.indexOf('项目说明'))
  expect.soft(text.indexOf('项目摘要')).toBeLessThan(text.indexOf('会话idle'))
  expect.soft(ui.byId('topic-session-idle').textContent).toContain('答完了')
  expect.soft(ui.byId('topic-session-respond-idle')).toBeNull()
  expect.soft(ui.byId('topic-session-waiting').textContent).toContain('Codex')
  expect.soft(ui.byId('topic-session-waiting').getAttribute('aria-label')).toContain('Codex')
  expect.soft(text).toContain(zh?'2 小时前':'2 h ago')
  expect.soft(ui.byId('topic-message-msg').textContent).toContain(zh?'2 小时前':'2 h ago')
  expect.soft(text).not.toContain(iso)
  expect.soft(text).toContain(zh?'这个项目的会话':'Sessions in this project')
  expect.soft(text).toContain(zh?'最近聊到':'Recently discussed')
  expect.soft(text).not.toContain(zh?'Sessions in this project':'这个项目的会话')
  expect.soft(text.indexOf(zh?'管理话题':'Manage topic')).toBeGreaterThan(text.indexOf(zh?'最近聊到':'Recently discussed'))
  const manage=ui.byId('topic-manage')
  expect.soft(manage?.getAttribute('aria-expanded')).toBe('false')
  expect.soft(ui.container.querySelector('input[aria-label="Topic name"],input[aria-label="话题名称"]')).toBeNull()
  if(manage)await act(()=>manage.click());await flush()
  expect.soft(manage?.getAttribute('aria-expanded')).toBe('true')
  expect.soft(ui.container.textContent).toContain(zh?'改名':'Rename')
})

it('keeps description above sessions when no active session needs the owner',async()=>{
  const demo=makeDemoBackend(),backend:Backend={...demo,topicDetail:async p=>{const base=await demo.topicDetail(p);return{...base,topic:{...base.topic,description:'项目说明'},matters:base.matters.map(m=>({...m,session:m.session?{...m.session,activity:'idle' as const}:undefined}))}}}
  host.params={id:'demo-backup'}
  const ui=await mount(withProviders(createElement(Topic),{backend,lang:'zh-Hans'}));await flush();await flush()
  const text=ui.container.textContent!
  expect.soft(text.indexOf('项目说明')).toBeLessThan(text.indexOf('这个项目的会话'))
})

it('distinguishes accent waiting dots, smaller inkSoft running dots, and unread hairlines',async()=>{
  const demo=makeDemoBackend(),data=await demo.topics({}),backend:Backend={...demo,topics:async()=>({...data,topics:data.topics.slice(0,3).map((topic,i)=>({...topic,activity:{waiting:topic.id==='demo-backup'?1:0,running:topic.id==='demo-trip'?1:0,unread:topic.id==='demo-topic-2'?1:0,lastActiveAt:100}}))})}
  const ui=await mount(withProviders(createElement(TopicRow),{backend,lang:'zh-Hans'}));await flush()
  const mark=(id:string)=>JSON.parse(ui.byId(`topic-activity-${id}`).firstElementChild!.getAttribute('data-style')??'{}')
  expect.soft(mark('demo-backup')).toMatchObject({backgroundColor:color.accent,width:7,height:7})
  expect.soft(mark('demo-trip')).toMatchObject({backgroundColor:color.inkSoft,width:5,height:5})
  expect.soft(mark('demo-topic-2')).toMatchObject({backgroundColor:color.inkSoft,width:10,height:1})
})

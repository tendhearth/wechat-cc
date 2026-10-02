/**
 * 随身 CC(手机)那 200 行内联 JS 的测试地基。
 *
 * 它此前**零测试**:是一整块 `String.raw` 模板,而仓库里没有 happy-dom / jsdom,
 * vitest 也没配 DOM 环境(桌面那些"UI 测试"其实都是纯函数返回字符串)。为了不给
 * 整个仓库新加一个 DOM 依赖,这里手写一个最小假 DOM:**只认注册过的 id,遇到没
 * 注册的直接抛** —— 比浏览器更严,元素不存在这类 bug 不会溜过去。
 *
 * 钉的是连接状态那组行为(2026-09-23):断线时说清"你看到的是几点的样子"、
 * 恢复即撤、回前台按当前页分路刷新、断网期间点的那一下重连后核对(绝不自动重发)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MOBILE_WORKBENCH_JS } from './mobile-page'
import { phoneHtml } from './settings-panel-html'
import { assembleMobilePage } from '../../apps/mobile/assemble'
import { readMobileSource } from '../../apps/mobile/sources'

const IDS = ['m-list', 'm-detail', 'm-back', 'm-title', 'm-notice', 'm-controls', 'm-permissions',
  'm-questions', 'm-events', 'm-artifacts', 'm-artifact-preview', 'm-inputs', 'm-say-box', 'm-say', 'm-send', 'm-conn']

type Handler = (ev: unknown) => void
interface FakeEl {
  id: string; textContent: string; innerHTML: string; hidden: boolean; disabled: boolean; value: string
  dataset: Record<string, string>; handlers: Record<string, Handler[]>
  addEventListener(type: string, fn: Handler): void
  replaceChildren(): void
  querySelectorAll(): FakeEl[]
  closest(): FakeEl | null
  fire(type: string, ev?: unknown): void
}

function fakeEl(id: string): FakeEl {
  return {
    id, textContent: '', innerHTML: '', hidden: false, disabled: false, value: '',
    dataset: {}, handlers: {},
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn) },
    replaceChildren() { this.innerHTML = '' },
    querySelectorAll() { return [] },
    closest() { return null },
    fire(type, ev) { for (const fn of this.handlers[type] ?? []) fn(ev ?? {}) },
  }
}

function harness(source = MOBILE_WORKBENCH_JS) {
  const els = new Map(IDS.map((id) => [id, fakeEl(id)]))
  // 照真页面来:连接提示那行平时不在(<div id="m-conn" hidden>),详情栏也是先藏着。
  els.get('m-conn')!.hidden = true
  els.get('m-detail')!.hidden = true
  const navButton = fakeEl('nav-matters'); navButton.dataset.p = 'matters'
  const docHandlers: Record<string, Handler[]> = {}
  const winHandlers: Record<string, Handler[]> = {}
  const store = new Map<string, string>()

  const doc = {
    hidden: false,
    getElementById(id: string) {
      const el = els.get(id)
      if (!el) throw new Error(`测试假 DOM 里没有登记这个元素:${id}(真页面有它吗?)`)
      return el
    },
    querySelectorAll(selector: string) { return selector.includes('nav button') ? [navButton] : [] },
    addEventListener(type: string, fn: Handler) { (docHandlers[type] ??= []).push(fn) },
  }
  const win = { addEventListener(type: string, fn: Handler) { (winHandlers[type] ??= []).push(fn) } }

  /** 一次 api 调用的记录;测试用 respond/fail 决定它怎么收场。 */
  const calls: Array<{ path: string; opts?: { method?: string; body?: string } }> = []
  let mode: 'ok' | 'down' = 'ok'
  let detail = {
    ok: true, matter: { id: 'm1', title: '首页调整', kind: 'task', status: 'open' }, runId: 'run1',
    permissions: [] as Array<Record<string, unknown>>, questions: [], events: [] as Array<Record<string, unknown>>, artifacts: [], inputs: [],
  }

  let deferred: (() => void) | undefined
  let deferNext = false
  const api = (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, ...(opts ? { opts } : {}) })
    if (mode === 'down') return Promise.reject(new Error('network down'))
    const body = path.startsWith('/m/api/matters')
      ? { ok: true, matters: [{ id: 'm1', title: '首页调整', kind: 'task', status: 'open' }] }
      : path.startsWith('/m/api/matter?') ? detail : { ok: true }
    const response = { status: 200, json: () => Promise.resolve(body) }
    if (deferNext && path.startsWith('/m/api/matter?')) {
      deferNext = false
      return new Promise<typeof response>((resolve) => { deferred = () => resolve(response) })
    }
    return Promise.resolve(response)
  }

  const boot = new Function('document', 'window', 'localStorage', 'REMOTE', 'api', 'esc', 'URL', 'ago', readMobileSource('markdown.js')+'\n'+source)
  boot(doc, win, {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }, { relay: 'https://relay.example', id: 'phone1' }, api, (s: string) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'), class extends URL { static revokeObjectURL() {} }, () => '刚刚')

  return {
    els, doc, calls, navButton, docHandlers, winHandlers,
    get conn() { return els.get('m-conn')! },
    get notice() { return els.get('m-notice')! },
    deferDetail() { deferNext = true },
    async resolveDetail() { deferred?.(); await vi.advanceTimersByTimeAsync(0) },
    async offline() { for (const fn of winHandlers.offline ?? []) fn({}); await vi.advanceTimersByTimeAsync(0) },
    down() { mode = 'down' },
    up() { mode = 'ok' },
    setDetail(next: Partial<typeof detail>) { detail = { ...detail, ...next } as typeof detail },
    /** 进「事」这一栏 → 拉列表。 */
    async enterPane() { navButton.fire('click'); await vi.advanceTimersByTimeAsync(0) },
    /** 点开列表里的那件事。 */
    async openMatter() {
      const list = els.get('m-list')!
      list.fire('click', { target: { closest: () => ({ dataset: { mid: 'm1' } }) } })
      await vi.advanceTimersByTimeAsync(0)
    },
    async tick(ms: number) { await vi.advanceTimersByTimeAsync(ms) },
    /** 点权限卡上的「允许这一次」。 */
    async allow(requestId: string) {
      els.get('m-controls')!.fire('click', { target: { closest: () => ({ dataset: { control: 'allow', task: 'm1', request: requestId } }) } })
      await vi.advanceTimersByTimeAsync(0)
    },
    postCalls() { return calls.filter((c) => c.opts?.method === 'POST').length },
    /** 切后台再回前台。 */
    async background() { doc.hidden = true; for (const fn of docHandlers['visibilitychange'] ?? []) fn({}); await vi.advanceTimersByTimeAsync(0) },
    async foreground() { doc.hidden = false; for (const fn of docHandlers['visibilitychange'] ?? []) fn({}); await vi.advanceTimersByTimeAsync(0) },
    listCalls() { return calls.filter((c) => c.path.startsWith('/m/api/matters')).length },
    detailCalls() { return calls.filter((c) => c.path.startsWith('/m/api/matter?')).length },
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-23T14:05:00+08:00')) })
afterEach(() => { vi.useRealTimers() })

describe('连不上的时候,页面说清你看到的是几点的样子', () => {
  it('连续两拍没联系上 daemon,浮出一条带时刻的提示', async () => {
    const h = harness()
    await h.enterPane()
    await h.openMatter()
    expect(h.conn.hidden).toBe(true)

    h.down()
    await h.tick(3000)   // 第一拍失败 —— 一次抖动不打扰人
    expect(h.conn.hidden).toBe(true)
    await h.tick(3000)   // 第二拍也失败

    expect(h.conn.hidden).toBe(false)
    expect(h.conn.textContent).toContain('连不上')
    // 时刻按本机时区渲染 —— 断言也按本机算,否则这条会在 UTC 的 CI 上假红。
    expect(h.conn.textContent).toContain(new Date('2026-09-23T14:05:00+08:00').getHours().toString().padStart(2,'0'))
  })

  it('一恢复就自己撤掉,连断线期间那条错误提示一起抹掉', async () => {
    const h = harness()
    await h.enterPane()
    await h.openMatter()

    h.down()
    await h.tick(3000)
    await h.tick(3000)
    expect(h.conn.hidden).toBe(false)
    expect(h.notice.textContent).not.toBe('')   // 断线期间确实留了一条错误提示

    h.up()
    await h.tick(3000)

    expect(h.conn.hidden).toBe(true)
    expect(h.notice.textContent).toBe('')       // 旧错误不许赖着不走
  })

  it('停在列表页时回前台,列表会重新拉一次(此前只有详情页会刷)', async () => {
    const h = harness()
    await h.enterPane()
    const before = h.listCalls()

    await h.background()
    await h.foreground()

    expect(h.listCalls()).toBe(before + 1)
  })

  it('审批消失不能证明自己的提交成功:可能过期或被别处处理,而且不重发', async () => {
    const h = harness()
    h.setDetail({ permissions: [{ id: 'p1', taskId: 'm1', tool: 'Bash', description: 'rm tmp' }] })
    await h.enterPane()
    await h.openMatter()

    h.down()
    await h.allow('p1')
    await h.tick(0)
    expect(h.postCalls()).toBe(1)

    // 请求消失不是提交回执,也可能是任务结束或其他设备已经处理。
    h.up()
    h.setDetail({ permissions: [] })
    await h.tick(3000)

    expect(h.notice.textContent).toContain('无法确认')
    expect(h.notice.textContent).not.toContain('已经生效')
    expect(h.postCalls()).toBe(1)   // 绝不自动重发
  })

  it('断网时批的那一下:重连后那条还在,就明说没送出去', async () => {
    const h = harness()
    h.setDetail({ permissions: [{ id: 'p1', taskId: 'm1', tool: 'Bash', description: 'rm tmp' }] })
    await h.enterPane()
    await h.openMatter()

    h.down()
    await h.allow('p1')
    await h.tick(0)

    h.up()
    await h.tick(3000)   // 详情里 p1 仍然挂着

    expect(h.notice.textContent).toContain('仍在等待')
    expect(h.postCalls()).toBe(1)
  })

  it.each(['offline', 'background'] as const)('失效前的在途详情不能在 %s 后重新启用提交', async (event) => {
    const h = harness()
    h.setDetail({ permissions: [{ id: 'p1', taskId: 'm1', tool: 'Bash', description: 'command' }] })
    await h.enterPane(); await h.openMatter()
    h.deferDetail(); await h.tick(3000)
    await h[event]()
    await h.resolveDetail()
    expect(h.els.get('m-send')!.disabled).toBe(true)
    await h.allow('p1')
    expect(h.postCalls()).toBe(0)
    if (event === 'offline') expect(h.conn.hidden).toBe(false)
  })

  it('一次详情读取失败后就停止接受审批,直到重新取得当前详情', async () => {
    const h=harness()
    h.setDetail({permissions:[{id:'p1',taskId:'m1',tool:'Bash',description:'command'}]})
    await h.enterPane();await h.openMatter()
    h.down();await h.tick(3000)
    await h.allow('p1')
    expect(h.postCalls()).toBe(0)
    h.up();await h.tick(3000);await h.allow('p1')
    expect(h.postCalls()).toBe(1)
  })
})

describe('脚本要的元素,真页面里都得有', () => {
  it('内联 JS 里每个 getElementById 的 id 都能在手机页 HTML 里找到', () => {
    const html = phoneHtml('tok', null)
    const ids = [...MOBILE_WORKBENCH_JS.matchAll(/getElementById\((["'])([^"']+)\1\)/g)].map((m) => m[2]!)
    const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`))
    // 这条守的是"测试里注册了、真页面却没加"这个空档 —— 假 DOM 抓不到它,
    // 因为假 DOM 的元素清单是测试自己写的。
    expect(missing, '脚本要用但页面上没有的元素').toEqual([])
  })
})

describe('手机交办页面接线', () => {
  it('keeps public messages visible while tool calls are escaped inside a closed section', async () => {
    const h=harness(readMobileSource('workbench.js'))
    h.setDetail({events:[
      {kind:'user',text:'公开要求',createdAt:1},
      {kind:'tool_call',text:'<img src=x onerror=evil()>\n读取文件 & 检查',createdAt:2},
      {kind:'text',text:'公开答复',createdAt:3},
      {kind:'tool_call',text:'继续检查',createdAt:4},
    ]})
    await h.openMatter()
    const html=h.els.get('m-events')!.innerHTML
    const folded=html.match(/<details\b[^>]*class="m-tool-events"[^>]*>([\s\S]*?)<\/details>/)
    expect(folded).not.toBeNull()
    expect(folded![0]).not.toMatch(/<details\b[^>]*\bopen\b/)
    expect(folded![1]).toContain('<summary>工具记录（2）</summary>')
    expect(folded![1]).toContain('&lt;img src=x onerror=evil()&gt;\n读取文件 &amp; 检查')
    expect(folded![1]).not.toContain('<img')
    expect(folded![1]).not.toContain('公开要求')
    expect(folded![1]).not.toContain('公开答复')
    expect(html.replace(folded![0],'')).toContain('公开要求')
    expect(html.replace(folded![0],'')).toContain('公开答复')
  })

  it('does not reserve a tool section when no tool calls exist', async () => {
    const h=harness(readMobileSource('workbench.js'))
    h.setDetail({events:[{kind:'text',text:'只有公开答复',createdAt:1}]})
    await h.openMatter()
    expect(h.els.get('m-events')!.innerHTML).toContain('只有公开答复')
    expect(h.els.get('m-events')!.innerHTML).not.toContain('<details')
    expect(h.els.get('m-events')!.innerHTML).not.toContain('工具记录')
  })

  it('preserves the owner’s expanded tool section during refresh', async () => {
    const h=harness(readMobileSource('workbench.js'))
    h.setDetail({events:[{kind:'tool_call',text:'执行细节',createdAt:1}]})
    await h.openMatter()
    h.els.get('m-events')!.querySelectorAll=()=>[fakeEl('expanded-tool-records')]
    await h.foreground()
    expect(h.els.get('m-events')!.innerHTML).toMatch(/<details\b[^>]*class="m-tool-events"[^>]*\bopen\b/)
    h.els.get('m-events')!.querySelectorAll=()=>[]
    await h.foreground()
    expect(h.els.get('m-events')!.innerHTML).not.toMatch(/<details\b[^>]*\bopen\b/)
  })

  it('assembles the visible entry and keeps public messages outside collapsed tool details', () => {
    const page=assembleMobilePage(readMobileSource).phone
    expect(page.includes('id="home-entry"')).toBe(true)
    expect(page.includes('id="entry-root"')).toBe(true)
    const ancestors:string[]=[]
    let eventsAncestors:string[]|undefined
    for(const match of page.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g,'').matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi)){
      const [,closing,tag,attributes]=match
      if(closing){const index=ancestors.lastIndexOf(tag!);if(index>=0)ancestors.splice(index)}
      else{
        if(/\bid="m-events"/.test(attributes!))eventsAncestors=[...ancestors]
        if(!['meta','link','img','input','br','hr'].includes(tag!))ancestors.push(tag!)
      }
    }
    expect(eventsAncestors).toBeDefined()
    expect(eventsAncestors).not.toContain('details')
    expect(page.indexOf('function createPhoneAttachments')).toBeGreaterThan(page.indexOf('var mCurrent'))
    expect(page.indexOf('function openEntry')).toBeGreaterThan(page.indexOf('function createPhoneAttachments'))
    expect(page.indexOf('function renderPresenceHome')).toBeGreaterThan(page.indexOf('function openEntry'))
    expect(page.indexOf('function render(s)')).toBeGreaterThan(page.indexOf('function renderPresenceHome'))
    expect(page.slice(page.indexOf('<script'),page.indexOf('<script')+8)).toBe('<script>')
  })

  it('starts by checking saved receipts and opens entry only on an explicit tap, without resending', async () => {
    const els=new Map<string,ReturnType<typeof fakeEl>&{focus:ReturnType<typeof vi.fn>;scrollIntoView:()=>void;appendChild:()=>void;click:()=>void;classList:{contains:()=>boolean;add:()=>void}}>()
    const get=(id:string)=>{if(!els.has(id))els.set(id,{...fakeEl(id),focus:vi.fn(),scrollIntoView(){},appendChild(){},click(){this.fire('click')},classList:{contains:()=>false,add(){}}});return els.get(id)!}
    const requestId='123e4567-e89b-42d3-a456-426614174000',input={requestId,text:'已经送出，不能再送一遍',target:{kind:'managed'}}
    const saved=new Map([['cc.phone.entry.v1:fixture',JSON.stringify({version:1,draft:{...input,providerId:'',revision:1},pending:[{input,revision:1}],last:null})]])
    const calls:Array<{path:string;method:string}>=[]
    const api=async(path:string,opts?:{method?:string})=>{
      calls.push({path,method:opts?.method??'GET'})
      const body=path.endsWith('/options')?{ok:true,status:'ready',defaultProviderId:'codex',projects:[],providers:[{id:'codex',displayName:'Codex',available:true}]}:{ok:false,error:'not_found'}
      return{status:path.includes('create-receipt')?404:200,json:async()=>body}
    }
    const env={document:{hidden:false,visibilityState:'visible',getElementById:get,createElement:(tag:string)=>get('created-'+tag),querySelector:(selector:string)=>get(selector),querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},REMOTE:{id:'fixture'},T:'test-token',location:{host:'test',replace(){}},localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)},api,esc:String,toast(){},setTimeout,clearTimeout,setInterval,crypto,openMatter:vi.fn(),openYou(){},ccMobilePane:vi.fn(),mUuid:()=>crypto.randomUUID()}
    new Function(...Object.keys(env),`var mCurrent=null,mSeq=0;\n${readMobileSource('attachments.js')}\n${readMobileSource('entry.js')}\n${readMobileSource('presence.js')}\n${readMobileSource('home.js')}`)(...Object.values(env))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter(c=>c.path.includes('create-receipt'))).toEqual([{path:'/m/api/matter/create-receipt?requestId='+requestId,method:'GET'}])
    expect(calls.filter(c=>c.method==='POST')).toEqual([])
    expect(get('entry-text').value).toBe(input.text)
    expect(get('entry-text').focus).not.toHaveBeenCalled()
    get('home-entry').fire('click');await vi.advanceTimersByTimeAsync(0)
    expect(get('entry-text').focus).toHaveBeenCalledOnce()
    expect(env.ccMobilePane).toHaveBeenCalledWith('today')
    expect(calls.filter(c=>c.method==='POST')).toEqual([])
    expect(env.openMatter).not.toHaveBeenCalled()
  })
})

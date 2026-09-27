import { afterEach, describe, expect, it, vi } from 'vitest'

const root = globalThis as unknown as { window?: unknown; document?: unknown }

const { handoffDialogCalls } = vi.hoisted(() => ({ handoffDialogCalls: [] as any[] }))
vi.mock('./workbench-handoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workbench-handoff.js')>()
  return { ...actual, mountHandoffDialog: (...args: any[]) => { handoffDialogCalls.push(args); return () => {} } }
})

afterEach(() => {
  delete root.window
  delete root.document
  vi.useRealTimers()
  vi.resetModules()
  handoffDialogCalls.length = 0
})

describe('workbench rendering', () => {
  it('keeps model controls in the existing disclosures and distinguishes observations from next-run choices',async()=>{
    const {renderWorkbench}=await import('./workbench.js')
    const execution={defaults:'native' as const,model:'requested-model',reasoningEffort:'deep'},task={id:'deadbeef',title:'Task',path:'/work',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
    const state={tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',selectedId:task.id,detail:{task,events:[],artifacts:[],execution,lastExecution:{taskId:task.id,runId:'run-A',choice:execution,effective:{model:'observed-model',source:'native_response'}}},selectedArtifactId:null,error:'',preview:null,canWechat:false}
    const html=renderWorkbench(state)
    expect(html).toMatch(/id="wb-task-info"[\s\S]*id="wb-model"[\s\S]*<\/details>/)
    expect(html).toContain('下一轮使用');expect(html).toContain('observed-model');expect(html).toContain('思考强度未报告')
    expect(html.match(/<select[^>]* disabled/g)).toHaveLength(2)
    expect(html.slice(html.indexOf('class="wb-controls"'))).not.toContain('id="wb-model"')
    const create=renderWorkbench({...state,selectedId:null,detail:null})
    expect(create).toMatch(/id="wb-options"[\s\S]*id="wb-model"[\s\S]*id="wb-title"/)
  })

  it('shows an actionable execution failure in the task banner without rewriting stored error data',async()=>{
    const {renderWorkbench}=await import('./workbench.js')
    const task={id:'deadbeef',title:'Task',path:'/work',providerId:'codex',status:'failed',createdAt:1,updatedAt:2,error:'execution_image_unsupported'}
    const html=renderWorkbench({tasks:[task],providers:[],defaultProvider:'codex',selectedId:task.id,detail:{task,events:[],artifacts:[]},selectedArtifactId:null,error:'',preview:null,canWechat:false})
    expect(html).toContain('不接收图片');expect(html).not.toContain('execution_image_unsupported');expect(task.error).toBe('execution_image_unsupported')
  })

  it('标出免审执行者:选单上带（免审）,打开它的任务时头部说清只能停止',async()=>{
    const {renderWorkbench}=await import('./workbench.js')
    const task={id:'deadbeef',title:'Task',path:'/work',providerId:'agy',status:'running',createdAt:1,updatedAt:2,error:null}
    const providers=[{id:'agy',displayName:'agy',capabilities:{permissions:'unattended' as const}},{id:'codex',displayName:'Codex',capabilities:{permissions:'ask'}}]
    const state={tasks:[task],providers,defaultProvider:'agy',canWechat:false,selectedId:task.id,detail:{task,events:[],artifacts:[]},selectedArtifactId:null,error:'',preview:null}
    const html=renderWorkbench(state)
    expect(html).toContain('<p class="wb-task-unattended">免审执行者 · 看不到单步,只能停止</p>')
    const managed=renderWorkbench({...state,detail:{...state.detail,task:{...task,providerId:'codex'}}})
    expect(managed).not.toContain('wb-task-unattended')
    const create=renderWorkbench({...state,selectedId:null,detail:null})
    expect(create).toContain('agy（免审）');expect(create).not.toContain('Codex（免审）')
    const limited=renderWorkbench({...state,selectedId:null,detail:null,providers:[{...providers[0]!,quota:{kind:'rate_limit' as const}}]})
    expect(limited).toContain('agy（限流中）（免审）')
    expect(renderWorkbench({...state,selectedId:null,detail:null,providers:[]})).not.toContain('Codex 执行者')
  })

  it('offers running supplements only with an active run and explains native versus next-round delivery', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task = { id: 'A', title: 'Working', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }
    const state = { tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false, selectedId: 'A', selectedArtifactId: null, error: '', preview: null, detail: { task, events: [], artifacts: [], runId: 'run-A', inputMode: 'steer' as const } }
    const native = renderWorkbench(state)
    expect(native).toContain('data-action="send-input"'); expect(native).toContain('data-run-id="run-A"')
    expect(native).toContain('发送补充'); expect(native).toContain('收到确认后显示已交付')
    const queued = renderWorkbench({ ...state, detail: { ...state.detail, inputMode: 'queue' } })
    expect(queued).toContain('加入下一轮'); expect(queued).toContain('正常结束后')
    expect(renderWorkbench({ ...state, detail: { ...state.detail, runId: undefined } })).not.toContain('data-action="send-input"')
    expect(renderWorkbench({ ...state, detail: { ...state.detail, task: { ...task, status: 'cancelling' } } })).not.toContain('data-action="send-input"')
  })

  it('marks pending questions separately and never renders another task question in the current controls', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task = { id: 'A', title: 'Working', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null, pendingQuestionCount: 2 }
    const html = renderWorkbench({ tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false, selectedId: 'A', selectedArtifactId: null, error: '', preview: null, detail: { task, events: [], artifacts: [], questions: [
      { id: 'Q-A', taskId: 'A', createdAt: 1, questions: [{ id: 'q', header: 'Plan', question: 'Own question', options: [] }] },
      { id: 'Q-B', taskId: 'B', createdAt: 1, questions: [{ id: 'q', header: 'Plan', question: 'Wrong question', options: [] }] },
    ] } })
    expect(html).toContain('2 项问题等你回答'); expect(html).toContain('Own question'); expect(html).not.toContain('Wrong question')
    expect(html.indexOf('class="wb-questions"')).toBeLessThan(html.indexOf('id="wb-followup-text"'))
  })
  it('把「改动」摆在「成果」之前,没有改动记录时不占地方', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task = { id: 'A', title: 'Review', path: '/work', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }
    const artifact = { id: 'DIFF', taskId: 'A', name: '对比.json', mime: 'application/json', size: 100, sha256: 'b'.repeat(64), createdAt: 3, approvedAt: null }
    const reviews = [{ artifactId: 'DIFF', sha256: 'a'.repeat(64), name: '对比.json', createdAt: 100, status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files: [{ path: 'src/app.ts', preexisting: false, kind: 'modified', diff: '@@ -1 +1 @@\n-a\n+b' }] }]
    const state = { tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false, selectedId: 'A', selectedArtifactId: null, error: '', preview: null, detail: { task, events: [], artifacts: [artifact] } }
    const html = renderWorkbench({ ...state, reviews } as never)
    expect(html.indexOf('id="wb-review"')).toBeGreaterThan(-1)
    expect(html.indexOf('id="wb-review"')).toBeLessThan(html.indexOf('id="wb-artifacts"'))
    expect(html).toContain('@@ -1 +1 @@')
    expect(renderWorkbench(state as never)).not.toContain('id="wb-review"')
  })

  it('escapes task and event content before putting it in the page', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const html = renderWorkbench({
      tasks: [{ id: 'A1B2C3D4', title: '<img src=x onerror=alert(1)>', path: '/tmp/<work>', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }],
      providers: [{ id: 'codex', displayName: 'Codex <unsafe>' }], defaultProvider: 'codex', canWechat: true,
      selectedId: 'A1B2C3D4',
      detail: { task: { id: 'A1B2C3D4', title: '<task>', path: '/tmp/<work>', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }, events: [{ id: 'e1', taskId: 'A1B2C3D4', kind: 'text', text: '<script>bad()</script>', createdAt: 3 }], artifacts: [] },
      selectedArtifactId: null,
      error: '', preview: null,
    })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()</script>')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
  })

  it('makes a fresh-session decision explicit and displays the exact escaped context', async () => {
    const {renderTaskControls}=await import('./workbench.js')
    const continuation={mode:'restart_required',restart:{token:'a'.repeat(64),context:'user: 原来的要求\ntext: <script>bad()</script>',eventCount:18,includedEventCount:12,truncated:true}}
    const html=renderTaskControls('failed',continuation)
    expect(html).toContain('原会话无法恢复')
    expect(html).toContain('18')
    expect(html).toContain('12')
    expect(html).toContain('更早的记录或过长内容未包含')
    expect(html).toContain('user: 原来的要求\ntext: &lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()</script>')
    expect(html).toContain('data-action="restart"')
    expect(html).toContain(`data-restart-token="${'a'.repeat(64)}"`)
    expect(html).toContain('带这些记录新开一轮')
    expect(html).not.toContain('data-action="continue"')
    expect(renderTaskControls('completed',{mode:'resume'})).toContain('data-action="continue"')
    expect(renderTaskControls('running',continuation)).not.toContain('data-action="restart"')
  })

  it('renders every user and provider message in arrival order with finished tools folded in place', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const html = renderWorkbench({tasks:[], providers:[{id:'codex',displayName:'Codex'}], defaultProvider:'codex',canWechat:false,selectedId:'A', selectedArtifactId:null,error:'',preview:null,
      detail:{task:{id:'A',title:'整理资料',path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null},artifacts:[],events:[
        {id:'1',taskId:'A',kind:'user',text:'先整理访谈。',createdAt:1},
        {id:'2',taskId:'A',kind:'text',text:'Codex 第一轮回复。',createdAt:2},
        {id:'3',taskId:'A',kind:'tool_call',text:'读取文件',createdAt:3},
        {id:'4',taskId:'A',kind:'user',text:'再补充引用。',createdAt:4},
        {id:'5',taskId:'A',kind:'text',text:'Codex 第二轮回复。',createdAt:5}
      ]}})
    expect(html.indexOf('先整理访谈。')).toBeLessThan(html.indexOf('Codex 第一轮回复。'))
    expect(html.indexOf('Codex 第一轮回复。')).toBeLessThan(html.indexOf('再补充引用。'))
    expect(html.indexOf('再补充引用。')).toBeLessThan(html.indexOf('Codex 第二轮回复。'))
    expect(html.indexOf('Codex 第一轮回复。')).toBeLessThan(html.indexOf('读取文件'))
    expect(html.indexOf('读取文件')).toBeLessThan(html.indexOf('再补充引用。'))
    expect(html).toMatch(/<details[^>]*data-timeline-group[^>]*>/)
    expect(html).not.toMatch(/<details[^>]*data-timeline-group[^>]* open/)
    expect(html).toContain('读取文件')
    expect(html).toContain('Codex')
    expect(html).not.toContain('alt="CC"')
  })

  it('renders provider Markdown and code without admitting raw HTML or unsafe links', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const html = renderWorkbench({tasks:[],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:'A',selectedArtifactId:null,error:'',preview:null,
      detail:{task:{id:'A',title:'Review',path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null},artifacts:[],events:[
        {id:'1',taskId:'A',kind:'text',text:'# Result\n\nUse **safe** output.\n\n```ts\nconst answer = 42\n```\n\n<script>bad()</script>\n\n[bad](javascript:alert(1))',createdAt:3}
      ]}})
    expect(html).toContain('<h1>Result</h1>')
    expect(html).toContain('<strong>safe</strong>')
    expect(html).toContain('<code class="language-ts">const answer = 42')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()</script>')
    expect(html).not.toContain('href="javascript:')
  })

  it('groups tasks by their exact project path and disambiguates matching folder names', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task = (id: string, path: string) => ({id,title:`Task ${id}`,path,providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null})
    const html = renderWorkbench({tasks:[task('A','/clients/alpha/app'),task('B','/clients/beta/app'),task('C','/clients/alpha/app')],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null})
    expect(html.match(/class="wb-project"/g)).toHaveLength(2)
    expect(html).toContain('/clients/alpha/app')
    expect(html).toContain('/clients/beta/app')
    expect(html).toContain('app · /clients/alpha')
    expect(html).toContain('app · /clients/beta')
  })

  it('marks only tasks with pending permission requests as waiting for confirmation', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task = (id:string,pendingPermissionCount?:number) => ({id,title:`Task ${id}`,path:'/work',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null,pendingPermissionCount})
    const html=renderWorkbench({tasks:[task('WAITING',2),task('ZERO',0),task('ABSENT')],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null})
    expect(html).toMatch(/data-task-id="WAITING"[\s\S]*?aria-label="[^"]*进行中[^"]*2 项权限请求等你确认[^"]*"[\s\S]*?等你确认[\s\S]*?<\/button>/)
    expect(html.match(/class="wb-task-attention"/g)).toHaveLength(1)
  })

  it('keeps task rows to a title and one provider-state line while retaining full date and status accessibly', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task={id:'TASK',title:'A complete task title',path:'/work',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
    const html=renderWorkbench({tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null})
    expect(html).toMatch(/data-task-id="TASK"[^>]*aria-label="[^"]*A complete task title[^"]*Codex[^"]*进行中[^"]*更新于[^"]*"/)
    expect(html).toMatch(/class="wb-task-title"[^>]*title="A complete task title"/)
    expect(html).toMatch(/class="wb-task-meta"[\s\S]*class="wb-task-provider"[\s\S]*class="wb-status"[\s\S]*<\/span>\s*<\/button>/)
    expect(html).not.toMatch(/class="wb-task-meta"[\s\S]*?<time>/)
  })

  it('shows an escaped same-folder blocker without changing the queued task status', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const waitingFor={taskId:'BLOCKER',title:'Build <unsafe>',reason:'same_path'} as const
    const task={id:'WAITING',title:'Waiting task',path:'/work',providerId:'codex',status:'queued',createdAt:1,updatedAt:2,error:null,waitingFor}
    const html=renderWorkbench({tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:'WAITING',detail:{task,events:[
      {id:'u1',taskId:'WAITING',kind:'user',text:'Continue this queued work',createdAt:1},
    ],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
    expect(html).toContain('data-status="queued">等待中')
    expect(html).toContain('等待「Build &lt;unsafe&gt;」结束')
    expect(html).toContain('使用同一个文件夹')
    expect(html).not.toContain('Build <unsafe>')
    expect(html).toContain('data-action="cancel"')
  })

  it('explains nested-folder waiting without inventing progress', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const waitingFor={taskId:'PARENT',title:'Parent task',reason:'nested_path'} as const
    const task={id:'CHILD',title:'Child task',path:'/work/child',providerId:'claude',status:'queued',createdAt:1,updatedAt:2,error:null,waitingFor}
    const html=renderWorkbench({tasks:[task],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude',canWechat:false,selectedId:'CHILD',detail:{task,events:[
      {id:'u1',taskId:'CHILD',kind:'user',text:'Start in the child folder',createdAt:1},
      {id:'h1',taskId:'CHILD',kind:'system',text:'Queued after path check',createdAt:2},
    ],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
    expect(html).toContain('等待「Parent task」结束')
    expect(html).toContain('文件夹彼此包含')
    expect(html).not.toMatch(/预计|进度|第\s*\d+\s*位/)
  })

  it('distinguishes an unconfirmed writer exit from ordinary waiting and retains the metadata-absent fallback', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const blocked={id:'BLOCKED',title:'Blocked task',path:'/work',providerId:'codex',status:'queued',createdAt:1,updatedAt:2,error:null,waitingFor:{taskId:'OLD',title:'Old task',reason:'writer_not_closed'} as const}
    const blockedHtml=renderWorkbench({tasks:[blocked],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:'BLOCKED',detail:{task:blocked,events:[
      {id:'u1',taskId:'BLOCKED',kind:'user',text:'Continue after the previous run',createdAt:1},
      {id:'t1',taskId:'BLOCKED',kind:'text',text:'Previous response remains visible',createdAt:2},
    ],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
    expect(blockedHtml).toContain('等待执行程序退出确认')
    expect(blockedHtml).toMatch(/data-task-id="BLOCKED"[^>]*aria-label="[^"]*等待执行程序退出确认[^"]*"/)
    expect(blockedHtml).toContain('队列不会继续')
    expect(blockedHtml).toContain('检查原进程和输出')
    expect(blockedHtml).toContain('其他文件夹的任务仍可继续')
    expect(blockedHtml).toContain('data-action="cancel"')

    const ordinary={...blocked,id:'ORDINARY',waitingFor:null}
    const ordinaryHtml=renderWorkbench({tasks:[ordinary],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:'ORDINARY',detail:{task:ordinary,events:[],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
    expect(ordinaryHtml).toContain('任务已记下，正在等待执行。')
    expect(ordinaryHtml).not.toContain('等待执行程序退出确认')
  })

  it('说人话:持有者已答复即将自动让位时换文案+收工按钮，仍在写时保持原文案，writer_not_closed 不被盖掉', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const base={id:'WAITING',title:'Waiting task',path:'/work',providerId:'codex',status:'queued' as const,createdAt:1,updatedAt:2,error:null}
    const render=(waitingFor:import('./workbench.js').WaitingFor)=>renderWorkbench({tasks:[{...base,waitingFor}],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:'WAITING',detail:{task:{...base,waitingFor},events:[{id:'u1',taskId:'WAITING',kind:'user',text:'go',createdAt:1}],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
    // 持有者还在写:保持今天的文案，不报假的倒计时，也没有「收工」按钮。
    const writing=render({taskId:'A',title:'Holder',reason:'same_path',holderWriting:true,closeInMs:null})
    expect(writing).toContain('正在等待「Holder」结束')
    expect(writing).not.toContain('已答复，会话还开着')
    expect(writing).not.toContain('data-cancel-task-id')
    // 持有者已答复、计时武装:换成人话，「收工」按钮盯的是持有者的任务编号，不是这条排队任务自己。
    const idle=render({taskId:'A',title:'Holder',reason:'same_path',holderWriting:false,closeInMs:7000})
    expect(idle).toContain('「Holder」已答复，会话还开着')
    expect(idle).toContain('7 秒后自动让出文件夹')
    expect(idle).toMatch(/data-action="cancel"[^>]*data-cancel-task-id="A"/)
    // 秒数要向下取,宁可显示得比实际早:7500ms 是「7 秒」不是四舍五入出来的「8 秒」
    // (评审 #3——显示得比实际剩的更多就是反向说谎)。
    expect(render({taskId:'A',title:'Holder',reason:'same_path',holderWriting:false,closeInMs:7500})).toContain('7 秒后自动让出文件夹')
    // writer_not_closed 就算意外带了 holderWriting:false，也不能被新文案盖掉(终审 I3 的教训)。
    const writerNotClosed=render({taskId:'OLD',title:'Old',reason:'writer_not_closed',holderWriting:false,closeInMs:1000})
    expect(writerNotClosed).toContain('执行程序尚未确认退出')
    expect(writerNotClosed).not.toContain('已答复，会话还开着')
  })

  it('shows genuine pending permission counts for more than one running task', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task=(id:string,count:number)=>({id,title:id,path:`/${id}`,providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null,pendingPermissionCount:count})
    const html=renderWorkbench({tasks:[task('A',1),task('B',2)],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null})
    expect(html).toContain('aria-label="进行中，1 项权限请求等你确认"')
    expect(html).toContain('aria-label="进行中，2 项权限请求等你确认"')
    expect(html.match(/class="wb-task-attention"/g)).toHaveLength(2)
  })

  it('escapes pending permission text and binds each decision to its request id', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const state = {tasks:[],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude',canWechat:false,selectedId:'TASK',selectedArtifactId:null,error:'',preview:null,
      detail:{task:{id:'TASK',title:'Deploy',path:'/work',providerId:'claude',status:'running',createdAt:1,updatedAt:2,error:null},events:[],artifacts:[],permissions:[{id:'REQ<1>',taskId:'TASK',tool:'Shell <unsafe>',description:'Run <img src=x onerror=alert(1)>',createdAt:3}]}}
    const html = renderWorkbench(state)
    expect(html).toContain('Run &lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Shell &lt;unsafe&gt;')
    expect(html).toContain('data-request-id="REQ&lt;1&gt;"')
    expect(html).toContain('data-action="allow-permission"')
    expect(html).toContain('data-action="deny-permission"')
    expect(html.indexOf('class="wb-controls"')).toBeLessThan(html.indexOf('class="wb-permissions"'))
    expect(html.indexOf('class="wb-permissions"')).toBeLessThan(html.indexOf('class="wb-followup'))
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(renderWorkbench({...state,error:'offline'})).not.toMatch(/data-action="allow-permission"[^>]* disabled/)
  })

  it('keeps optional service and title fields in a closed disclosure, retaining their form values', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const html = renderWorkbench({tasks:[],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null})
    expect(html).toMatch(/<details[^>]*id="wb-options"[^>]*>/)
    expect(html).toContain('id="wb-provider"')
    expect(html).toContain('value="codex" selected')
    expect(html).toContain('id="wb-title"')
  })

  it('shows stop only while active and continuation only after a turn ends', async () => {
    const { renderTaskControls } = await import('./workbench.js')
    expect(renderTaskControls('running')).toContain('data-action="cancel"')
    expect(renderTaskControls('running')).not.toContain('data-action="continue"')
    expect(renderTaskControls('running')).toContain('id="wb-followup-text"')
    expect(renderTaskControls('running')).toContain('本轮结束后可发送')
    expect(renderTaskControls('running')).not.toMatch(/<button[^>]*disabled/)
    expect(renderTaskControls('running')).not.toContain('type="submit"')
    expect(renderTaskControls('queued')).toContain('data-action="cancel"')
    expect(renderTaskControls('queued')).not.toMatch(/<button[^>]*disabled/)
    expect(renderTaskControls('queued')).not.toContain('data-action="continue"')
    expect(renderTaskControls('queued')).not.toContain('type="submit"')
    const completed=renderTaskControls('completed')
    expect(completed).toContain('data-action="continue"')
    expect(completed).not.toContain('data-action="cancel"')
    expect(completed).toContain('<label class="wb-sr-only" for="wb-followup-text">继续这个任务</label>')
    expect(completed).toContain('placeholder="继续这个任务…"')
    for(const status of ['running','queued','cancelling','completed'])expect(renderTaskControls(status)).toContain('rows="2"')
  })

  it('puts full identity and optional WeChat continuation in closed task details', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task={id:'TASK1234',title:'Focused task',path:'/clients/alpha/project',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const html=renderWorkbench({tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:true,selectedId:'TASK1234',detail:{task,events:[],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
    expect(html).toMatch(/<header class="wb-task-head">[\s\S]*?<details id="wb-task-info" class="wb-task-info">/)
    expect(html).not.toMatch(/<details id="wb-task-info"[^>]* open/)
    expect(html).toContain('<summary>任务详情</summary>')
    expect(html).toContain('class="wb-task-context">project · Codex')
    expect(html).toContain('/clients/alpha/project')
    expect(html).toContain('TASK1234')
    expect(html).toContain('在微信继续')
    expect(html).toContain('data-action="copy-wechat-command"')
  })

  it('uses one conversation scroller and keeps the permission card with the composer dock', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task={id:'TASK',title:'Focused task',path:'/work',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
    const permission={id:'REQ',taskId:'TASK',tool:'Shell',description:'Run tests',createdAt:3}
    const html=renderWorkbench({tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:'TASK',detail:{task,events:[{id:'u1',taskId:'TASK',kind:'user',text:'Please test',createdAt:1}],artifacts:[],permissions:[permission]},selectedArtifactId:null,error:'',preview:null})
    expect(html).toMatch(/<main class="wb-main">[\s\S]*?<header class="wb-task-head">[\s\S]*?<div class="wb-content">[\s\S]*?class="wb-dialogue"[\s\S]*?<\/div>\s*<div class="wb-controls">/)
    expect(html.indexOf('class="wb-controls"')).toBeLessThan(html.indexOf('class="wb-permissions"'))
    expect(html.indexOf('class="wb-permissions"')).toBeLessThan(html.indexOf('id="wb-followup-text"'))
  })

  it('does not render an empty artifact disclosure', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const task={id:'TASK',title:'No artifacts',path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const html=renderWorkbench({tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:'TASK',detail:{task,events:[],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
    expect(html).not.toContain('id="wb-artifacts"')
    expect(html).not.toContain('data-action="show-artifacts"')
    expect(html).not.toContain('成果文件会在这里出现')
  })

  it('explains that no task can start when no work executor is available', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const html = renderWorkbench({tasks:[],providers:[],defaultProvider:'',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null})
    expect(html).toContain('暂时没有可用的工作执行者')
    expect(html).toContain('连接或管理')
    expect(html).not.toContain('安装')
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/)
  })

  it('offers an admitted non-brand executor as an ordinary review handoff target', async () => {
    const {renderWorkbench}=await import('./workbench.js')
    const task={id:'TASK',title:'Done',path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const html=renderWorkbench({tasks:[task],providers:[{id:'codex',displayName:'Codex'},{id:'local-managed',displayName:'Local Managed'}],defaultProvider:'codex',canWechat:false,selectedId:task.id,detail:{task,events:[{id:'reply',taskId:task.id,kind:'text',text:'完成',createdAt:2}],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
    expect(html).toContain('data-action="handoff-review"')
    expect(html).toContain('交给 Local Managed 检查')
  })

  it('shows a loading surface instead of the new-task form while opening a task from an empty view', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const html=renderWorkbench({tasks:[],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:null,loadingId:'TASK',detail:null,selectedArtifactId:null,error:'',preview:null})
    expect(html).toContain('正在打开任务')
    expect(html).not.toContain('id="wb-create-form"')
  })

  it('keeps the selected artifact version when a newer poll arrives', async () => {
    const { chooseArtifactId } = await import('./workbench.js')
    const artifacts = [
      { id: 'old', taskId: 'A1B2C3D4', name: 'report.md', mime: 'text/markdown', size: 1, sha256: 'a', createdAt: 1, approvedAt: null },
      { id: 'new', taskId: 'A1B2C3D4', name: 'report.md', mime: 'text/markdown', size: 2, sha256: 'b', createdAt: 2, approvedAt: null },
    ]
    expect(chooseArtifactId(artifacts, 'old')).toBe('old')
    expect(chooseArtifactId(artifacts, 'missing')).toBe('new')
  })

  it('keeps an opened preview and its controls when poll data is rendered', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const artifact = { id: 'a1', taskId: 'TASK', name: 'report.md', mime: 'text/markdown', size: 2, sha256: 'hash', createdAt: 2, approvedAt: null }
    const html = renderWorkbench({ tasks: [], providers: [], defaultProvider: 'codex', canWechat: false, selectedId: 'TASK', selectedArtifactId: 'a1', error: '', preview: { artifactId: 'a1', html: '<pre>safe preview</pre>' }, detail: { task: { id: 'TASK', title: 'Report', path: '/tmp', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }, events: [], artifacts: [artifact] } })
    expect(html).toContain('<pre>safe preview</pre>')
    expect(html).toMatch(/<details[^>]*id="wb-artifacts"[^>]*>/)
    expect(html).not.toMatch(/<details[^>]*id="wb-artifacts"[^>]* open/)
    expect(html).toContain('data-action="download-artifact"')
    expect(html).toContain('data-action="approve-artifact"')
    expect(html).toMatch(/<header class="wb-task-head">[\s\S]*?data-action="show-artifacts"[\s\S]*?<\/header>/)
    expect(html).toContain('data-action="back-to-dialogue"')
  })

  it('presents Markdown artifacts as documents while retaining escaped original text', async () => {
    const {renderWorkbenchArtifactText}=await import('./workbench.js')
    const text='# Findings\n\n| Item | Result |\n| --- | --- |\n| A | Passed |\n\n```js\nconst a = "<b>"\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))'
    const html=renderWorkbenchArtifactText('report.md','text/markdown',text)
    expect(html).toContain('<h1>Findings</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<code class="language-js">')
    expect(html).toContain('查看原文')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    expect(renderWorkbenchArtifactText('report.MD','text/plain','# Findings')).toContain('<h1>Findings</h1>')
    expect(renderWorkbenchArtifactText('page.html','text/html','<script>alert(1)</script>')).toBe('<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>')
  })

  it('shows the explicit WeChat continuation command only when available', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const base = { tasks: [], providers: [], defaultProvider: 'codex', selectedId: 'TASK1234', selectedArtifactId: null, error: '', preview: null, detail: { task: { id: 'TASK1234', title: 'Report', path: '/tmp', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }, events: [], artifacts: [] } }
    expect(renderWorkbench({ ...base, canWechat: true })).toContain('任务 TASK1234')
    expect(renderWorkbench({ ...base, canWechat: false })).not.toContain('在微信继续')
  })
})

describe('workbench drafts', () => {
  it('retains provider choice and scopes followups to their task', async () => {
    const { createWorkbenchDraftStore } = await import('./workbench.js')
    const drafts = createWorkbenchDraftStore()
    drafts.set('new', { path: '/work', text: 'draft', title: '', providerId: 'claude', followup: '' })
    drafts.set('task:A', { path: '', text: '', title: '', providerId: '', followup: 'for A' })
    expect(drafts.get('new').providerId).toBe('claude')
    expect(drafts.get('task:B').followup).toBe('')
    expect(drafts.get('task:A').followup).toBe('for A')
  })
})

describe('workbench request ordering', () => {
  it('opens the most recent task after the initial list loads', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    const invokeWorkbenchApi = vi.fn(async (_method: string, path: string) => path === '/v1/workbench'
      ? { tasks: [{ id: 'RECENT' }], providers: [], defaultProvider: 'codex', canWechat: false }
      : { task: { id: 'RECENT' }, events: [], artifacts: [] })
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: vi.fn() })
    await controller.refresh()
    expect(controller.state.selectedId).toBe('RECENT')
    expect(controller.state.detail?.task.id).toBe('RECENT')
  })

  it('clears a previous read error when reconnecting to an empty task list', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    const controller = createWorkbenchController({invokeWorkbenchApi:vi.fn(async()=>({tasks:[],providers:[],defaultProvider:'',canWechat:false})),render:vi.fn()})
    controller.state.error='连接失败'
    await controller.refresh()
    expect(controller.state.error).toBe('')
  })

  it('ignores a stale detail response after the user selects another task', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    let finishFirst!: (value: unknown) => void
    const first = new Promise(resolve => { finishFirst = resolve })
    const invokeWorkbenchApi = vi.fn((method: string, path: string) => {
      if (path.includes('id=FIRST')) return first
      return Promise.resolve({ task: { id: 'SECOND' }, events: [], artifacts: [] })
    })
    const renders: any[] = []
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: (state: unknown) => renders.push(structuredClone(state)) })
    const pending = controller.selectTask('FIRST')
    await controller.selectTask('SECOND')
    finishFirst({ task: { id: 'FIRST' }, events: [], artifacts: [] })
    await pending
    expect(renders.at(-1).selectedId).toBe('SECOND')
    expect(renders.at(-1).detail.task.id).toBe('SECOND')
  })

  it('ignores an older list response that arrives after a newer refresh', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    const oldTask={id:'OLD',title:'Old',path:'/old',providerId:'codex',status:'running',createdAt:1,updatedAt:1,error:null,pendingPermissionCount:0}
    const freshTask={id:'FRESH',title:'Fresh',path:'/fresh',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null,pendingPermissionCount:2}
    let finishOld!:(value:unknown)=>void
    const oldList=new Promise(resolve=>{finishOld=resolve})
    let listCalls=0
    const invokeWorkbenchApi=vi.fn((_method:string,path:string)=>{
      if(path==='/v1/workbench')return ++listCalls===1?oldList:Promise.resolve({tasks:[freshTask],providers:[],defaultProvider:'codex',canWechat:false})
      return Promise.resolve({task:freshTask,events:[],artifacts:[]})
    })
    const controller=createWorkbenchController({invokeWorkbenchApi,render:vi.fn()})
    const oldRefresh=controller.refresh()
    await controller.refresh()
    finishOld({tasks:[oldTask],providers:[],defaultProvider:'codex',canWechat:false})
    await oldRefresh
    expect(controller.state.tasks.map(task=>task.id)).toEqual(['FRESH'])
    expect(controller.state.tasks[0]?.pendingPermissionCount).toBe(2)
  })

  it('does not surface a stale list error after a newer refresh succeeds', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    const task={id:'FRESH',title:'Fresh',path:'/fresh',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    let rejectOld!:(reason?:unknown)=>void
    const oldList=new Promise((_resolve,reject)=>{rejectOld=reject})
    let listCalls=0
    const invokeWorkbenchApi=vi.fn((_method:string,path:string)=>path==='/v1/workbench'?(++listCalls===1?oldList:Promise.resolve({tasks:[task],providers:[],defaultProvider:'codex',canWechat:false})):Promise.resolve({task,events:[],artifacts:[]}))
    const controller=createWorkbenchController({invokeWorkbenchApi,render:vi.fn()})
    const oldRefresh=controller.refresh()
    await controller.refresh()
    rejectOld(new Error('stale list failed'))
    await expect(oldRefresh).resolves.toBeUndefined()
    expect(controller.state.selectedId).toBe('FRESH')
  })

  it('列表里挂着自动让位倒计时时，只有 closeInMs 在走不该拖出全量重画（评审修复轮 #1）', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    const render = vi.fn()
    const controller = createWorkbenchController({ invokeWorkbenchApi: vi.fn(async () => ({ tasks: [], providers: [], defaultProvider: '', canWechat: false })), render })
    const waiting = (closeInMs: number | null, holderWriting = false) => [{ id: 'B', title: 'Waiting', path: '/work', providerId: 'codex', status: 'queued' as const, createdAt: 1, updatedAt: 2, error: null, waitingFor: { taskId: 'A', title: 'Holder', reason: 'same_path' as const, holderWriting, closeInMs } }]
    controller.state.tasks = waiting(15_000)
    controller.paint()
    expect(render).toHaveBeenCalledTimes(1)
    // 模拟连续几轮列表轮询:每一轮里只有 closeInMs 在减小(后端按 Date.now() 现算),其余字段
    // 原样不动——这正是列表每 3 秒回来一次、挡路方计时武装着的那段窗口。
    for (const remaining of [12_000, 9_000, 6_000, 3_000, 0]) { controller.state.tasks = waiting(remaining); controller.paint() }
    expect(render).toHaveBeenCalledTimes(1)
    // 去重不是连带失效了:真正的转变(持有者不再安静，倒计时撤掉)照样要拖出重画。
    controller.state.tasks = waiting(null, true)
    controller.paint()
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('closeInMs 从 null(没计时)变成非 null(已武装)必须单独拖出重画，不能被抹平成同一个键（终审 M1）', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    const render = vi.fn()
    const controller = createWorkbenchController({ invokeWorkbenchApi: vi.fn(async () => ({ tasks: [], providers: [], defaultProvider: '', canWechat: false })), render })
    const waiting = (closeInMs: number | null) => [{ id: 'B', title: 'Waiting', path: '/work', providerId: 'codex', status: 'queued' as const, createdAt: 1, updatedAt: 2, error: null, waitingFor: { taskId: 'A', title: 'Holder', reason: 'same_path' as const, holderWriting: false, closeInMs } }]
    // holderWriting 全程不变:唯一的差异是 closeInMs 从 null 变成 15000——如果两者被抹平成同一个
    // paintKey，这个转变（补充投递失败后 armIdleClose 重新武装计时）就不会拖出重画，「收工」按钮
    // 永远不出现。
    controller.state.tasks = waiting(null)
    controller.paint()
    expect(render).toHaveBeenCalledTimes(1)
    controller.state.tasks = waiting(15_000)
    controller.paint()
    expect(render).toHaveBeenCalledTimes(2)
  })

})

describe('workbench mutations', () => {
  class FakeElement {
    id = ''
    tagName = ''
    value = ''
    selectionStart: number | null = null
    selectionEnd: number | null = null
    dataset: Record<string, string> = {}
    innerHTML = ''
    scrollTop = 0
    scrollHeight = 0
    clientHeight = 0
    hidden = false
    parentElement: FakeElement | null = null
    attributes = new Map<string, string>()
    listeners = new Map<string, Set<(event: any) => void>>()
    addEventListener(name: string, fn: (event: any) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(fn); this.listeners.set(name, set) }
    removeEventListener(name: string, fn: (event: any) => void) { this.listeners.get(name)?.delete(fn) }
    dispatchEvent(event:Event) { Object.defineProperty(event,'target',{value:this});for(let node:FakeElement|null=this;node;node=event.bubbles?node.parentElement:null)for(const fn of node.listeners.get(event.type)??[])fn(event);return true }
    closest(selector?: string) { return selector === 'button' || selector === 'summary' ? this : null }
    contains(element: unknown) { return element !== null }
    querySelector(_selector?: string): FakeElement | null { return null }
    focus() {}
    setSelectionRange(start: number, end: number) { this.selectionStart=start; this.selectionEnd=end }
    setAttribute(name:string,value:string) { this.attributes.set(name,value) }
    removeAttribute(name:string) { this.attributes.delete(name) }
    hasAttribute(name:string) { return this.attributes.has(name) }
    toggleAttribute(name:string,force?:boolean) { const next=force ?? !this.hasAttribute(name); if(next)this.setAttribute(name,'');else this.removeAttribute(name);return next }
  }

  function installFakePage(fields: Record<string, FakeElement> = {}, content?: FakeElement) {
    const page = new FakeElement()
    for(const field of Object.values(fields))field.parentElement=page
    if(content)(page as any).querySelector=(selector:string)=>selector==='.wb-content'?content:null
    root.document = {getElementById:(id:string)=>id==='workbench-root'?page:fields[id]??null,activeElement:null,createElement:()=>new FakeElement()}
    root.window = {}
    vi.stubGlobal('Element',FakeElement)
    return page
  }

  function installDraftPage(nativeProviderSelect = false) {
    const fields = Object.fromEntries(['wb-project-form', 'wb-create-form', 'wb-path', 'wb-create-text', 'wb-title', 'wb-provider'].map(id => {
      const field = new FakeElement(); field.id = id; field.tagName = id.endsWith('-form') ? 'FORM' : ''; return [id, field]
    }))
    const page = installFakePage(fields)
    let html = ''
    let providerOptions: string[] = [], selectedProvider = ''
    // A real select cannot retain a value absent from its options. In particular,
    // restoring a saved executor into an empty loading select yields value=''.
    if (nativeProviderSelect) Object.defineProperty(fields['wb-provider'], 'value', { get: () => selectedProvider, set: value => { selectedProvider = providerOptions.includes(value) ? value : '' } })
    Object.defineProperty(page, 'innerHTML', { get: () => html, set: value => {
      html = value
      for (const field of Object.values(fields)) field.value = ''
      if (nativeProviderSelect) {
        const select = html.match(/<select id="wb-provider"[\s\S]*?<\/select>/)?.[0] ?? ''
        providerOptions = [...select.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]!)
        fields['wb-provider']!.value = select.match(/<option value="([^"]*)" selected/)?.[1] ?? providerOptions[0] ?? ''
      } else fields['wb-provider']!.value = 'codex'
    } })
    root.document = { getElementById: (id: string) => id === 'workbench-root' ? page : html.includes(`id="${id}"`) ? fields[id] : null, activeElement: null }
    return { page, fields }
  }

  it('preserves the project executor when chat metadata paints before provider options load', async () => {
    const { page, fields } = installDraftPage(true)
    const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    root.window = { sessionStorage: storage }
    const { createWorkbenchDraftStore, saveWorkbenchView } = await import('./workbench-window-state.js')
    createWorkbenchDraftStore(storage).set('new:/work/B', { path: '/work/B', text: 'B 项目的原草稿', title: '', providerId: 'claude', followup: '' })
    saveWorkbenchView(storage, { scope: 'new:/work/B', query: { q: '', archived: 'exclude' }, search: '' })
    const list = { tasks: [], projects: [{ id: 'B', path: '/work/B', name: 'B', providerId: 'claude' }], projectProviders: { '/work/B': 'claude' }, providers: [{ id: 'codex', displayName: 'Codex' }, { id: 'claude', displayName: 'Claude' }], defaultProvider: 'codex', canWechat: false }
    let finish!: (value: typeof list) => void
    const pendingList = new Promise<typeof list>(resolve => { finish = resolve })
    const api = async (_method: string, path: string) => path === '/v1/workbench' ? pendingList : { matters: [] }
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    try {
      await vi.waitFor(() => expect(page.innerHTML).toContain('id="wb-provider"'))
      expect(fields['wb-provider']!.value).toBe('')
      controller.paint(true)
      expect(createWorkbenchDraftStore(storage).get('new:/work/B').providerId).toBe('claude')
      finish(list)
      await vi.waitFor(() => expect(controller.state.providers).toHaveLength(2))
      expect(fields['wb-provider']!.value).toBe('claude')
      expect(fields['wb-create-text']!.value).toBe('B 项目的原草稿')
    } finally { finish(list); module.stopWorkbenchPolling() }
  })

  it('prepares a chat request in the existing project form and preserves its unsent draft and executor', async () => {
    const { page, fields } = installDraftPage()
    const project = { id: 'site', name: '网站', path: '/work/site', providerId: 'codex' }
    const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    root.window = { sessionStorage: storage }
    const { createWorkbenchDraftStore } = await import('./workbench-window-state.js')
    const attachment = { id: '12345678-1234-1234-1234-123456789abc', name: 'context.txt', mime: 'text/plain', size: 1, sha256: 'a'.repeat(64), status: 'ready' as const }
    const execution = { defaults: 'native' as const, model: 'chosen-model', reasoningEffort: 'high' }
    createWorkbenchDraftStore(storage).set('new:/work/site', { path: project.path, text: '', title: '', providerId: 'codex', followup: '', attachments: [attachment], execution })
    const list = { projects: [project], tasks: [], projectProviders: { '/work/site': 'claude' }, providers: [{ id: 'codex', displayName: 'Codex' }, { id: 'claude', displayName: 'Claude' }], defaultProvider: 'codex', canWechat: false }
    const api = vi.fn(async (_method: string, _path: string) => list)
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    try {
      await controller.refresh()
      const projectNew = new FakeElement(); projectNew.dataset = { action: 'new-project-task', projectPath: project.path }
      await [...page.listeners.get('click')!][0]!({ target: projectNew })
      fields['wb-create-text']!.value = '原来的未发要求'
      fields['wb-title']!.value = '原来的名称'
      fields['wb-provider']!.value = 'codex'
      expect(await module.openWorkbenchDraft?.({ path: project.path, text: '这次聊天交办的要求', providerId: 'claude' })).toBe(true)
      expect(controller.state.selectedId).toBeNull()
      expect(controller.state.newScope).toBe('new:/work/site')
      expect(fields['wb-create-text']!.value).toBe('原来的未发要求\n\n—— 从聊天交办 ——\n这次聊天交办的要求')
      expect(fields['wb-title']!.value).toBe('原来的名称')
      expect(fields['wb-provider']!.value).toBe('codex')
      const stored = createWorkbenchDraftStore(storage).get('new:/work/site')
      expect(stored.attachments).toEqual([attachment])
      expect(stored.execution).toEqual(execution)
      expect(api.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    } finally { module.stopWorkbenchPolling() }
  })

  it('waits for project metadata and uses the latest executor when handing over a new draft', async () => {
    const { fields } = installDraftPage()
    const api = vi.fn(async (_method: string, _path: string) => ({ projects: [{ id: 'p', name: 'Project', path: '/work', providerId: 'codex' }], tasks: [], projectProviders: { '/work': 'claude' }, providers: [{ id: 'codex', displayName: 'Codex' }, { id: 'claude', displayName: 'Claude' }], defaultProvider: 'codex', canWechat: false }))
    const module = await import('./workbench.js')
    module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    try {
      expect(await module.openWorkbenchDraft?.({ path: '/work', text: '检查文档' })).toBe(true)
      expect(fields['wb-create-text']!.value).toBe('检查文档')
      expect(fields['wb-path']!.value).toBe('/work')
      expect(fields['wb-provider']!.value).toBe('claude')
      expect(api.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    } finally { module.stopWorkbenchPolling() }
  })

  it('keeps the handover request through adding a project, including a failed first attempt', async () => {
    const { page, fields } = installDraftPage()
    const originalFormData = globalThis.FormData
    vi.stubGlobal('FormData', class {
      values = new Map([['path', fields['wb-path']!.value], ['name', fields['wb-title']!.value], ['providerId', fields['wb-provider']!.value]])
      get(name: string) { return this.values.get(name) ?? null }
    })
    const project = { id: 'p', name: 'New project', path: '/work/new', providerId: 'claude' }
    let added = false, failAdd = true
    const api = vi.fn(async (method: string, path: string) => {
      if (method === 'POST') {
        if (path !== '/v1/workbench/project') throw Error('Unexpected task execution')
        if (failAdd) { failAdd = false; throw Error('offline') }
        added = true; return { project }
      }
      return { projects: added ? [project] : [], tasks: [], projectProviders: {}, providers: [{ id: 'codex', displayName: 'Codex' }, { id: 'claude', displayName: 'Claude' }], defaultProvider: 'codex', canWechat: false }
    })
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    try {
      expect(await module.openWorkbenchDraft?.({ path: '', text: '添加项目后仍需保留', providerId: 'claude' })).toBe(true)
      expect(page.innerHTML).toContain('id="wb-project-form"')
      expect(page.innerHTML).toContain('添加项目后仍需保留')
      fields['wb-path']!.value = '/work/new'
      fields['wb-title']!.value = 'New project'
      fields['wb-provider']!.value = 'claude'
      const submit = [...page.listeners.get('submit')!][0]!
      await submit({ target: fields['wb-project-form'], preventDefault() {} })
      expect(controller.state.error).toBe('offline')
      await controller.refresh()
      await submit({ target: fields['wb-project-form'], preventDefault() {} })
      expect(page.innerHTML).toContain('id="wb-create-form"')
      expect(fields['wb-create-text']!.value).toBe('添加项目后仍需保留')
      expect(fields['wb-path']!.value).toBe('/work/new')
      expect(fields['wb-provider']!.value).toBe('claude')
      expect(api.mock.calls.filter(([method]) => method === 'POST').map(([, path]) => path)).toEqual(['/v1/workbench/project', '/v1/workbench/project'])
    } finally { module.stopWorkbenchPolling(); vi.stubGlobal('FormData', originalFormData) }
  })

  it('does not accept a handover into a project that disappeared while opening the workbench', async () => {
    installDraftPage()
    const module = await import('./workbench.js')
    module.initWorkbenchPage({ invokeWorkbenchApi: async () => ({ projects: [], tasks: [], providers: [], defaultProvider: null, canWechat: false }), pollMs: 60_000 })
    try { expect(await module.openWorkbenchDraft({ path: '/gone', text: '保留在聊天里' })).toBe(false) }
    finally { module.stopWorkbenchPolling() }
  })

  it('saves a native folder selection and refreshes the catalog for that selected directory',async()=>{
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
    const fields=Object.fromEntries(['wb-create-form','wb-path','wb-create-text','wb-provider'].map(id=>{const f=new FakeElement();f.id=id;f.tagName=id==='wb-path'?'INPUT':'';return[id,f]}))
    const page=installFakePage(fields);root.window={sessionStorage:storage}
    const settings=new FakeElement();settings.id='wb-options';settings.setAttribute('open','')
    page.querySelector=selector=>selector==='#wb-options[open]'?settings:null
    const api=vi.fn(async(_method:string,path:string)=>path.startsWith('/v1/workbench/models?')?{catalog:{source:'native',models:[{id:'model-for-'+new URLSearchParams(path.split('?')[1]).get('path'),displayName:'Selected folder model',reasoningEfforts:[]}]}}:{tasks:[],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex'})
    const invoke=vi.fn(async()=>'/selected folder')
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,invoke,pollMs:100000})!
    await vi.waitFor(()=>expect(controller.state.providers).toHaveLength(1))
    fields['wb-path']!.value='/before';fields['wb-provider']!.value='codex'
    await [...page.listeners.get('toggle')!][0]!({target:settings})
    await vi.waitFor(()=>expect(api).toHaveBeenCalledWith('GET','/v1/workbench/models?providerId=codex&path=%2Fbefore'))
    const choose=new FakeElement();choose.dataset.action='choose-folder'
    await [...page.listeners.get('click')!][0]!({target:choose})
    await vi.waitFor(()=>expect(api).toHaveBeenCalledWith('GET','/v1/workbench/models?providerId=codex&path=%2Fselected+folder'))
    expect(invoke).toHaveBeenCalledWith('choose_workbench_folder',{})
    const {createWorkbenchDraftStore}=await import('./workbench-window-state.js')
    expect(createWorkbenchDraftStore(storage).get('new').path).toBe('/selected folder')
    expect(fields['wb-path']!.value).toBe('/selected folder')
    module.stopWorkbenchPolling()
  })

  it.each(['new-scope','task'] as const)('ignores a late native folder result after navigating to %s',async destination=>{
    const fields=Object.fromEntries(['wb-create-form','wb-path','wb-create-text','wb-provider','wb-followup-text'].map(id=>{const f=new FakeElement();f.id=id;return[id,f]})),page=installFakePage(fields)
    const task={id:'deadbeef',title:'Task',path:'/task',providerId:'codex',status:'completed',createdAt:1,updatedAt:2}
    const api=vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex'}:{task,events:[],artifacts:[]})
    let finish!:(path:string)=>void
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,invoke:async()=>await new Promise<string>(resolve=>{finish=resolve}),pollMs:100000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe(task.id))
    const click=[...page.listeners.get('click')!][0]!,create=new FakeElement();create.dataset.action='new-task';await click({target:create})
    fields['wb-path']!.value='/original';fields['wb-provider']!.value='codex'
    const choose=new FakeElement();choose.dataset.action='choose-folder';const choosing=click({target:choose})
    const next=new FakeElement();next.dataset=destination==='task'?{taskId:task.id}:{action:'new-project-task',projectPath:'/other'}
    await click({target:next})
    fields['wb-path']!.value='/current';fields['wb-followup-text']!.value='Current draft'
    finish('/late-picked');await choosing
    expect(fields['wb-path']!.value).toBe('/current');expect(fields['wb-followup-text']!.value).toBe('Current draft')
    expect(api.mock.calls.some(([,path])=>path.includes('late-picked'))).toBe(false)
    expect(controller.state.error).toBe('')
    module.stopWorkbenchPolling()
  })

  it('restores automatic selection, submits a frozen execution choice and preserves later setting edits',async()=>{
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
    const automatic={defaults:'native' as const,model:null,reasoningEffort:null},stored={...automatic,model:'old-model'}
    const {createWorkbenchDraftStore,saveWorkbenchView}=await import('./workbench-window-state.js')
    createWorkbenchDraftStore(storage).set('task:deadbeef',{path:'',text:'',title:'',providerId:'',followup:'Continue',execution:automatic})
    saveWorkbenchView(storage,{scope:'task:deadbeef',query:{q:'',archived:'exclude'},search:''})
    const fields=Object.fromEntries(['wb-followup-text','wb-model','wb-reasoning-effort'].map(id=>{const f=new FakeElement();f.id=id;return[id,f]}))
    fields['wb-model']!.value='old-model'
    const page=installFakePage(fields);root.window={sessionStorage:storage}
    const task={id:'deadbeef',title:'Task',path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:2}
    let sent:any,finish!:(value:any)=>void
    const api=async(method:string,path:string,body?:any)=>method==='POST'?(sent=body,await new Promise(resolve=>{finish=resolve})):path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex'}:{task,events:[],artifacts:[],execution:stored}
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe(task.id));expect(fields['wb-model']!.value).toBe('')
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    const submitting=[...page.listeners.get('submit')!][0]!({target:form,preventDefault(){}})
    await vi.waitFor(()=>expect(sent).toBeTruthy());expect(sent.execution).toEqual(automatic)
    fields['wb-model']!.value='new-model'
    await [...page.listeners.get('change')!][0]!({target:fields['wb-model']})
    finish({task});await submitting
    const kept=createWorkbenchDraftStore(storage).get('task:deadbeef')
    expect(kept.execution?.model).toBe('new-model');expect(kept.followup).toBe('Continue')
    module.stopWorkbenchPolling()
  })

  it('loads models only after opening settings and invalidates prepared native continuation after an execution edit',async()=>{
    const fields=Object.fromEntries(['wb-followup-text','wb-model','wb-reasoning-effort'].map(id=>{const f=new FakeElement();f.id=id;return[id,f]}))
    const page=installFakePage(fields),settings=new FakeElement();settings.id='wb-task-info';settings.tagName='DETAILS'
    page.querySelector=selector=>selector==='#wb-task-info[open]'&&settings.hasAttribute('open')?settings:null
    const task={id:'deadbeef',title:'Task',path:'/work A',providerId:'codex',status:'completed',createdAt:1,updatedAt:2}
    const execution={defaults:'native' as const,model:null,reasoningEffort:null}
    const api=vi.fn(async(_method:string,path:string)=>path.startsWith('/v1/workbench/models?')?{catalog:{source:'native',models:[{id:'native-model',displayName:'Native model',reasoningEfforts:['deep']}]}}:path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex'}:{task,events:[],artifacts:[],execution,requiresExternalClose:true})
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe(task.id));expect(api.mock.calls.some(c=>c[1].startsWith('/v1/workbench/models'))).toBe(false)
    settings.setAttribute('open','');await [...page.listeners.get('toggle')!][0]!({target:settings})
    await vi.waitFor(()=>expect(page.innerHTML).toContain('Native model'))
    expect(api).toHaveBeenCalledWith('GET','/v1/workbench/models?providerId=codex&path=%2Fwork+A')
    controller.state.nativeResume={taskId:task.id,token:'prepared'} as any
    fields['wb-model']!.value='native-model';await [...page.listeners.get('change')!][0]!({target:fields['wb-model']})
    expect(controller.state.nativeResume).toBeNull()
    module.stopWorkbenchPolling()
  })

  it('waits for the chosen restart preview and ignores late original-choice responses and stale submit tokens',async()=>{
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
    const execution={defaults:'native' as const,model:'A',reasoningEffort:null}
    const {createWorkbenchDraftStore,saveWorkbenchView}=await import('./workbench-window-state.js')
    createWorkbenchDraftStore(storage).set('task:deadbeef',{path:'',text:'',title:'',providerId:'',followup:'Restart please',execution})
    saveWorkbenchView(storage,{scope:'task:deadbeef',query:{q:'',archived:'exclude'},search:''})
    const fields=Object.fromEntries(['wb-followup-text','wb-model','wb-reasoning-effort'].map(id=>{const f=new FakeElement();f.id=id;return[id,f]})),page=installFakePage(fields);root.window={sessionStorage:storage}
    const task={id:'deadbeef',title:'Task',path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:2}
    const preview=(token:string,context:string)=>({mode:'restart_required',restart:{token,context,eventCount:1,includedEventCount:1,truncated:false}})
    const pending=new Map<string,{resolve:(value:any)=>void,reject:(error:any)=>void}>(),sent:any[]=[]
    const api=async(method:string,path:string,body?:any)=>{
      if(path==='/v1/workbench/prepare-continuation')return await new Promise((resolve,reject)=>pending.set(body.execution.model,{resolve,reject}))
      if(method==='POST'){sent.push(body);return{task}}
      return path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex'}:{task,events:[],artifacts:[],execution,continuation:preview('a'.repeat(64),'original preview A')}
    }
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    await vi.waitFor(()=>expect(pending.has('A')).toBe(true))
    fields['wb-model']!.value='B';await [...page.listeners.get('change')!][0]!({target:fields['wb-model']})
    await vi.waitFor(()=>expect(pending.has('B')).toBe(true))
    expect(page.innerHTML).not.toContain('original preview A');expect(page.innerHTML).toMatch(/type="submit" disabled/)
    const form=new FakeElement();form.tagName='FORM';form.dataset={action:'restart',restartToken:'a'.repeat(64)}
    const submit=[...page.listeners.get('submit')!][0]!
    await submit({target:form,preventDefault(){}});expect(sent).toHaveLength(0)
    pending.get('B')!.reject(Error('lost_response'));await vi.waitFor(()=>expect(page.innerHTML).toContain('重新读取恢复说明'))
    const retry=new FakeElement();retry.dataset.action='retry-continuation-preview';await [...page.listeners.get('click')!][0]!({target:retry})
    pending.get('B')!.resolve({continuation:preview('b'.repeat(64),'chosen preview B')})
    await vi.waitFor(()=>expect(page.innerHTML).toContain('chosen preview B'))
    pending.get('A')!.resolve({continuation:preview('a'.repeat(64),'late preview A')});await new Promise(resolve=>setTimeout(resolve,0))
    expect(page.innerHTML).not.toContain('late preview A')
    await submit({target:form,preventDefault(){}});expect(sent).toHaveLength(0)
    form.dataset.restartToken='b'.repeat(64)
    await submit({target:form,preventDefault(){}})
    expect(sent[0]).toMatchObject({execution:{...execution,model:'B'},restartToken:'b'.repeat(64)})
    module.stopWorkbenchPolling()
  })

  it('shows an actionable execution failure after submission and retains the draft',async()=>{
    const field=new FakeElement();field.id='wb-followup-text'
    const page=installFakePage({'wb-followup-text':field})
    const task={id:'deadbeef',title:'Task',path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:2}
    const api=async(method:string,path:string)=>{
      if(method==='POST')throw Error('execution_model_unsupported')
      return path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex'}:{task,events:[],artifacts:[]}
    }
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe(task.id))
    field.value='Keep my request'
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    await [...page.listeners.get('submit')!][0]!({target:form,preventDefault(){}})
    expect(controller.state.error).toContain('重新选择模型');expect(controller.state.error).not.toContain('execution_model_unsupported')
    expect(field.value).toBe('Keep my request')
    module.stopWorkbenchPolling()
  })

  it('keeps uploaded files with the initiating task and submits attachment-only continuation',async()=>{
    const field=new FakeElement();field.id='wb-followup-text'
    const picker=new FakeElement();picker.id='wb-attachment-files';picker.tagName='INPUT'
    const page=installFakePage({'wb-followup-text':field,'wb-attachment-files':picker})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const tasks=[{id:'deadbeef',title:'A',path:'/A',providerId:'claude',status:'completed',createdAt:1,updatedAt:2},{id:'cafefeed',title:'B',path:'/B',providerId:'claude',status:'completed',createdAt:1,updatedAt:1}]
    let upload!:(value:any)=>void;let uploadedId='';const calls:any[]=[]
    const api=async(method:string,path:string,body?:any)=>{
      calls.push({method,path,body})
      if(path==='/v1/workbench/attachment'){uploadedId=body.id;return await new Promise(resolve=>{upload=resolve})}
      if(path==='/v1/workbench/continue')return {task:tasks[0]}
      if(path.startsWith('/v1/workbench/task'))return {task:tasks.find(t=>path.includes(t.id)),events:[],artifacts:[]}
      return {tasks,providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude'}
    }
    class Reader{result='data:text/plain;base64,aGVsbG8=';onload?:()=>void;readAsDataURL(){this.onload?.()}}
    vi.stubGlobal('FileReader',Reader)
    const controller=initWorkbenchPage({invokeWorkbenchApi:api,pollMs:60_000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe('deadbeef'))
    ;(picker as any).files=[new File(['hello'],'notes.txt',{type:'text/plain'})]
    await Promise.all([...page.listeners.get('change')!].map(fn=>fn({target:picker})))
    await vi.waitFor(()=>expect(upload).toBeTypeOf('function'))
    await controller.selectTask('cafefeed');field.value='keep B'
    upload({attachment:{id:uploadedId,name:'notes.txt',mime:'text/plain',size:5,sha256:'a'.repeat(64)}})
    await vi.waitFor(()=>expect(calls.filter(c=>c.path==='/v1/workbench/attachment')).toHaveLength(1))
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(field.value).toBe('keep B')
    await controller.selectTask('deadbeef');field.value=''
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    await Promise.all([...page.listeners.get('submit')!].map(fn=>fn({target:form,preventDefault(){}})))
    expect(calls.find(c=>c.path==='/v1/workbench/continue')?.body).toMatchObject({id:'deadbeef',text:'',attachmentIds:[uploadedId],draftId:expect.any(String)})
    stopWorkbenchPolling()
  })

  it.each([false,true])('recovers attachment-only terminal continuation after a lost response and reload, edited=%s',async edited=>{
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
    const a={id:crypto.randomUUID(),name:'notes.txt',mime:'text/plain',size:5,sha256:'a'.repeat(64),status:'ready' as const},draftId=crypto.randomUUID()
    const {createWorkbenchDraftStore,saveWorkbenchView}=await import('./workbench-window-state.js')
    createWorkbenchDraftStore(storage).set('task:deadbeef',{path:'/work',text:'',title:'',providerId:'claude',followup:'',draftId,attachments:[a]})
    saveWorkbenchView(storage,{scope:'task:deadbeef',query:{q:'',archived:'exclude'},search:''})
    const field=new FakeElement();field.id='wb-followup-text'
    const page=installFakePage({'wb-followup-text':field});root.window={sessionStorage:storage}
    const task={id:'deadbeef',title:'A',path:'/work',providerId:'claude',status:'completed',createdAt:1,updatedAt:2}
    const accepted=new Map<string,any>(),requests:any[]=[];let showReceipts=false
    const api=async(method:string,path:string,body?:any)=>{
      if(path==='/v1/workbench/continue'){
        requests.push(body);if(!accepted.has(body.inputRequestId))accepted.set(body.inputRequestId,{id:body.inputRequestId,taskId:task.id,runId:crypto.randomUUID(),text:body.text.trim(),attachments:[a],status:'delivered',createdAt:1,error:null})
        throw Error('response_lost')
      }
      if(path.startsWith('/v1/workbench/task'))return{task,events:[],artifacts:[],inputs:showReceipts?[...accepted.values()]:[]}
      return{tasks:[task],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude'}
    }
    const old=await import('./workbench.js'),controller=old.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe(task.id))
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    await [...page.listeners.get('submit')!][0]!({target:form,preventDefault(){}})
    expect(requests[0].inputRequestId).toEqual(expect.any(String))
    old.stopWorkbenchPolling();vi.resetModules()
    const nextField=new FakeElement();nextField.id='wb-followup-text'
    const nextPage=installFakePage({'wb-followup-text':nextField});root.window={sessionStorage:storage}
    const next=await import('./workbench.js'),mounted=next.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    await vi.waitFor(()=>expect(mounted.state.selectedId).toBe(task.id))
    expect(createWorkbenchDraftStore(storage).get('task:deadbeef').attachments?.map(a=>a.id)).toEqual([a.id])
    await [...nextPage.listeners.get('submit')!][0]!({target:form,preventDefault(){}})
    expect(requests[1].inputRequestId).toBe(requests[0].inputRequestId);expect(accepted.size).toBe(1)
    if(edited){nextField.value='New followup';for(const listener of nextPage.listeners.get('input')??[])listener({target:nextField})}
    showReceipts=true;task.updatedAt++;await mounted.refresh({force:true})
    const kept=createWorkbenchDraftStore(storage).get('task:deadbeef')
    expect(nextField.value).toBe(edited?'New followup':'');expect(kept.attachments?.map(a=>a.id)).toEqual(edited?[a.id]:[])
    next.stopWorkbenchPolling()
  })

  it.each(['create','create-add','continue','restart','native-continue','send-input'])('sends attachments through %s and retains a composer edited during submission',async actionName=>{
    const action=actionName==='create-add'?'create':actionName
    const scope=action==='create'?'new':'task:deadbeef',values=new Map<string,string>()
    const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
    const a={id:crypto.randomUUID(),name:'notes.txt',mime:'text/plain',size:5,sha256:'a'.repeat(64),status:'ready' as const},draftId=crypto.randomUUID()
    const {createWorkbenchDraftStore,saveWorkbenchView}=await import('./workbench-window-state.js')
    const drafts=createWorkbenchDraftStore(storage)
    drafts.set(scope,{path:'/work',text:'Keep the request',title:'',providerId:'claude',followup:'Keep the request',draftId,attachments:[a]})
    saveWorkbenchView(storage,{scope,query:{q:'',archived:'exclude'},search:''})
    const fields=Object.fromEntries((action==='create'?['wb-create-form','wb-path','wb-create-text','wb-title','wb-provider']:['wb-followup-text']).map(id=>{const f=new FakeElement();f.id=id;return[id,f]}))
    const page=installFakePage(fields);root.window={sessionStorage:storage}
    const originalFormData=globalThis.FormData
    vi.stubGlobal('FormData',class{get(name:string){return fields[{'path':'wb-path','text':'wb-create-text','title':'wb-title','providerId':'wb-provider'}[name]??'']?.value??''}})
    const task={id:'deadbeef',title:'A',path:'/work',providerId:'claude',status:action==='send-input'?'running':'completed',createdAt:1,updatedAt:2}
    let finish!:(value:any)=>void;let sent:any;let addedId=''
    const api=async(method:string,path:string,body?:any)=>{
      if(path==='/v1/workbench/attachment'){addedId=body.id;return{attachment:{...a,id:addedId,name:body.name}}}
      if(path==='/v1/workbench/discard-attachment')return{ok:true}
      if(method==='POST'){sent=body;return await new Promise(resolve=>{finish=resolve})}
      if(path.startsWith('/v1/workbench/task'))return {task,events:[],artifacts:[],runId:'run-A',inputMode:'steer',...(action==='restart'?{continuation:{mode:'restart_required',restart:{token:'a'.repeat(64),context:'history',eventCount:1,includedEventCount:1,truncated:false}}}:{})}
      return {tasks:[task],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude'}
    }
    const module=await import('./workbench.js');const controller=module.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:60_000})!
    await vi.waitFor(()=>expect(action==='create'?controller.state.providers.length:controller.state.selectedId).toBe(action==='create'?1:'deadbeef'))
    const form=action==='create'?fields['wb-create-form']!:new FakeElement();form.tagName='FORM';form.dataset={action,ownerTask:'deadbeef',runId:'run-A',restartToken:'a'.repeat(64),nativeToken:'b'.repeat(64)}
    const submitting=[...page.listeners.get('submit')!][0]!({target:form,preventDefault(){}})
    await vi.waitFor(()=>expect(sent).toBeTruthy());expect(sent).toMatchObject({text:'Keep the request',attachmentIds:[a.id],draftId})
    if(actionName==='create-add'){
      class Reader{result='data:text/plain;base64,aGVsbG8=';onload?:()=>void;readAsDataURL(){this.onload?.()}};vi.stubGlobal('FileReader',Reader)
      const field=fields['wb-create-text']!;field.closest=()=>form
      await [...page.listeners.get('drop')!][0]!({target:field,preventDefault(){},dataTransfer:{files:[new File(['hello'],'new.txt',{type:'text/plain'})]}})
      await vi.waitFor(()=>expect(addedId).toBeTruthy())
    }else{
      const remove=new FakeElement();remove.dataset={action:'remove-attachment',attachmentId:a.id}
      await [...page.listeners.get('click')!][0]!({target:remove})
    }
    finish(action==='send-input'?{input:{id:sent.requestId,taskId:'deadbeef',runId:'run-A',text:sent.text,attachments:[a],status:'pending',createdAt:1,error:null}}:{task});await submitting
    const kept=createWorkbenchDraftStore(storage).get(scope)
    expect(action==='create'?kept.text:kept.followup).toBe('Keep the request');expect(kept.attachments?.map(a=>a.id)).toEqual(actionName==='create-add'?[addedId]:[])
    module.stopWorkbenchPolling();vi.stubGlobal('FormData',originalFormData)
  })

  it('opens attention targets without sending and keeps newer navigation plus the old task draft', async () => {
    const field = new FakeElement(); field.id = 'wb-followup-text'
    installFakePage({ 'wb-followup-text': field })
    let finish!: (value: unknown) => void
    const task = (id: string) => ({ id, title: id, path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null })
    const detail = (id: string) => ({ task: task(id), events: [], artifacts: [] })
    const api = vi.fn(async (_method: string, path: string) => path === '/v1/workbench' ? { tasks: [task('A')], providers: [], defaultProvider: '', canWechat: false } : path.endsWith('B') ? new Promise(resolve => { finish = resolve }) : detail(path.endsWith('C') ? 'C' : 'A'))
    const module = await import('./workbench.js')
    module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 100000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    field.value = 'Keep A draft'
    const opening = module.openWorkbenchTask('B')
    expect(module.getActiveWorkbenchTaskId()).toBe('B')
    await module.openWorkbenchTask('C'); finish(detail('B')); await opening
    expect(module.getActiveWorkbenchTaskId()).toBe('C')
    await module.openWorkbenchTask('A'); expect(field.value).toBe('Keep A draft')
    expect(api.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    module.stopWorkbenchPolling(); expect(module.getActiveWorkbenchTaskId()).toBeNull()
  })

  it('sends a run-bound supplement once, preserves edits and ignores a detached stale form', async () => {
    const field = new FakeElement(); field.id = 'wb-followup-text'
    const page = installFakePage({ 'wb-followup-text': field })
    let finish!: (value: unknown) => void
    const task = (id: string) => ({ id, title: id, path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null })
    const posts: any[] = []
    const api = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'POST') { posts.push(body); return new Promise(resolve => { finish = resolve }) }
      const id = path.endsWith('B') ? 'B' : 'A'
      return path === '/v1/workbench' ? { tasks: [task('A'), task('B')], providers: [], defaultProvider: '', canWechat: false } : { task: task(id), events: [], artifacts: [], runId: 'run-' + id, inputMode: 'steer' }
    })
    const module = await import('./workbench.js')
    module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 100000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    field.value = 'For A'
    const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'send-input', ownerTask: 'A', runId: 'run-A' }
    const submit = [...page.listeners.get('submit')!][0]!
    const sending = submit({ target: form, preventDefault() {} })
    await submit({ target: form, preventDefault() {} })
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ id: 'A', runId: 'run-A', text: 'For A' })
    await module.openWorkbenchTask('B'); field.value = 'For B'
    await submit({ target: form, preventDefault() {} }); expect(posts).toHaveLength(1)
    finish({ input: { id: posts[0].requestId, taskId: 'A', runId: 'run-A', text: 'For A', status: 'delivered', createdAt: 1, error: null } }); await sending
    expect(module.getActiveWorkbenchTaskId()).toBe('B'); expect(field.value).toBe('For B')
    module.stopWorkbenchPolling()
  })

  it('saves a task draft on input before polling and restores the selected task after page reload', async () => {
    const stored = new Map<string,string>()
    const storage = { getItem:(key:string)=>stored.get(key)??null, setItem:(key:string,value:string)=>{stored.set(key,value)}, removeItem:(key:string)=>{stored.delete(key)} }
    const field = new FakeElement(); field.id = 'wb-followup-text'
    const page = installFakePage({'wb-followup-text':field})
    root.window = {sessionStorage:storage}
    const task = (id:string)=>({id,title:id,path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null})
    const api = vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[task('aaaaaaaa'),task('bbbbbbbb')],providers:[],defaultProvider:'codex',canWechat:false}:{task:task(path.endsWith('bbbbbbbb')?'bbbbbbbb':'aaaaaaaa'),events:[],artifacts:[]})
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    for(let i=0;i<8;i++)await Promise.resolve()
    await controller.selectTask('bbbbbbbb'); field.value='B 的未发送要求'
    for(const listener of page.listeners.get('input')??[])listener({target:field})
    const {createWorkbenchDraftStore,loadWorkbenchView}=await import('./workbench-window-state.js')
    expect(createWorkbenchDraftStore(storage).get('task:bbbbbbbb').followup).toBe('B 的未发送要求')
    expect(loadWorkbenchView(storage).scope).toBe('task:bbbbbbbb')
    module.stopWorkbenchPolling();vi.resetModules()
    const restoredField=new FakeElement();restoredField.id='wb-followup-text'
    installFakePage({'wb-followup-text':restoredField});root.window={sessionStorage:storage}
    const reloaded=await import('./workbench.js')
    const next=reloaded.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    for(let i=0;i<8;i++)await Promise.resolve()
    expect(next.state.selectedId).toBe('bbbbbbbb');expect(restoredField.value).toBe('B 的未发送要求')
    expect(api.mock.calls.every(([method])=>method==='GET')).toBe(true)
    reloaded.stopWorkbenchPolling()
  })

  it.each([false, true])('clears only the original whitespace-padded supplement draft, with mid-send edit=%s', async edited => {
    const field = new FakeElement(); field.id = 'wb-followup-text'
    const page = installFakePage({ 'wb-followup-text': field })
    const task = { id: 'A', title: 'A', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }
    let finish!: (value: unknown) => void, body: any
    const receipts: any[] = []
    const api = vi.fn(async (method: string, path: string, request?: Record<string, unknown>) => {
      if (method === 'POST') { body = request; return new Promise(resolve => { finish = resolve }) }
      return path === '/v1/workbench' ? { tasks: [task], providers: [], defaultProvider: '', canWechat: false } : { task, events: [], artifacts: [], inputs: receipts, runId: 'run-A', inputMode: 'steer' }
    })
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 100000 })!
    try {
      for (let i = 0; i < 8; i++) await Promise.resolve()
      field.value = ' \n Original supplement\t '
      const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'send-input', ownerTask: 'A', runId: 'run-A' }
      const sending = [...page.listeners.get('submit')!][0]!({ target: form, preventDefault() {} })
      if (edited) field.value = ' Original supplement\n' // Even a whitespace-only edit remains a new draft.
      const receipt = { id: body.requestId, taskId: 'A', runId: 'run-A', text: 'Original supplement', status: 'delivered', createdAt: 1, error: null }
      receipts.push(receipt); finish({ input: receipt }); await sending
      expect(controller.state.detail?.inputs?.[0]?.status).toBe('delivered')
      expect(field.value).toBe(edited ? ' Original supplement\n' : '')
      expect(page.innerHTML).not.toContain('暂时没能确认提交结果')
    } finally { module.stopWorkbenchPolling() }
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])('reconciles a late supplement receipt after page remount with edits=%s and storage=%s', async (edited, persistent) => {
    const saved = new Map<string, string>(), storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) }, removeItem: (key: string) => { saved.delete(key) } }
    const oldField = new FakeElement(); oldField.id = 'wb-followup-text'
    const oldPage = installFakePage({ 'wb-followup-text': oldField }); root.window = persistent ? { sessionStorage: storage } : {}
    const task = { id: 'A', title: 'A', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }
    let finish!: (value: unknown) => void, body: any
    const receipts: any[] = []
    const api = vi.fn(async (method: string, path: string, request?: Record<string, unknown>) => {
      if (method === 'POST') { body = request; return new Promise(resolve => { finish = resolve }) }
      return path === '/v1/workbench' ? { tasks: [task], providers: [], defaultProvider: '', canWechat: false } : { task, events: [], artifacts: [], inputs: [...receipts], runId: 'run-A', inputMode: 'steer' }
    })
    const module = await import('./workbench.js')
    module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 100000 })!
    try {
      for (let i = 0; i < 8; i++) await Promise.resolve()
      oldField.value = ' \n Original supplement\t '
      const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'send-input', ownerTask: 'A', runId: 'run-A' }
      const sending = [...oldPage.listeners.get('submit')!][0]!({ target: form, preventDefault() {} })
      module.stopWorkbenchPolling()
      const current = new FakeElement(); current.id = 'wb-followup-text'
      installFakePage({ 'wb-followup-text': current }); root.window = persistent ? { sessionStorage: storage } : {}
      const mounted = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 100000 })!
      for (let i = 0; i < 8; i++) await Promise.resolve()
      expect(current.value).toBe(' \n Original supplement\t ')
      if (edited) current.value = 'New draft written after remount'
      const receipt = { id: body.requestId, taskId: 'A', runId: 'run-A', text: 'Original supplement', status: 'delivered', createdAt: 1, error: null }
      receipts.push(receipt); finish({ input: receipt }); await sending
      await mounted.refresh()
      expect(current.value).toBe(edited ? 'New draft written after remount' : '')
      expect(api.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1)
    } finally { module.stopWorkbenchPolling() }
  })

  it('treats returning a held supplement to the composer as an explicit new submission', async () => {
    const field = new FakeElement(); field.id = 'wb-followup-text'
    const page = installFakePage({ 'wb-followup-text': field })
    const task = { id: 'A', title: 'A', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }
    const receipts: any[] = [], posts: any[] = []
    const api = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'POST') { posts.push(body); const receipt = { id: body!.requestId, taskId: 'A', runId: 'run-A', text: body!.text, status: 'held', createdAt: 1, error: null }; receipts.push(receipt); return { input: receipt } }
      return path === '/v1/workbench' ? { tasks: [task], providers: [], defaultProvider: '', canWechat: false } : { task, events: [], artifacts: [], inputs: [...receipts], runId: 'run-A', inputMode: 'steer' }
    })
    const module = await import('./workbench.js'), controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 100000 })!
    try {
      for (let i = 0; i < 8; i++) await Promise.resolve()
      field.value = 'Preserved supplement'
      const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'send-input', ownerTask: 'A', runId: 'run-A' }
      const submit = [...page.listeners.get('submit')!][0]!
      await submit({ target: form, preventDefault() {} })
      const copy = new FakeElement(); copy.dataset = { action: 'copy-held-input', ownerTask: 'A', requestId: receipts[0].id }
      await [...page.listeners.get('click')!][0]!({ target: copy })
      task.updatedAt++
      await controller.refresh()
      expect(field.value).toBe('Preserved supplement')
      expect(posts).toHaveLength(1)
      await submit({ target: form, preventDefault() {} })
      expect(posts[1].requestId).not.toBe(posts[0].requestId)
    } finally { module.stopWorkbenchPolling() }
  })

  it.each([true, false])('follows new replies only when already at the end: %s', async following => {
    const content = new FakeElement(); content.clientHeight = 400; content.scrollHeight = 1000
    const notice = new FakeElement(); notice.hidden = true
    const page = installFakePage({}, content)
    page.querySelector = selector => selector === '.wb-content' ? content : selector === '.wb-reading-bar' ? notice : null
    let html = ''
    Object.defineProperty(page, 'innerHTML', { get: () => html, set: value => { html = value; content.scrollHeight = value.includes('New reply') ? 1400 : 1000 } })
    const task = { id: 'READ', title: 'Read', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }
    const events = [{ id: 'e1', taskId: task.id, kind: 'text', text: 'First reply', createdAt: 1 }]
    const invokeWorkbenchApi = vi.fn(async (_method: string, path: string) => path === '/v1/workbench' ? { tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false } : { task, events: [...events], artifacts: [] })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 100000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    content.scrollTop = following ? 600 : 100
    events.push({ id: 'e2', taskId: task.id, kind: 'text', text: 'New reply', createdAt: 2 })
    await controller.refresh()
    expect(content.scrollTop).toBe(following ? 1400 : 100)
    expect(notice.hidden).toBe(following)
    if (!following) {
      const latest = new FakeElement(); latest.dataset.action = 'latest-content'
      await [...page.listeners.get('click')!][0]!({ target: latest })
      expect(content.scrollTop).toBe(1400); expect(notice.hidden).toBe(true)
    }
    stopWorkbenchPolling()
  })

  it('keeps reading position and unread updates scoped to each task', async () => {
    const content = new FakeElement(); content.clientHeight = 400; content.scrollHeight = 1000
    const notice = new FakeElement(); notice.hidden = true
    const page = installFakePage({}, content)
    page.querySelector = selector => selector === '.wb-content' ? content : selector === '.wb-reading-bar' ? notice : null
    const task = (id: string) => ({ id, title: id, path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null })
    let revision = 1
    const invokeWorkbenchApi = vi.fn(async (_method: string, path: string) => path === '/v1/workbench' ? { tasks: [task('A'), task('B')], providers: [], defaultProvider: 'codex', canWechat: false } : { task: task(path.endsWith('B') ? 'B' : 'A'), events: [{ id: '1', kind: 'text', text: String(revision), createdAt: 1 }], artifacts: [] })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 100000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    content.scrollTop = 150; revision++; await controller.refresh()
    expect(notice.hidden).toBe(false)
    await controller.selectTask('B'); expect(notice.hidden).toBe(true)
    await controller.selectTask('A'); expect(content.scrollTop).toBe(150); expect(notice.hidden).toBe(false)
    content.scrollTop = 600
    for (const listener of page.listeners.get('scroll') ?? []) listener({ target: content })
    expect(notice.hidden).toBe(true)
    stopWorkbenchPolling()
  })

  it('does not pull a reader out of expanded results when a task updates', async () => {
    const content=new FakeElement();content.clientHeight=400;content.scrollHeight=1000
    const notice=new FakeElement(),results=new FakeElement()
    const page=installFakePage({},content)
    page.querySelector=selector=>selector==='.wb-content'?content:selector==='.wb-reading-bar'?notice:selector==='#wb-artifacts'||selector==='#wb-artifacts[open]'&&results.hasAttribute('open')?results:null
    const task={id:'RESULT',title:'Review',path:'/work',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
    const api=vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[task],providers:[],defaultProvider:'codex',canWechat:false}:{task,events:[],artifacts:[]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi:api,pollMs:100000})!
    for(let i=0;i<8;i++)await Promise.resolve()
    results.setAttribute('open','');content.scrollTop=600;task.status='completed'
    await controller.refresh()
    expect(content.scrollTop).toBe(600);expect(notice.hidden).toBe(false);expect(results.hasAttribute('open')).toBe(true)
    // Scrolling inside the open result is not reading the new conversation.
    for(const listener of page.listeners.get('scroll')??[])listener({target:content})
    expect(notice.hidden).toBe(false)
    const latest=new FakeElement();latest.dataset.action='latest-content'
    await [...page.listeners.get('click')!][0]!({target:latest})
    expect(results.hasAttribute('open')).toBe(false);expect(notice.hidden).toBe(true)
    stopWorkbenchPolling()
  })

  it('archives and restores the selected task through one busy guard, keeping its detail readable', async () => {
    vi.useFakeTimers()
    const page = installFakePage()
    const base = { id: 'A', title: 'A', path: '/work', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null, canArchive: true }
    let archivedAt: number | null = null
    let finishArchive!: () => void
    const archivePending = new Promise<void>(resolve => { finishArchive = resolve })
    const invokeWorkbenchApi = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'POST') { await archivePending; archivedAt = body?.archived ? 5 : null; return { task: { ...base, archivedAt } } }
      const task = { ...base, archivedAt }
      return path === '/v1/workbench' ? { tasks: archivedAt ? [] : [task], providers: [], defaultProvider: null, canWechat: false } : { task, events: [], artifacts: [] }
    })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const action = new FakeElement(); action.dataset.action = 'archive-task'
    const click = [...page.listeners.get('click')!][0]!
    const pending = click({ target: action })
    await click({ target: action })
    expect(invokeWorkbenchApi.mock.calls.filter(([method]) => method === 'POST')).toEqual([['POST', '/v1/workbench/archive', { id: 'A', archived: true }]])
    finishArchive(); await pending
    expect(controller.state.tasks).toEqual([])
    expect(controller.state.detail?.task.archivedAt).toBe(5)
    expect(controller.state.selectedId).toBe('A')
    action.dataset.action = 'restore-task'; await click({ target: action })
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('POST', '/v1/workbench/archive', { id: 'A', archived: false })
    expect(controller.state.detail?.task.archivedAt).toBeNull()
    stopWorkbenchPolling()
  })

  it('refreshes the loaded prefix after archive and discards an older pending page that contains the archived task', async () => {
    vi.useFakeTimers()
    const page = installFakePage()
    const task = (id: string) => ({ id, title: id, path: '/work', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null, canArchive: true, archivedAt: id === 'OLD' && archived ? 5 : null })
    let archived = false
    let finishMore!: (value: unknown) => void
    const more = new Promise(resolve => { finishMore = resolve })
    const list = (id: string, cursor: string | null) => ({ tasks: [task(id)], providers: [], defaultProvider: null, canWechat: false, page: { limit: 1, total: archived ? 2 : 3, hasMore: !!cursor, nextCursor: cursor } })
    const invokeWorkbenchApi = vi.fn(async (method: string, path: string) => {
      if (method === 'POST') { archived = true; return { task: task('OLD') } }
      if (path.includes('/task?')) return { task: task(path.includes('OLD') ? 'OLD' : 'A'), events: [], artifacts: [] }
      if (path.includes('cursor=late')) return more
      if (path.includes('cursor=')) return list('B', archived ? null : 'late')
      return list('A', archived ? 'fresh-second' : 'second')
    })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await controller.loadMore()
    await controller.selectTask('OLD')
    const pending = controller.loadMore()
    const action = new FakeElement(); action.dataset.action = 'archive-task'
    await [...page.listeners.get('click')!][0]!({ target: action })
    const staleTask = { ...task('OLD'), archivedAt: null }
    finishMore({ ...list('OLD', null), tasks: [staleTask] })
    await pending
    expect(controller.state.tasks.map(task => task.id)).toEqual(['A', 'B'])
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('GET', '/v1/workbench?cursor=fresh-second')
    expect(controller.state.loadingMore).toBe(false)
    expect(controller.state.selectedId).toBe('OLD')
    expect(controller.state.detail?.task.archivedAt).toBe(5)
    stopWorkbenchPolling()
  })

  it('rejects a stale continue or restart submission for an archived task without dispatching execution', async () => {
    vi.useFakeTimers()
    const followup = new FakeElement(); followup.value = 'Keep this request'
    const page = installFakePage({ 'wb-followup-text': followup })
    const task = { id: 'A', title: 'A', path: '/work', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null, archivedAt: 5, canArchive: false }
    const invokeWorkbenchApi = vi.fn(async (_method: string, path: string) => path === '/v1/workbench' ? { tasks: [task], providers: [], defaultProvider: null, canWechat: false } : { task, events: [], artifacts: [] })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const form = new FakeElement(); form.tagName = 'FORM'; form.dataset.action = 'continue'
    const submit = [...page.listeners.get('submit')!][0]!
    await submit({ target: form, preventDefault() {} })
    form.dataset.action = 'restart'; form.dataset.restartToken = 'a'.repeat(64)
    await submit({ target: form, preventDefault() {} })
    expect(invokeWorkbenchApi.mock.calls.filter(([method]) => method === 'POST')).toEqual([])
    expect(controller.state.error).toContain('恢复后可继续')
    expect(followup.value).toBe('Keep this request')
    stopWorkbenchPolling()
  })

  it.each([false, true])('preserves project drafts and latest executor inheritance with filtered project metadata=%s', async useProjectProviders => {
    vi.useFakeTimers()
    const fields = Object.fromEntries(['wb-create-form', 'wb-path', 'wb-create-text', 'wb-title', 'wb-provider', 'wb-followup-text'].map(id => { const field = new FakeElement(); field.id = id; return [id, field] }))
    const page = installFakePage(fields)
    let html = ''
    Object.defineProperty(page, 'innerHTML', { get: () => html, set: value => { html = value; for (const field of Object.values(fields)) field.value = ''; fields['wb-provider']!.value = 'codex' } })
    root.document = { getElementById: (id: string) => id === 'workbench-root' ? page : html.includes(`id="${id}"`) ? fields[id] : null, activeElement: null }
    const label = { textContent: '' }
    page.querySelector = ((selector: string) => selector === '#wb-options summary span' ? label : selector === '#wb-provider' ? { selectedOptions: [{ textContent: fields['wb-provider']!.value === 'claude' ? 'Claude Code' : 'Codex' }] } : null) as any
    const older = { id: 'OLD', title: 'Old', path: '/work', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }
    const recent = { ...older, id: 'RECENT', providerId: 'claude', updatedAt: 3 }
    const invokeWorkbenchApi = vi.fn(async (_method: string, path: string) => path === '/v1/workbench' ? { tasks: useProjectProviders ? [older] : [older, recent], projectProviders: useProjectProviders ? { '/work': 'claude' } : undefined, providers: [{ id: 'codex', displayName: 'Codex' }, { id: 'claude', displayName: 'Claude Code' }], defaultProvider: 'codex', canWechat: false } : { task: older, events: [], artifacts: [] })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const click = [...page.listeners.get('click')!][0]!
    const globalNew = new FakeElement(); globalNew.dataset.action = 'new-task'
    await click({ target: globalNew })
    fields['wb-path']!.value = '/global'; fields['wb-create-text']!.value = 'Global draft'
    const projectNew = new FakeElement(); projectNew.dataset.action = 'new-project-task'; projectNew.dataset.projectPath = '/work'
    await click({ target: projectNew })
    expect(fields['wb-path']!.value).toBe('/work')
    expect(fields['wb-provider']!.value).toBe('claude')
    expect(label.textContent).toBe('当前使用 Claude Code')
    expect(fields['wb-create-text']!.value).toBe('')
    fields['wb-create-text']!.value = 'Project draft'; fields['wb-provider']!.value = 'codex'
    await click({ target: globalNew })
    expect(fields['wb-path']!.value).toBe('/global')
    expect(fields['wb-create-text']!.value).toBe('Global draft')
    await click({ target: projectNew })
    expect(fields['wb-create-text']!.value).toBe('Project draft')
    expect(fields['wb-provider']!.value).toBe('codex')
    expect(controller.state.selectedId).toBeNull()
    stopWorkbenchPolling()
    const resumed = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(resumed.state.selectedId).toBeNull()
    expect(fields['wb-create-text']!.value).toBe('Project draft')
    expect(fields['wb-path']!.value).toBe('/work')
    stopWorkbenchPolling()
  })

  it.each(['none', 'text', 'provider'])('reseeds a submitted project draft from the latest executor and preserves edits during submission: %s', async edit => {
    vi.useFakeTimers()
    const fields = Object.fromEntries(['wb-create-form', 'wb-path', 'wb-create-text', 'wb-title', 'wb-provider'].map(id => { const field = new FakeElement(); field.id = id; return [id, field] }))
    fields['wb-create-form']!.tagName = 'FORM'
    const page = installFakePage(fields)
    let html = ''
    Object.defineProperty(page, 'innerHTML', { get: () => html, set: value => { html = value; for (const field of Object.values(fields)) field.value = ''; fields['wb-provider']!.value = 'codex' } })
    root.document = { getElementById: (id: string) => id === 'workbench-root' ? page : html.includes(`id="${id}"`) ? fields[id] : null, activeElement: null }
    const originalFormData = globalThis.FormData
    vi.stubGlobal('FormData', class {
      values = new Map([['path', fields['wb-path']!.value], ['text', fields['wb-create-text']!.value], ['title', fields['wb-title']!.value], ['providerId', fields['wb-provider']!.value]])
      get(name: string) { return this.values.get(name) ?? null }
    })
    let latestProvider = 'claude'
    let finishCreate!: () => void
    const pendingCreate = new Promise<void>(resolve => { finishCreate = resolve })
    const task = (id: string) => ({ id, title: id, path: '/work', providerId: 'claude', status: 'completed', createdAt: 1, updatedAt: 2, error: null })
    const invokeWorkbenchApi = vi.fn(async (method: string, path: string) => {
      if (method === 'POST') { await pendingCreate; return { task: task('CREATED') } }
      if (path.includes('/task?')) return { task: task(path.includes('CREATED') ? 'CREATED' : 'OLD'), events: [], artifacts: [] }
      return { tasks: [task('OLD')], projectProviders: { '/work': latestProvider }, providers: [{ id: 'codex', displayName: 'Codex' }, { id: 'claude', displayName: 'Claude Code' }], defaultProvider: 'codex', canWechat: false }
    })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    try {
      const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
      for (let i = 0; i < 8; i++) await Promise.resolve()
      const click = [...page.listeners.get('click')!][0]!
      const projectNew = new FakeElement(); projectNew.dataset = { action: 'new-project-task', projectPath: '/work' }
      await click({ target: projectNew })
      expect(fields['wb-provider']!.value).toBe('claude')
      fields['wb-create-text']!.value = 'Submitted request'; fields['wb-title']!.value = 'Submitted name'
      const submitting = [...page.listeners.get('submit')!][0]!({ target: fields['wb-create-form'], preventDefault() {} })
      if (edit === 'text') fields['wb-create-text']!.value = 'Unsent request'
      if (edit === 'provider') fields['wb-provider']!.value = 'codex'
      finishCreate(); await submitting
      expect(invokeWorkbenchApi).toHaveBeenCalledWith('POST', '/v1/workbench/create', { path: '/work', text: 'Submitted request', title: 'Submitted name', providerId: 'claude' })
      latestProvider = edit === 'provider' ? 'claude' : 'codex'
      await controller.refresh()
      await click({ target: projectNew })
      expect(fields['wb-path']!.value).toBe('/work')
      expect(fields['wb-create-text']!.value).toBe(edit === 'text' ? 'Unsent request' : '')
      expect(fields['wb-provider']!.value).toBe(edit === 'text' ? 'claude' : 'codex')
    } finally {
      stopWorkbenchPolling()
      vi.stubGlobal('FormData', originalFormData)
    }
  })

  it('submits sidebar filters without dropping the followup draft or pending permission, and retains search across remounts', async () => {
    vi.useFakeTimers()
    const followup = new FakeElement(); followup.id = 'wb-followup-text'
    const search = new FakeElement(); search.id = 'wb-search'
    const page = installFakePage({ 'wb-followup-text': followup, 'wb-search': search })
    let html = ''
    Object.defineProperty(page, 'innerHTML', { get: () => html, set: value => { html = value; followup.value = ''; search.value = '' } })
    const task = { id: 'A', title: 'A', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }
    const invokeWorkbenchApi = vi.fn(async (_method: string, path: string) => path.includes('/task?') ? { task, events: [], artifacts: [], permissions: [{ id: 'REQ', taskId: 'A', tool: 'Shell', description: 'Run tests', createdAt: 1 }] } : { tasks: path.includes('?') ? [] : [task], providers: [], defaultProvider: null, canWechat: false })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    followup.value = 'Task draft'; search.value = 'older project'
    await controller.refresh()
    expect(search.value).toBe('older project')
    expect(invokeWorkbenchApi.mock.calls.some(([, path]) => path.includes('q='))).toBe(false)
    const form = new FakeElement(); form.tagName = 'FORM'; form.id = 'wb-search-form'
    await [...page.listeners.get('submit')!][0]!({ target: form, preventDefault() {} })
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('GET', '/v1/workbench?q=older+project')
    expect(followup.value).toBe('Task draft')
    expect(controller.state.selectedId).toBe('A')
    expect(page.innerHTML).toContain('data-request-id="REQ"')
    const archiveView = new FakeElement(); archiveView.dataset.action = 'toggle-archived'
    await [...page.listeners.get('click')!][0]!({ target: archiveView })
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('GET', '/v1/workbench?q=older+project&archived=only')
    expect(followup.value).toBe('Task draft')
    stopWorkbenchPolling(); search.value = ''
    const resumed = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(search.value).toBe('older project')
    expect(resumed.state.selectedId).toBe('A')
    expect(resumed.state.query?.archived).toBe('only')
    stopWorkbenchPolling()
  })

  it('sends a restart token only for the explicit fresh-session action, retaining the request after a stale decision', async () => {
    vi.useFakeTimers()
    const field=new FakeElement();field.id='wb-followup-text';field.value='继续整理资料'
    const page=installFakePage({'wb-followup-text':field})
    const task={id:'deadbeef',title:'恢复任务',path:'/tmp/recover',providerId:'codex',status:'failed',createdAt:1,updatedAt:2,error:null}
    let token='a'.repeat(64)
    const invokeWorkbenchApi=vi.fn(async(method:string,path:string)=>{
      if(method==='POST') {token='b'.repeat(64);throw new Error('HTTP 409: {"error":"restart_confirmation_stale"}')}
      if(path==='/v1/workbench')return {tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}
      return {task,events:[],artifacts:[],continuation:{mode:'restart_required',restart:{token,context:'user: 原请求',eventCount:1,includedEventCount:1,truncated:false}}}
    })
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    const form=new FakeElement();form.tagName='FORM';form.dataset={action:'continue'}
    for(const listener of page.listeners.get('submit')??[])await listener({target:form,preventDefault:vi.fn()})
    expect(invokeWorkbenchApi.mock.calls.filter(([method])=>method==='POST')).toHaveLength(0)
    expect(field.value).toBe('继续整理资料')
    form.dataset={action:'restart',restartToken:'a'.repeat(64)}
    for(const listener of page.listeners.get('submit')??[])await listener({target:form,preventDefault:vi.fn()})
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('POST','/v1/workbench/continue',{id:'deadbeef',text:'继续整理资料',restartToken:'a'.repeat(64),inputRequestId:expect.any(String)})
    expect(controller.state.detail?.continuation?.restart?.token).toBe('b'.repeat(64))
    expect(controller.state.error).toContain('记录已更新')
    expect(field.value).toBe('继续整理资料')
    stopWorkbenchPolling()
  })

  it('does not surface a rejected stale detail request on the newly selected task', async () => {
    vi.useFakeTimers()
    const page=installFakePage()
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    let rejectFirst!:(reason?:unknown)=>void
    const pendingFirst=new Promise((_resolve,reject)=>{rejectFirst=reject})
    const invokeWorkbenchApi=vi.fn((_method:string,path:string)=>path==='/v1/workbench'?Promise.resolve({tasks:[second,first],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):path.includes('FIRST')?pendingFirst:Promise.resolve({task:second,events:[],artifacts:[]}))
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    const click=[...(page.listeners.get('click')??[])][0]!
    const firstButton=new FakeElement();firstButton.dataset.taskId='FIRST'
    const stale=click({target:firstButton});await Promise.resolve()
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND'
    await click({target:secondButton})
    rejectFirst(new Error('FIRST detail failed'));await stale
    expect(controller.state.detail?.task.id).toBe('SECOND')
    expect(controller.state.error).toBe('')
    stopWorkbenchPolling()
  })

  it('keeps the visible task and its control target atomic while another detail loads', async () => {
    vi.useFakeTimers()
    const page=installFakePage()
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    let finishSecond!:(value:unknown)=>void
    const pendingSecond=new Promise(resolve=>{finishSecond=resolve})
    let finishCancel!:(value:unknown)=>void
    const pendingCancel=new Promise(resolve=>{finishCancel=resolve})
    const invokeWorkbenchApi=vi.fn((method:string,path:string,body?:unknown)=>method==='POST'?pendingCancel:path==='/v1/workbench'?Promise.resolve({tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):path.includes('SECOND')?pendingSecond:Promise.resolve({task:first,events:[],artifacts:[]}))
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    const click=[...(page.listeners.get('click')??[])][0]!
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND'
    const selecting=click({target:secondButton});await Promise.resolve()
    const cancel=new FakeElement();cancel.dataset.action='cancel'
    const cancelling=click({target:cancel});await Promise.resolve()
    expect(controller.state.selectedId).toBe('FIRST')
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('POST','/v1/workbench/cancel',{id:'FIRST'})
    finishSecond({task:second,events:[],artifacts:[]});await selecting
    finishCancel({task:first});await cancelling
    expect(controller.state.selectedId).toBe('SECOND')
    expect(controller.state.detail?.task.id).toBe('SECOND')
    stopWorkbenchPolling()
  })

  it('keeps a new-task draft while the create form is replaced by task loading', async () => {
    vi.useFakeTimers()
    const pathField=new FakeElement();pathField.id='wb-path'
    const textField=new FakeElement();textField.id='wb-create-text'
    const titleField=new FakeElement();titleField.id='wb-title'
    const providerField=new FakeElement();providerField.id='wb-provider'
    const fields:Record<string,FakeElement>={'wb-create-form':new FakeElement(),'wb-path':pathField,'wb-create-text':textField,'wb-title':titleField,'wb-provider':providerField}
    const page=new FakeElement()
    root.document={
      getElementById:(id:string)=>id==='workbench-root'?page:page.innerHTML.includes(`id="${id}"`)?fields[id]??null:null,
      activeElement:null,
      createElement:()=>new FakeElement(),
    }
    root.window={}
    vi.stubGlobal('Element',FakeElement)
    const task={id:'TASK',title:'Existing task',path:'/existing',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    let finishDetail!:(value:unknown)=>void
    const pendingDetail=new Promise(resolve=>{finishDetail=resolve})
    const invokeWorkbenchApi=vi.fn((_method:string,path:string)=>path==='/v1/workbench'?Promise.resolve({tasks:[],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):pendingDetail)
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000});for(let i=0;i<5;i++)await Promise.resolve()
    pathField.value='/draft/project';textField.value='Prepare a report';titleField.value='Draft title';providerField.value='codex'
    const click=[...(page.listeners.get('click')??[])][0]!
    const taskButton=new FakeElement();taskButton.dataset.taskId='TASK'
    const selecting=click({target:taskButton});await Promise.resolve()
    expect(page.innerHTML).toContain('正在打开任务')
    pathField.value='';textField.value='';titleField.value='';providerField.value=''
    finishDetail({task,events:[],artifacts:[]});await selecting
    const newButton=new FakeElement();newButton.dataset.action='new-task';await click({target:newButton})
    expect(pathField.value).toBe('/draft/project')
    expect(textField.value).toBe('Prepare a report')
    expect(titleField.value).toBe('Draft title')
    expect(providerField.value).toBe('codex')
    stopWorkbenchPolling()
  })

  it('posts the selected permission request and task decision', async () => {
    vi.useFakeTimers()
    const page=installFakePage()
    const task={id:'TASK',title:'Task',path:'/tmp',providerId:'claude',status:'running',createdAt:1,updatedAt:2,error:null}
    const permission={id:'REQ-2',taskId:'TASK',tool:'Shell',description:'Run tests',createdAt:3}
    const invokeWorkbenchApi=vi.fn(async(method:string,path:string)=>method==='POST'?{task}:path==='/v1/workbench'?{tasks:[task],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude',canWechat:false}:{task,events:[],artifacts:[],permissions:[permission]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    expect(controller.state.selectedId).toBe('TASK')
    const button=new FakeElement();button.dataset={action:'allow-permission',requestId:'REQ-2'}
    page.listeners.get('click')?.forEach(fn=>fn({target:button}));await vi.runAllTicks()
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('POST','/v1/workbench/permission',{id:'TASK',requestId:'REQ-2',decision:'allow'})
    stopWorkbenchPolling()
  })

  it('keeps valid permission decisions available when an unrelated preview error is shown', async () => {
    vi.useFakeTimers()
    const page=installFakePage()
    const task={id:'TASK',title:'Task',path:'/tmp',providerId:'claude',status:'running',createdAt:1,updatedAt:2,error:null}
    const permission={id:'REQ-2',taskId:'TASK',tool:'Shell',description:'Run tests',createdAt:3}
    const posts:Array<{path:string,body:unknown}>=[]
    const invokeWorkbenchApi=vi.fn(async(method:string,path:string,body?:unknown)=>{
      if(method==='POST'){posts.push({path,body});return {ok:true}}
      return path==='/v1/workbench'?{tasks:[task],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude',canWechat:false}:{task,events:[],artifacts:[],permissions:[permission]}
    })
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    controller.state.error='preview failed';controller.paint()
    const button=new FakeElement();button.dataset={action:'allow-permission',requestId:'REQ-2'}
    const click=[...(page.listeners.get('click')??[])][0]!;await click({target:button})
    expect(posts).toEqual([{path:'/v1/workbench/permission',body:{id:'TASK',requestId:'REQ-2',decision:'allow'}}])
    stopWorkbenchPolling()
  })

  it('allows mutations on A and B to overlap while suppressing a duplicate mutation on A', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='Continue A'
    const page=installFakePage({'wb-followup-text':followup})
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    const posts:Array<{id:unknown,text:unknown}>=[]
    const finishes=new Map<string,(value:unknown)=>void>()
    const invokeWorkbenchApi=vi.fn((method:string,path:string,body?:Record<string,unknown>)=>{
      if(method==='POST'){
        posts.push({id:body?.id,text:body?.text})
        return new Promise(resolve=>{finishes.set(String(body?.id),resolve)})
      }
      if(path==='/v1/workbench')return Promise.resolve({tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false})
      return Promise.resolve({task:path.includes('SECOND')?second:first,events:[],artifacts:[]})
    })
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000});for(let i=0;i<5;i++)await Promise.resolve()
    const submit=[...(page.listeners.get('submit')??[])][0]!
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    const firstRequest=submit({target:form,preventDefault(){}});await Promise.resolve()
    await submit({target:form,preventDefault(){}})
    const click=[...(page.listeners.get('click')??[])][0]!
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND';await click({target:secondButton})
    followup.value='Continue B'
    const secondRequest=submit({target:form,preventDefault(){}});await Promise.resolve()
    expect(posts).toEqual([{id:'FIRST',text:'Continue A'},{id:'SECOND',text:'Continue B'}])
    finishes.get('SECOND')?.({task:second});await secondRequest
    finishes.get('FIRST')?.({task:first});await firstRequest
    stopWorkbenchPolling()
  })

  it('preserves A and B edits when overlapping completions settle out of order', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='Send A'
    const page=installFakePage({'wb-followup-text':followup})
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    const finishes=new Map<string,(value:unknown)=>void>()
    const invokeWorkbenchApi=vi.fn((method:string,path:string,body?:Record<string,unknown>)=>method==='POST'?new Promise(resolve=>{finishes.set(String(body?.id),resolve)}):path==='/v1/workbench'?Promise.resolve({tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):Promise.resolve({task:path.includes('SECOND')?second:first,events:[],artifacts:[]}))
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    const submit=[...(page.listeners.get('submit')??[])][0]!
    const click=[...(page.listeners.get('click')??[])][0]!
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    const requestA=submit({target:form,preventDefault(){}});await Promise.resolve();followup.value='Keep A edit'
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND';await click({target:secondButton});followup.value='Send B'
    const requestB=submit({target:form,preventDefault(){}});await Promise.resolve();followup.value='Keep B edit'
    finishes.get('FIRST')?.({task:first});await requestA
    finishes.get('SECOND')?.({task:second});await requestB
    expect(controller.state.selectedId).toBe('SECOND')
    expect(followup.value).toBe('Keep B edit')
    const firstButton=new FakeElement();firstButton.dataset.taskId='FIRST';await click({target:firstButton})
    expect(followup.value).toBe('Keep A edit')
    stopWorkbenchPolling()
  })

  it('cancels a queued task by its selected task id', async () => {
    vi.useFakeTimers()
    const page=installFakePage()
    const task={id:'QUEUED',title:'Queued',path:'/tmp',providerId:'codex',status:'queued',createdAt:1,updatedAt:2,error:null,waitingFor:{taskId:'RUNNING',title:'Running',reason:'same_path'}}
    const posts:Array<{path:string,body:unknown}>=[]
    const invokeWorkbenchApi=vi.fn(async(method:string,path:string,body?:unknown)=>{if(method==='POST'){posts.push({path,body});return {task:{...task,status:'cancelled'}}}return path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:{task,events:[],artifacts:[]}})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000});for(let i=0;i<5;i++)await Promise.resolve()
    const cancel=new FakeElement();cancel.dataset.action='cancel'
    const click=[...(page.listeners.get('click')??[])][0]!;await click({target:cancel})
    expect(posts).toEqual([{path:'/v1/workbench/cancel',body:{id:'QUEUED'}}])
    stopWorkbenchPolling()
  })

  it('等待行的「收工」关的是持有者的会话，不带上这条排队任务自己的 runId', async () => {
    vi.useFakeTimers()
    const page=installFakePage()
    const task={id:'QUEUED',title:'Queued',path:'/tmp',providerId:'codex',status:'queued',createdAt:1,updatedAt:2,error:null,waitingFor:{taskId:'HOLDER',title:'Holder',reason:'same_path',holderWriting:false,closeInMs:7000}}
    const posts:Array<{path:string,body:unknown}>=[]
    // 这条排队任务自己也带着一个 runId(队列里的任务本来就已经登记了 run)——「收工」关的必须是
    // 持有者 HOLDER,带上这条自己的 runId 只会让持有者那边的取消请求被当成过期请求拒掉。
    const invokeWorkbenchApi=vi.fn(async(method:string,path:string,body?:unknown)=>{if(method==='POST'){posts.push({path,body});return {task:{...task,status:'cancelled'}}}return path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:{task,events:[],artifacts:[],runId:'run-QUEUED'}})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000});for(let i=0;i<5;i++)await Promise.resolve()
    const cancel=new FakeElement();cancel.dataset.action='cancel';cancel.dataset.cancelTaskId='HOLDER'
    const click=[...(page.listeners.get('click')??[])][0]!;await click({target:cancel})
    expect(posts).toEqual([{path:'/v1/workbench/cancel',body:{id:'HOLDER'}}])
    stopWorkbenchPolling()
  })

  it.each(['text/plain', 'application/vnd.cc.workbench-review+json'])('ignores a late %s artifact response after another task is selected', async reviewMime => {
    vi.useFakeTimers()
    const page=installFakePage()
    const firstTask={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const secondTask={...firstTask,id:'SECOND',title:'Second',path:'/two'}
    const artifact={id:'FILE',taskId:'FIRST',name:'report.txt',mime:reviewMime,size:4,sha256:'hash',createdAt:3,approvedAt:null}
    let finishArtifact!:(value:unknown)=>void
    const pendingArtifact=new Promise(resolve=>{finishArtifact=resolve})
    const invokeWorkbenchApi=vi.fn((_method:string,path:string)=>{
      if(path==='/v1/workbench')return Promise.resolve({tasks:[firstTask,secondTask],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false})
      if(path.includes('/artifact'))return pendingArtifact
      if(path.includes('SECOND'))return Promise.resolve({task:secondTask,events:[],artifacts:[]})
      return Promise.resolve({task:firstTask,events:[],artifacts:[artifact]})
    })
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!
    for(let i=0;i<5;i++)await Promise.resolve()
    expect(controller.state.selectedArtifactId).toBe('FILE')
    const click=[...(page.listeners.get('click')??[])][0]!
    const preview=new FakeElement();preview.dataset.action='preview-artifact'
    const previewing=click({target:preview});await Promise.resolve()
    const second=new FakeElement();second.dataset.taskId='SECOND'
    await click({target:second})
    finishArtifact({name:'report.txt',mime:reviewMime,contentBase64:'ZGF0YQ==',size:4,sha256:'hash'});await previewing
    expect(controller.state.detail?.task.id).toBe('SECOND')
    expect(controller.state.preview).toBeNull()
    stopWorkbenchPolling()
  })

  it('opens results directly, previews the selected report, and returns to the same conversation position', async () => {
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const content=new FakeElement();content.scrollTop=120;content.scrollHeight=900
    const page=installFakePage({},content)
    const summary=new FakeElement();summary.focus=vi.fn()
    const details=Object.assign(new FakeElement(),{scrollIntoView:vi.fn(),querySelector:()=>summary})
    const show=new FakeElement();show.dataset.action='show-artifacts';show.focus=vi.fn()
    page.querySelector=(selector:string)=>selector==='.wb-content'?content:selector==='#wb-artifacts'?details:selector==='[data-action="show-artifacts"]'?show:null
    const task={id:'abcd1234',title:'Review',path:'/tmp/report',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const artifact={id:'report',taskId:task.id,name:'report.md',mime:'text/markdown',size:16,sha256:'hash',createdAt:3,approvedAt:null}
    const invokeWorkbenchApi=vi.fn(async(_method:string,path:string)=>path.includes('/artifact?')?{...artifact,contentBase64:Buffer.from('# Ready\n\nSafe result.').toString('base64')}:path==='/v1/workbench'?{tasks:[task],providers:[],defaultProvider:'codex',canWechat:false}:{task,events:[],artifacts:[artifact]})
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:100000})!
    for(let i=0;i<6;i++)await Promise.resolve()
    content.scrollTop=120
    const click=[...page.listeners.get('click')!][0]!
    await click({target:show})
    expect(details.hasAttribute('open')).toBe(true)
    expect(details.scrollIntoView).toHaveBeenCalledWith({block:'start'})
    expect(summary.focus).toHaveBeenCalledWith({preventScroll:true})
    const file=new FakeElement();file.dataset.artifactId='report'
    await click({target:file})
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('GET','/v1/workbench/artifact?id=abcd1234&artifactId=report')
    expect(controller.state.preview?.html).toContain('<h1>Ready</h1>')
    expect(controller.state.preview?.artifactId).toBe('report')
    content.scrollTop=800
    await click({target:show})
    const back=new FakeElement();back.dataset.action='back-to-dialogue'
    await click({target:back})
    expect(content.scrollTop).toBe(120)
    expect(show.focus).toHaveBeenCalledWith({preventScroll:true})
    stopWorkbenchPolling()
  })

  it('previews a generated code review with hash-bound approval and preserves file disclosure choices on refresh', async () => {
    vi.useFakeTimers()
    const page = installFakePage()
    const fileDisclosure = new FakeElement(); fileDisclosure.id = 'wb-review-file-0'
    let html = ''
    Object.defineProperty(page, 'innerHTML', { get: () => html, set: value => { html = value; fileDisclosure.removeAttribute('open'); if (/id="wb-review-file-0"[^>]* open/.test(value)) fileDisclosure.setAttribute('open', '') } })
    page.querySelector = (selector: string) => selector === '#wb-review-file-0' ? fileDisclosure : null
    ;(page as any).querySelectorAll = () => html.includes('data-review-disclosure') ? [fileDisclosure] : []
    const task = { id: 'REVIEW', title: 'Review', path: '/work', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }
    const artifact = { id: 'DIFF', taskId: 'REVIEW', name: '本轮文件对比.json', mime: 'application/vnd.cc.workbench-review+json', size: 100, sha256: 'b'.repeat(64), createdAt: 3, approvedAt: null }
    const source = JSON.stringify({ version: 1, scope: 'working-tree-before-after', startedAt: 1, finishedAt: 2, headBefore: null, headAfter: null, status: 'complete', notes: [], preexistingPaths: [], files: [{ path: 'app.ts', kind: 'added', preexisting: false, diff: '@@ -0,0 +1 @@\n+const value = 1' }] })
    const invokeWorkbenchApi = vi.fn(async (method: string, path: string) => method === 'POST' ? { task } : path.includes('/artifact?') ? { ...artifact, contentBase64: Buffer.from(source).toString('base64') } : path === '/v1/workbench' ? { tasks: [task], providers: [], defaultProvider: null, canWechat: false } : { task, events: [], artifacts: [artifact] })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const click = [...page.listeners.get('click')!][0]!
    const file = new FakeElement(); file.dataset.artifactId = 'DIFF'
    await click({ target: file })
    expect(controller.state.preview?.html).toContain('class="wb-code-review"')
    expect(page.innerHTML).toContain('data-action="download-artifact"')
    expect(page.innerHTML).toContain('data-action="approve-artifact"')
    expect(fileDisclosure.hasAttribute('open')).toBe(true)
    fileDisclosure.removeAttribute('open')
    task.updatedAt = 4
    await controller.refresh()
    expect(fileDisclosure.hasAttribute('open')).toBe(false)
    const approve = new FakeElement(); approve.dataset.action = 'approve-artifact'
    await click({ target: approve })
    expect(invokeWorkbenchApi).toHaveBeenCalledWith('POST', '/v1/workbench/approve', { id: 'REVIEW', artifactId: 'DIFF', sha256: 'b'.repeat(64) })
    stopWorkbenchPolling()
  })

  it('creates closed operation groups at run end and preserves manual choices, focus, drafts and reading position across polling', async () => {
    vi.useFakeTimers()
    const field = new FakeElement(); field.id = 'wb-followup-text'
    const page = installFakePage({ 'wb-followup-text':field })
    const content = new FakeElement(); content.clientHeight = 400; content.scrollHeight = 1000
    const notice = new FakeElement()
    let markup = ''
    let disclosures = new Map<string, FakeElement>()
    let summaries = new Map<string, FakeElement>()
    Object.defineProperty(page, 'innerHTML', { get:() => markup, set:(value:string) => {
      markup = value; disclosures = new Map(); summaries = new Map()
      for (const [, id] of value.matchAll(/<details\b[^>]*id="([^"]+)"[^>]*data-timeline-disclosure[^>]*>/g)) {
        const disclosure = new FakeElement(); disclosure.id = id!
        const summary = new FakeElement(); summary.parentElement = disclosure; summary.focus = vi.fn()
        disclosures.set(id!, disclosure); summaries.set(id!, summary)
      }
    } })
    page.querySelector = (selector:string) => {
      if (selector === '.wb-content') return content
      if (selector === '.wb-reading-bar') return notice
      if (selector === '[data-timeline-disclosure][open]') return [...disclosures.values()].find(node => node.hasAttribute('open')) ?? null
      if (selector.endsWith(' > summary')) return summaries.get(selector.slice(1, -10)) ?? null
      return disclosures.get(selector.slice(1)) ?? null
    }
    ;(page as any).querySelectorAll = (selector:string) => selector === '[data-timeline-disclosure]' ? [...disclosures.values()] : selector === '[data-timeline-disclosure][open]' ? [...disclosures.values()].filter(node => node.hasAttribute('open')) : []
    const task = { id:'A', title:'Timeline', path:'/work', providerId:'codex', status:'running', createdAt:1, updatedAt:2, error:null }
    const other = { ...task, id:'B', status:'completed' }
    const operation = (taskId:string) => ({ id:'read', taskId, runId:'run1', kind:'tool_call', text:'Read source', createdAt:3, activity:{ id:'read', type:'read', status:'completed', label:'Read source' } })
    const invokeWorkbenchApi = vi.fn(async (_method:string, path:string) => path === '/v1/workbench' ? { tasks:[task,other], providers:[], defaultProvider:null, canWechat:false }
      : { task:path.endsWith('B') ? other : task, events:[operation(path.endsWith('B') ? 'B' : 'A')], artifacts:[], runId:'run1' })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs:60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(disclosures.size).toBe(0)
    field.value = 'Keep my draft'
    task.status = 'completed'; await controller.refresh()
    const groupId = [...disclosures.keys()][0]!
    expect(groupId).toBeTruthy()
    expect(disclosures.get(groupId)?.hasAttribute('open')).toBe(false)
    disclosures.get(groupId)?.setAttribute('open', '')
    content.scrollTop = 600
    const doc = root.document as { activeElement:unknown }; doc.activeElement = summaries.get(groupId)
    task.updatedAt++; await controller.refresh()
    expect(disclosures.get(groupId)?.hasAttribute('open')).toBe(true)
    expect(summaries.get(groupId)?.focus).toHaveBeenCalledWith({ preventScroll:true })
    expect(content.scrollTop).toBe(600)
    expect(field.value).toBe('Keep my draft')
    doc.activeElement = null
    await controller.selectTask('B')
    expect([...disclosures.values()].every(node => !node.hasAttribute('open'))).toBe(true)
    await controller.selectTask('A')
    expect(disclosures.get(groupId)?.hasAttribute('open')).toBe(true)
    const latest = new FakeElement(); latest.dataset.action = 'latest-content'
    const click = [...page.listeners.get('click')!][0]!
    await click({ target:latest })
    expect(disclosures.get(groupId)?.hasAttribute('open')).toBe(false)
    expect(content.scrollTop).toBe(1000)
    stopWorkbenchPolling()
  })

  it.each(['reply', 'operation'] as const)('keeps a visible %s at the same viewport offset when completion folds earlier operations, without borrowing another task anchor', async kind => {
    vi.useFakeTimers()
    const page = installFakePage()
    const content = new FakeElement(); content.clientHeight = 400
    ;(content as any).getBoundingClientRect = () => ({ top:100, bottom:500, height:400 })
    let markup = '', currentTask = '', targetTop = 0
    let target = new FakeElement(), group:FakeElement|null = null
    const targetRect = () => group && !group.hasAttribute('open') ? { top:0, bottom:0, height:0 }
      : { top:100 + targetTop - content.scrollTop, bottom:200 + targetTop - content.scrollTop, height:100 }
    Object.defineProperty(page, 'innerHTML', { get:() => markup, set:(value:string) => {
      markup = value; content.scrollTop = 0
      currentTask = value.includes('A reading target') ? 'A' : 'B'
      const folded = /<details\b[^>]*data-timeline-group/.test(value)
      // A completed group above the reply removes 300 px from its document
      // position. An operation remains at its old position only if its group
      // is kept open while that operation is being read.
      targetTop = currentTask === 'A' ? kind === 'reply' && folded ? 420 : 720 : 240
      content.scrollHeight = currentTask === 'A' && folded ? 1300 : 1600
      const article = [...value.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].find(match => match[0].includes(`${currentTask} reading target`))?.[0] ?? ''
      target = new FakeElement(); target.id = article.match(/\bid="([^"]+)"/)?.[1] ?? `target-${currentTask}`
      group = kind === 'operation' && folded ? new FakeElement() : null
      ;(target as any).getBoundingClientRect = targetRect
      target.closest = (selector?:string) => selector === 'details[data-timeline-group]' ? group : null
    } })
    page.querySelector = (selector:string) => selector === '.wb-content' ? content : selector === `#${target.id}` ? target : null
    ;(page as any).querySelectorAll = (selector:string) => selector === '[data-timeline-anchor]' ? [target] : []
    const task = { id:'A', title:'A', path:'/work', providerId:'codex', status:'running', createdAt:1, updatedAt:2, error:null }
    const other = { ...task, id:'B', status:'completed' }
    const detail = (id:string) => ({ task:id === 'A' ? task : other, runId:'run1', artifacts:[], events:[
      { id:'tool', taskId:id, runId:'run1', kind:'tool_call', text:'Earlier operations', createdAt:1 },
      { id:'target', taskId:id, runId:'run1', kind:kind === 'reply' ? 'text' : 'tool_call', text:`${id} reading target`, createdAt:2 },
    ] })
    const invokeWorkbenchApi = vi.fn(async (_method:string, path:string) => path === '/v1/workbench' ? { tasks:[task,other], providers:[], defaultProvider:null, canWechat:false } : detail(path.endsWith('B') ? 'B' : 'A'))
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    const controller = initWorkbenchPage({ invokeWorkbenchApi, pollMs:60_000 })!
    for (let i = 0; i < 8; i++) await Promise.resolve()
    content.scrollTop = 650
    const before = targetRect().top
    expect(before).toBe(170)
    task.status = 'completed'; await controller.refresh()
    expect(targetRect().top).toBe(before)
    expect(content.scrollTop).toBe(kind === 'reply' ? 350 : 650)
    if (kind === 'operation') expect((group as FakeElement|null)?.hasAttribute('open')).toBe(true)
    await controller.selectTask('B')
    expect(content.scrollTop).toBe(1600)
    ;(group as FakeElement|null)?.setAttribute('open', '')
    content.scrollTop = 180
    await controller.selectTask('A')
    expect(targetRect().top).toBe(170)
    await controller.selectTask('B')
    expect(targetRect().top).toBe(160)
    stopWorkbenchPolling()
  })

  it('does not surface a rejected stale artifact request on the newly selected task', async () => {
    vi.useFakeTimers()
    const page=installFakePage()
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    const artifact={id:'FILE',taskId:'FIRST',name:'report.txt',mime:'text/plain',size:4,sha256:'hash',createdAt:3,approvedAt:null}
    let rejectArtifact!:(reason?:unknown)=>void
    const pendingArtifact=new Promise((_resolve,reject)=>{rejectArtifact=reject})
    const invokeWorkbenchApi=vi.fn((_method:string,path:string)=>path==='/v1/workbench'?Promise.resolve({tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):path.includes('/artifact')?pendingArtifact:path.includes('SECOND')?Promise.resolve({task:second,events:[],artifacts:[]}):Promise.resolve({task:first,events:[],artifacts:[artifact]}))
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    const click=[...(page.listeners.get('click')??[])][0]!
    const preview=new FakeElement();preview.dataset.action='preview-artifact'
    const stale=click({target:preview});await Promise.resolve()
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND'
    await click({target:secondButton})
    rejectArtifact(new Error('FIRST artifact failed'));await stale
    expect(controller.state.detail?.task.id).toBe('SECOND')
    expect(controller.state.error).toBe('')
    stopWorkbenchPolling()
  })

  it('keeps the user on a task selected while an earlier mutation completes', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='continue A'
    const page=installFakePage({'wb-followup-text':followup})
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    let finishMutation!:(value:unknown)=>void
    const pendingMutation=new Promise(resolve=>{finishMutation=resolve})
    const invokeWorkbenchApi=vi.fn((method:string,path:string)=>method==='POST'?pendingMutation:path==='/v1/workbench'?Promise.resolve({tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):path.includes('SECOND')?Promise.resolve({task:second,events:[],artifacts:[]}):Promise.resolve({task:first,events:[],artifacts:[]}))
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    const submit=[...(page.listeners.get('submit')??[])][0]!
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    const mutation=submit({target:form,preventDefault(){}});await Promise.resolve()
    const click=[...(page.listeners.get('click')??[])][0]!
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND'
    await click({target:secondButton})
    finishMutation({task:first});await mutation
    expect(controller.state.selectedId).toBe('SECOND')
    expect(controller.state.detail?.task.id).toBe('SECOND')
    stopWorkbenchPolling()
  })

  it('does not surface an earlier task mutation rejection after navigation', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='continue A'
    const page=installFakePage({'wb-followup-text':followup})
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    let rejectMutation!:(reason?:unknown)=>void
    const pendingMutation=new Promise((_resolve,reject)=>{rejectMutation=reject})
    const invokeWorkbenchApi=vi.fn((method:string,path:string)=>method==='POST'?pendingMutation:path==='/v1/workbench'?Promise.resolve({tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):path.includes('SECOND')?Promise.resolve({task:second,events:[],artifacts:[]}):Promise.resolve({task:first,events:[],artifacts:[]}))
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    const submit=[...(page.listeners.get('submit')??[])][0]!
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    const mutation=submit({target:form,preventDefault(){}});await Promise.resolve()
    const click=[...(page.listeners.get('click')??[])][0]!
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND';await click({target:secondButton})
    rejectMutation(new Error('FIRST continue failed'));await mutation
    expect(controller.state.detail?.task.id).toBe('SECOND')
    expect(controller.state.error).toBe('')
    stopWorkbenchPolling()
  })

  it('uses navigation generation to avoid an extra A reload after A to B to A navigation', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='continue A'
    const page=installFakePage({'wb-followup-text':followup})
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    let finishMutation!:(value:unknown)=>void
    const pendingMutation=new Promise(resolve=>{finishMutation=resolve})
    const invokeWorkbenchApi=vi.fn((method:string,path:string)=>method==='POST'?pendingMutation:path==='/v1/workbench'?Promise.resolve({tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):path.includes('SECOND')?Promise.resolve({task:second,events:[],artifacts:[]}):Promise.resolve({task:first,events:[],artifacts:[]}))
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000});for(let i=0;i<5;i++)await Promise.resolve()
    const submit=[...(page.listeners.get('submit')??[])][0]!
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    const mutation=submit({target:form,preventDefault(){}});await Promise.resolve()
    const click=[...(page.listeners.get('click')??[])][0]!
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND';await click({target:secondButton})
    const firstButton=new FakeElement();firstButton.dataset.taskId='FIRST';await click({target:firstButton})
    finishMutation({task:first});await mutation
    expect(invokeWorkbenchApi.mock.calls.filter(([method,path])=>method==='GET'&&String(path).startsWith('/v1/workbench/task?id=FIRST'))).toHaveLength(3)
    stopWorkbenchPolling()
  })

  it('clears only the submitted followup so text typed during the request survives', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='first request'
    const page=installFakePage({'wb-followup-text':followup})
    const task={id:'TASK',title:'Task',path:'/tmp',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    let finishContinue!:(value:unknown)=>void
    const pendingContinue=new Promise(resolve=>{finishContinue=resolve})
    const invokeWorkbenchApi=vi.fn((method:string,path:string)=>method==='POST'?pendingContinue:path==='/v1/workbench'?Promise.resolve({tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}):Promise.resolve({task,events:[],artifacts:[]}))
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000});await vi.runAllTicks()
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    page.listeners.get('submit')?.forEach(fn=>fn({target:form,preventDefault(){}}));await vi.runAllTicks()
    followup.value='second request'
    finishContinue({task});await vi.runAllTicks()
    expect(followup.value).toBe('second request')
    stopWorkbenchPolling()
  })

  it('clears a successfully submitted followup when it has not been edited', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='send this'
    const page=installFakePage({'wb-followup-text':followup})
    const task={id:'TASK',title:'Task',path:'/tmp',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const invokeWorkbenchApi=vi.fn(async(method:string,path:string)=>method==='POST'?{task}:path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:{task,events:[],artifacts:[]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000});for(let i=0;i<5;i++)await Promise.resolve()
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    const submit=[...(page.listeners.get('submit')??[])][0]!
    await submit({target:form,preventDefault(){}})
    expect(followup.value).toBe('')
    stopWorkbenchPolling()
  })

  it('retains a followup when submission fails so it can be retried', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='retry me'
    const page=installFakePage({'wb-followup-text':followup})
    const task={id:'TASK',title:'Task',path:'/tmp',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const invokeWorkbenchApi=vi.fn(async(method:string,path:string)=>{if(method==='POST')throw new Error('offline');return path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:{task,events:[],artifacts:[]}})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    const submit=[...(page.listeners.get('submit')??[])][0]!
    await submit({target:form,preventDefault(){}})
    expect(followup.value).toBe('retry me')
    expect(controller.state.error).toBe('offline')
    stopWorkbenchPolling()
  })

  it('opens an unseen task at the latest messages and preserves reading positions thereafter', async () => {
    vi.useFakeTimers()
    const main=new FakeElement();main.scrollHeight=1200
    installFakePage({},main)
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    let revision=0
    const invokeWorkbenchApi=vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:path.includes('SECOND')?{task:second,events:[{id:`b${revision++}`,taskId:'SECOND',kind:'text',text:'B',createdAt:3}],artifacts:[]}:{task:first,events:[{id:`a${revision++}`,taskId:'FIRST',kind:'text',text:'A',createdAt:3}],artifacts:[]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    expect(main.scrollTop).toBe(1200)
    main.scrollTop=210
    await controller.refresh()
    expect(main.scrollTop).toBe(210)
    await controller.selectTask('SECOND')
    expect(main.scrollTop).toBe(1200)
    main.scrollTop=430
    await controller.selectTask('FIRST')
    expect(main.scrollTop).toBe(210)
    stopWorkbenchPolling()
  })

  it('restores focused draft fields without moving the saved conversation scroll', async () => {
    vi.useFakeTimers()
    const main=new FakeElement();main.scrollHeight=1200
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='working draft'
    installFakePage({'wb-followup-text':followup},main)
    const task={id:'TASK',title:'Task',path:'/tmp',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    let revision=0
    const invokeWorkbenchApi=vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:{task,events:[{id:`reply-${revision++}`,taskId:'TASK',kind:'text',text:'Reply',createdAt:3}],artifacts:[]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    main.scrollTop=175
    ;(root.document as any).activeElement=followup
    let focusOptions:FocusOptions|undefined
    ;(followup as any).focus=(options?:FocusOptions)=>{focusOptions=options;if(!options?.preventScroll)main.scrollTop=main.scrollHeight}
    await controller.refresh()
    expect(focusOptions).toEqual({preventScroll:true})
    expect(main.scrollTop).toBe(175)
    stopWorkbenchPolling()
  })

  it('preserves task-details disclosure and conversation scroll independently for each task', async () => {
    vi.useFakeTimers()
    const page=new FakeElement()
    let markup=''
    const surface:{content:FakeElement|null,info:FakeElement|null,summary:FakeElement|null}={content:null,info:null,summary:null}
    Object.defineProperty(page,'innerHTML',{get:()=>markup,set:(value:string)=>{
      markup=value
      surface.content=new FakeElement();surface.content.scrollHeight=1200
      surface.info=value.includes('id="wb-task-info"')?new FakeElement():null
      surface.summary=surface.info?new FakeElement():null
      if(surface.summary)surface.summary.parentElement=surface.info
    }})
    ;(page as any).querySelector=(selector:string)=>{
      if(selector==='.wb-content')return surface.content
      if(selector==='#wb-task-info')return surface.info
      if(selector==='#wb-task-info[open]')return surface.info?.hasAttribute('open')?surface.info:null
      if(selector==='#wb-task-info > summary')return surface.summary
      return null
    }
    root.document={getElementById:(id:string)=>id==='workbench-root'?page:null,activeElement:null,createElement:()=>new FakeElement()}
    root.window={}
    vi.stubGlobal('Element',FakeElement)
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    let revision=0
    const invokeWorkbenchApi=vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:path.includes('SECOND')?{task:second,events:[{id:`b${revision++}`,taskId:'SECOND',kind:'text',text:'B',createdAt:3}],artifacts:[]}:{task:first,events:[{id:`a${revision++}`,taskId:'FIRST',kind:'text',text:'A',createdAt:3}],artifacts:[]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    surface.info?.toggleAttribute('open',true)
    if(surface.content)surface.content.scrollTop=180
    await controller.refresh()
    expect(surface.info?.hasAttribute('open')).toBe(true)
    expect(surface.content?.scrollTop).toBe(180)
    await controller.selectTask('SECOND')
    expect(surface.info?.hasAttribute('open')).toBe(false)
    if(surface.content)surface.content.scrollTop=360
    await controller.selectTask('FIRST')
    expect(surface.info?.hasAttribute('open')).toBe(true)
    expect(surface.content?.scrollTop).toBe(180)
    stopWorkbenchPolling()
  })

  it('preserves permission scroll for the same request set, resets for new requests, and scopes it by task', async () => {
    vi.useFakeTimers()
    const page=new FakeElement()
    let markup=''
    const surface:{content:FakeElement|null,permissions:FakeElement|null,taskInfoBody:FakeElement|null}={content:null,permissions:null,taskInfoBody:null}
    Object.defineProperty(page,'innerHTML',{get:()=>markup,set:(value:string)=>{
      markup=value
      surface.content=new FakeElement();surface.content.scrollHeight=1200
      surface.permissions=value.includes('class="wb-permissions"')?new FakeElement():null
      surface.taskInfoBody=value.includes('class="wb-task-info-body"')?new FakeElement():null
    }})
    ;(page as any).querySelector=(selector:string)=>selector==='.wb-content'?surface.content:selector==='.wb-permissions'?surface.permissions:selector==='.wb-task-info-body'?surface.taskInfoBody:null
    root.document={getElementById:(id:string)=>id==='workbench-root'?page:null,activeElement:null,createElement:()=>new FakeElement()}
    root.window={}
    vi.stubGlobal('Element',FakeElement)
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    const permission=(id:string,taskId:string)=>({id,taskId,tool:'Shell',description:`Permission ${id}`,createdAt:3})
    let firstHasNewRequest=false
    let revision=0
    const invokeWorkbenchApi=vi.fn(async(_method:string,path:string)=>{
      if(path==='/v1/workbench')return {tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}
      const task=path.includes('SECOND')?second:first
      const permissions=task.id==='SECOND'?[permission('B-1','SECOND')]:[permission('A-1','FIRST'),permission('A-2','FIRST'),...(firstHasNewRequest?[permission('A-3','FIRST')]:[])]
      return {task,events:[{id:`event-${revision++}`,taskId:task.id,kind:'text',text:'Updated',createdAt:4}],artifacts:[],permissions}
    })
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    if(surface.permissions)surface.permissions.scrollTop=140
    if(surface.taskInfoBody)surface.taskInfoBody.scrollTop=60
    await controller.refresh()
    expect(surface.permissions?.scrollTop).toBe(140)
    expect(surface.taskInfoBody?.scrollTop).toBe(60)
    firstHasNewRequest=true
    await controller.refresh()
    expect(surface.permissions?.scrollTop).toBe(0)
    if(surface.permissions)surface.permissions.scrollTop=90
    await controller.selectTask('SECOND')
    expect(surface.permissions?.scrollTop).toBe(0)
    if(surface.permissions)surface.permissions.scrollTop=35
    await controller.selectTask('FIRST')
    expect(surface.permissions?.scrollTop).toBe(90)
    await controller.selectTask('SECOND')
    expect(surface.permissions?.scrollTop).toBe(35)
    stopWorkbenchPolling()
  })

  it('does not move followup focus from one task to another task with the same field id', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text';followup.value='Draft for A'
    const page=installFakePage({'wb-followup-text':followup})
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    const invokeWorkbenchApi=vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:path.includes('SECOND')?{task:second,events:[],artifacts:[]}:{task:first,events:[],artifacts:[]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    ;(root.document as any).activeElement=followup
    let focusCalls=0
    ;(followup as any).focus=()=>{focusCalls++}
    const click=[...(page.listeners.get('click')??[])][0]!
    const secondButton=new FakeElement();secondButton.dataset.taskId='SECOND';await click({target:secondButton})
    expect(controller.state.selectedId).toBe('SECOND')
    expect(focusCalls).toBe(0)
    stopWorkbenchPolling()
  })

  it('restores the selected task and its latest draft after leaving and returning to workbench', async () => {
    vi.useFakeTimers()
    const followup=new FakeElement();followup.id='wb-followup-text'
    const page=installFakePage({'wb-followup-text':followup})
    const first={id:'FIRST',title:'First',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const second={...first,id:'SECOND',title:'Second',path:'/two'}
    const invokeWorkbenchApi=vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[first,second],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:path.includes('SECOND')?{task:second,events:[],artifacts:[]}:{task:first,events:[],artifacts:[]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const firstMount=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    await firstMount.selectTask('SECOND')
    followup.value='Keep this B draft'
    stopWorkbenchPolling()
    followup.value=''

    const secondMount=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    expect(secondMount.state.selectedId).toBe('SECOND')
    expect(followup.value).toBe('Keep this B draft')
    stopWorkbenchPolling()
  })

  it('restores new-task mode and its latest draft after leaving and returning to workbench', async () => {
    vi.useFakeTimers()
    const form=new FakeElement();form.id='wb-create-form'
    const pathField=new FakeElement();pathField.id='wb-path'
    const textField=new FakeElement();textField.id='wb-create-text'
    const page=installFakePage({'wb-create-form':form,'wb-path':pathField,'wb-create-text':textField})
    const task={id:'TASK',title:'Task',path:'/one',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
    const invokeWorkbenchApi=vi.fn(async(_method:string,path:string)=>path==='/v1/workbench'?{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}:{task,events:[],artifacts:[]})
    const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
    const firstMount=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    firstMount.newTask()
    pathField.value='/new/project';textField.value='New task draft'
    stopWorkbenchPolling()
    pathField.value='';textField.value=''

    const secondMount=initWorkbenchPage({invokeWorkbenchApi,pollMs:60_000})!;for(let i=0;i<5;i++)await Promise.resolve()
    expect(secondMount.state.selectedId).toBeNull()
    expect(secondMount.state.detail).toBeNull()
    expect(pathField.value).toBe('/new/project')
    expect(textField.value).toBe('New task draft')
    stopWorkbenchPolling()
  })

  it.each([true,false])('免审执行者:create 撞到 428 时先当面确认一次,确认=%s 才原样重发',async confirmed=>{
    const fields=Object.fromEntries(['wb-create-form','wb-path','wb-create-text','wb-title','wb-provider'].map(id=>{const f=new FakeElement();f.id=id;f.tagName=id==='wb-create-form'?'FORM':'';return[id,f]}))
    const page=installFakePage(fields)
    const originalFormData=globalThis.FormData
    vi.stubGlobal('FormData',class{get(name:string){return fields[{'path':'wb-path','text':'wb-create-text','title':'wb-title','providerId':'wb-provider'}[name]??'']?.value??''}})
    const task={id:'deadbeef',title:'A',path:'/work',providerId:'agy',status:'completed',createdAt:1,updatedAt:2,error:null}
    let acknowledged=false
    const calls:{method:string,path:string,body?:any}[]=[]
    const api=vi.fn(async(method:string,path:string,body?:any)=>{
      calls.push({method,path,body})
      if(path==='/v1/workbench/unattended-ack'){acknowledged=true;return{acknowledgedAt:111}}
      if(path==='/v1/workbench/create'){if(!acknowledged)throw Error('unattended_ack_required');return{task}}
      if(path.startsWith('/v1/workbench/task'))return{task,events:[],artifacts:[]}
      return{tasks:[],providers:[{id:'agy',displayName:'agy',capabilities:{permissions:'unattended'}}],defaultProvider:'agy',canWechat:false}
    })
    const confirmUnattended=vi.fn(async()=>confirmed)
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,confirmUnattended,pollMs:60_000})!
    await vi.waitFor(()=>expect(controller.state.providers).toHaveLength(1))
    fields['wb-path']!.value='/work';fields['wb-create-text']!.value='请把这些整理一下';fields['wb-provider']!.value='agy'
    await [...page.listeners.get('submit')!][0]!({target:fields['wb-create-form'],preventDefault(){}})
    expect(confirmUnattended).toHaveBeenCalledTimes(1)
    const creates=calls.filter(c=>c.path==='/v1/workbench/create')
    expect(calls.some(c=>c.method==='POST'&&c.path==='/v1/workbench/unattended-ack')).toBe(confirmed)
    expect(creates).toHaveLength(confirmed?2:1)
    if(confirmed)expect(creates[1]!.body).toEqual(creates[0]!.body)
    expect(controller.state.error).toBe('')
    module.stopWorkbenchPolling();vi.stubGlobal('FormData',originalFormData)
  })

  it.each([true,false])('免审执行者:continue 撞到 428 也只问一次,确认=%s',async confirmed=>{
    const field=new FakeElement();field.id='wb-followup-text'
    const page=installFakePage({'wb-followup-text':field})
    const task={id:'deadbeef',title:'A',path:'/work',providerId:'agy',status:'completed',createdAt:1,updatedAt:2,error:null}
    let acknowledged=false
    const calls:{method:string,path:string,body?:any}[]=[]
    const api=vi.fn(async(method:string,path:string,body?:any)=>{
      calls.push({method,path,body})
      if(path==='/v1/workbench/unattended-ack'){acknowledged=true;return{acknowledgedAt:111}}
      if(path==='/v1/workbench/continue'){if(!acknowledged)throw Error('unattended_ack_required');return{task}}
      if(path.startsWith('/v1/workbench/task'))return{task,events:[],artifacts:[]}
      return{tasks:[task],providers:[{id:'agy',displayName:'agy',capabilities:{permissions:'unattended'}}],defaultProvider:'agy',canWechat:false}
    })
    const confirmUnattended=vi.fn(async()=>confirmed)
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,confirmUnattended,pollMs:60_000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe(task.id))
    field.value='接着做'
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    await [...page.listeners.get('submit')!][0]!({target:form,preventDefault(){}})
    expect(confirmUnattended).toHaveBeenCalledTimes(1)
    const continues=calls.filter(c=>c.path==='/v1/workbench/continue')
    expect(calls.some(c=>c.method==='POST'&&c.path==='/v1/workbench/unattended-ack')).toBe(confirmed)
    expect(continues).toHaveLength(confirmed?2:1)
    if(confirmed)expect(continues[1]!.body).toEqual(continues[0]!.body)
    expect(controller.state.error).toBe('')
    expect(field.value).toBe(confirmed?'':'接着做')
    module.stopWorkbenchPolling()
  })

  it('免审执行者:别的错误不弹确认,照旧报出来',async()=>{
    const field=new FakeElement();field.id='wb-followup-text'
    const page=installFakePage({'wb-followup-text':field})
    const task={id:'deadbeef',title:'A',path:'/work',providerId:'agy',status:'completed',createdAt:1,updatedAt:2,error:null}
    const api=async(method:string,path:string)=>{
      if(method==='POST')throw Error('workbench_busy')
      if(path.startsWith('/v1/workbench/task'))return{task,events:[],artifacts:[]}
      return{tasks:[task],providers:[{id:'agy',displayName:'agy',capabilities:{permissions:'unattended'}}],defaultProvider:'agy',canWechat:false}
    }
    const confirmUnattended=vi.fn(async()=>true)
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,confirmUnattended,pollMs:60_000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe(task.id))
    field.value='接着做'
    const form=new FakeElement();form.tagName='FORM';form.dataset.action='continue'
    await [...page.listeners.get('submit')!][0]!({target:form,preventDefault(){}})
    expect(confirmUnattended).not.toHaveBeenCalled()
    expect(controller.state.error).toContain('文件夹')
    module.stopWorkbenchPolling()
  })

  it('does not auto-pick an unattended executor as a review handoff target, but still picks an ordinary peer',async()=>{
    const task={id:'deadbeef',title:'Done',path:'/work',providerId:'claude',status:'completed',createdAt:1,updatedAt:2,error:null}
    const api=async(method:string,path:string)=>{
      if(path.startsWith('/v1/workbench/task'))return{task,events:[{id:'e1',taskId:task.id,kind:'text',text:'完成',createdAt:1}],artifacts:[]}
      return{tasks:[task],providers:[{id:'claude',displayName:'Claude'},{id:'agy',displayName:'agy',capabilities:{permissions:'unattended'}}],defaultProvider:'claude',canWechat:false}
    }
    const page=installFakePage();root.window={getSelection:()=>null}
    const module=await import('./workbench.js'),controller=module.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:60_000})!
    await vi.waitFor(()=>expect(controller.state.selectedId).toBe(task.id))
    const button=new FakeElement();button.dataset.action='handoff-review'
    await [...page.listeners.get('click')!][0]!({target:button})
    expect(handoffDialogCalls).toHaveLength(0)
    module.stopWorkbenchPolling()

    const api2=async(method:string,path:string)=>{
      if(path.startsWith('/v1/workbench/task'))return{task,events:[{id:'e1',taskId:task.id,kind:'text',text:'完成',createdAt:1}],artifacts:[]}
      return{tasks:[task],providers:[{id:'claude',displayName:'Claude'},{id:'codex',displayName:'Codex'}],defaultProvider:'claude',canWechat:false}
    }
    const page2=installFakePage();root.window={getSelection:()=>null}
    const controller2=module.initWorkbenchPage({invokeWorkbenchApi:api2,pollMs:60_000})!
    await vi.waitFor(()=>expect(controller2.state.selectedId).toBe(task.id))
    await [...page2.listeners.get('click')!][0]!({target:button})
    expect(handoffDialogCalls).toHaveLength(1)
    expect(handoffDialogCalls[0]![1]).toMatchObject({targetProviderId:'codex'})
    module.stopWorkbenchPolling()
  })

  const reviewTask = { id: 'REVIEW', title: '改动', path: '/work', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }
  const reviewFile = (overrides: Record<string, unknown> = {}) => ({ path: 'src/app.ts', preexisting: false, kind: 'modified', diff: '@@ -1 +1 @@\n-old\n+new', ...overrides })
  const reviewTurn = (overrides: Record<string, unknown> = {}) => ({ artifactId: 'ART-1', sha256: 'a'.repeat(64), name: '本轮文件对比.json', createdAt: 100, status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files: [reviewFile()], ...overrides })
  const reviewPage = (reviews: unknown, extra: (method: string, path: string) => unknown = () => null) => {
    const calls: Array<[string, string, unknown]> = []
    const api = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body])
      const custom = extra(method, path)
      if (custom) return custom
      if (path.startsWith('/v1/matters')) return { matters: [] }
      if (path.startsWith('/v1/workbench/review')) { if (reviews instanceof Error) throw reviews; return { reviews } }
      if (method === 'POST') return { task: reviewTask }
      if (path.startsWith('/v1/workbench/task')) return { task: reviewTask, events: [{ id: 'e1', taskId: 'REVIEW', kind: 'text', text: '做完了', createdAt: 1 }], artifacts: [] }
      return { tasks: [reviewTask], providers: [{ id: 'codex', displayName: 'Codex' }], defaultProvider: 'codex', canWechat: false }
    })
    return { api, calls }
  }

  it('选中任务就去拉改动,逐文件接受写回标记', async () => {
    const page = installFakePage()
    const { api } = reviewPage([reviewTurn()])
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    expect(api).toHaveBeenCalledWith('GET', '/v1/workbench/review?id=REVIEW')
    await vi.waitFor(() => expect(page.innerHTML).toContain('id="wb-review"'))
    expect(page.innerHTML).toContain('1 轮 · 1 个文件 · 已接受 0 · 已打回 0')
    expect(page.innerHTML).toContain('data-action="review-accept"')
    const accept = new FakeElement(); accept.dataset = { action: 'review-accept', artifactId: 'ART-1', path: 'src/app.ts' }
    await [...page.listeners.get('click')!][0]!({ target: accept })
    expect(api).toHaveBeenCalledWith('POST', '/v1/workbench/review-mark', { id: 'REVIEW', artifactId: 'ART-1', path: 'src/app.ts', mark: 'accepted' })
    module.stopWorkbenchPolling()
  })

  it('打回:点开表单、勾选的路径和意见一起发回,成功后收起表单', async () => {
    const page = installFakePage()
    const { api } = reviewPage([reviewTurn()])
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    const click = [...page.listeners.get('click')!][0]!
    const open = new FakeElement(); open.dataset = { action: 'review-return', artifactId: 'ART-1', path: 'src/app.ts' }
    await click({ target: open })
    expect(controller.state.reviewReturnOpen).toEqual({ artifactId: 'ART-1', paths: ['src/app.ts'], comment: '' })
    expect(page.innerHTML).toContain('data-action="review-return-submit"')
    const box = new FakeElement(); box.value = 'src/app.ts'; (box as any).checked = true
    const comment = new FakeElement(); comment.value = '  把命名改回来  '
    const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'review-return-submit', artifactId: 'ART-1' }
    form.querySelector = (selector: string) => selector.includes('textarea') ? comment : null
    ;(form as any).querySelectorAll = () => [box]
    const submit = [...page.listeners.get('submit')!][0]!
    comment.value = '   '
    await submit({ preventDefault() {}, target: form })
    expect(api).not.toHaveBeenCalledWith('POST', '/v1/workbench/review-return', expect.anything())
    expect(controller.state.error).toContain('要怎么改')
    comment.value = '  把命名改回来  '
    await submit({ preventDefault() {}, target: form })
    expect(api).toHaveBeenCalledWith('POST', '/v1/workbench/review-return', { id: 'REVIEW', artifactId: 'ART-1', paths: ['src/app.ts'], comment: '把命名改回来' })
    expect(controller.state.reviewReturnOpen).toBe(null)
    const cancelOpen = new FakeElement(); cancelOpen.dataset = { action: 'review-return', artifactId: 'ART-1', path: 'src/app.ts' }
    await click({ target: cancelOpen })
    const cancel = new FakeElement(); cancel.dataset = { action: 'review-return-cancel' }
    await click({ target: cancel })
    expect(controller.state.reviewReturnOpen).toBe(null)
    module.stopWorkbenchPolling()
  })

  it('重画不会把勾上的文件弄丢:勾选与草稿一起发回', async () => {
    const page = installFakePage()
    const { api } = reviewPage([reviewTurn({ files: [reviewFile(), reviewFile({ path: 'src/b.ts' })] })])
    const boxes = [{ value: 'src/app.ts', checked: true }, { value: 'src/b.ts', checked: false }]
    const comment = new FakeElement(); comment.value = ''
    const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'review-return-submit', artifactId: 'ART-1' }
    form.querySelector = (selector: string) => selector.includes('textarea') ? comment : null
    ;(form as any).querySelectorAll = () => boxes
    page.querySelector = (selector: string) => selector === '.wb-review-return-form' ? form : null
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    const open = new FakeElement(); open.dataset = { action: 'review-return', artifactId: 'ART-1', path: 'src/app.ts' }
    await [...page.listeners.get('click')!][0]!({ target: open })
    expect(controller.state.reviewReturnOpen?.paths).toEqual(['src/app.ts'])
    // 主人在表单里又勾了第二个文件,然后长轮询 / 任何别的原因触发了一次整页重画。
    boxes[1]!.checked = true
    comment.value = '两个文件一起改'
    controller.paint(true)
    expect(controller.state.reviewReturnOpen?.paths).toEqual(['src/app.ts', 'src/b.ts'])
    expect(controller.state.reviewReturnOpen?.comment).toBe('两个文件一起改')
    expect(page.innerHTML).toContain('value="src/b.ts" checked')
    expect(page.innerHTML).toContain('两个文件一起改')
    await [...page.listeners.get('submit')!][0]!({ preventDefault() {}, target: form })
    expect(api).toHaveBeenCalledWith('POST', '/v1/workbench/review-return', { id: 'REVIEW', artifactId: 'ART-1', paths: ['src/app.ts', 'src/b.ts'], comment: '两个文件一起改' })
    module.stopWorkbenchPolling()
  })

  // 终审(2026-09-17):原会话不可恢复时,打回过去是死胡同 —— 现在当面确认一次,带上重开令牌再发。
  it('打回遇上原会话不可恢复:草稿留住、表单里说明,确认后带重开令牌再发一次', async () => {
    const page = installFakePage()
    const restartToken = 'c'.repeat(64)
    const sent: unknown[] = []
    const { api } = reviewPage([reviewTurn()], (method, path) => {
      if (method === 'POST' && path === '/v1/workbench/review-return') {
        if (!sent.length) { sent.push('first'); throw new Error('HTTP 409: {"error":"restart_confirmation_required"}') }
        sent.push('second')
        return { task: reviewTask }
      }
      if (path.startsWith('/v1/workbench/task')) return { task: reviewTask, events: [{ id: 'e1', taskId: 'REVIEW', kind: 'text', text: '做完了', createdAt: 1 }], artifacts: [], continuation: { mode: 'restart_required', restart: { token: restartToken, context: '记录', eventCount: 1, includedEventCount: 1, truncated: false } } }
      return null
    })
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    const box = new FakeElement(); box.value = 'src/app.ts'; (box as any).checked = true
    const comment = new FakeElement(); comment.value = '把命名改回来'
    const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'review-return-submit', artifactId: 'ART-1' }
    form.querySelector = (selector: string) => selector.includes('textarea') ? comment : null
    ;(form as any).querySelectorAll = () => [box]
    const open = new FakeElement(); open.dataset = { action: 'review-return', artifactId: 'ART-1', path: 'src/app.ts' }
    await [...page.listeners.get('click')!][0]!({ target: open })
    const submit = [...page.listeners.get('submit')!][0]!
    await submit({ preventDefault() {}, target: form })
    expect(api).toHaveBeenCalledWith('POST', '/v1/workbench/review-return', { id: 'REVIEW', artifactId: 'ART-1', paths: ['src/app.ts'], comment: '把命名改回来' })
    // 表单还在,勾选和意见都没丢,里面说清楚了为什么没发出去。
    expect(controller.state.reviewReturnOpen).toMatchObject({ artifactId: 'ART-1', paths: ['src/app.ts'], comment: '把命名改回来', restartToken })
    expect(page.innerHTML).toContain('原会话无法恢复')
    expect(page.innerHTML).toContain('把命名改回来')
    await submit({ preventDefault() {}, target: form })
    expect(api).toHaveBeenCalledWith('POST', '/v1/workbench/review-return', { id: 'REVIEW', artifactId: 'ART-1', paths: ['src/app.ts'], comment: '把命名改回来', restartToken })
    expect(sent).toEqual(['first', 'second'])
    expect(controller.state.reviewReturnOpen).toBe(null)
    module.stopWorkbenchPolling()
  })

  // 终审(2026-09-17):任务自己在跑的时候 workbench_busy 那句「另一个任务在写」是误报。
  it('任务正在跑时不发回,表单里如实说明并留住草稿', async () => {
    const page = installFakePage()
    const running = { ...reviewTask, status: 'running' }
    const { api } = reviewPage([reviewTurn()], (_method, path) =>
      path.startsWith('/v1/workbench/task') ? { task: running, events: [{ id: 'e1', taskId: 'REVIEW', kind: 'text', text: '在写', createdAt: 1 }], artifacts: [] } : null)
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    await vi.waitFor(() => expect(controller.state.detail?.task.status).toBe('running'))
    const box = new FakeElement(); box.value = 'src/app.ts'; (box as any).checked = true
    const comment = new FakeElement(); comment.value = '把命名改回来'
    const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'review-return-submit', artifactId: 'ART-1' }
    form.querySelector = (selector: string) => selector.includes('textarea') ? comment : null
    ;(form as any).querySelectorAll = () => [box]
    const open = new FakeElement(); open.dataset = { action: 'review-return', artifactId: 'ART-1', path: 'src/app.ts' }
    await [...page.listeners.get('click')!][0]!({ target: open })
    await [...page.listeners.get('submit')!][0]!({ preventDefault() {}, target: form })
    expect(api).not.toHaveBeenCalledWith('POST', '/v1/workbench/review-return', expect.anything())
    expect(page.innerHTML).toContain('这项任务正在跑，等它答复后再打回。')
    expect(controller.state.reviewReturnOpen).toMatchObject({ artifactId: 'ART-1', paths: ['src/app.ts'], comment: '把命名改回来' })
    module.stopWorkbenchPolling()
  })

  // 评审 2026-09-21 #7:保留会话答复后 status 还是 running,但打回送得出去 —— 别在桌面这边先挡了。
  it('已答复的保留会话(status 仍是 running)照样能发回', async () => {
    const page = installFakePage()
    const replied = { ...reviewTask, status: 'running', phase: 'replied' }
    const { api } = reviewPage([reviewTurn()], (method, path) =>
      method === 'POST' && path === '/v1/workbench/review-return'
        ? { input: { id: '123e4567-e89b-42d3-a456-426614174001', taskId: 'REVIEW', runId: 'run-1', text: '打回以下改动，请按意见修改：', status: 'sending', createdAt: 1, error: null } }
        : path.startsWith('/v1/workbench/task') ? { task: replied, events: [], artifacts: [] } : null)
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    await vi.waitFor(() => expect(controller.state.detail?.task.phase).toBe('replied'))
    const box = new FakeElement(); box.value = 'src/app.ts'; (box as any).checked = true
    const comment = new FakeElement(); comment.value = '把命名改回来'
    const form = new FakeElement(); form.tagName = 'FORM'; form.dataset = { action: 'review-return-submit', artifactId: 'ART-1' }
    form.querySelector = (selector: string) => selector.includes('textarea') ? comment : null
    ;(form as any).querySelectorAll = () => [box]
    const open = new FakeElement(); open.dataset = { action: 'review-return', artifactId: 'ART-1', path: 'src/app.ts' }
    await [...page.listeners.get('click')!][0]!({ target: open })
    await [...page.listeners.get('submit')!][0]!({ preventDefault() {}, target: form })
    expect(api).toHaveBeenCalledWith('POST', '/v1/workbench/review-return', { id: 'REVIEW', artifactId: 'ART-1', paths: ['src/app.ts'], comment: '把命名改回来' })
    // 回的是回执不是任务视图,面板照样收工(表单关掉、详情刷新过)。
    expect(controller.state.reviewReturnOpen).toBeNull()
    module.stopWorkbenchPolling()
  })

  it('改动记录读不到时照实说,详情照常显示', async () => {
    const page = installFakePage()
    const { api } = reviewPage(new Error('workbench_connection_unavailable'))
    const module = await import('./workbench.js')
    const controller = module.initWorkbenchPage({ invokeWorkbenchApi: api, pollMs: 60_000 })!
    await vi.waitFor(() => expect(controller.state.reviewsError).toBe(true))
    await vi.waitFor(() => expect(page.innerHTML).toContain('改动记录暂时读不到'))
    expect(page.innerHTML).toContain('做完了')
    expect(controller.state.error).toBe('')
    module.stopWorkbenchPolling()
  })
})

describe('workbench lifecycle', () => {
  it('removes the previous activation handlers so one click dispatches once', async () => {
    vi.useFakeTimers()
    class FakeElement {
      dataset: Record<string, string> = {}
      innerHTML = ''
      listeners = new Map<string, Set<(event: any) => void>>()
      addEventListener(name: string, fn: (event: any) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(fn); this.listeners.set(name, set) }
      removeEventListener(name: string, fn: (event: any) => void) { this.listeners.get(name)?.delete(fn) }
      closest() { return null }
      querySelector() { return null }
    }
    const page = new FakeElement()
    const button = new FakeElement(); button.dataset.action = 'cancel'; (button as any).closest = () => button
    root.document = { getElementById: (id: string) => id === 'workbench-root' ? page : null, activeElement: null, createElement: () => new FakeElement() }
    root.window = {}
    vi.stubGlobal('Element', FakeElement)
    const task = { id: 'TASK', title: 'Task', path: '/tmp', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }
    const invokeWorkbenchApi = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/v1/workbench') return { tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false }
      if (method === 'GET') return { task, events: [], artifacts: [] }
      return { task }
    })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })
    await vi.runAllTicks()
    initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })
    await vi.runAllTicks()
    expect(page.listeners.get('click')?.size).toBe(1)
    page.listeners.get('click')?.forEach(fn => fn({ target: button }))
    await vi.runAllTicks()
    expect(invokeWorkbenchApi.mock.calls.filter(([method, path]) => method === 'POST' && path === '/v1/workbench/cancel')).toHaveLength(1)
    stopWorkbenchPolling()
  })
})

it('the collapsed execution label follows the selected service rather than the default', async () => {
  const { syncWorkbenchProviderLabel } = await import('./workbench.js')
  const label = {textContent:''}
  const select = {selectedOptions:[{textContent:'Claude'}]}
  const host = {querySelector:(s:string)=>s==='#wb-provider'?select:label}
  syncWorkbenchProviderLabel(host as any)
  expect(label.textContent).toBe('当前使用 Claude')
  select.selectedOptions[0]!.textContent='Codex'
  syncWorkbenchProviderLabel(host as any)
  expect(label.textContent).toBe('当前使用 Codex')
})

it('does not rebuild unchanged task UI on each poll while the user types',async()=>{
  const {createWorkbenchController}=await import('./workbench.js')
  const render=vi.fn()
  const controller=createWorkbenchController({invokeWorkbenchApi:vi.fn(async()=>({tasks:[],providers:[],defaultProvider:'',canWechat:false})),render})
  await controller.refresh();await controller.refresh()
  expect(render).toHaveBeenCalledTimes(1)
})

it('imported tasks ask for explicit original-tool closure before native continuation',async()=>{
 const {renderTaskControls}=await import('./workbench.js')
 const initial=renderTaskControls('interrupted',{mode:'resume'},null,{requiresClose:true})
 expect(initial).toContain('尚未执行');expect(initial).toContain('data-action="native-prepare"');expect(initial).not.toContain('data-action="continue"')
 const decision={taskId:'task',sourceId:'source',token:'a'.repeat(64),mode:'native_resume' as const,providerId:'claude' as const,nativeId:'original',path:'/project',context:'',truncated:false,changedSinceImport:false,expiresAt:Date.now()+1000}
 const confirmed=renderTaskControls('interrupted',{mode:'resume'},null,{requiresClose:true,decision})
 expect(confirmed).toContain('原程序已关闭，继续');expect(confirmed).toContain('data-native-token="'+decision.token+'"');expect(confirmed).not.toContain('已检测到退出')
})

describe('一件事:对话也在同一张列表里(2026-09-16)',()=>{
  it('lists desktop-bound chat matters above the tasks and opens a session pane for the selected one',async()=>{
    const {renderWorkbench}=await import('./workbench.js')
    const task={id:'deadbeef',title:'Task',path:'/work',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
    const chat={id:'0badcafe',kind:'chat',title:'跟 CC 说',status:'open',updatedAt:3}
    const base={tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedArtifactId:null,error:'',preview:null,chats:[chat]}
    const listed=renderWorkbench({...base,selectedId:null,detail:null,selectedMatterId:null})
    expect(listed).toContain('class="wb-kicker">项目<')
    expect(listed).toMatch(/data-matter-id="0badcafe"[\s\S]*data-task-id="deadbeef"/)
    expect(listed).not.toContain('id="wb-converse-host"')
    const opened=renderWorkbench({...base,selectedId:null,detail:null,selectedMatterId:'0badcafe'})
    expect(opened).toContain('id="wb-converse-host"')
    expect(opened).toMatch(/class="wb-task is-selected" data-matter-id="0badcafe"/)
    expect(opened).not.toContain('id="wb-create-form"')
  })
})

describe('workbench live stream', () => {
  const task = { id: 'T', title: 'Live', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null, archivedAt: null }
  const event = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ id, taskId: 'T', kind: 'text', text, createdAt: id, ...extra })
  const detail = { task, events: [event(1, 'a')], artifacts: [], runId: 'run-A' }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const harness = async (overrides: Record<string, unknown> = {}) => {
    const { createWorkbenchController } = await import('./workbench.js')
    const calls: string[] = []
    const list = { tasks: [task] as Record<string, unknown>[] }
    let release!: (value: unknown) => void
    const invokeWorkbenchApi = vi.fn((_method: string, path: string) => {
      calls.push(path)
      if (path.startsWith('/v1/matters')) return Promise.resolve({ matters: [] })
      if (path.startsWith('/v1/workbench/task')) {
        if (path.includes('since=')) return new Promise(resolve => { release = resolve as (value: unknown) => void })
        return Promise.resolve({ ...detail, version: 5 })
      }
      return Promise.resolve({ tasks: list.tasks, providers: [], defaultProvider: 'codex', canWechat: false })
    })
    const renders: unknown[] = []
    const patched: any[][] = []
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: () => renders.push(1), patchLive: (changed: any[]) => { patched.push(changed); return true }, ...overrides } as any)
    await controller.selectTask('T')
    return { controller, calls, renders, patched, list, release: (value: unknown) => release(value) }
  }

  it('选中任务后接上长轮询:since 用上一次的 version,增量事件走补丁不整页重画', async () => {
    const { controller, calls, renders, patched, release } = await harness()
    expect(calls).toContain('/v1/workbench/task?id=T')
    expect(calls.at(-1)).toBe('/v1/workbench/task?id=T&since=5&wait_ms=20000')
    const painted = renders.length
    release({ ...detail, version: 6, events: [event(2, 'b')] })
    await flush()
    expect(patched.at(-1)?.map(e => e.id)).toEqual([2])
    expect(controller.state.detail?.events.map(e => e.id)).toEqual([1, 2])
    expect(controller.state.version).toBe(6)
    expect(renders.length).toBe(painted)
    await flush()
    expect(calls.at(-1)).toBe('/v1/workbench/task?id=T&since=6&wait_ms=20000')
    controller.destroy()
  })

  it('结构变了(状态/权限)整页重画,不走补丁', async () => {
    const { controller, renders, patched, release } = await harness()
    const painted = renders.length
    release({ ...detail, version: 7, task: { ...task, status: 'completed' }, events: [event(1, 'aa')] })
    await flush()
    expect(patched).toHaveLength(0)
    expect(renders.length).toBe(painted + 1)
    expect(controller.state.detail?.events.map(e => e.text)).toEqual(['aa'])
    controller.destroy()
  })

  it('补丁补不上就整页重画', async () => {
    const { controller, renders, patched, release } = await harness({ patchLive: () => false })
    const painted = renders.length
    release({ ...detail, version: 8, events: [event(2, 'b')] })
    await flush()
    expect(patched).toHaveLength(0)
    expect(renders.length).toBe(painted + 1)
    controller.destroy()
  })

  it('长轮询在跑的时候,3 秒列表这条腿不再重拉详情;force 才拉', async () => {
    const { controller, calls, release } = await harness()
    const detailCalls = () => calls.filter(path => path.startsWith('/v1/workbench/task') && !path.includes('since=')).length
    const before = detailCalls()
    await controller.refresh()
    expect(detailCalls()).toBe(before)
    await controller.refresh({ force: true })
    expect(detailCalls()).toBe(before + 1)
    release({ ...detail, version: 9, events: [] })
    controller.destroy()
  })

  it('换任务 / 新建 / 销毁都把长轮询停掉', async () => {
    const { controller } = await harness()
    expect(controller.liveActive()).toBe(true)
    controller.newTask('/work')
    expect(controller.liveActive()).toBe(false)
    controller.resumeLive()
    expect(controller.liveActive()).toBe(false)
    await controller.selectTask('T')
    expect(controller.liveActive()).toBe(true)
    controller.destroy()
    expect(controller.liveActive()).toBe(false)
  })

  it('旧后台不带 version 就不开长轮询,详情退回 3 秒重拉', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    const calls: string[] = []
    const invokeWorkbenchApi = vi.fn((_method: string, path: string) => {
      calls.push(path)
      if (path.startsWith('/v1/matters')) return Promise.resolve({ matters: [] })
      if (path.startsWith('/v1/workbench/task')) return Promise.resolve(detail)
      return Promise.resolve({ tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false })
    })
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: vi.fn() } as any)
    await controller.selectTask('T')
    expect(controller.liveActive()).toBe(false)
    expect(calls.some(path => path.includes('since='))).toBe(false)
    await controller.refresh()
    expect(calls.filter(path => path.startsWith('/v1/workbench/task')).length).toBe(2)
    controller.destroy()
  })

  it('列表只是把选中任务的 updatedAt 往前推,不该整页重画', async () => {
    const { controller, renders, list, release } = await harness()
    await controller.refresh()
    await flush()
    const painted = renders.length
    list.tasks = [{ ...task, updatedAt: task.updatedAt + 5000 }]
    await controller.refresh()
    expect(renders.length).toBe(painted)
    expect(controller.state.tasks[0]?.updatedAt).toBe(task.updatedAt + 5000)
    list.tasks = [{ ...task, updatedAt: task.updatedAt + 9000, status: 'completed' }]
    await controller.refresh()
    expect(renders.length).toBe(painted + 1)
    release({ ...detail, version: 9, events: [] })
    controller.destroy()
  })

  it('长轮询中途拿到不带 version 的响应:停下来,并且真的换回 3 秒重拉', async () => {
    const { controller, calls, release } = await harness()
    const detailCalls = () => calls.filter(path => path.startsWith('/v1/workbench/task') && !path.includes('since=')).length
    const before = detailCalls()
    release({ ...detail, events: [] })
    await flush()
    expect(controller.liveActive()).toBe(false)
    controller.resumeLive()
    expect(controller.liveActive()).toBe(false)
    await controller.refresh()
    expect(detailCalls()).toBe(before + 1)
    controller.destroy()
  })
})

describe('工作台「改动」的拉取与重画', () => {
  const task = { id: 'T', title: 'Live', path: '/work', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null, archivedAt: null }
  const detail = { task, events: [{ id: 1, taskId: 'T', kind: 'text', text: 'a', createdAt: 1 }], artifacts: [], runId: 'run-A' }
  const file = (mark?: string) => ({ path: 'src/app.ts', preexisting: false, kind: 'modified', diff: '@@ -1 +1 @@\n-a\n+b', ...(mark ? { mark: { mark, comment: '', createdAt: 9 } } : {}) })
  const turn = (files: unknown[]) => ({ artifactId: 'ART-1', sha256: 'a'.repeat(64), name: '对比.json', createdAt: 100, status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files })

  it('选中任务并行拉改动;标记变了才整页重画;换任务先清空', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    let reviews: unknown[] = [turn([file()])]
    let release!: (value: unknown) => void
    const calls: string[] = []
    const invokeWorkbenchApi = vi.fn((_method: string, path: string) => {
      calls.push(path)
      if (path.startsWith('/v1/matters')) return Promise.resolve({ matters: [] })
      if (path.startsWith('/v1/workbench/review')) return Promise.resolve({ reviews })
      if (path.startsWith('/v1/workbench/task')) {
        if (path.includes('since=')) return new Promise(resolve => { release = resolve as (value: unknown) => void })
        return Promise.resolve({ ...detail, version: 5 })
      }
      return Promise.resolve({ tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false })
    })
    const renders: unknown[] = []
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: () => renders.push(1), patchLive: () => true } as any)
    await controller.selectTask('T')
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    expect(calls).toContain('/v1/workbench/review?id=T')
    const painted = renders.length
    reviews = [turn([file('accepted')])]
    // 微信那边改了标记:version 往前走了、没有新事件(标记不写事件),任务同时跑完了 —— 重拉 + 整页重画。
    release({ ...detail, version: 6, events: [], task: { ...task, status: 'completed' } })
    await vi.waitFor(() => expect(controller.state.reviews?.[0]?.files?.[0]?.mark?.mark).toBe('accepted'))
    expect(calls.filter(path => path.startsWith('/v1/workbench/review')).length).toBe(2)
    expect(renders.length).toBeGreaterThan(painted + 1)
    controller.newTask('/work')
    expect(controller.state.reviews).toEqual([])
    expect(controller.state.reviewsSignature).toBe('[]')
    controller.destroy()
  })

  // 终审(2026-09-17):结构签名里还有 runtime / 权限 / 输入回执,它们动一下跟改动记录毫无关系。
  it('只有 runtime 变了不重拉改动;成果变了才拉', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    let release!: (value: unknown) => void
    const calls: string[] = []
    const invokeWorkbenchApi = vi.fn((_method: string, path: string) => {
      calls.push(path)
      if (path.startsWith('/v1/matters')) return Promise.resolve({ matters: [] })
      if (path.startsWith('/v1/workbench/review')) return Promise.resolve({ reviews: [turn([file()])] })
      if (path.startsWith('/v1/workbench/task')) {
        if (path.includes('since=')) return new Promise(resolve => { release = resolve as (value: unknown) => void })
        return Promise.resolve({ ...detail, version: 5 })
      }
      return Promise.resolve({ tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false })
    })
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: () => {}, patchLive: () => true } as any)
    await controller.selectTask('T')
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    const reviewCalls = () => calls.filter(path => path.startsWith('/v1/workbench/review')).length
    const pollCalls = () => calls.filter(path => path.includes('since=')).length
    expect(reviewCalls()).toBe(1)
    // 只是前台/后台这类运行时信号变了(带着新事件,免得落到「空转」那条腿上)——改动记录没动过。
    release({ ...detail, version: 6, events: [{ id: 2, taskId: 'T', kind: 'text', text: 'b', createdAt: 2 }], runtime: { foreground: true } })
    await vi.waitFor(() => expect(pollCalls()).toBe(2))
    expect(reviewCalls()).toBe(1)
    // 成果变了(新的一轮快照)⇒ 必须重拉。
    release({ ...detail, version: 7, events: [{ id: 3, taskId: 'T', kind: 'text', text: 'c', createdAt: 3 }], runtime: { foreground: true }, artifacts: [{ id: 'ART-1', taskId: 'T', name: '对比.json', mime: 'application/vnd.wechat-cc.git-review+json', size: 1, sha256: 'a'.repeat(64), createdAt: 9, approvedAt: null }] })
    await vi.waitFor(() => expect(reviewCalls()).toBe(2))
    controller.destroy()
  })

  it('长轮询空转(version 没往前走)不重拉改动;版本动了才拉', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    let release!: (value: unknown) => void
    const calls: string[] = []
    const invokeWorkbenchApi = vi.fn((_method: string, path: string) => {
      calls.push(path)
      if (path.startsWith('/v1/matters')) return Promise.resolve({ matters: [] })
      if (path.startsWith('/v1/workbench/review')) return Promise.resolve({ reviews: [turn([file()])] })
      if (path.startsWith('/v1/workbench/task')) {
        if (path.includes('since=')) return new Promise(resolve => { release = resolve as (value: unknown) => void })
        return Promise.resolve({ ...detail, version: 5 })
      }
      return Promise.resolve({ tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false })
    })
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: () => {}, patchLive: () => true } as any)
    await controller.selectTask('T')
    await vi.waitFor(() => expect(controller.state.reviews).toHaveLength(1))
    const reviewCalls = () => calls.filter(path => path.startsWith('/v1/workbench/review')).length
    const pollCalls = () => calls.filter(path => path.includes('since=')).length
    expect(reviewCalls()).toBe(1)
    // 长轮询等超时回来:同一个 version、没有新事件 —— 什么都没发生,别再问一次。
    release({ ...detail, version: 5, events: [] })
    await vi.waitFor(() => expect(pollCalls()).toBe(2))
    expect(reviewCalls()).toBe(1)
    // 版本往前走了(标记可能是微信那边改的),这一次要重拉。
    release({ ...detail, version: 6, events: [] })
    await vi.waitFor(() => expect(reviewCalls()).toBe(2))
    controller.destroy()
  })
})

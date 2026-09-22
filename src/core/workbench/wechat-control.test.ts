import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {makeWechatWorkbenchControl,wechatTaskMessageKey} from './wechat-control'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentProvider} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'

let root:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService,owner:string|null
const result:AgentEvent={kind:'result',sessionId:'native-one',numTurns:1,durationMs:1}
const identity={accountId:'account',userId:'owner',msgId:'message-one',createTimeMs:1}
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
function setup(provider:AgentProvider){
  const registry=createProviderRegistry();registry.register('claude',provider,{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>owner})
}
const create=(text='整理周报')=>service.create({path:project,providerId:'claude',text})
const settled=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)}
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-wechat-control-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);owner='owner'})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(root)})

describe('WeChat task control through the shared service',()=>{
  it.each([
    ['workbench_attachments_unsupported','移除附件'],
    ['workbench_execution_unsupported','自动设置'],
    ['workbench_resume_unsupported','桌面'],
    ['unattended_ack_required','免审'],
    ['unavailable_provider','连接或管理'],
  ])('translates executor admission failure %s into an actionable reply',async(code,hint)=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const projectId='p-'+'a'.repeat(20)
    const control=makeWechatWorkbenchControl({store,ownerChatId:()=>owner,actions:{...service,projects:()=>[{id:projectId,name:'project',path:project,providerId:'claude'}],createWechat(){throw Error(code)}}})
    const reply=await control('owner',`任务 新建 ${projectId} 整理周报`,identity)
    expect(reply).toContain(hint)
    expect(reply).not.toContain(code)
    if(code==='unattended_ack_required'){
      expect(reply).toContain('桌面')
      expect(reply).toContain('只能停止')
    }
    if(code==='unavailable_provider'){
      expect(reply).not.toContain('Claude Code')
      expect(reply).not.toContain('安装')
    }
  })
  it('shows retained runtime observations in list/detail while keeping child output out of the main reply',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=store.create({title:'后台校对',path:project,providerId:'claude',ownerChatId:'owner'})
    store.update(task.id,'running')
    store.addEvent(task.id,'text','主回复已经到达。')
    store.recordAgentEvent(task.id,'epoch',{kind:'tool_call',tool:'Agent',activity:{id:'child',type:'agent',status:'completed',label:'子助手',output:'不作为主回复的子结果'}})
    const runtime={retained:true,foreground:'idle' as const,backgroundCount:0,input:'send' as const}
    const control=makeWechatWorkbenchControl({store,ownerChatId:()=>owner,actions:{...service,detail:id=>({...service.detail(id),runtime})}})
    expect(await control('owner','任务')).toContain('会话保留中')
    const reply=await control('owner',`任务 ${task.id}`)
    expect(reply).toContain('会话保留中')
    expect(reply).toContain('主回复已经到达。')
    expect(reply).not.toContain('不作为主回复的子结果')
    expect(reply).toContain(`结束：任务 ${task.id} 停止`)
    runtime.backgroundCount=2
    expect(await control('owner',`任务 ${task.id}`)).toContain('后台执行中 · 2')
    store.update(task.id,'cancelling')
    expect(await control('owner',`任务 ${task.id}`)).toContain('正在停止')
    expect(await control('owner',`任务 ${task.id}`)).not.toContain('会话保留中')
  })
  it('does not promise a new round for a retained queue-only runtime',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=store.create({title:'后台会话',path:project,providerId:'claude',ownerChatId:'owner'})
    store.update(task.id,'running')
    const control=makeWechatWorkbenchControl({store,ownerChatId:()=>owner,actions:{...service,
      detail:id=>({...service.detail(id),runId:'epoch',inputMode:'queue',runtime:{retained:true,foreground:'idle',backgroundCount:0,input:'queue'}}),
      submitInput:async(id,input)=>store.liveInputs.add({id:input.requestId,taskId:id,runId:input.runId,text:input.text}),
    }})
    const reply=await control('owner',`任务 ${task.id} 补充 保留接口`,identity)
    expect(reply).toContain('不会自动发送')
    expect(reply).not.toContain('下一轮')
    expect(await control('owner',`任务 ${task.id} 补充 保留接口`,identity)).toBe(reply)
  })
  it('等待行说人话:持有者已答复即将自动让位时加一句同义的话,持有者仍在写时不加',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=store.create({title:'排队中',path:project,providerId:'claude',ownerChatId:'owner'})
    const idle=async()=>{
      const waitingFor={taskId:'HOLDER',title:'Holder task',reason:'same_path' as const,holderWriting:false,closeInMs:7000}
      const control=makeWechatWorkbenchControl({store,ownerChatId:()=>owner,actions:{...service,detail:id=>{const detail=service.detail(id);return{...detail,task:{...detail.task,waitingFor}}}}})
      return control('owner',`任务 ${task.id}`)
    }
    const reply=await idle()
    expect(reply).toContain('「Holder task」已答复，会话还开着')
    expect(reply).toContain('等 7 秒它会自己让开')
    expect(reply).toContain('或者说『任务 HOLDER 停止』')
    const writing=async()=>{
      const waitingFor={taskId:'HOLDER',title:'Holder task',reason:'same_path' as const,holderWriting:true,closeInMs:null}
      const control=makeWechatWorkbenchControl({store,ownerChatId:()=>owner,actions:{...service,detail:id=>{const detail=service.detail(id);return{...detail,task:{...detail.task,waitingFor}}}}})
      return control('owner',`任务 ${task.id}`)
    }
    expect(await writing()).not.toContain('已答复，会话还开着')
  })
  it('lists only the current owner original tasks and keeps ordinary conversation out of the workbench',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const mine=store.create({title:'我的报告',path:project,providerId:'claude',ownerChatId:'owner'})
    store.create({title:'别人的秘密',path:project,providerId:'claude',ownerChatId:'previous-owner'})
    const list=await service.handleWechat('owner','任务')
    expect(list).toContain(mine.id);expect(list).toContain('我的报告');expect(list).not.toContain('别人的秘密')
    expect(await service.handleWechat('owner','刚才的任务怎么样了')).toBeNull()
    expect(await service.handleWechat('other','任务')).toBeNull()
    owner='new-owner';expect(await service.handleWechat('new-owner',`任务 ${mine.id}`)).not.toContain('我的报告')
  })

  it('shows latest assistant output separately from errors, plus named artifact versions and held input',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=store.create({title:'报告',path:project,providerId:'claude',ownerChatId:'owner'})
    store.addEvent(task.id,'text','已完成表格核对。');store.addEvent(task.id,'error','导出失败，需要重试。');store.update(task.id,'failed','export_failed')
    store.addArtifact({taskId:task.id,name:'核对结果.csv',mime:'text/csv',size:12,sha256:'a'.repeat(64),storagePath:'/unused/snapshot'})
    const input=store.liveInputs.add({id:crypto.randomUUID(),taskId:task.id,runId:crypto.randomUUID(),text:'请保留附录'})
    store.liveInputs.set(input.id,'held','未发送')
    const reply=await service.handleWechat('owner',`任务 ${task.id} 结果`)
    expect(reply).toContain('已完成表格核对。');expect(reply).toContain('导出失败');expect(reply).toContain('核对结果.csv')
    expect(reply).toContain('请保留附录');expect(reply).not.toContain('/unused/snapshot')
    expect(store.events(task.id).filter(e=>e.kind==='user')).toEqual([])
  })

  it('shows the newest eight artifact versions, including the current result',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=create();await settled(task.id)
    for(let i=1;i<=9;i++)store.addArtifact({taskId:task.id,name:`result-${i}.txt`,mime:'text/plain',size:i,sha256:String(i).repeat(64),storagePath:'/unused'})
    const reply=await service.handleWechat('owner',`任务 ${task.id} 结果`)
    expect(reply).toContain('result-9.txt');expect(reply).not.toContain('result-1.txt')
  })

  it.each([false,true])('never replays a stop against a newer desktop run (daemon restart: %s)',async restart=>{
    let cancels=0
    const provider:AgentProvider={async spawn(){const turn=gate();return{async *dispatch(){yield {kind:'init',sessionId:'native-one'};await turn.promise;yield result},async cancel(){cancels++;turn.resolve()},async close(){turn.resolve()}}}}
    setup(provider);const task=create();await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
    const original=await service.handleWechat('owner',`任务 ${task.id} 停止`,identity);await settled(task.id)
    if(restart){await service.shutdown();db.close();db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);setup(provider)}
    service.continueTask(task.id,'desktop next');await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
    const currentRun=service.detail(task.id).runId
    expect(await service.handleWechat('owner',`任务 ${task.id} 停止`,identity)).toBe(original)
    expect(await service.handleWechat('owner',`任务 ${task.id} 补充 changed stop message`,identity)).toContain('不一致')
    expect(service.detail(task.id).runId).toBe(currentRun);expect(service.detail(task.id).task.status).toBe('running');expect(cancels).toBe(1)
  })

  it('does not apply an unfinished durable stop receipt to a later run after restart',async()=>{
    let cancels=0
    const provider:AgentProvider={async spawn(){const turn=gate();return{async *dispatch(){yield {kind:'init',sessionId:'native-one'};await turn.promise;yield result},async cancel(){cancels++;turn.resolve()},async close(){turn.resolve()}}}}
    setup(provider);const task=create();await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
    const text=`任务 ${task.id} 停止`,requestId=wechatTaskMessageKey({...identity,chatId:'owner',text})!.slice('workbench:'.length)
    store.controlReceipts.reserve({id:requestId,taskId:task.id,runId:service.detail(task.id).runId!,action:'stop',textHash:createHash('sha256').update(text).digest('hex')})
    await service.shutdown();db.close();db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);setup(provider)
    service.continueTask(task.id,'desktop next');await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
    const before=cancels,currentRun=service.detail(task.id).runId
    expect(await service.handleWechat('owner',text,identity)).toContain('尚未确认')
    expect(service.detail(task.id).runId).toBe(currentRun);expect(service.detail(task.id).task.status).toBe('running');expect(cancels).toBe(before)
  })

  it('binds a no-op stop receipt to the ended run instead of stopping a later desktop run',async()=>{
    let spawned=0,cancels=0
    setup({async spawn(){const n=++spawned,turn=gate();return{async *dispatch(){yield {kind:'init',sessionId:'native-one'};if(n>1)await turn.promise;yield result},async cancel(){cancels++;turn.resolve()},async close(){turn.resolve()}}}})
    const task=create();await settled(task.id)
    const original=await service.handleWechat('owner',`任务 ${task.id} 停止`,identity)
    expect(original).toContain('已经结束')
    service.continueTask(task.id,'desktop next');await expect.poll(()=>spawned).toBe(2)
    expect(await service.handleWechat('owner',`任务 ${task.id} 停止`,identity)).toBe(original)
    await expect(service.cancel(task.id,'stale-run')).rejects.toThrow('control_stale')
    expect(service.detail(task.id).task.status).toBe('running');expect(cancels).toBe(0)
  })

  it('acknowledges a running native supplement only after steering succeeds, and retries the inbound once across run completion',async()=>{
    const turn=gate(),ack=gate(),seen:string[]=[]
    setup({async spawn(){return{async *dispatch(){yield {kind:'init',sessionId:'native-one'};await turn.promise;yield result},async steer(text){seen.push(text);await ack.promise},async close(){turn.resolve()}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).inputMode).toBe('steer')
    let replied=false
    const send=service.handleWechat('owner',`任务 ${task.id} 补充 保留附录`,identity).then(reply=>{replied=true;return reply})
    await expect.poll(()=>seen.length).toBe(1);expect(replied).toBe(false)
    expect(await service.handleWechat('owner',`任务 ${task.id} 补充 保留附录`,identity)).toContain('尚未确认')
    expect(seen).toHaveLength(1)
    ack.resolve();expect(await send).toContain('已传达')
    turn.resolve();await settled(task.id)
    expect(await service.handleWechat('owner',`任务 ${task.id} 补充 保留附录`,identity)).toContain('已传达')
    expect(seen).toEqual(['保留附录']);expect(store.events(task.id).filter(e=>e.kind==='user').map(e=>e.text)).toEqual(['整理周报','保留附录'])
  })

  it('queues a running supplement for the next native turn',async()=>{
    const turn=gate(),seen:string[]=[],resumes:Array<string|undefined>=[]
    setup({async spawn(_p,ctx){resumes.push(ctx.resumeSessionId);return{async *dispatch(text){seen.push(text);if(seen.length===1)await turn.promise;yield result},async close(){turn.resolve()}}}})
    const task=create();await expect.poll(()=>seen.length).toBe(1)
    const reply=await service.handleWechat('owner',`任务 ${task.id} 补充 缩短摘要`,identity)
    expect(reply).toContain('下一轮');expect(reply).not.toContain('已传达');expect(seen).toHaveLength(1)
    turn.resolve();await expect.poll(()=>seen.length).toBe(2);await settled(task.id)
    expect(seen).toEqual(['整理周报','缩短摘要']);expect(resumes).toEqual([undefined,'native-one'])
  })

  it('does not re-execute an idle phone continuation after reply failure and daemon restart',async()=>{
    const seen:string[]=[]
    const provider:AgentProvider={async spawn(){return{async *dispatch(text){seen.push(text);yield result},async close(){}}}}
    setup(provider);const task=create();await settled(task.id)
    await service.handleWechat('owner',`任务 ${task.id} 继续 保留附录`,identity);await settled(task.id)
    await service.shutdown();setup(provider)
    await service.handleWechat('owner',`任务 ${task.id} 继续 保留附录`,identity)
    await new Promise(r=>setImmediate(r))
    expect(seen).toEqual(['整理周报','保留附录'])
    expect(store.events(task.id).filter(e=>e.kind==='user').map(e=>e.text)).toEqual(['整理周报','保留附录'])
  })

  it('binds message identity to its task and rejects changed text on replay',async()=>{
    const turn=gate(),seen:string[]=[]
    setup({async spawn(){return{async *dispatch(){await turn.promise;yield result},async steer(text){seen.push(text)},async close(){turn.resolve()}}}})
    const one=create();await expect.poll(()=>service.detail(one.id).inputMode).toBe('steer')
    const otherProject=join(root,'other');mkdirSync(otherProject)
    const two=service.create({path:otherProject,providerId:'claude',text:'另一件事'})
    await expect.poll(()=>service.detail(two.id).inputMode).toBe('steer')
    await service.handleWechat('owner',`任务 ${one.id} 补充 第一条`,identity)
    expect(await service.handleWechat('owner',`任务 ${one.id} 补充 被修改的内容`,identity)).toContain('不一致')
    await service.handleWechat('owner',`任务 ${two.id} 补充 第二条`,identity)
    expect(seen).toEqual(['第一条','第二条'])
    expect(service.detail(one.id).inputs[0]?.id).not.toBe(service.detail(two.id).inputs[0]?.id)
  })

  it('accepts different timestamp-only messages in the same millisecond while deduplicating exact redelivery',async()=>{
    const turn=gate(),seen:string[]=[]
    setup({async spawn(){return{async *dispatch(){await turn.promise;yield result},async steer(text){seen.push(text)},async close(){turn.resolve()}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).inputMode).toBe('steer')
    const withoutId={accountId:'account',userId:'owner',createTimeMs:123}
    for(const text of ['保留附录','缩短摘要','保留附录'])await service.handleWechat('owner',`任务 ${task.id} 补充 ${text}`,withoutId)
    expect(seen).toEqual(['保留附录','缩短摘要'])
  })

  it('rejects malformed continuation receipt UUIDs before writing task history',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=create();await settled(task.id);const before=store.events(task.id)
    for(const inputRequestId of ['-'.repeat(36),'a'.repeat(36),'aaaaaaaa-aaaa-0aaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa']){
      expect(()=>service.continueTask(task.id,'bad',{inputRequestId})).toThrow('invalid_request')
    }
    expect(store.events(task.id)).toEqual(before)
  })

  it('requires the actual inbound sender to be the bound owner, even when chatId matches',async()=>{
    setup({async spawn(_p,ctx){return{async *dispatch(){await ctx.requestPermission!({tool:'Bash',description:'read report'});yield result},async close(){}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).permissions.length).toBe(1)
    const request=service.detail(task.id).permissions[0]!,spoof={...identity,userId:'other-member'}
    expect(await service.handleWechat('owner',`任务 ${task.id}`,spoof)).toBeNull()
    expect(await service.handleWechat('owner',`任务 ${task.id} 允许 ${request.id}`,spoof)).toBeNull()
    expect(service.detail(task.id).permissions).toHaveLength(1)
  })

  it('retains an unconfirmed native supplement without claiming it was delivered',async()=>{
    const turn=gate()
    setup({async spawn(){return{async *dispatch(){await turn.promise;yield result},async steer(){throw Error('ack lost')},async close(){turn.resolve()}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).inputMode).toBe('steer')
    const reply=await service.handleWechat('owner',`任务 ${task.id} 补充 缩短摘要`,identity)
    expect(reply).toContain('未确认');expect(reply).not.toContain('已传达');expect(service.detail(task.id).inputs[0]?.status).toBe('held')
  })

  it('shows and resolves only the exact permission, rejecting wrong task, owner and duplicate grants',async()=>{
    const allowed:boolean[]=[]
    setup({async spawn(_p,ctx){return{async *dispatch(){allowed.push(await ctx.requestPermission!({tool:'Bash',description:'读取项目中的报告文件'}));yield result},async close(){}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).permissions.length).toBe(1)
    const request=service.detail(task.id).permissions[0]!
    const other=store.create({title:'其他任务',path:project,providerId:'claude',ownerChatId:'owner'})
    expect(await service.handleWechat('owner',`任务 ${task.id}`)).toContain(request.id)
    expect(await service.handleWechat('owner',`任务 ${task.id} 权限 ${request.id}`)).toContain('读取项目中的报告文件')
    await service.handleWechat('other',`任务 ${task.id} 允许 ${request.id}`)
    expect(await service.handleWechat('owner',`任务 ${other.id} 允许 ${request.id}`)).toContain('已失效')
    expect(allowed).toEqual([])
    expect(await service.handleWechat('owner',`任务 ${task.id} 允许 ${request.id}`)).toContain('已允许')
    await settled(task.id);expect(allowed).toEqual([true])
    expect(await service.handleWechat('owner',`任务 ${task.id} 允许 ${request.id}`)).toContain('已失效')
    service.continueTask(task.id,'再检查');await expect.poll(()=>service.detail(task.id).permissions.length).toBe(1)
    expect(await service.handleWechat('owner',`任务 ${task.id} 允许 ${request.id}`)).toContain('已失效')
    expect(service.detail(task.id).permissions.length).toBe(1)
    const fresh=service.detail(task.id).permissions[0]!.id
    expect(await service.handleWechat('owner',`任务 ${task.id} 拒绝 ${fresh}`)).toContain('已拒绝');await settled(task.id)
    expect(allowed).toEqual([true,false])
  })

  it('does not allow an oversized permission whose full action cannot be displayed on the phone',async()=>{
    setup({async spawn(_p,ctx){return{async *dispatch(){await ctx.requestPermission!({tool:'Bash',description:'x'.repeat(7000)});yield result},async close(){}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).permissions.length).toBe(1)
    const request=service.detail(task.id).permissions[0]!
    expect(await service.handleWechat('owner',`任务 ${task.id} 允许 ${request.id}`)).toContain('桌面')
    expect(service.detail(task.id).permissions).toHaveLength(1)
    await service.handleWechat('owner',`任务 ${task.id} 拒绝 ${request.id}`);await settled(task.id)
  })

  it('never applies a stale desktop permission reply to the next phone request or vice versa',async()=>{
    const allowed:boolean[]=[]
    setup({async spawn(_p,ctx){return{async *dispatch(){for(const description of ['first','second'])allowed.push(await ctx.requestPermission!({tool:'Bash',description}));yield result},async close(){}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).permissions.length).toBe(1)
    const first=service.detail(task.id).permissions[0]!.id
    service.resolvePermission(task.id,first,'allow')
    await expect.poll(()=>service.detail(task.id).permissions[0]?.description).toBe('second')
    const second=service.detail(task.id).permissions[0]!.id
    expect(await service.handleWechat('owner',`任务 ${task.id} 允许 ${first}`)).toContain('已失效')
    expect(allowed).toEqual([true]);expect(service.detail(task.id).permissions[0]!.id).toBe(second)
    expect(await service.handleWechat('owner',`任务 ${task.id} 拒绝 ${second}`)).toContain('已拒绝')
    expect(()=>service.resolvePermission(task.id,second,'allow')).toThrow('permission_stale')
    await settled(task.id);expect(allowed).toEqual([true,false])
  })

  it('never applies a stale desktop answer to the next phone question or vice versa',async()=>{
    const answers:unknown[]=[]
    setup({async spawn(_p,ctx){return{async *dispatch(){for(const question of ['first','second'])answers.push(await ctx.requestUserInput!({questions:[{id:'note',header:'备注',question,options:[],allowOther:true}]}));yield result},async close(){}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).questions.length).toBe(1)
    const first=service.detail(task.id).questions[0]!.id
    service.resolveAnswer(task.id,first,{note:['desktop answer']})
    await expect.poll(()=>service.detail(task.id).questions[0]?.questions[0]?.question).toBe('second')
    const second=service.detail(task.id).questions[0]!.id
    expect(await service.handleWechat('owner',`任务 ${task.id} 回答 ${first} 其他 old`)).toContain('已失效')
    expect(answers).toEqual([{note:['desktop answer']}])
    expect(await service.handleWechat('owner',`任务 ${task.id} 回答 ${second} 其他 phone answer`)).toContain('已提交回答')
    expect(()=>service.resolveAnswer(task.id,second,{note:['late desktop']})).toThrow('question_stale')
    await settled(task.id);expect(answers).toEqual([{note:['desktop answer']},{note:['phone answer']}])
  })

  it('shows question options and maps an explicit answer to the owning request only',async()=>{
    let answer:unknown
    setup({async spawn(_p,ctx){return{async *dispatch(){answer=await ctx.requestUserInput!({questions:[{id:'format',header:'格式',question:'需要哪种文件？',options:[{label:'PDF',description:'固定版式'},{label:'Word',description:'方便编辑'}],allowOther:true}]});yield result},async close(){}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).questions.length).toBe(1)
    const request=service.detail(task.id).questions[0]!,other=store.create({title:'其他',path:project,providerId:'claude',ownerChatId:'owner'})
    const show=await service.handleWechat('owner',`任务 ${task.id} 问题 ${request.id}`)
    expect(show).toContain('需要哪种文件？');expect(show).toContain('Word');expect(show).toContain(request.id)
    expect(await service.handleWechat('owner',`任务 ${other.id} 回答 ${request.id} 2`)).toContain('已失效')
    await service.handleWechat('other',`任务 ${task.id} 回答 ${request.id} 2`)
    expect(await service.handleWechat('owner',`任务 ${task.id} 回答 ${request.id} 9`)).toContain('答案')
    expect(service.detail(task.id).questions).toHaveLength(1)
    expect(await service.handleWechat('owner',`任务 ${task.id} 回答 ${request.id} 2`)).toContain('已提交回答')
    await settled(task.id);expect(answer).toEqual({format:['Word']})
    expect(await service.handleWechat('owner',`任务 ${task.id} 回答 ${request.id} 1`)).toContain('已失效')
  })

  it('answers a complete multi-question request with exact option labels and allowed free text',async()=>{
    let answer:unknown
    setup({async spawn(_p,ctx){return{async *dispatch(){answer=await ctx.requestUserInput!({questions:[{id:'parts',header:'章节',question:'保留哪些？',options:[{label:'正文',description:''},{label:'附录',description:''}],multiSelect:true},{id:'note',header:'备注',question:'其他要求？',options:[],allowOther:true}]});yield result},async close(){}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).questions.length).toBe(1)
    const request=service.detail(task.id).questions[0]!
    expect(await service.handleWechat('owner',`任务 ${task.id} 回答 ${request.id} 1=1,2\n2=其他 保留原表格`)).toContain('已提交回答')
    await settled(task.id);expect(answer).toEqual({parts:['正文','附录'],note:['保留原表格']})
  })

  it('consumes malformed explicit control verbs instead of sending them as new task text',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=create();await settled(task.id)
    const before=store.events(task.id)
    for(const suffix of ['允许','回答 wrong-id 1','权限','补充'])expect(await service.handleWechat('owner',`任务 ${task.id} ${suffix}`)).toContain('用法')
    expect(store.events(task.id)).toEqual(before)
  })
})

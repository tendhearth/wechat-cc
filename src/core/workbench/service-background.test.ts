import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentAttachment,AgentEvent,AgentProvider,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime,SpawnContext} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'

function gate(){let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const result:AgentEvent={kind:'result',sessionId:'owned-parent',numTurns:1,durationMs:1}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
class OwnedRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'idle',backgroundCount:0,input:'send'}
  started:string[]=[]
  startMaterials:readonly AgentAttachment[]=[]
  submitted:Array<{id:string;text:string;materials:readonly AgentAttachment[];ack:ReturnType<typeof gate>;persistedStatus?:string}>=[]
  subscribed=false
  closeCount=0
  closeGate?:ReturnType<typeof gate>
  context?:SpawnContext
  readReceipt?:(id:string)=>{status:string}|null
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:(text,materials=[])=>{
      if(!this.subscribed)throw Error('runtime_start_without_consumer')
      this.started.push(text)
      this.startMaterials=materials
      this.queue.push({kind:'init',sessionId:'owned-parent'})
      this.queue.push({kind:'text',itemId:'main-first',text:'The parent has replied.'})
      this.queue.push(result)
    },
    submit:(id,text,materials=[])=>{const ack=gate();this.submitted.push({id,text,materials,ack,persistedStatus:this.readReceipt?.(id)?.status});return ack.promise},
    snapshot:()=>this.state,
  }
  session:AgentSession={
    workbenchRuntime:this.runtime,
    async *dispatch(){yield {kind:'text',text:'legacy dispatch was used'} as AgentEvent;yield result},
    close:async()=>{this.closeCount++;this.queue.end();if(this.closeGate)await this.closeGate.promise},
  }
}
let area:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService
let revocations:string[]
function setup(owned:OwnedRuntime,extra:{timeoutMs?:number;closeTimeoutMs?:number}={},other?:AgentProvider){
  const registry=createProviderRegistry();let spawns=0
  const provider:AgentProvider={async spawn(p,context){
    if(spawns++&&other)return other.spawn(p,context)
    owned.context=context;return owned.session
  }}
  registry.register('claude',provider,{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  registry.register('codex',provider,{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);owned.readReceipt=id=>store.liveInputs.get(id)
  service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>null,mintSessionToken:()=> 'owned-token',revokeSessionToken:key=>revocations.push(key),...extra})
}
const create=()=>service.create({path:project,providerId:'claude',text:'Start owned work',execution:{defaults:'native',model:'owned-model',reasoningEffort:'high'}})
const started=async(owned:OwnedRuntime)=>expect.poll(()=>owned.started.length,{interval:5}).toBe(1)
const settled=async(id:string)=>expect.poll(()=>service.detail(id).task.status,{interval:5}).not.toMatch(/^(queued|running|cancelling)$/)
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-service-background-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')});revocations=[]})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})

describe('workbench owned background runtime',()=>{
  it('keeps one run, its permissions and writer reservation after parent results until explicit close',async()=>{
    const owned=new OwnedRuntime();owned.state.backgroundCount=1
    setup(owned,{}, {async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=create();await started(owned)
    const runId=service.detail(task.id).runId!
    expect(owned.context?.workbenchLifecycle).toBe(true)
    await expect.poll(()=>store.events(task.id).some(e=>e.text==='The parent has replied.')).toBe(true)
    writeFileSync(join(project,'.cc-workbench',task.id,'late.txt'),'background output')
    const same=service.create({path:project,providerId:'codex',text:'Wait for the writer'})
    const other=join(area,'other');mkdirSync(other)
    const parallel=service.create({path:other,providerId:'codex',text:'Independent work'});await settled(parallel.id)
    expect(service.detail(same.id).task.waitingFor?.taskId).toBe(task.id)
    const permission=owned.context!.requestPermission!({tool:'Read',description:'Background file read'},new AbortController().signal)
    await expect.poll(()=>service.detail(task.id).permissions.length).toBe(1)
    service.resolvePermission(task.id,service.detail(task.id).permissions[0]!.id,'allow')
    await expect(permission).resolves.toBeDefined()
    owned.queue.push({kind:'tool_call',tool:'Agent',activity:{id:'child-occurrence',type:'agent',label:'Owned child',status:'completed'}})
    owned.state.backgroundCount=0
    owned.queue.push({kind:'text',itemId:'automatic-A',text:'A automatic reply'})
    owned.queue.push(result)
    owned.queue.push({kind:'text',itemId:'automatic-B',text:'B later automatic reply'})
    owned.queue.push(result)
    await expect.poll(()=>store.events(task.id).some(e=>e.text==='B later automatic reply')).toBe(true)
    expect(service.detail(task.id).runId).toBe(runId)
    expect(service.detail(task.id).task.status).toBe('running')
    expect(store.events(task.id).filter(e=>e.kind==='text').every(e=>e.runId===runId)).toBe(true)
    expect(owned.closeCount).toBe(0);expect(revocations).not.toContain(`workbench/${task.id}`)
    // 回合落定(前台空闲、后台归零)就登记成果,不必先关会话 —— 主人拿到东西和
    // 「这条 run 还没拆」是两件事:下面几行仍然要求没有关闭、没有回收凭证。
    expect(service.detail(task.id).artifacts.map(a=>a.name)).toEqual(['late.txt'])
    expect(()=>service.continueTask(task.id,'Change model',{execution:{model:'another'}})).toThrow('workbench_busy')
    await service.cancel(task.id);await settled(task.id);await settled(same.id)
    // 停止请求到达时本轮早已答复(前台空闲、后台归零、无待批):这是收工,不是取消。
    // 一件做成了的事不该记成 cancelled —— 2026-09-15 真机上五个成功任务四个显示「已取消」。
    expect(service.detail(task.id).task.status).toBe('completed')
    expect(service.detail(task.id).task.phase).toBe('replied')
    expect(owned.closeCount).toBe(1);expect(revocations).toContain(`workbench/${task.id}`)
    expect(service.detail(task.id).artifacts.map(a=>a.name)).toContain('late.txt')
  })

  it('copies runtime observations to list and detail and derives send/steer/queue dynamically',async()=>{
    const owned=new OwnedRuntime();setup(owned);const task=create();await started(owned)
    expect(service.detail(task.id).runtime).toEqual({retained:true,foreground:'idle',backgroundCount:0,input:'send'})
    expect(service.list().tasks[0]?.runtime).toEqual({retained:true,foreground:'idle',backgroundCount:0,input:'send'})
    const detail=service.detail(task.id);detail.runtime!.retained=false;detail.task.runtime!.backgroundCount=99
    expect(owned.state.retained).toBe(true);expect(owned.state.backgroundCount).toBe(0)
    for(const input of ['steer','send','queue'] as const){owned.state.input=input;expect(service.detail(task.id).inputMode).toBe(input)}
    owned.state.input='queue'
    const input=await service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:randomUUID(),text:'Keep this queued'})
    expect(input.status).toBe('pending');expect(owned.submitted).toEqual([])
    owned.queue.push(result);await pause(20)
    expect(owned.started).toHaveLength(1);expect(store.liveInputs.get(input.id)?.status).toBe('pending')
  })

  it('returns a durable sending receipt without waiting for native acknowledgement and records only its original run',async()=>{
    const owned=new OwnedRuntime();setup(owned);const task=create();await started(owned)
    const runId=service.detail(task.id).runId!,requestId=randomUUID()
    // 不拿 100ms 的时钟赌「没等 native ack」:满载套件里 submitInput 自己就可能超过
    // 100ms,race 于是给出 null,红成 `expected null to match object`(2026-09-19 node
    // 作业实测)。证明力本来也不在那 100ms —— ack 要到下面 `ack.resolve()` 才兑现,
    // 所以 submitInput 真去等 ack 的话这个 await 永远不会回来,测试以超时告终,同样
    // 是真失败信号,而且不看机器忙不忙。
    const receipt=await service.submitInput(task.id,{runId,requestId,text:'Continue in this epoch'})
    expect(receipt).toMatchObject({id:requestId,taskId:task.id,runId,status:'sending',execution:{model:'owned-model',reasoningEffort:'high'}})
    expect(owned.submitted).toHaveLength(1);expect(owned.submitted[0]?.persistedStatus).toBe('sending')
    await service.submitInput(task.id,{runId,requestId,text:'Continue in this epoch'})
    expect(owned.submitted).toHaveLength(1)
    expect(store.events(task.id).filter(e=>e.text==='Continue in this epoch')).toEqual([])
    owned.submitted[0]!.ack.resolve()
    await expect.poll(()=>store.liveInputs.get(requestId)?.status).toBe('delivered')
    expect(store.events(task.id).filter(e=>e.text==='Continue in this epoch')).toMatchObject([{kind:'user',runId}])
    expect(service.detail(task.id).runId).toBe(runId);expect(owned.started).toHaveLength(1)
  })

  it('passes pinned attachments through start and submit and binds the acknowledged materials to the original receipt',async()=>{
    const owned=new OwnedRuntime();setup(owned)
    const upload=(text:string,taskId?:string)=>{
      const id=randomUUID(),draftId=randomUUID()
      const attachment=service.uploadAttachment({id,draftId,taskId,name:'input.txt',mime:'text/plain',base64:Buffer.from(text).toString('base64')})
      return{attachment,attachmentIds:[id],draftId}
    }
    const initial=upload('First material')
    const task=service.create({path:project,providerId:'claude',text:'',...initial});await started(owned)
    expect(owned.startMaterials).toHaveLength(1)
    expect(readFileSync(owned.startMaterials[0]!.path,'utf8')).toBe('First material')
    const next=upload('Later material',task.id),other=upload('Other material',task.id)
    const request={runId:service.detail(task.id).runId!,requestId:randomUUID(),text:'',...next}
    expect(await service.submitInput(task.id,request)).toMatchObject({status:'sending',attachments:[next.attachment]})
    expect(owned.submitted[0]!.materials).toHaveLength(1)
    expect(readFileSync(owned.submitted[0]!.materials[0]!.path,'utf8')).toBe('Later material')
    await expect(service.submitInput(task.id,{...request,attachmentIds:other.attachmentIds,draftId:other.draftId})).rejects.toThrow('input_conflict')
    owned.submitted[0]!.ack.resolve()
    await expect.poll(()=>store.liveInputs.get(request.requestId)?.status).toBe('delivered')
    expect(store.events(task.id).filter(e=>e.kind==='user').at(-1)).toMatchObject({runId:request.runId,attachments:[next.attachment]})
  })

  it.each(['resolve','reject'] as const)('does not let a late native %s after stop affect a new run or resurrect queued input',async outcome=>{
    const owned=new OwnedRuntime();setup(owned,{}, {async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=create();await started(owned);const originalRun=service.detail(task.id).runId!,requestId=randomUUID()
    await service.submitInput(task.id,{runId:originalRun,requestId,text:'Old runtime input'})
    await service.cancel(task.id);await settled(task.id)
    expect(store.liveInputs.get(requestId)?.status).toBe('held')
    expect(store.liveInputs.get(requestId)?.error).toMatch(/^未确认执行者收到/)
    expect(store.liveInputs.get(requestId)?.error).not.toContain('尚未发送')
    service.continueTask(task.id,'A new run');await settled(task.id)
    if(outcome==='resolve')owned.submitted[0]!.ack.resolve();else owned.submitted[0]!.ack.reject(Error('closed before acknowledgement'))
    await pause(20)
    expect(store.liveInputs.get(requestId)?.status).toBe(outcome==='resolve'?'delivered':'held')
    if(outcome==='reject')expect(store.liveInputs.get(requestId)?.error).toMatch(/^未确认执行者收到/)
    expect(store.events(task.id).filter(e=>e.text==='Old runtime input').every(e=>e.runId===originalRun)).toBe(true)
    expect(service.detail(task.id).task.status).toBe('completed')
    expect(owned.submitted).toHaveLength(1)
  })

  it.each(['stop','shutdown','failure'] as const)('preserves uncertain native delivery on %s while marking a never-written queued receipt as unsent',async end=>{
    const owned=new OwnedRuntime();setup(owned);const task=create();await started(owned)
    const runId=service.detail(task.id).runId!,sentId=randomUUID(),pendingId=randomUUID()
    await service.submitInput(task.id,{runId,requestId:sentId,text:'Native has queued this, but its acknowledgement is held'})
    expect(owned.submitted.map(input=>input.id)).toEqual([sentId])
    owned.state.input='queue'
    await service.submitInput(task.id,{runId,requestId:pendingId,text:'Saved only; never passed to native'})
    expect(store.liveInputs.get(pendingId)?.status).toBe('pending')
    if(end==='stop')await service.cancel(task.id)
    else if(end==='shutdown')await service.shutdown()
    else {owned.queue.push({kind:'error',message:'owned runtime failed'});owned.queue.end()}
    await settled(task.id)
    expect(store.liveInputs.get(sentId)).toMatchObject({runId,status:'held',error:expect.stringMatching(/^未确认执行者收到/)})
    expect(store.liveInputs.get(sentId)?.error).not.toContain('尚未发送')
    expect(store.liveInputs.get(pendingId)).toMatchObject({runId,status:'held',error:expect.stringContaining('尚未发送')})
    owned.submitted[0]!.ack.reject(Error('closed without acknowledgement'))
    await pause(10)
    expect(store.liveInputs.get(sentId)?.error).toMatch(/^未确认执行者收到/)
    expect(owned.submitted.map(input=>input.id)).toEqual([sentId])
  })

  it.each(['resolve','reject'] as const)('preserves uncertain delivery after a transient receipt write failure on native %s',async outcome=>{
    const owned=new OwnedRuntime();setup(owned);const task=create();await started(owned)
    const runId=service.detail(task.id).runId!,requestId=randomUUID()
    await service.submitInput(task.id,{runId,requestId,text:'Native receipt persistence failed once'})
    const set=store.liveInputs.set;let failed=false
    store.liveInputs.set=(id,status,error)=>{
      if(id===requestId&&!failed&&(status==='delivered'||status==='held')){failed=true;throw Error('owned transient receipt write failure')}
      return set(id,status,error)
    }
    if(outcome==='resolve')owned.submitted[0]!.ack.resolve();else owned.submitted[0]!.ack.reject(Error('native acceptance unconfirmed'))
    await expect.poll(()=>failed).toBe(true)
    expect(store.liveInputs.get(requestId)?.status).toBe('sending')
    await service.cancel(task.id);await settled(task.id)
    expect(store.liveInputs.get(requestId)).toMatchObject({runId,status:'held',error:expect.stringMatching(/^未确认执行者收到/)})
    expect(store.liveInputs.get(requestId)?.error).not.toContain('尚未发送')
    expect(owned.submitted).toHaveLength(1)
    expect(store.events(task.id).some(event=>event.text==='Native receipt persistence failed once')).toBe(false)
  })

  it('holds a runtime submit rejection without retrying or failing the retained conversation',async()=>{
    const owned=new OwnedRuntime();setup(owned);const task=create();await started(owned)
    const runId=service.detail(task.id).runId!,requestId=randomUUID()
    await service.submitInput(task.id,{runId,requestId,text:'Unconfirmed input'})
    owned.submitted[0]!.ack.reject(Error('native acknowledgement lost'))
    await expect.poll(()=>store.liveInputs.get(requestId)?.status).toBe('held')
    expect(store.liveInputs.get(requestId)?.error).toMatch(/^未确认执行者收到/)
    await service.submitInput(task.id,{runId,requestId,text:'Unconfirmed input'})
    expect(owned.submitted).toHaveLength(1);expect(service.detail(task.id).task.status).toBe('running')
  })

  it('allows another same-epoch receipt while a native acknowledgement is pending and matches each outcome exactly',async()=>{
    const owned=new OwnedRuntime();owned.state.input='steer';setup(owned);const task=create();await started(owned)
    const runId=service.detail(task.id).runId!,first=randomUUID(),second=randomUUID()
    const firstReceipt=await service.submitInput(task.id,{runId,requestId:first,text:'First queued native input'})
    const secondReceipt=await service.submitInput(task.id,{runId,requestId:second,text:'Second queued native input'})
    expect([firstReceipt.status,secondReceipt.status]).toEqual(['sending','sending'])
    expect(owned.submitted.map(input=>input.id)).toEqual([first,second])
    owned.submitted[1]!.ack.resolve();owned.submitted[0]!.ack.reject(Error('first not confirmed'))
    await expect.poll(()=>store.liveInputs.get(second)?.status).toBe('delivered')
    expect(store.liveInputs.get(first)?.status).toBe('held')
    expect(store.events(task.id).filter(e=>e.text==='Second queued native input')).toMatchObject([{runId,kind:'user'}])
    expect(store.events(task.id).some(e=>e.text==='First queued native input')).toBe(false)
    expect(owned.started).toHaveLength(1)
  })

  it('keeps background questions open after parent replies and closes only the original requests on stop',async()=>{
    const owned=new OwnedRuntime();setup(owned);const task=create();await started(owned)
    const spec={questions:[{id:'q',header:'Format',question:'Which format?',options:[],allowOther:true}]}
    const answered=owned.context!.requestUserInput!(spec)
    await expect.poll(()=>service.detail(task.id).questions.length).toBe(1)
    service.resolveAnswer(task.id,service.detail(task.id).questions[0]!.id,{q:['PDF']})
    await expect(answered).resolves.toEqual({q:['PDF']})
    const abandoned=owned.context!.requestUserInput!(spec),requestId=service.detail(task.id).questions[0]!.id
    await service.cancel(task.id);await settled(task.id)
    await expect(abandoned).resolves.toBeNull()
    expect(()=>service.resolveAnswer(task.id,requestId,{q:['Word']})).toThrow('question_stale')
    await expect(owned.context!.requestUserInput!(spec)).resolves.toBeNull()
  })

  it('does not report a retained runtime as completed when its stream unexpectedly ends after a parent result',async()=>{
    const owned=new OwnedRuntime();setup(owned);const task=create();await started(owned)
    owned.queue.end();await settled(task.id)
    expect(service.detail(task.id).task).toMatchObject({status:'failed',error:'background_runtime_ended'})
    expect(owned.closeCount).toBe(1)
  })

  it('records a parent result session identity before the retained runtime closes even without an init event',async()=>{
    const owned=new OwnedRuntime()
    owned.runtime.start=text=>{owned.started.push(text);owned.queue.push(result)}
    setup(owned);const task=create();await started(owned)
    await expect.poll(()=>store.get(task.id).sessionId).toBe('owned-parent')
    expect(service.detail(task.id).task.status).toBe('running');expect(owned.closeCount).toBe(0)
  })

  it('holds a still-unacknowledged input when the runtime closes even if its submit promise never settles',async()=>{
    const owned=new OwnedRuntime();owned.state.retained=false
    setup(owned);const task=create();await started(owned)
    const requestId=randomUUID()
    await service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId,text:'Unacknowledged at EOF'})
    owned.queue.end();await settled(task.id)
    expect(service.detail(task.id).task.status).toBe('completed')
    expect(store.liveInputs.get(requestId)?.status).toBe('held')
    expect(owned.submitted).toHaveLength(1)
  })

  it('does not let a pending native acknowledgement hide unknown execution from the watchdog',async()=>{
    const owned=new OwnedRuntime();setup(owned,{timeoutMs:45});const task=create();await started(owned)
    const requestId=randomUUID()
    await service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId,text:'Waiting for native echo'})
    owned.state.foreground='unknown'
    await settled(task.id)
    expect(service.detail(task.id).task).toMatchObject({status:'failed',error:'turn_timeout'})
    expect(store.liveInputs.get(requestId)?.status).toBe('held')
  })

  it('keeps retained observed idle alive beyond the watchdog but times out unobserved execution',async()=>{
    const owned=new OwnedRuntime();setup(owned,{timeoutMs:45});const task=create();await started(owned)
    await pause(150)
    expect(service.detail(task.id).task.status).toBe('running');expect(owned.closeCount).toBe(0)
    owned.state.foreground='unknown'
    await settled(task.id)
    expect(service.detail(task.id).task).toMatchObject({status:'failed',error:'turn_timeout'})
    expect(owned.closeCount).toBe(1)
  })

  it.each([{foreground:'running' as const,backgroundCount:0},{foreground:'idle' as const,backgroundCount:1}])('does not pause the watchdog for retained executing state %j',async state=>{
    const owned=new OwnedRuntime();Object.assign(owned.state,state);setup(owned,{timeoutMs:45});const task=create();await started(owned)
    await settled(task.id)
    expect(service.detail(task.id).task).toMatchObject({status:'failed',error:'turn_timeout'})
  })

  it('quarantines the path and withholds final artifacts until owned close is confirmed',async()=>{
    const owned=new OwnedRuntime();owned.closeGate=gate()
    setup(owned,{closeTimeoutMs:25}, {async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=create();await started(owned)
    // 父回合已答复、租约已释放:同文件夹的任务此时可以进来(会话空闲,不会自己写)。
    const during=service.create({path:project,providerId:'codex',text:'Admitted while idle'});await settled(during.id)
    // 文件要在父回合的回合末登记**之后**才出现(CI 慢机上 result 事件可能晚于这里被消费,
    // 先写会被回合末登记收走,那不是这条测试要验的事):此后父任务没有新事件,只剩结算能看见它。
    writeFileSync(join(project,'.cc-workbench',task.id,'after-close.txt'),'owned output')
    await service.cancel(task.id);await settled(task.id)
    expect(service.detail(task.id).task.error).toBe('writer_not_closed')
    // 退出未确认 → 租约重新挂回,此后到来的任务按 writer_not_closed 等待。
    const next=service.create({path:project,providerId:'codex',text:'Wait for owned close'})
    expect(service.detail(next.id).task.waitingFor?.reason).toBe('writer_not_closed')
    expect(service.detail(task.id).artifacts).toEqual([])
    await expect(service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:randomUUID(),text:'Too late'})).rejects.toThrow('input_stale')
    owned.closeGate.resolve();await settled(next.id)
    await expect.poll(()=>service.detail(task.id).artifacts.some(a=>a.name==='after-close.txt')).toBe(true)
  })

  it('finishes a safe no-background runtime at EOF and preserves legacy first-result dispatch behavior',async()=>{
    const owned=new OwnedRuntime();owned.state.retained=false
    setup(owned,{}, {async spawn(){return{async *dispatch(text){yield {kind:'text',text};yield result},async close(){}}}})
    const task=create();await started(owned);owned.queue.end();await settled(task.id)
    expect(service.detail(task.id).task.status).toBe('completed');expect(owned.closeCount).toBe(1)
    service.continueTask(task.id,'Legacy next turn');await settled(task.id)
    expect(service.detail(task.id).task.status).toBe('completed')
    expect(store.events(task.id).some(e=>e.kind==='text'&&e.text==='Legacy next turn')).toBe(true)
  })
})

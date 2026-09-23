import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {discoverCodexModels} from './codex-model-catalog'
import {discoverClaudeModels} from './claude-model-catalog'

const mocks=vi.hoisted(()=>({spawn:vi.fn(),query:vi.fn(),native:vi.fn()}))
vi.mock('node:child_process',()=>({spawn:mocks.spawn}))
vi.mock('@anthropic-ai/claude-agent-sdk',()=>({query:mocks.query}))
vi.mock('./claude-native-config',()=>({readNativeClaudeTools:mocks.native,workbenchClaudeEnvironment:(value:unknown)=>value}))
class Child extends EventEmitter {
  stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough()
  done=false;ignoreTerm=false
  kill=vi.fn((signal:string)=>{if(signal==='SIGTERM'&&this.ignoreTerm)return true;queueMicrotask(()=>this.close());return true})
  close(code=0){if(this.done)return;this.done=true;this.stdout.end();this.stderr.end();this.emit('exit',code);this.emit('close',code)}
}
let children:Child[],configDelay:number,reply:boolean,ignoreTerm:boolean
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(0);children=[];configDelay=110;reply=false;ignoreTerm=false
  mocks.native.mockReset().mockReturnValue({servers:{},omitted:[]})
  mocks.query.mockReset().mockReturnValue({supportedModels:()=>new Promise(()=>{}),close:vi.fn()})
  mocks.spawn.mockReset().mockImplementation((_binary:string,args:string[])=>{
    const child=new Child();children.push(child)
    if(args.includes('mcp'))setTimeout(()=>{child.stdout.write('[]');child.close()},configDelay)
    else {
      child.ignoreTerm=ignoreTerm
      let data='';child.stdin.on('data',chunk=>{
        data+=String(chunk)
        while(data.includes('\n')) {
          const at=data.indexOf('\n'),message=JSON.parse(data.slice(0,at));data=data.slice(at+1)
          if(!reply||message.id===undefined)continue
          const result=message.method==='model/list'?{data:[{id:'owned',model:'owned',displayName:'Owned',description:'Owned',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}:message.method==='config/read'?{config:{}}:{}
          queueMicrotask(()=>child.stdout.write(JSON.stringify({id:message.id,result})+'\n'))
        }
      })
    }
    return child
  })
})
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers()})
it('does not spawn the Codex app-server after configuration exhausts the total deadline',async()=>{
  let outcome:unknown
  void discoverCodexModels('/owned','/project',100).then(value=>{outcome=value},error=>{outcome=error})
  await vi.advanceTimersByTimeAsync(100)
  expect(outcome).toBeInstanceOf(Error)
  expect(children).toHaveLength(1);expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL')
  await vi.advanceTimersByTimeAsync(20)
  expect(children).toHaveLength(1)
})
it('uses only the remaining Codex deadline after a slow successful configuration read',async()=>{
  configDelay=80;let outcome:unknown
  void discoverCodexModels('/owned','/project',100).then(value=>{outcome=value},error=>{outcome=error})
  await vi.advanceTimersByTimeAsync(99)
  expect(children).toHaveLength(2);expect(outcome).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(outcome).toBeInstanceOf(Error)
  expect(children[1]!.kill).toHaveBeenCalledWith('SIGKILL')
})
it('checks elapsed time before app-server spawn even when config close wins the timer race',async()=>{
  configDelay=100;let outcome:unknown
  void discoverCodexModels('/owned','/project',100).then(value=>{outcome=value},error=>{outcome=error})
  await vi.advanceTimersByTimeAsync(100)
  expect(outcome).toBeInstanceOf(Error)
  expect(children).toHaveLength(1)
})
it('includes Codex graceful close time in the same total deadline',async()=>{
  configDelay=90;reply=true;ignoreTerm=true;let outcome:unknown
  void discoverCodexModels('/owned','/project',100).then(value=>{outcome=value},error=>{outcome=error})
  await vi.advanceTimersByTimeAsync(100)
  expect(outcome).toMatchObject({source:'native'})
  expect(children[1]!.kill).toHaveBeenCalledWith('SIGKILL')
})
it('does not launch Claude after native disk setup has consumed the deadline',async()=>{
  mocks.native.mockImplementation(()=>{vi.setSystemTime(101);return {servers:{},omitted:[]}})
  let outcome:unknown
  void discoverClaudeModels({cwd:'/owned'},100).then(value=>{outcome=value},error=>{outcome=error})
  await Promise.resolve()
  expect(mocks.query).not.toHaveBeenCalled()
  expect(outcome).toBeInstanceOf(Error)
})
it('closes and aborts the Claude native query when initialization times out',async()=>{
  let outcome:unknown
  void discoverClaudeModels({cwd:'/owned'},100).then(value=>{outcome=value},error=>{outcome=error})
  await vi.advanceTimersByTimeAsync(100)
  expect(outcome).toBeInstanceOf(Error)
  expect(mocks.query.mock.calls[0]![0].options.abortController.signal.aborted).toBe(true)
  expect(mocks.query.mock.results[0]!.value.close).toHaveBeenCalledTimes(1)
})

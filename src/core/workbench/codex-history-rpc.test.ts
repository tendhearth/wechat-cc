import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { openCodexHistoryRpc, type HistoryProcess } from './codex-history-rpc'

type Rpc={id?:string|number;method?:string;params?:Record<string,unknown>;result?:unknown;error?:unknown}
class FakeChild extends EventEmitter {
  stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough()
  sent:Rpc[]=[];autoInitialize=true;autoExit=true
  kill=vi.fn((_signal?:string)=>{if(this.autoExit)queueMicrotask(()=>this.emit('close',0));return true})
  constructor(){super();let buffer='';this.stdin.on('data',chunk=>{buffer+=String(chunk);while(buffer.includes('\n')){const end=buffer.indexOf('\n'),message=JSON.parse(buffer.slice(0,end)) as Rpc;buffer=buffer.slice(end+1);this.sent.push(message);if(message.method==='initialize'&&this.autoInitialize)queueMicrotask(()=>this.send({id:message.id,result:{userAgent:'synthetic'}}))}})}
  send(message:Rpc){this.stdout.write(JSON.stringify(message)+'\n')}
}
function setup(child=new FakeChild(),extra={}) {
  const spawnProcess=vi.fn(()=>child as unknown as HistoryProcess)
  return {child,spawnProcess,open:()=>openCodexHistoryRpc({codexPathOverride:'/synthetic/codex',cwd:'/fixture',spawnProcess,timeoutMs:30,closeTimeoutMs:50,...extra})}
}

describe('read-only Codex JSONL transport',()=>{
  it('initializes without starting a thread, restricts methods and closes the owned process',async()=>{
    const {child,spawnProcess,open}=setup(),rpc=await open()
    expect(child.sent.map(x=>x.method)).toEqual(['initialize','initialized'])
    expect(spawnProcess.mock.calls[0]).toEqual(expect.arrayContaining(['/synthetic/codex']))
    const call=rpc.request('thread/list',{useStateDbOnly:true})
    const request=child.sent.at(-1)!;child.send({id:request.id,result:{data:[],nextCursor:null}})
    expect(await call).toEqual({data:[],nextCursor:null})
    await expect(rpc.request('thread/resume' as never,{threadId:'x'})).rejects.toThrow('native_history_unsupported')
    expect(child.sent.some(x=>x.method==='thread/resume')).toBe(false)
    await rpc.close();await rpc.close();expect(child.kill).toHaveBeenCalled()
    expect(child.stdin.writableEnded).toBe(true)
  })
  it('rejects unexpected execution requests and shuts down without accepting permissions',async()=>{
    const {child,open}=setup(),rpc=await open(),pending=rpc.request('thread/read',{threadId:'id',includeTurns:false})
    child.send({id:'server-approval',method:'item/commandExecution/requestApproval',params:{command:'rm private'}})
    await expect(pending).rejects.toThrow('native_history_unavailable')
    await rpc.close()
    expect(child.sent.find(x=>x.id==='server-approval')).toMatchObject({error:{code:-32601}})
    expect(JSON.stringify(child.sent)).not.toContain('"decision":"accept"')
    expect(child.kill).toHaveBeenCalled()
  })
  it('maps unsupported native methods distinctly and bounds oversized or malformed responses',async()=>{
    for(const response of ['unsupported','oversized','malformed']) {
      const {child,open}=setup(),rpc=await open(),pending=rpc.request('thread/list',{})
      if(response==='unsupported')child.send({id:child.sent.at(-1)!.id,error:{code:-32601,message:'private details'}})
      else child.stdout.write(response==='oversized'?'x'.repeat(2*1024*1024+1):'not json\n')
      await expect(pending).rejects.toThrow(response==='unsupported'?'native_history_unsupported':'native_history_unavailable')
      await rpc.close();expect(child.kill).toHaveBeenCalled()
    }
  })
  it('cleans up startup timeout, startup errors and stalled requests within bounded deadlines',async()=>{
    const noInit=new FakeChild();noInit.autoInitialize=false
    const first=setup(noInit,{timeoutMs:5})
    await expect(first.open()).rejects.toThrow('native_history_unavailable');expect(noInit.kill).toHaveBeenCalled()
    const {child,open}=setup(undefined,{timeoutMs:5}),rpc=await open()
    await expect(rpc.request('thread/items/list',{})).rejects.toThrow('native_history_unavailable')
    await rpc.close();expect(child.kill).toHaveBeenCalled()
    const spawnError=setup();const failed=spawnError.open();spawnError.child.emit('error',new Error('sensitive binary details'))
    await expect(failed).rejects.toThrow('native_history_unavailable')
  })
  it('escalates stalled close and reports missing exit confirmation rather than leaving an idle process',async()=>{
    const {child,open}=setup(undefined,{closeTimeoutMs:20}),rpc=await open();child.autoExit=false
    await expect(rpc.close()).rejects.toThrow('native_history_unavailable')
    expect(child.kill.mock.calls.map(c=>c[0])).toEqual(['SIGTERM','SIGKILL'])
    child.emit('close',0)
  })
})

describe('readCodexRateLimits (2026-09-16 订阅额度)',()=>{
  it('asks only account/rateLimits/read on a short-lived process and closes it; failures are null',async()=>{
    const {readCodexRateLimits}=await import('./codex-history-rpc')
    const child=new FakeChild(),spawnProcess=vi.fn(()=>child as unknown as HistoryProcess)
    const call=readCodexRateLimits({codexPathOverride:'/synthetic/codex',spawnProcess,timeoutMs:200,closeTimeoutMs:50})
    await vi.waitFor(()=>{if(!child.sent.some(x=>x.method==='account/rateLimits/read'))throw new Error('not yet')})
    const request=child.sent.find(x=>x.method==='account/rateLimits/read')!
    child.send({id:request.id,result:{rateLimits:{primary:{usedPercent:100,windowDurationMins:10080,resetsAt:1789912347},planType:'prolite'}}})
    expect(await call).toMatchObject({rateLimits:{planType:'prolite'}})
    expect(child.sent.map(x=>x.method).filter(Boolean)).toEqual(['initialize','initialized','account/rateLimits/read'])
    expect(child.kill).toHaveBeenCalled()
    const broken=new FakeChild();broken.autoInitialize=false
    await expect(readCodexRateLimits({codexPathOverride:'/synthetic/codex',spawnProcess:vi.fn(()=>broken as unknown as HistoryProcess),timeoutMs:30,closeTimeoutMs:50})).resolves.toBeNull()
  })
})

import {spawn} from 'node:child_process'
import {discoverWorkbenchCodexConfig,workbenchCodexArgs,workbenchCodexEnv} from './codex-config'
import {readCodexModelCatalog, type CatalogRequest} from './native-model-catalog'

/** Catalog transport never creates a thread or enables an MCP server. */
export async function discoverCodexModels(binary: string, cwd: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const discovery = await discoverWorkbenchCodexConfig(binary,cwd,deadline).catch(()=>{throw new Error('model_catalog_unavailable')})
  // A late config close can win its timer callback. Never spawn a second child
  // after the single caller-owned budget is exhausted.
  if (Date.now() >= deadline) throw new Error('model_catalog_unavailable')
  const child = spawn(binary,[...workbenchCodexArgs(discovery.config),'app-server','--listen','stdio://'],{cwd,env:workbenchCodexEnv(),stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform !== 'win32'})
  let buffer = '', nextId = 0, failure: Error | undefined, exited = false
  const pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  const fail = () => { failure ??= new Error('model_catalog_unavailable'); for (const entry of pending.values()) entry.reject(failure); pending.clear() }
  const exit = new Promise<void>(resolve => child.once('close',()=>{exited=true;fail();resolve()}))
  const request: CatalogRequest = (method,params) => new Promise((resolve,reject)=>{
    if (Date.now() >= deadline) {reject(new Error('model_catalog_unavailable'));return}
    if (failure) {reject(failure);return}
    const id = ++nextId; pending.set(id,{resolve,reject})
    try {child.stdin.write(JSON.stringify({id,method,params})+'\n')} catch {fail()}
  })
  const stop = (signal: NodeJS.Signals) => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid,signal); else if (!exited) child.kill(signal) } catch { /* Already reaped. */ }
  }
  child.stdin.on('error',fail); child.on('error',fail); child.stderr.resume()
  child.stdout.on('data',chunk=>{
    buffer += String(chunk)
    if (buffer.length > 2_000_000) {fail();stop('SIGKILL');return}
    while (buffer.includes('\n')) {
      const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1)
      if(!line.trim())continue
      try {
        const message=JSON.parse(line), entry=pending.get(message.id)
        if (entry) {pending.delete(message.id);if(message.error || !message.result || typeof message.result !== 'object' || Array.isArray(message.result))entry.reject(new Error('model_catalog_unavailable'));else entry.resolve(message.result)}
        else if (message.id !== undefined && typeof message.method === 'string') child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Catalog requests do not permit tools.'}})+'\n')
      } catch {fail();stop('SIGKILL');return}
    }
  })
  const timer = setTimeout(()=>{fail();stop('SIGKILL')},Math.max(0,deadline-Date.now()))
  try {
    await request('initialize',{clientInfo:{name:'cc_workbench_catalog',version:'0.6.4'},capabilities:{experimentalApi:false}})
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n')
    const catalog = await readCodexModelCatalog(request,cwd)
    if (Date.now() >= deadline) throw new Error('model_catalog_unavailable')
    return catalog
  } finally {
    clearTimeout(timer);child.stdin.end();stop('SIGTERM')
    let timeout:ReturnType<typeof setTimeout>|undefined
    const remaining = Math.min(1000,Math.max(0,deadline-Date.now()))
    if (remaining > 0) await Promise.race([exit,new Promise<void>(resolve=>{timeout=setTimeout(resolve,remaining)})])
    clearTimeout(timeout)
    // Also reap descendants if a native plugin unexpectedly outlives the server.
    stop('SIGKILL')
  }
}

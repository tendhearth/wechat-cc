import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'

describe('reading logs during refresh',()=>{
  beforeEach(()=>vi.resetModules())
  afterEach(()=>vi.unstubAllGlobals())
  it('keeps visible history and the latest reading position through a pending or failed refresh',async()=>{
    const body={innerHTML:'',scrollHeight:1000,clientHeight:100,scrollTop:0}
    const meta={textContent:''}
    const elements:Record<string,unknown>={'logs-body':body,'logs-meta':meta,'logs-tail-select':{value:'50'},'logs-filter':{value:''}}
    vi.stubGlobal('document',{getElementById:(id:string)=>elements[id]??null})
    const {loadLogsPane}=await import('./logs.js')
    const result={ok:true,entries:[{timestamp:'2026-10-03T10:00:00Z',tag:'BOOT',message:'上次记录'}],totalLines:1,logFile:'/tmp/daemon.log'}
    const invoke=vi.fn().mockResolvedValueOnce(result)
    const deps={invoke,formatInvokeError:(error:Error)=>error.message}
    await loadLogsPane(deps)
    expect(body.scrollTop).toBe(1000)
    body.scrollTop=120
    const content=body.innerHTML
    let reject!:(error:Error)=>void
    invoke.mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail}))
    const pending=loadLogsPane(deps)
    expect(body.innerHTML).toBe(content)
    body.scrollTop=180
    reject(new Error('暂时离线'))
    await pending
    expect(body.innerHTML).toBe(content)
    expect(body.scrollTop).toBe(180)
    expect(meta.textContent).toContain('保留上次记录')
    invoke.mockResolvedValueOnce({...result,entries:[...result.entries,{timestamp:null,tag:null,message:'新增记录'}]})
    await loadLogsPane(deps)
    expect(body.scrollTop).toBe(180)
    expect(body.innerHTML).toContain('新增记录')
    body.scrollTop=920
    invoke.mockResolvedValueOnce(result)
    await loadLogsPane(deps)
    expect(body.scrollTop).toBe(1000)
  })
})

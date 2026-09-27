import { afterEach, describe, expect, it, vi } from 'vitest'
import * as care from './cc-care.js'
import { openTestDb } from '../../../../src/lib/db'
import { makeWorkbenchStore } from '../../../../src/core/workbench/store'
import { workbenchRoutes } from '../../../../src/daemon/internal-api/routes-workbench'
import type { InternalApiDeps } from '../../../../src/daemon/internal-api/types'

const task = (id:string, extra:Record<string,unknown>={}) => ({id,title:`事项 ${id}`,path:'/project/a',providerId:'claude',status:'running',updatedAt:100, ...extra})
afterEach(()=>vi.useRealTimers())
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function sheetFixture(options:Record<string,unknown> = {}) {
  const listeners = new Map<string,(event?:any)=>unknown>()
  const body = {innerHTML:'',scrollTop:0,querySelectorAll:()=>[]}
  const error = {textContent:''}
  const opener = {isConnected:true,focus:vi.fn(),getAttribute:()=>null}
  const replacement = {isConnected:true,focus:vi.fn()}
  const dialog = {
    open:false,innerHTML:'',className:'',setAttribute() {},
    querySelector(selector:string) {return ({'.cc-care-body':body,'.cc-care-error':error,'.cc-care-presence':{textContent:''}} as Record<string,any>)[selector]},
    addEventListener(name:string,handler:(event?:any)=>unknown) {listeners.set(name,handler)},
    showModal() {this.open=true},
    close() {this.open=false;listeners.get('close')?.()},
    getBoundingClientRect() {return {left:100,right:500,top:100,bottom:600}},
    closest() {return null},remove() {},
  }
  const documentTarget = {activeElement:opener,visibilityState:'visible',createElement:()=>dialog,body:{append() {}},querySelector:(selector:string)=>selector==='[data-life-care]'?replacement:null,addEventListener() {},removeEventListener() {}}
  const sheet = care.mountCareSheet({call:async()=>({tasks:[]}),presencePoller:{subscribe:()=>()=>{}},openTask:async()=>{},openWorkbench() {},navigate() {},...options,documentTarget:documentTarget as unknown as Document})
  const clickTask = (id:string) => {
    const button = {disabled:false,hasAttribute:()=>false,getAttribute:(name:string)=>name==='data-care-task'?id:null}
    return listeners.get('click')!({target:{closest:()=>button}}) as Promise<void>
  }
  return {sheet,dialog,body,error,opener,replacement,clickTask,click:(x:number,y:number)=>listeners.get('click')!({target:dialog,clientX:x,clientY:y})}
}

describe('CC is looking after real tasks',()=>{
  it('separates pending decisions, actual work and replies, without calling retained idle work',()=>{
    expect(care.careSections).toBeTypeOf('function')
    const groups=care.careSections({tasks:[task('1',{pendingPermissionCount:1}),task('2'),task('3',{phase:'replied'}),task('4',{status:'failed'}),task('5',{archivedAt:100})],projects:[{name:'网站',path:'/project/a'}]})
    expect(groups.attention.map(x=>x.id)).toEqual(['1'])
    expect(groups.working.map(x=>x.id)).toEqual(['2'])
    expect(groups.recent.map(x=>x.id)).toEqual(['3','4'])
    expect(groups.recent.map(x=>x.label)).toEqual(['已答复','执行遇到问题'])
    expect(groups.working[0]!.project).toBe('网站')
  })
  it('includes pending tasks outside the list window and clears already resolved cards',()=>{
    expect(care.careSections).toBeTypeOf('function')
    const snapshot={tasks:[task('1',{pendingPermissionCount:1})],page:{hasMore:true}}
    const view=care.careSections(snapshot,{tasks:[task('other',{pendingPermissionCount:1})],stale:false})
    expect(view.attention.map(x=>x.id)).toEqual(['other'])
    expect(view.working.map(x=>x.id)).toEqual(['1'])
    expect(view.truncated).toBe(true)
  })
  it('keeps foreground-idle sessions with live background workers in progress',()=>{
    expect(care.careSections).toBeTypeOf('function')
    const view=care.careSections({tasks:[task('1',{runtime:{retained:true,foreground:'idle',backgroundCount:2}}),task('2',{runtime:{retained:true,foreground:'idle',backgroundCount:0}})]})
    expect(view.working.map(x=>x.id)).toEqual(['1'])
    expect(view.working[0]!.label).toContain('后台执行中')
    expect(view.recent[0]!.label).toBe('会话保留中')
  })
})

describe('care reader lifecycle',()=>{
  it('uses a list size accepted by the real workbench route and store',async()=>{
    const db=openTestDb(),store=makeWorkbenchStore(db)
    for(let i=0;i<101;i++)store.create({title:`任务 ${i}`,path:'/project/a',providerId:'claude',ownerChatId:'owner'})
    const routes=workbenchRoutes({workbench:{list:store.listPage}} as unknown as InternalApiDeps)
    const changed=vi.fn(),reader=care.createCareReader({onChange:changed,call:async(method:string,path:string)=>{
      const url=new URL(path,'http://localhost')
      const response=await routes[`${method} ${url.pathname}`]!(url.searchParams,undefined)
      if(response.status!==200)throw new Error(`HTTP ${response.status}`)
      return response.body
    }})
    try {
      await reader.start()
      expect(changed.mock.lastCall?.[0]).toMatchObject({stale:false,loading:false,data:{page:{limit:100,hasMore:true}}})
      expect(changed.mock.lastCall?.[0].data.tasks).toHaveLength(100)
    } finally {reader.stop();db.close()}
  })
  it('reads only when opened, and a closed request cannot overwrite the next visit',async()=>{
    expect(care.createCareReader).toBeTypeOf('function')
    let resolve!:(value:unknown)=>void
    const call=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValue({tasks:[task('new')]})
    const changed=vi.fn(),reader=care.createCareReader({call,onChange:changed})
    expect(call).not.toHaveBeenCalled()
    const old=reader.start();reader.stop();await reader.start()
    resolve({tasks:[task('old')]});await old
    expect(changed.mock.lastCall?.[0].data.tasks[0].id).toBe('new')
    reader.stop()
  })
  it('keeps the last snapshot visibly stale on failure and stops its poll after close',async()=>{
    expect(care.createCareReader).toBeTypeOf('function')
    vi.useFakeTimers()
    const call=vi.fn().mockResolvedValueOnce({tasks:[task('1')]}).mockRejectedValue(new Error('offline')),changed=vi.fn()
    const reader=care.createCareReader({call,onChange:changed,intervalMs:100})
    await reader.start();await vi.advanceTimersByTimeAsync(100)
    expect(changed.mock.lastCall?.[0]).toMatchObject({stale:true,data:{tasks:[{id:'1'}]}})
    reader.stop();const calls=call.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000);expect(call).toHaveBeenCalledTimes(calls)
  })
})

describe('care sheet visits',()=>{
  it('marks retained completion as a previous record while a reopened sheet refreshes',async()=>{
    let finish!:(value:unknown)=>void
    const call=vi.fn().mockResolvedValueOnce({tasks:[task('one',{status:'completed'})]}).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const {sheet,body}=sheetFixture({call})
    try {
      sheet.open();await settle()
      expect(body.innerHTML).toContain('已结束')
      sheet.close();sheet.open()
      expect(body.innerHTML).toContain('上次读取的记录')
      finish({tasks:[task('one')]});await settle()
      expect(body.innerHTML).toContain('执行中')
      expect(body.innerHTML).not.toContain('上次读取的记录')
    } finally {sheet.destroy()}
  })
  it.each(['resolve','reject'])('ignores an old task opening that will %s after another sheet visit',async outcome=>{
    let firstDone!:()=>void,secondDone!:()=>void
    const opening=vi.fn().mockImplementationOnce(()=>new Promise<void>((resolve,reject)=>{firstDone=outcome==='resolve'?resolve:()=>reject(new Error('old read failed'))})).mockImplementationOnce(()=>new Promise<void>(resolve=>{secondDone=resolve}))
    const {sheet,dialog,error,clickTask}=sheetFixture({openTask:opening})
    try {
      sheet.open();const first=clickTask('one')
      sheet.close();sheet.open();const second=clickTask('two')
      expect(opening.mock.calls.map(([id])=>id)).toEqual(['one','two'])
      firstDone();await first
      expect(dialog.open).toBe(true)
      expect(error.textContent).toBe('')
      secondDone();await second
      expect(dialog.open).toBe(false)
    } finally {sheet.destroy()}
  })
  it('returns focus to the replacement care trigger after presence redraws the avatar',()=>{
    const {sheet,opener,replacement}=sheetFixture()
    try {
      sheet.open();opener.isConnected=false;sheet.close()
      expect(replacement.focus).toHaveBeenCalledOnce()
    } finally {sheet.destroy()}
  })
  it('keeps the sheet open for padding clicks but closes on the backdrop',()=>{
    const {sheet,dialog,click}=sheetFixture()
    try {
      sheet.open();click(120,120)
      expect(dialog.open).toBe(true)
      click(50,120)
      expect(dialog.open).toBe(false)
    } finally {sheet.destroy()}
  })
  it('describes the actual 100-record window when older tasks are omitted',async()=>{
    const {sheet,body}=sheetFixture({call:async()=>({tasks:[task('one')],page:{limit:100,hasMore:true}})})
    try {
      sheet.open();await settle()
      expect(body.innerHTML).toContain('最近 100 项记录')
      expect(body.innerHTML).not.toContain('200 项记录')
    } finally {sheet.destroy()}
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskListReader } from './task-list-reader.js'
import { openTestDb } from '../../../../src/lib/db'
import { makeWorkbenchStore } from '../../../../src/adapters/store/workbench/store'
import { workbenchRoutes, type WorkbenchRoutesDeps } from '../../../../src/features/workbench/routes'

const task = (id:string, extra:Record<string,unknown>={}) => ({id,title:`事项 ${id}`,path:'/project/a',providerId:'claude',status:'running',updatedAt:100, ...extra})
afterEach(()=>vi.useRealTimers())

describe('主页的任务列表读取器',()=>{
  it('uses a list size accepted by the real workbench route and store',async()=>{
    const db=openTestDb(),store=makeWorkbenchStore(db)
    for(let i=0;i<101;i++)store.create({title:`任务 ${i}`,path:'/project/a',providerId:'claude',ownerChatId:'owner'})
    const routes=workbenchRoutes({workbench:{list:store.listPage}} as unknown as WorkbenchRoutesDeps)
    const changed=vi.fn(),reader=createTaskListReader({onChange:changed,call:async(method:string,path:string)=>{
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
    expect(createTaskListReader).toBeTypeOf('function')
    let resolve!:(value:unknown)=>void
    const call=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValue({tasks:[task('new')]})
    const changed=vi.fn(),reader=createTaskListReader({call,onChange:changed})
    expect(call).not.toHaveBeenCalled()
    const old=reader.start();reader.stop();await reader.start()
    resolve({tasks:[task('old')]});await old
    expect(changed.mock.lastCall?.[0].data.tasks[0].id).toBe('new')
    reader.stop()
  })
  it('keeps the last snapshot visibly stale on failure and stops its poll after close',async()=>{
    expect(createTaskListReader).toBeTypeOf('function')
    vi.useFakeTimers()
    const call=vi.fn().mockResolvedValueOnce({tasks:[task('1')]}).mockRejectedValue(new Error('offline')),changed=vi.fn()
    const reader=createTaskListReader({call,onChange:changed,intervalMs:100})
    await reader.start();await vi.advanceTimersByTimeAsync(100)
    expect(changed.mock.lastCall?.[0]).toMatchObject({stale:true,data:{tasks:[{id:'1'}]}})
    reader.stop();const calls=call.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000);expect(call).toHaveBeenCalledTimes(calls)
  })
})


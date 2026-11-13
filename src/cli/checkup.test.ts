import { expect,it,vi } from 'vitest'
import { runCheckupCli } from './checkup'
it('shows cost before dispatch and forwards the target-bound estimate without a second spend',async()=>{
  const order:string[]=[],request=vi.fn(async(method,path,body)=>{order.push(path);return path.endsWith('estimate')?{targetKey:'quote'}:{attempt:{status:'completed'}}})
  await runCheckupCli({request,estimate:()=>{order.push('displayed')},sleep:async()=>{}},{full:true,providerId:'fake',model:'invented'})
  expect(order).toEqual(['/v1/checkup/estimate','displayed','/v1/checkup/run'])
  expect(request).toHaveBeenLastCalledWith('POST','/v1/checkup/run',{full:true,providerId:'fake',model:'invented',expectedTargetKey:'quote'})
})
it('estimate-only never starts a run',async()=>{
  const request=vi.fn(async()=>({targetKey:'quote'}))
  await runCheckupCli({request,estimate:()=>{},sleep:async()=>{}},{estimateOnly:true})
  expect(request).toHaveBeenCalledTimes(1)
})
it('polls the accepted run identity even when the owner changes the current model or endpoint',async()=>{
  const paths:string[]=[],request=vi.fn(async(_method,path)=>{paths.push(path);return path.endsWith('estimate')?{targetKey:'bound-run'}:path.endsWith('/run')?{attempt:{status:'running'}}:{attempt:{status:'completed'}}})
  await runCheckupCli({request,estimate:()=>{},sleep:async()=>{}},{})
  expect(paths[2]).toBe('/v1/checkup?run=bound-run')
})
it('Ctrl-C cancels the daemon run and polls its terminal state',async()=>{
  const abort=new AbortController();let cancelled=false
  const request=vi.fn(async(_method,path)=>path.endsWith('estimate')?{targetKey:'quote'}:path.endsWith('cancel')?(cancelled=true,{}):{attempt:{status:cancelled?'cancelled':'running'}})
  const result=await runCheckupCli({request,estimate:()=>{},sleep:async()=>{abort.abort()}},{signal:abort.signal})
  expect(result.view?.attempt?.status).toBe('cancelled');expect(request).toHaveBeenCalledWith('POST','/v1/checkup/cancel',{})
})

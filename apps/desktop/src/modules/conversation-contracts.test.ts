// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {mountOwnerConversation} from './conversation-contracts.js'
const controllers:ReturnType<typeof mountOwnerConversation>[]=[]
afterEach(()=>{controllers.splice(0).forEach(c=>c.destroy());document.body.innerHTML='';vi.useRealTimers()})
it('reads only explicitly declared shared contracts and binds stop to the observed turn',async()=>{
  vi.useFakeTimers()
  const root=document.createElement('div');document.body.append(root)
  let stopped=false
  const call=vi.fn(async(_method:string,path:string,body?:any)=>{
    if(path==='/v1/protocol/capabilities')return {topics:'v1',routes:'v1'}
    if(path.includes('/window'))return {messages:[],anchor:null,earlier:null,later:null}
    if(path.endsWith('/work'))return {references:[],results:[]}
    if(path.includes('/events'))return {running:stopped?null:{turnId:'current'},events:[{id:'item:1',turnId:'current',text:'partial'}],cursor:12}
    if(path.endsWith('/stop')){expect(body).toEqual({turnId:'current'});stopped=true;return {stopped:true}}
    throw Error(path)
  })
  const render={window:vi.fn(),work:vi.fn(),stream:vi.fn()},c=mountOwnerConversation(root,call,render);controllers.push(c)
  expect(await c.ready).toBe(true);await vi.advanceTimersByTimeAsync(0)
  expect(c.turn()).toBe('current');expect(render.stream).toHaveBeenCalled()
  await expect(c.stop('old')).rejects.toThrow('input_stale')
  expect(call.mock.calls.filter(c=>c[1].endsWith('/stop'))).toHaveLength(0)
  await c.stop('current');expect(c.turn()).toBe('')
  c.destroy();const count=call.mock.calls.length;await vi.advanceTimersByTimeAsync(5000);expect(call).toHaveBeenCalledTimes(count)
})
it('does not infer owner conversation support from an unrelated response shape',async()=>{
  const root=document.createElement('div');document.body.append(root)
  const call=vi.fn(async()=>({topics:[],revision:'1'})),render={window:vi.fn(),work:vi.fn(),stream:vi.fn()}
  const c=mountOwnerConversation(root,call,render);controllers.push(c)
  expect(await c.ready).toBe(false);expect(call).toHaveBeenCalledTimes(1);expect(render.window).not.toHaveBeenCalled()
})

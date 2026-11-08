// @ts-check
import { V1,v1 } from '../daemon-client.js'

/** Shared owner contracts; the host owns authentication, this controller only reads projections.
 * @param {HTMLElement} root @param {(method:any,path:string,body?:any)=>Promise<any>} call
 * @param {{window:(data:any,query:any)=>void,work:(data:any)=>void,stream:(data:any)=>void}} render */
export function mountOwnerConversation(root,call,render) {
  let alive=true,busy=false,cursor=0,turnId='',ticks=0,scope='',streamScope=''
  let activityReady=false
  /** @type {Map<string,any>} */const references=new Map(),results=new Map()
  /** @type {ReturnType<typeof setInterval>|undefined} */ let timer
  const read=async(/** @type {any} */ query={})=>{const data=await v1(call,V1.conversation.window,{query});if(alive)render.window(data,query);return data}
  const readWork=async()=>{
    /** @type {string|undefined|null} */ let next
    const visited=new Set()
    references.clear();results.clear()
    do {
      /** @type {any} */ const page=await v1(call,V1.conversation.work,{query:{cursor:next??undefined}})
      if(!alive)return
      if(page.scope&&page.scope!==scope){scope=page.scope;references.clear();results.clear()}
      for(const ref of page.references??[])references.set(ref.id,ref)
      for(const result of page.results??[])results.set(result.id,result)
      next=page.nextCursor
      if(next){if(visited.has(next))throw Error('repeated_cursor');visited.add(next)}
    }while(next)
    if(alive)render.work({scope,references:[...references.values()],results:[...results.values()]})
  }
  const refresh=async()=>{
    if(!alive||busy)return
    if(root.isConnected===false){destroy();return}
    busy=true
    try{
      const data=await v1(call,V1.conversation.events,{query:{since:cursor}})
      if(!alive)return;if(data.scope&&streamScope&&data.scope!==streamScope){cursor=0;activityReady=false;streamScope=data.scope;render.stream({...data,activityReady:false,events:[]});return}streamScope=data.scope??streamScope;cursor=data.cursor;turnId=data.running?.turnId??'';render.stream({...data,activityReady});if(!data.events?.length)activityReady=true
      if(ticks++%5===0){await read();await readWork()}
    }catch{activityReady=false;if(alive){turnId='';render.stream({running:null,events:[],cursor})}}finally{busy=false}
  }
  const ready=(async()=>{
    try{
      const capabilities=await v1(call,V1.protocol.capabilities)
      if(!alive||capabilities.routes!=='v1'||capabilities.topics!=='v1')return false
      await read()
      await readWork()
      timer=setInterval(()=>void refresh(),1000);void refresh();return true
    }catch{return false}
  })()
  function destroy(){alive=false;if(timer)clearInterval(timer)}
  window.addEventListener?.('pagehide',destroy,{once:true})
  return {ready,read,refresh,destroy,turn:()=>turnId,async stop(/** @type {string} */ expected){if(!expected||expected!==turnId)throw Error('input_stale');await v1(call,V1.conversation.stop,{body:{turnId:expected}});await refresh()}}
}

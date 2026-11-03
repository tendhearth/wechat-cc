// @ts-check
// Native movement is serialized and bounded relative to a private temporary anchor.
/** @typedef {{token:number,minOffset:number,maxOffset:number}} Context */
/** @param {{context:()=>Promise<Context|null>,step:(p:{token:number,offset:number})=>Promise<unknown>,stop:()=>Promise<unknown>,schedule?:(fn:()=>void,ms:number)=>unknown,cancel?:(h:unknown)=>void,now?:()=>number,onError?:(e:unknown)=>void}} deps */
export function createCompanionMotion(deps){
  const schedule=deps.schedule??((fn,ms)=>setTimeout(fn,ms)),cancel=deps.cancel??(h=>clearTimeout(/** @type {any} */(h))),now=deps.now??Date.now
  let epoch=0,disposed=false
  /** @type {unknown} */ let timer=null
  let pending=Promise.resolve()
  const clear=()=>{if(timer!==null)cancel(timer);timer=null}
  const error=(/** @type {unknown} */ e)=>deps.onError?.(e)
  function stop(){
    epoch++;clear()
    pending=pending.then(async()=>{await deps.stop()}).catch(error)
    return pending
  }
  return {
    /** @param {number} direction */
    play(direction){
      if(disposed)return Promise.resolve()
      const generation=++epoch;clear()
      pending=pending.then(async()=>{
        await deps.stop()
        const context=await deps.context()
        if(generation!==epoch||disposed){await deps.stop();return}
        if(!context||![context.token,context.minOffset,context.maxOffset].every(Number.isFinite))return
        let target=Math.max(context.minOffset,Math.min(context.maxOffset,direction<0?-48:48))
        if(Math.abs(target)<12)target=Math.max(context.minOffset,Math.min(context.maxOffset,direction<0?48:-48))
        if(Math.abs(target)<12){await deps.stop();return}
        const started=now()
        const frame=()=>{
          timer=null;if(generation!==epoch||disposed)return
          const progress=Math.max(0,Math.min(1,(now()-started)/2400))
          const offset=progress===1?0:Math.round(target*Math.sin(Math.PI*progress)*2)/2
          pending=(async()=>{
            await deps.step({token:context.token,offset})
            if(generation!==epoch||disposed)return
            if(progress<1)timer=schedule(frame,50)
            else {epoch++;await deps.stop()}
          })().catch(async e=>{clear();epoch++;error(e);await deps.stop().catch(error)})
        }
        timer=schedule(frame,0)
      }).catch(error)
      return pending
    },
    stop,
    destroy(){disposed=true;return stop()},
  }
}

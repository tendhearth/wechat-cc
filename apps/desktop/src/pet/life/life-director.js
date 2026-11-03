// @ts-check
// Decorative actions have their own clock. They never write task or pet facts.
/** @typedef {import('../domain/state-machine.js').PetSnapshot} Snapshot */
/** @typedef {{action:string,direction:number,authored?:boolean,token?:number}} Action */
/** @param {{schedule:(fn:()=>void,ms:number)=>unknown,cancel:(h:unknown)=>void,random:()=>number,onAction:(a:Action)=>void,now?:()=>number}} deps */
export function createLifeDirector({schedule,cancel,random,onAction,now=()=>performance.now()}) {
  /** @type {Snapshot|null} */ let facts=null
  /** @type {unknown} */ let idea=null
  /** @type {unknown} */ let nap=null
  /** @type {unknown} */ let ending=null
  let available=false,suppressed=false,disposed=false,calmClock=false,lastIdea='',action='still',direction=1
  /** @type {number|null} */ let calmSince=null
  let curiosityAvailable=false,curiosityPlayed=false,curiosityNotBefore=0,generation=0
  const current=()=>({action,direction,...(action==='curiosity'?{token:generation}:{})})
  const clear=(/** @type {unknown} */ h)=>{if(h!==null)cancel(h)}
  const emit=(/** @type {string} */ name)=>{if(action===name)return;action=name;generation++;onAction(current())}
  const clearEnd=()=>{clear(ending);ending=null}
  const cancelIdle=()=>{clear(idea);clear(nap);idea=nap=null;calmClock=false;calmSince=null;curiosityPlayed=false}
  const calm=()=>Boolean(facts&&facts.form==='lit'&&!facts.transition&&['idle','companion'].includes(facts.resting)&&['idle','companion','blink','look'].includes(facts.behavior))
  const eligible=()=>!disposed&&!suppressed&&available&&calm()
  const base=()=>facts?.behavior==='working'?'work':facts?.behavior==='thinking'?'ponder':'still'
  const timed=(/** @type {string} */ name,/** @type {number} */ ms,/** @type {()=>void} */ done)=>{
    clearEnd();emit(name);ending=schedule(()=>{ending=null;if(!disposed&&!suppressed)done()},ms)
  }
  const armIdea=()=>{
    if(!eligible()||idea!==null||action==='doze'||action==='curiosity')return
    idea=schedule(()=>{
      idea=null;if(!eligible())return
      if(action!=='still'){armIdea();return}
      if(curiosityAvailable&&!curiosityPlayed&&calmSince!==null&&now()-calmSince>=75_000&&now()>=curiosityNotBefore){
        // Consume the opportunity now, including interrupted or broken scenes.
        curiosityPlayed=true;curiosityNotBefore=now()+1_800_000
        clearEnd();emit('curiosity');return
      }
      const choices=['peek','stretch','walk-start'].filter(n=>n!==lastIdea)
      const pick=choices[Math.min(choices.length-1,Math.floor(Math.max(0,random())*choices.length))]??'peek'
      lastIdea=pick;direction=random()<.5?-1:1
      if(pick==='walk-start')timed('walk-start',300,()=>timed('walk',2400,()=>timed('walk-stop',300,()=>{emit('still');armIdea()})))
      else timed(pick,1200,()=>{emit('still');armIdea()})
    },20_000+Math.min(1,Math.max(0,random()))*20_000)
  }
  const syncIdle=()=>{
    if(!eligible()){cancelIdle();return}
    if(!calmClock){calmClock=true;calmSince=now();nap=schedule(()=>{nap=null;if(!eligible())return;clear(idea);idea=null;clearEnd();emit('doze')},180_000)}
    armIdea()
  }
  return {
    /** @param {Snapshot} next */
    observe(next){
      if(disposed)return
      const previous=facts;facts=next
      if(suppressed){cancelIdle();clearEnd();emit('still');return}
      if(next.transition||next.form!=='lit'||['permission','error','sleep'].includes(next.behavior)){
        cancelIdle();clearEnd();emit('still');return
      }
      if(next.behavior==='drag'){cancelIdle();clearEnd();emit('lift');return}
      if(previous?.behavior==='drag'){clearEnd();emit(base())}
      if(next.behavior==='working'){
        cancelIdle()
        if(previous?.behavior!=='working')timed('work-enter',350,()=>emit('work'))
        return
      }
      if(next.behavior==='thinking'){cancelIdle();clearEnd();emit('ponder');return}
      if(previous?.behavior==='working'){
        cancelIdle()
        timed('work-exit',300,()=>{
          if(facts?.behavior==='done')timed('celebrate',800,()=>{emit(base());syncIdle()})
          else {emit(base());syncIdle()}
        });return
      }
      if(next.behavior==='done'&&previous?.behavior!=='done'){
        if(action==='work-exit')return
        cancelIdle();timed('celebrate',800,()=>{emit(base());syncIdle()});return
      }
      if(action==='work-exit'&&next.behavior==='receive')return
      if(!calm()&&next.behavior!=='done'){cancelIdle();clearEnd();emit('still')}
      // Blink/look are our own decoration; their snapshots don't restart calm time.
      syncIdle()
    },
    /** @param {boolean} on */
    setAvailable(on){
      if(disposed||available===on)return
      available=on
      if(!on){
        cancelIdle()
        if(['peek','stretch','walk-start','walk','walk-stop','curiosity','doze','wake'].includes(action)){
          const asleep=action==='doze';clearEnd()
          if(asleep&&!suppressed&&calm())timed('wake',800,()=>emit('still'));else emit(base())
        }
      }else syncIdle()
    },
    /** @param {boolean} on */
    setSuppressed(on){
      if(disposed||suppressed===on)return
      suppressed=on;cancelIdle();clearEnd();emit(on?'still':base());if(!on)syncIdle()
    },
    /** Optional art disappearing must not reset the calm doze deadline.
     * @param {boolean} on
     */
    setCuriosityAvailable(on){
      if(disposed||curiosityAvailable===on)return
      curiosityAvailable=on
      if(!on&&action==='curiosity'){clearEnd();emit(base());armIdea()}
    },
    /** @param {number} token */
    finishCuriosity(token){
      if(disposed||action!=='curiosity'||token!==generation||!eligible())return false
      emit(base());syncIdle();return true
    },
    land(){
      if(disposed||suppressed||!facts||facts.transition||['permission','error','sleep','drag'].includes(facts.behavior))return
      cancelIdle();timed('land',550,()=>{emit(base());syncIdle()})
    },
    current,
    destroy(){disposed=true;cancelIdle();clearEnd();emit('still')},
  }
}

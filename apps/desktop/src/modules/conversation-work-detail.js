// @ts-check
import {createAgentAvatars} from '../shared/agent-avatars.js'
import {renderWorkbenchLedger} from './workbench-ledger.js'
import { V1,v1 } from '../daemon-client.js'
/** Session draft belongs to the canonical terminal detail, across dock/fullscreen hosts. @type {Map<string,string>} */
const terminalDrafts=new Map()
/** @type {Map<string,symbol>} */
const terminalDraftOwners=new Map()

/** Open the canonical kind first. Terminal/act ids never enter workbench task APIs.
 * @param {(method:any,path:string,body?:any)=>Promise<any>} call @param {string} id @param {(id:string)=>unknown} openTask */
export async function openConversationWork(call,id,openTask) {
  const detail=await v1(call,V1.matter.get,{query:{id}})
  if(detail.matter?.id!==id)throw Error('matter_not_found')
  if(detail.matter.kind==='task')return openTask(id)
  return showWorkDetail(call,detail)
}

/** @param {(method:any,path:string,body?:any)=>Promise<any>} call @param {string} sessionId */
export function openConversationTerminal(call,sessionId){return showWorkDetail(call,{matter:{kind:'terminal',title:'电脑上的会话'},bindings:[{surface:'cli',surfaceKey:sessionId}]})}

/** @param {(method:any,path:string,body?:any)=>Promise<any>} call @param {any} detail @param {HTMLElement} [mount] */
export async function showWorkDetail(call,detail,mount){
  const dialog=document.createElement(mount?'section':'dialog');dialog.className='wb-history-dialog';dialog.ariaLabel=detail.matter.title
  const title=document.createElement('h2');title.textContent=detail.matter.title
  const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>{ if(dialog instanceof HTMLDialogElement)dialog.close();else{dispose();dialog.remove()} }
  const body=document.createElement('div');body.className='wb-handoff-body'
  const note=document.createElement('p');note.role='status'
  dialog.append(title,close,body,note)
  let alive=true,busy=false,confirmed='',timer=0
  let saveDraft=()=>{}
  const dispose=()=>{saveDraft();alive=false;clearInterval(timer);dialog.remove()}
  if(mount){close.hidden=true;mount.append(dialog)}else{dialog.addEventListener('close',dispose,{once:true});document.body.append(dialog);if(dialog instanceof HTMLDialogElement)dialog.showModal()}
  if(detail.terminalParticipants?.length){
    const ledger=document.createElement('div')
    ledger.innerHTML=renderWorkbenchLedger({...detail,task:{id:detail.matter.id}},id=>detail.matter.agentNames?.[id])
    ledger.addEventListener('click',async event=>{
      const button=event.target instanceof Element?event.target.closest('button[data-participation-id]'):null
      if(!(button instanceof HTMLButtonElement))return
      button.disabled=true
      try{await v1(call,V1.cli.detach,{body:{participationId:button.dataset.participationId}});button.textContent='已摘下';note.textContent='终端已摘下'}catch{button.disabled=false;note.textContent='没摘下，请重试'}
    })
    body.append(ledger)
  }
  if(detail.matter.kind==='act') {
    for(const turn of detail.actTurns??[])for(const step of turn.steps??[]){const line=document.createElement('p');line.textContent=step.payload?.text??step.kind;body.append(line)}
    return dispose
  }
  const sessionId=detail.bindings?.find((/** @type {any} */ b)=>b.surface==='cli')?.surfaceKey
  if(!sessionId){note.textContent='这条会话尚未同步';return dispose}
  const input=document.createElement('textarea');input.dataset.terminalInput='';input.ariaLabel='对终端说…';input.placeholder='对终端说…';input.maxLength=4000
  const draftOwner=Symbol(sessionId);terminalDraftOwners.set(sessionId,draftOwner)
  input.value=terminalDrafts.get(sessionId)??''
  saveDraft=()=>{if(terminalDraftOwners.get(sessionId)===draftOwner)terminalDrafts.set(sessionId,input.value)}
  input.addEventListener('input',saveDraft)
  const send=document.createElement('button');send.type='button';send.textContent='发送';send.disabled=true
  const stop=document.createElement('button');stop.type='button';stop.textContent='停止这一轮';stop.hidden=true
  const avatar=document.createElement('span');avatar.className='terminal-input-avatar'
  body.append(avatar,input,send,stop)
  /** @type {any} */ let session=null
  const refresh=async()=>{
    if(busy||!alive)return;busy=true
    try{
      const list=await v1(call,V1.cli.sessions,{query:{owner:1,session_id:sessionId}})
      if(!alive)return;session=list.sessions?.find((/** @type {any} */ s)=>s.session_id===sessionId)
      const who=session?.displayName||session?.source||'终端'
      input.ariaLabel=`对 ${who} 说…`;input.placeholder=`对 ${who} 说…`
      avatar.innerHTML=createAgentAvatars().agentAvatarsHtml(session?.source?[session.source]:[])
      send.disabled=!session||session.stale||(!session.live_window&&session.status!=='idle')
      stop.hidden=!session?.run_id
      note.textContent=session?.last_summary??'尚未同步'
      for(const node of body.querySelectorAll('[data-terminal-approval]'))node.remove()
      const pending=session?.pending
      if(pending?.actionable){const description=document.createElement('p');description.dataset.terminalApproval='description';description.textContent=[pending.tool,pending.summary].filter(Boolean).join(' · ');body.append(description)}
      if(pending?.actionable)for(const [label,decision] of /** @type {[string,string][]} */([['允许','allow'],['拒绝','deny']])){
        const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.terminalApproval=decision
        button.onclick=async()=>{if(!pending?.actionable)return;button.disabled=true;try{await v1(call,V1.cli.decide,{body:{session_id:sessionId,hash:pending.hash,decision}});for(const node of body.querySelectorAll('[data-terminal-approval]'))node.remove();await refresh()}catch{note.textContent='尚未同步，请重试';button.disabled=false}}
        body.append(button)
      }
      const activity=await v1(call,V1.cli.activity,{query:{session_id:sessionId}})
      if(!alive)return
      let progress=body.querySelector('[data-terminal-progress]');if(!progress){progress=document.createElement('div');progress.setAttribute('data-terminal-progress','');body.prepend(progress)}
      progress.replaceChildren(...(activity.items??[]).map((/** @type {any} */ item)=>{const p=document.createElement('p');p.textContent=item.text;return p}))
    }catch{if(alive)note.textContent='尚未同步，请重试'}finally{busy=false}
  }
  send.onclick=async()=>{const text=input.value.trim();if(!text||send.disabled)return;send.disabled=true;try{await v1(call,V1.cli.sessionSay,{body:{session_id:sessionId,text}});if(input.value.trim()===text){input.value='';saveDraft()};note.textContent='已收下';await refresh()}catch{note.textContent='没送成，请重试'}finally{if(alive)send.disabled=!session||session.stale||(!session.live_window&&session.status!=='idle')}}
  stop.onclick=async()=>{const run=session?.run_id;if(!run)return;if(confirmed!==run){confirmed=run;stop.textContent='再点一次，确认停止';return}try{await v1(call,V1.cli.stop,{body:{session_id:sessionId,run_id:run,confirmed:true}});confirmed='';stop.textContent='停止这一轮';await refresh()}catch{note.textContent='这一轮已经结束或换了一轮，请刷新'}}
  timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh()},3000);await refresh()
  return dispose
}

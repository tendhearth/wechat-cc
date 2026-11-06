// @ts-check
import { escapeHtml } from '../view.js'
import { STATUS_WORDS } from '../generated/status-table.js'
/** @typedef {{session_id:string,status:string,project?:string,source?:string,displayName?:string,last_summary?:string|null,last_event_at?:number,stale?:boolean,now?:{text?:string}|null}} Session */
/** @type {Map<string,Session>} */ let current=new Map()
/** The desktop's existing terminal projection is read-only. It never becomes a task or a new chat. @param {Session|undefined} session */
export function terminalWord(session){
  if(!session||session.stale)return '尚未同步'
  return session.status==='waiting'?STATUS_WORDS.waiting:session.status==='running'?STATUS_WORDS.working:session.status==='idle'?STATUS_WORDS.replied:session.status==='ended'?'会话已结束':'尚未同步'
}
/** @param {string} id @param {string} title */
export function terminalReferenceHtml(id,title){
  return `<div class="converse-msg converse-msg-cc"><details class="converse-terminal" data-terminal-reference="${escapeHtml(id)}"><summary><span data-terminal-title>${escapeHtml(title)}</span><span data-terminal-state>尚未同步</span></summary><p data-terminal-step></p><small data-terminal-source></small><p class="converse-terminal-note">电脑上的会话 · 只读，操作请回原程序；等批准的请求仍从「N 件事等你」打开。</p></details></div>`
}
/** @param {Session[]} sessions */
export function updateTerminalReferences(sessions){current=new Map(sessions.map(s=>[s.session_id,s]));paintTerminalReferences()}
export function paintTerminalReferences(){
  for(const row of document.querySelectorAll('[data-terminal-reference]')){
    const id=/** @type {HTMLElement} */(row).dataset.terminalReference,session=id?current.get(id):undefined
    const state=row.querySelector('[data-terminal-state]');if(state)state.textContent=terminalWord(session)
    if(!session)continue
    const title=row.querySelector('[data-terminal-title]');if(title)title.textContent=session.project||'终端会话'
    const step=row.querySelector('[data-terminal-step]');if(step)step.textContent=session.now?.text||session.last_summary||''
    const source=row.querySelector('[data-terminal-source]');if(source)source.textContent=[session.displayName||session.source||'claude',typeof session.last_event_at==='number'?new Date(session.last_event_at).toLocaleString():''].filter(Boolean).join(' · ')
  }
}
/** Resource selection retains the original native import/closed-program confirmation flow.
 * @param {()=>Session[]} sessions @param {(session:Session)=>void} select @param {()=>unknown} history */
export function openComputerSessions(sessions,select,history){
  const dialog=document.createElement('dialog');dialog.className='wb-history-dialog';dialog.ariaLabel='电脑上的会话'
  const title=document.createElement('h2');title.textContent='电脑上的会话'
  const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>dialog.close()
  const header=document.createElement('header');header.append(title,close);close.className='wb-new'
  const body=document.createElement('div');body.className='wb-handoff-body';dialog.append(header,body)
  for(const session of sessions()){
    const button=document.createElement('button');button.type='button';button.className='wb-btn';button.textContent=`${session.project||'终端会话'} · ${terminalWord(session)}`
    button.onclick=()=>{const latest=sessions().find(s=>s.session_id===session.session_id);if(latest){dialog.close();select(latest)}else button.textContent='这段会话暂时读不到，请重新打开'}
    body.append(button)
  }
  const imported=document.createElement('button');imported.type='button';imported.className='wb-btn';imported.textContent='查找、导入或接着做已有会话';imported.onclick=()=>{dialog.close();void history()};body.append(imported)
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal()
}

// @ts-check
import {escapeHtml} from '../view.js'
/** Native <dialog> confirmation follows the existing workbench dialog layout.
 * Closing or cancelling resolves false and never runs a mutation.
 * @param {{path?:string,kind?:string,startedAt?:string,finishedAt?:string,keepCurrent?:boolean}} input */
export function mountRestoreConfirmation(input){
 const dialog=document.createElement('dialog'),title=input.keepCurrent?'保留当前现场':'撤回这个文件'
 dialog.className='wb-history-dialog wb-handoff-dialog wb-restore-dialog'
 dialog.setAttribute('aria-label',title)
 const impact=input.kind==='added'?'会删除会话中新建的这个文件。':input.kind==='deleted'?'会恢复会话开始时存在的这个文件。':'会恢复会话开始时的文件内容和权限。'
 dialog.innerHTML=`<header class="wb-history-head"><div><h2>${title}</h2><p>${input.keepCurrent?'结束这次恢复核对，保留当前文件。':'先确认这个文件会受到的影响。'}</p></div></header><div class="wb-handoff-body">${input.keepCurrent?'<p>这一步不会撤回文件，只记录你决定保留当前现场。现场已变化时，需要重新核对。</p>':`<p class="wb-path">${escapeHtml(input.path??'')}</p><p>整段已关闭会话：${escapeHtml(input.startedAt??'')} — ${escapeHtml(input.finishedAt??'')}。</p><p>${impact}范围包含这段会话的所有回合。</p>`}</div><footer class="wb-handoff-footer"><button type="button" class="wb-btn" data-restore-confirm="cancel">取消</button><button type="button" class="wb-btn wb-btn-primary" data-restore-confirm="accept">${title}</button></footer>`
 document.body.append(dialog)
 let answer=false,settled=false
 /** @type {(answer:boolean)=>void} */let resolve=()=>{}
 const result=new Promise(/** @param {(answer:boolean)=>void} done */done=>{resolve=done})
 const finish=()=>{if(settled)return;settled=true;dialog.remove();resolve(answer)}
 dialog.addEventListener('close',finish)
 dialog.addEventListener('click',event=>{
  const action=event.target instanceof Element?event.target.closest('[data-restore-confirm]')?.getAttribute('data-restore-confirm'):null
  if(action==='accept'){answer=true;dialog.close()}
  else if(action==='cancel')dialog.close()
 })
 try{dialog.showModal()}catch{finish()}
 return{result,close:()=>{answer=false;dialog.close();finish()}}
}

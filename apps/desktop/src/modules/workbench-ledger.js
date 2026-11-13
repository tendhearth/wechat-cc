// @ts-check
import {escapeWorkbenchHtml as escape} from './workbench-markdown.js'

/** @param {import('./workbench.js').Detail} detail @param {(id:string)=>string|undefined} nameOf */
export function renderWorkbenchLedger(detail,nameOf){
  const agents=(detail.agentRuns??[]).filter(a=>a.matterId===detail.task.id)
  const notes=(detail.notes??[]).filter(n=>n.matterId===detail.task.id)
  if(agents.length<2)return ''
  const label={queued:'排队',running:'在做',completed:'这一轮做完了',failed:'没做成'}
  /** @param {string} id */
  const name=id=>id==='cc'?'CC':id==='owner'?'你':nameOf(id)??id
  return `<section class="wb-ledger" aria-label="执行者与记录">${agents.length?`<h3>执行者</h3><dl class="wb-task-info">${agents.map(a=>`<div data-agent-position="${a.position}"><dt>${escape(name(a.executor))}</dt><dd>${escape(a.brief)}<br><small>${escape(label[a.status]??a.status)}</small></dd></div>`).join('')}</dl>`:''}${notes.length?`<details id="wb-ledger-notes" class="wb-disclosure" open><summary>记录</summary><dl class="wb-task-info">${notes.map(n=>`<div><dt>${escape(name(n.author))}</dt><dd>${escape(n.text)}</dd></div>`).join('')}</dl></details>`:''}</section>`
}

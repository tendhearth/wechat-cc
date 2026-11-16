// @ts-check
import {escapeWorkbenchHtml as escape} from './workbench-markdown.js'

/** @param {import('./workbench.js').Detail} detail @param {(id:string)=>string|undefined} nameOf */
export function renderWorkbenchLedger(detail,nameOf){
  const agents=(detail.agentRuns??[]).filter(a=>a.matterId===detail.task.id)
  const notes=(detail.notes??[]).filter(n=>n.matterId===detail.task.id)
  const terminals=(detail.terminalParticipants??[]).filter(p=>p.matterId===detail.task.id)
  if(agents.length<2&&!terminals.length)return ''
  const label={queued:'排队',running:'在做',completed:'这一轮做完了',failed:'没做成',cancelled:'已取消',interrupted:'已中断'}
  /** @param {string} id */
  const name=id=>id==='cc'?'CC':id==='owner'?'你':nameOf(id)??id
  return `<section class="wb-ledger" aria-label="执行者与记录">${agents.length?`<h3>执行者</h3><dl class="wb-task-info">${agents.map(a=>`<div data-agent-position="${a.position}"><dt>${escape(name(a.executor))}</dt><dd>${escape(a.brief)}<br><small>${escape(label[a.status]??a.status)}</small></dd></div>`).join('')}</dl>`:''}${terminals.length?`<h3>终端参与者</h3><dl class="wb-task-info">${terminals.map(p=>`<div><dt>${escape(p.displayName??name(p.source??'claude'))} · 终端 · ${escape(p.code??p.sessionId.slice(0,6))}</dt><dd>${escape(p.cwd??'')}<br><small>${escape(({running:'在做',waiting:'等批准',idle:'空闲',ended:'已结束'})[p.activity??'idle']??p.activity??'')} · ${p.detachedAt!==null?'已摘下':p.connection==='connected'?'记录本已接通':'已挂入，待接通'}</small>${p.detachedAt===null?` <button type="button" class="wb-btn" data-action="terminal-detach" data-participation-id="${escape(p.id)}">摘下</button>`:''}</dd></div>`).join('')}</dl>`:''}${notes.length?`<details id="wb-ledger-notes" class="wb-disclosure" open><summary>记录</summary><dl class="wb-task-info">${notes.map(n=>`<div><dt>${escape(name(n.author))}</dt><dd>${escape(n.text)}</dd></div>`).join('')}</dl></details>`:''}</section>`
}

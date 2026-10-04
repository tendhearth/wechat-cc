// @ts-check
const encode=(/** @type {string} */value)=>Array.from(value).map(c=>c.codePointAt(0)?.toString(16)).join('-')
/** @param {string} taskId @param {string} requestId @param {string} action */
export function permissionControlId(taskId,requestId,action){return `wb-permission-${action}-${encode(JSON.stringify([taskId,requestId]))}`}

/** @typedef {{taskId:string,requestId:string,action:string,index:number,requests:string[]}} PermissionFocus */
/** @param {HTMLElement} root @returns {PermissionFocus|null} */
export function capturePermissionFocus(root){
  const active=/** @type {HTMLElement|null} */(root.ownerDocument?.activeElement)
  if(!active||!root.contains(active)||!['allow-permission','deny-permission'].includes(active.dataset.action??'')||!active.dataset.ownerTask||!active.dataset.requestId)return null
  const action=active.dataset.action??'',taskId=active.dataset.ownerTask
  const controls=Array.from(/** @type {NodeListOf<HTMLElement>} */(root.querySelectorAll(`[data-action="${action}"]`))).filter(control=>control.dataset.ownerTask===taskId)
  return{taskId,requestId:active.dataset.requestId,action,index:controls.indexOf(active),requests:controls.map(control=>control.dataset.requestId??'')}
}

/** @param {HTMLElement} root @param {PermissionFocus} focus */
export function restorePermissionFocus(root,focus){
  const controls=Array.from(/** @type {NodeListOf<HTMLButtonElement>} */(root.querySelectorAll(`[data-action="${focus.action}"]`))).filter(control=>control.dataset.ownerTask===focus.taskId&&!control.disabled)
  const successor=focus.requests.slice(focus.index+1).map(id=>controls.find(control=>control.dataset.requestId===id)).find(Boolean)
  const target=controls.find(control=>control.dataset.requestId===focus.requestId)??successor??controls[Math.min(Math.max(0,focus.index),controls.length-1)]
  const next=target??/** @type {HTMLElement|null} */(root.querySelector('#wb-followup-text'))??/** @type {HTMLElement|null} */(root.querySelector('.wb-content'))
  if(next){if(!target&&next.classList.contains('wb-content'))next.tabIndex=-1;next.focus({preventScroll:true})}
}

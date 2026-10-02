// @ts-check
import {patchLiveRow} from './workbench-live-dom.js'

/** Preserve actual message nodes when permissions, results or reconnection require a full page paint.
 * @param {HTMLElement} root */
export function captureTimelineReading(root){
  const document=root.ownerDocument
  if(!document)return null
  const rows=Array.from(root.querySelectorAll('.wb-dialogue article[id]'))
  const contains=(/** @type {Node|null} */ node)=>!!node&&rows.some(row=>row.contains(node))
  const selection=document.getSelection()
  const selected=selection&&!selection.isCollapsed&&contains(selection.anchorNode)&&contains(selection.focusNode)
    ? {anchor:selection.anchorNode,anchorOffset:selection.anchorOffset,focus:selection.focusNode,focusOffset:selection.focusOffset}:null
  const active=contains(document.activeElement)?/** @type {HTMLElement} */(document.activeElement):null
  const positions=rows.flatMap(row=>Array.from(row.querySelectorAll('pre,table,[data-timeline-disclosure]')).filter(node=>node.scrollLeft||node.scrollTop).map(node=>({node,left:node.scrollLeft,top:node.scrollTop})))
  return {rows,selected,active,positions}
}

/** @param {HTMLElement} root @param {ReturnType<typeof captureTimelineReading>} snapshot */
export function restoreTimelineReading(root,snapshot){
  if(!snapshot)return
  const updates=[]
  for(const row of snapshot.rows){
    const next=root.querySelector(`#${row.id}`)
    if(next&&next.tagName===row.tagName){updates.push({row,html:next.outerHTML});next.replaceWith(row)}
  }
  // A temporary detach clears browser selection/focus. Restore it before deciding
  // whether a changed message can safely update, so disruptive formatting stays deferred.
  const selected=snapshot.selected,selection=root.ownerDocument.getSelection()
  if(selected?.anchor?.isConnected&&selected.focus?.isConnected){
    try{selection?.setBaseAndExtent(selected.anchor,selected.anchorOffset,selected.focus,selected.focusOffset)}catch{/* Deleted messages cannot retain a selection. */}
  }
  if(snapshot.active?.isConnected)snapshot.active.focus({preventScroll:true})
  for(const {node,left,top} of snapshot.positions)if(node.isConnected){node.scrollLeft=left;node.scrollTop=top}
  for(const {row,html} of updates)patchLiveRow(root,row,html)
}

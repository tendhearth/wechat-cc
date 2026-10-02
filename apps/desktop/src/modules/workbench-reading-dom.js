// @ts-check
import {patchLiveRow} from './workbench-live-dom.js'

/** @param {Node} node */
function selectionEndpoint(node){
  const element=node.nodeType===1?/** @type {Element} */(node):node.parentElement
  const container=element?.closest('[id]')
  /** @type {number[]} */const path=[]
  let child=node
  while(container&&child!==container&&child.parentNode){path.unshift(Array.from(child.parentNode.childNodes).indexOf(/** @type {ChildNode} */(child)));child=child.parentNode}
  return {node,id:container?.id??null,path,value:node.nodeValue,type:node.nodeType}
}

/** @param {HTMLElement} root @param {ReturnType<typeof selectionEndpoint>} point */
function findEndpoint(root,point){
  if(point.node.isConnected&&root.contains(point.node))return point.node
  let node=point.id?/** @type {Node|null} */(root.querySelector(`#${point.id}`)):null
  for(const index of point.path)node=node?.childNodes[index]??null
  return node?.nodeType===point.type&&node.nodeValue===point.value?node:null
}

/** Preserve actual message nodes when permissions, results or reconnection require a full page paint.
 * @param {HTMLElement} root */
export function captureTimelineReading(root){
  const document=root.ownerDocument
  if(!document)return null
  const rows=Array.from(root.querySelectorAll('.wb-dialogue article[id]'))
  const contains=(/** @type {Node|null} */ node)=>!!node&&rows.some(row=>row.contains(node))
  const dialogue=root.querySelector('.wb-dialogue')
  const selection=document.getSelection()
  const selected=selection&&!selection.isCollapsed&&selection.anchorNode&&selection.focusNode&&dialogue?.contains(selection.anchorNode)&&dialogue.contains(selection.focusNode)
    ? {anchor:selectionEndpoint(selection.anchorNode),anchorOffset:selection.anchorOffset,focus:selectionEndpoint(selection.focusNode),focusOffset:selection.focusOffset}:null
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
  const anchor=selected?findEndpoint(root,selected.anchor):null,focus=selected?findEndpoint(root,selected.focus):null
  if(selected&&anchor&&focus){
    try{selection?.setBaseAndExtent(anchor,selected.anchorOffset,focus,selected.focusOffset)}catch{/* Deleted messages cannot retain a selection. */}
  }
  if(snapshot.active?.isConnected)snapshot.active.focus({preventScroll:true})
  for(const {node,left,top} of snapshot.positions)if(node.isConnected){node.scrollLeft=left;node.scrollTop=top}
  for(const {row,html} of updates)patchLiveRow(root,row,html)
}

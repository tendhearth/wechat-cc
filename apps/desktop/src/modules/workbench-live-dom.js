// @ts-check
// Update stream rows in place. A format change must not remove the node someone is using.

/** @param {Element} row */
function interaction(row) {
  const document=row.ownerDocument,selection=document.getSelection()
  const active=document.activeElement
  const scrolled=Array.from(row.querySelectorAll('pre,table,[data-timeline-disclosure]')).filter(node=>node.scrollLeft>0||node.scrollTop>0)
  /** @param {Node} node */
  const selected=node=>{
    if(!selection||selection.isCollapsed)return false
    for(let i=0;i<selection.rangeCount;i++)try{if(selection.getRangeAt(i).intersectsNode(node))return true}catch{/* A detached selection has nothing to protect. */}
    return false
  }
  /** @param {Node} node */
  const protectedNode=node=>selected(node)||!!(active&&active!==document.body&&node.contains(active))||scrolled.some(reader=>node.contains(reader)||reader.contains(node))
  return {selected,protectedNode,active,scrolled}
}

/** @param {Node} before @param {Node} after */
function sameKind(before,after){return before.nodeType===after.nodeType&&(before.nodeType!==1||(/** @type {Element} */(before).tagName===/** @type {Element} */(after).tagName&&/** @type {Element} */(before).id===/** @type {Element} */(after).id))}

/** @param {Node} before @param {Node} after @param {ReturnType<typeof interaction>} reading @returns {boolean} */
function canUpdate(before,after,reading){
  if(before.isEqualNode(after))return true
  if(!sameKind(before,after))return !reading.protectedNode(before)
  if(before.nodeType===3)return !reading.selected(before)||(after.nodeValue??'').startsWith(before.nodeValue??'')
  if(before.nodeType===1&&before===reading.active){
    for(const name of ['href','type','disabled'])if(/** @type {Element} */(before).getAttribute(name)!==/** @type {Element} */(after).getAttribute(name))return false
  }
  const oldChildren=Array.from(before.childNodes),newChildren=Array.from(after.childNodes)
  return oldChildren.every((child,index)=>newChildren[index]?canUpdate(child,/** @type {Node} */(newChildren[index]),reading):!reading.protectedNode(child))
}

/** @param {Node} before @param {Node} after */
function update(before,after){
  if(before.isEqualNode(after))return
  if(!sameKind(before,after)){before.parentNode?.replaceChild(after.cloneNode(true),before);return}
  if(before.nodeType===3){
    const oldText=before.nodeValue??'',newText=after.nodeValue??''
    if(newText.startsWith(oldText))/** @type {Text} */(before).appendData(newText.slice(oldText.length))
    else before.nodeValue=newText
    return
  }
  if(before.nodeType===1){
    const oldElement=/** @type {Element} */(before),newElement=/** @type {Element} */(after)
    for(const attribute of Array.from(oldElement.attributes))if(!newElement.hasAttribute(attribute.name))oldElement.removeAttribute(attribute.name)
    for(const attribute of Array.from(newElement.attributes))if(oldElement.getAttribute(attribute.name)!==attribute.value)oldElement.setAttribute(attribute.name,attribute.value)
  }
  const oldChildren=Array.from(before.childNodes),newChildren=Array.from(after.childNodes)
  for(let index=0;index<Math.max(oldChildren.length,newChildren.length);index++){
    const oldChild=oldChildren[index],newChild=newChildren[index]
    if(oldChild&&newChild)update(oldChild,newChild)
    else if(oldChild)before.removeChild(oldChild)
    else if(newChild)before.appendChild(newChild.cloneNode(true))
  }
}

/** @param {Element} row @param {string} html */
function refreshRow(row,html){
  const template=row.ownerDocument.createElement('template');template.innerHTML=html
  const next=template.content.firstElementChild
  if(!next)return true
  const reading=interaction(row)
  if(!canUpdate(row,next,reading))return false
  const positions=reading.scrolled.map(node=>({node,left:node.scrollLeft,top:node.scrollTop}))
  update(row,next)
  for(const {node,left,top} of positions){node.scrollLeft=left;node.scrollTop=top}
  return true
}

/** @typedef {{rows:Map<string,{row:Element,html:string}>,dispose:()=>void,schedule:()=>void}} Pending */
/** @type {WeakMap<object,Pending>} */
const pending=new WeakMap()

/** @param {any} root */
export function clearLiveTimelinePatches(root){pending.get(root)?.dispose();pending.delete(root)}

/** @param {any} root @param {Element} row @param {string} html */
function deferRow(root,row,html){
  let state=pending.get(root)
  if(!state){
    const document=row.ownerDocument,rows=new Map()
    /** @type {ReturnType<typeof setTimeout>|null} */let timer=null
    const flush=()=>{
      timer=null
      for(const [id,value] of rows){
        // A full paint already used the controller's latest data; never replay an older row over it.
        if(root.querySelector(`#${id}`)!==value.row||refreshRow(value.row,value.html))rows.delete(id)
      }
      if(!rows.size)clearLiveTimelinePatches(root)
    }
    const schedule=()=>{if(timer===null)timer=setTimeout(flush,0)}
    const events=['focusout','pointerup','keyup','scroll']
    document.addEventListener('selectionchange',schedule)
    for(const event of events)root.addEventListener(event,schedule,true)
    const dispose=()=>{if(timer!==null)clearTimeout(timer);document.removeEventListener('selectionchange',schedule);for(const event of events)root.removeEventListener(event,schedule,true)}
    state={rows,dispose,schedule};pending.set(root,state)
  }
  state.rows.set(row.id,{row,html})
}

/** @param {any} root @param {Element} row @param {string} html @returns {boolean} Whether the row was refreshed immediately. */
export function patchLiveRow(root,row,html){
  if(refreshRow(row,html)){
    const state=pending.get(root);state?.rows.delete(row.id)
    if(state&&!state.rows.size)clearLiveTimelinePatches(root)
    return true
  }
  deferRow(root,row,html);return false
}

/** @param {any} root */
export function hasLiveTimelineInteraction(root){
  const document=root.ownerDocument
  if(!document)return false
  const active=document.activeElement,selection=document.getSelection()
  if(active&&root.querySelector('.wb-dialogue')?.contains(active)&&active!==document.body)return true
  if(selection&&!selection.isCollapsed)for(let i=0;i<selection.rangeCount;i++)try{if(selection.getRangeAt(i).intersectsNode(root.querySelector('.wb-dialogue')))return true}catch{/* A missing row is not being read. */}
  return Array.from(/** @type {Element[]} */(root.querySelectorAll?.('.wb-dialogue pre,.wb-dialogue table')??[])).some(node=>node.scrollLeft>0)
}

// @ts-check
// Keep already-read messages in the DOM: polling must not erase selection,
// keyboard focus, disclosure state or horizontal code scrolling.
/** @typedef {{id:number,role:'user'|'cc'|'error'|'system',text:string,pending?:boolean}} Message */
/** @typedef {{message:Message,node:Element}} Row */
/** @typedef {{rows:Map<number,Row>,unread:boolean,following:boolean,lastTop:number}} ReadingState */
/** @type {WeakMap<HTMLElement,ReadingState>} */
const states = new WeakMap()

/** @param {HTMLElement} scroll */
export function conversationAtLatest(scroll) {
  return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 48
}

/** @param {HTMLElement} scroll */
export function conversationInteractionActive(scroll) {
  const document=scroll.ownerDocument,selection=document.getSelection?.()
  return !!(document.activeElement && scroll.contains(document.activeElement)) ||
    !!(selection && !selection.isCollapsed && ((selection.anchorNode && scroll.contains(selection.anchorNode)) || (selection.focusNode && scroll.contains(selection.focusNode))))
}

/** @param {HTMLElement} scroll @param {HTMLButtonElement|null} latest */
export function syncConversationLatest(scroll, latest) {
  const state=states.get(scroll)
  if(state){
    if(scroll.scrollTop<state.lastTop-1)state.following=false
    else if(conversationAtLatest(scroll) && !conversationInteractionActive(scroll)){state.following=true;state.unread=false}
    state.lastTop=scroll.scrollTop
  }
  if(latest)latest.hidden=!state?.unread
}

/** @param {HTMLElement} scroll @param {HTMLButtonElement|null} latest */
export function showConversationLatest(scroll, latest) {
  const state=states.get(scroll)
  if(state){state.unread=false;state.following=true}
  scroll.scrollTop=scroll.scrollHeight
  if(state)state.lastTop=scroll.scrollTop
  if(latest)latest.hidden=true
}

/** @param {HTMLElement} scroll @param {Message[]} messages
 * @param {(message:Message)=>string} render @param {string} empty
 * @param {{follow?:boolean,latest?:HTMLButtonElement|null}} [options] */
export function paintConversation(scroll, messages, render, empty, {follow=false,latest=null}={}) {
  let state=states.get(scroll)
  if(!state){state={rows:new Map(),unread:false,following:true,lastTop:scroll.scrollTop};states.set(scroll,state)}
  if(scroll.scrollTop<state.lastTop-1)state.following=false
  const following=follow || !state.rows.size || (state.following && conversationAtLatest(scroll) && !conversationInteractionActive(scroll))
  const top=scroll.scrollTop
  if(!messages.length){
    if(state.rows.size || !scroll.firstElementChild)scroll.innerHTML=empty
    state.rows.clear();state.unread=false
    if(latest)latest.hidden=true
    return
  }
  if(!state.rows.size)scroll.replaceChildren()
  /** @type {Map<number,Row>} */
  const next=new Map()
  let cursor=scroll.firstElementChild,newReply=false
  for(const message of messages){
    const previous=state.rows.get(message.id)
    let row=previous
    if(!previous || previous.message.role!==message.role || previous.message.text!==message.text || previous.message.pending!==message.pending){
      const template=scroll.ownerDocument.createElement('template')
      template.innerHTML=render(message)
      const node=template.content.firstElementChild
      if(!node)continue
      node.setAttribute('data-converse-message',String(message.id))
      row={message:{...message},node}
    }
    if(!row)continue
    if(row.node!==cursor)scroll.insertBefore(row.node,cursor)
    cursor=row.node.nextElementSibling
    next.set(message.id,row)
    if(!previous && message.role==='cc' && !message.pending)newReply=true
  }
  while(cursor){const stale=cursor;cursor=cursor.nextElementSibling;stale.remove()}
  state.rows=next
  if(following){
    state.unread=false
    requestAnimationFrame(()=>{
      // A reader can scroll or select between receiving a reply and this frame.
      if(follow || (!conversationInteractionActive(scroll) && scroll.scrollTop===top))showConversationLatest(scroll,latest)
      else{state.following=false;state.lastTop=scroll.scrollTop;if(newReply){state.unread=true;if(latest)latest.hidden=false}}
    })
  }else{
    scroll.scrollTop=top
    state.following=false;state.lastTop=top
    if(newReply)state.unread=true
  }
  if(latest)latest.hidden=!state.unread
}

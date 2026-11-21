// @ts-check
// Keep already-read messages in the DOM: polling must not erase selection,
// keyboard focus, disclosure state or horizontal code scrolling.
import { deskDate, messageDay } from './desk-page.js'

/** @typedef {import('./converse.js').ConverseMsg} Message */
/** @typedef {{message:Message,signature:string,node:Element}} Row */
/** @typedef {{rows:Map<number|string,Row>,unread:boolean,following:boolean,lastTop:number,empty:string}} ReadingState */
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

/** @param {HTMLElement} scroll */
export function rememberConversationPosition(scroll) {
  const top = scroll.scrollTop
  const viewportTop = scroll.getBoundingClientRect?.().top
  const anchor = viewportTop === undefined ? undefined : [...scroll.children].find(node =>
    (node.hasAttribute('data-converse-message') || node.hasAttribute('data-converse-place-card'))
    && node.getBoundingClientRect().bottom > viewportTop
  )
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0
  return () => {
    if (anchor && scroll.contains(anchor)) scroll.scrollTop += anchor.getBoundingClientRect().top - anchorTop
    else scroll.scrollTop = top
    const state = states.get(scroll)
    if (state) state.lastTop = scroll.scrollTop
  }
}

/** @param {HTMLElement} scroll @param {Message[]} messages
 * @param {(message:Message)=>string} render @param {string} empty
 * @param {{follow?:boolean,prepend?:boolean,preserve?:boolean,latest?:HTMLButtonElement|null,decoration?:(message:Message)=>string}} [options] */
export function paintConversation(scroll, messages, render, empty, {follow=false,prepend=false,preserve=false,latest=null,decoration}={}) {
  let state=states.get(scroll)
  if(!state){state={rows:new Map(),unread:false,following:true,lastTop:scroll.scrollTop,empty:''};states.set(scroll,state)}
  if(scroll.scrollTop<state.lastTop-1)state.following=false
  const following=follow || !state.rows.size || (state.following && conversationAtLatest(scroll) && !conversationInteractionActive(scroll))
  const top=scroll.scrollTop
  const keepPosition = prepend || preserve
  const restorePosition = keepPosition ? rememberConversationPosition(scroll) : null
  if(!messages.length){
    if(state.empty!==empty || !scroll.firstElementChild)scroll.innerHTML=empty
    state.empty=empty
    state.rows.clear();state.unread=false
    if(latest)latest.hidden=true
    return
  }
  if(!state.rows.size)scroll.replaceChildren()
  state.empty=''
  /** @type {Map<number|string,Row>} */
  const next=new Map()
  let cursor=scroll.firstElementChild,newReply=false
  let previousRole = ''
  let previousDay = null
  for(const message of messages){
    const key = message.placeCardKey ?? message.id
    const previous=state.rows.get(key)
    const signature=JSON.stringify([message.role,message.text,message.pending,message.speaker,message.provider,message.replyParts,message.attachments,message.attachmentSourceIndexes,message.narration,message.projection,decoration?.(message)])
    let row=previous
    if(!previous || previous.signature!==signature){
      const template=scroll.ownerDocument.createElement('template')
      template.innerHTML=render(message)
      const node=template.content.firstElementChild
      if(!node)continue
      if (message.placeCardKey) node.setAttribute('data-converse-place-card', message.placeCardKey)
      else node.setAttribute('data-converse-message',String(message.id))
      row={message:{...message},signature,node}
    }
    if(!row)continue
    const day = messageDay(message.at)
    if (day && day.toDateString() !== previousDay?.toDateString()) {
      const label = deskDate(day)
      if (!cursor?.classList.contains('desk-message-date')) {
        const divider = scroll.ownerDocument.createElement('time')
        divider.className = 'desk-message-date'
        scroll.insertBefore(divider, cursor)
        cursor = divider
      }
      if (cursor.textContent !== label) cursor.textContent = label
      cursor = cursor.nextElementSibling
    } else if (cursor?.classList.contains('desk-message-date') && cursor.nextElementSibling === row.node) {
      const divider = cursor
      cursor = divider.nextElementSibling
      divider.remove()
    }
    if (day) previousDay = day
    row.node.toggleAttribute('data-same-speaker', !message.placeCardKey && message.role === previousRole)
    previousRole = message.placeCardKey ? '' : message.role
    if(row.node!==cursor)scroll.insertBefore(row.node,cursor)
    cursor=row.node.nextElementSibling
    next.set(key,row)
    if (!prepend && !previous && !message.placeCardKey && message.role==='cc' && !message.pending) newReply=true
  }
  while(cursor){const stale=cursor;cursor=cursor.nextElementSibling;stale.remove()}
  state.rows=next
  if (keepPosition || messages.every(message => message.placeCardKey)) {
    if (follow) state.unread = false
    if (restorePosition) restorePosition()
    else scroll.scrollTop = top
    state.lastTop = scroll.scrollTop
  } else if(following){
    state.unread=false
    requestAnimationFrame(()=>{
      if (state.rows !== next || !next.size) return
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

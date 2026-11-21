// @ts-check
// Keep already-read messages in the DOM: polling must not erase selection,
// keyboard focus, disclosure state or horizontal code scrolling.
import { deskDate, messageDay } from './desk-page.js'

/** @typedef {Omit<import('./converse.js').ConverseMsg, 'id'|'role'> & {id:number|string,role:string}} Message */
/** @typedef {{message:Message,signature:string,node:Element}} Row */
/** @typedef {{rows:Map<number|string,Row>,unread:boolean,following:boolean,owed:boolean,lastTop:number,empty:string,latest:HTMLButtonElement|null}} ReadingState */
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
  // 记的是这一条离阅读区顶边多远,不是它在屏幕上的高度:换版式后阅读区自己的位置会变。
  const anchorTop = anchor && viewportTop !== undefined ? anchor.getBoundingClientRect().top - viewportTop : 0
  return () => {
    if (anchor && scroll.contains(anchor)) scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchorTop
    else scroll.scrollTop = top
    const state = states.get(scroll)
    if (state) state.lastTop = scroll.scrollTop
  }
}

/** @template {Message} M @param {HTMLElement} scroll @param {M[]} messages
 * @param {(message:M)=>string} render @param {string} empty
 * @param {{update?:(node:Element,message:M)=>boolean|'defer',follow?:boolean,prepend?:boolean,preserve?:boolean,latest?:HTMLButtonElement|null,decoration?:(message:M)=>unknown}} [options] */
export function paintConversation(scroll, messages, render, empty, {follow=false,prepend=false,preserve=false,latest=null,decoration,update}={}) {
  let state=states.get(scroll)
  if(!state){
    const created=state={rows:new Map(),unread:false,following:true,owed:false,lastTop:scroll.scrollTop,empty:'',latest}
    states.set(scroll,created)
    // 消息比页面先到(这一栏还没显示出来、高度是 0)时没法滚到最新:等它有了高度再补上。
    if(typeof ResizeObserver==='function')new ResizeObserver(()=>{
      if(!created.owed || !created.rows.size || !scroll.clientHeight)return
      created.owed=false
      showConversationLatest(scroll,created.latest)
    }).observe(scroll)
  }
  state.latest=latest
  if(scroll.scrollTop<state.lastTop-1)state.following=false
  const following=follow || !state.rows.size || (state.following && conversationAtLatest(scroll) && !conversationInteractionActive(scroll))
  const top=scroll.scrollTop
  // 往上翻一页是主人自己要看旧的:之前欠着的「跟到最新」作废。
  if (prepend) state.owed = false
  // 上一次重画说好下一帧跟到最新,那一帧还没到又来一次重画:这次接着欠,不许因为位置没变就当成不用跟。
  const owed = state.owed
  const keepPosition = (prepend || preserve) && !owed
  const restorePosition = keepPosition ? rememberConversationPosition(scroll) : null
  // 流最上面的常驻节点(「更早的对话」):不是消息,重画时留在原处。
  const head = scroll.firstElementChild
  const lead = head?.hasAttribute?.('data-converse-lead') ? head : null
  if(!messages.length){
    if(state.empty!==empty || !(lead ? lead.nextElementSibling : head)){
      scroll.innerHTML=empty
      if(lead)scroll.prepend(lead)
    }
    state.empty=empty
    state.rows.clear();state.unread=false;state.owed=false
    if(latest)latest.hidden=true
    return
  }
  if(!state.rows.size)scroll.replaceChildren(...(lead?[lead]:[]))
  state.empty=''
  /** @type {Map<number|string,Row>} */
  const next=new Map()
  let cursor=lead?lead.nextElementSibling:scroll.firstElementChild,newReply=false
  let previousRole = ''
  let previousDay = null
  for(const message of messages){
    const key = message.placeCardKey ?? message.id
    const previous=state.rows.get(key)
    const signature=JSON.stringify([message.role,message.text,message.pending,message.speaker,message.provider,message.replyParts,message.attachments,message.attachmentSourceIndexes,message.narration,message.projection,decoration?.(message)])
    let row=previous
    const changed = previous && previous.signature !== signature
    const updated = changed ? update?.(previous.node,message) : false
    if(updated === true && previous){
      row={message:{...message},signature,node:previous.node}
    }else if(!previous || (changed && updated !== 'defer')){
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
    state.owed = false
    if (follow) state.unread = false
    if (restorePosition) restorePosition()
    else scroll.scrollTop = top
    state.lastTop = scroll.scrollTop
  } else if(following || owed){
    state.unread=false
    state.owed=true
    requestAnimationFrame(()=>{
      // 这一帧之前又重画过:那一次接手了这笔账(state.owed 还在)。
      if (state.rows !== next || !next.size) return
      // 这一栏还没显示出来:账先留着,等它有了高度(上面的 ResizeObserver)再跟到最新。
      if (!scroll.clientHeight && scroll.isConnected && typeof ResizeObserver==='function') return
      state.owed=false
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

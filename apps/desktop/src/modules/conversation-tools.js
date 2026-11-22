// @ts-check
import { wireDeskDisclosure } from './desk-disclosure.js'
/** Tools live above the conversation, never as an alternate owner conversation.
 * @param {{root:HTMLElement,delegate:()=>unknown,search:()=>unknown,history:()=>unknown,projects:()=>unknown,navigate:(name:string)=>unknown}} deps */
export function mountConversationTools({root,delegate,search,history,projects,navigate}) {
  const legacy=root.querySelector('#converse-delegate');if(legacy instanceof HTMLElement)legacy.hidden=true
  const bar = document.createElement('div'); bar.className = 'conversation-tools'
  const make = (/** @type {string} */ text, /** @type {()=>unknown} */ run) => { const button = document.createElement('button'); button.type='button'; button.textContent=text; button.onclick=()=>{void run()}; return button }
  const plus = document.createElement('details'); plus.className='conversation-add'
  const summary = document.createElement('summary'); summary.textContent='＋'; summary.ariaLabel='添加'; plus.append(summary)
  const items = document.createElement('div')
  items.className = 'conversation-add-items'
  items.append(make('交办一件事',delegate),make('项目与文件夹',projects))
  items.append(make('电脑上的会话',history),make('搜索对话',()=>{const button=root.querySelector('#converse-search-open');if(button instanceof HTMLElement)button.click()}))
  plus.append(items); bar.append(plus); root.querySelector('.converse-compose')?.prepend(bar)
  const close = (/** @type {Event} */ event) => { const button=/** @type {HTMLElement} */(event.target).closest('button'); if(button){plus.open=false} }
  bar.addEventListener('click',close)
  const listeners = new AbortController()
  wireDeskDisclosure(plus, listeners.signal)
  return () => {
    listeners.abort()
    bar.remove()
  }
}

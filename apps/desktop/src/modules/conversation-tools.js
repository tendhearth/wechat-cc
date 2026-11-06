// @ts-check
/** Tools live above the conversation, never as an alternate owner conversation.
 * @param {{root:HTMLElement,delegate:()=>unknown,search:()=>unknown,history:()=>unknown,projects:()=>unknown,navigate:(name:string)=>unknown}} deps */
export function mountConversationTools({root,delegate,search,history,projects,navigate}) {
  const bar = document.createElement('div'); bar.className = 'conversation-tools'
  const make = (/** @type {string} */ text, /** @type {()=>unknown} */ run) => { const button = document.createElement('button'); button.type='button'; button.textContent=text; button.onclick=()=>{void run()}; return button }
  const plus = document.createElement('details'); plus.className='conversation-add'
  const summary = document.createElement('summary'); summary.textContent='＋'; summary.ariaLabel='添加'; plus.append(summary)
  plus.append(make('交办一件事',delegate),make('项目与文件夹',projects))
  const more = document.createElement('details'); more.className='conversation-more'
  const moreSummary = document.createElement('summary'); moreSummary.textContent='更多'; more.append(moreSummary)
  more.append(make('电脑上的会话',history))
  for (const [name,label] of /** @type {[string,string][]} */ ([['recollections','回忆'],['atelier','画室与相册'],['memory','记忆与纠错'],['todos','待办'],['a2a-agents','觅食'],['sessions','后厨']])) more.append(make(label,()=>navigate(name)))
  const find=make('搜索事项',search); find.dataset.conversationSearchMatters=''
  bar.append(plus,find,more); root.prepend(bar)
  const close = (/** @type {Event} */ event) => { const button=/** @type {HTMLElement} */(event.target).closest('button'); if(button){plus.open=false;more.open=false} }
  bar.addEventListener('click',close)
  return ()=>bar.remove()
}

// @ts-check
import { V1, v1 } from '../daemon-client.js'
import { STATUS_WORDS } from '../generated/status-table.js'
import { escapeHtml } from '../view.js'

/** T4 reads never open a bubble. Only a deliberate owner selection writes.
 * @param {{root:HTMLElement,call:(method:any,path:string,body?:any)=>Promise<any>,openMatter:(id:string)=>unknown,locateMessage:(id:string,excerpt?:string)=>unknown,manage:()=>unknown,onTopics?:(ids:string[])=>void}} deps */
export function mountConversationTopics({root,call,openMatter,locateMessage,manage,onTopics}) {
  const row = document.createElement('nav'); row.className = 'conversation-topics'; row.ariaLabel = '最近话题'; row.hidden = true
  const panel = document.createElement('section'); panel.className = 'conversation-topic-panel'; panel.ariaLabel = '话题'; panel.hidden = true; panel.tabIndex = -1
  root.querySelector('.converse-compose')?.before(row)
  root.append(panel)
  /** @type {HTMLElement|null} */ let returnFocus = null
  let editing = false
  let alive = true, selected = '', revision = '', ticket = 0, listTicket = 0, all = false, cursor = '', stale = false
  /** @type {boolean|null} */ let supported=null
  /** @type {any[]} */ let topics = []
  /** @type {any} */ let detail = null
  /** @type {{id:string,requestId:string}|null} */ let pendingOpen = null
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer
  const narrow=window.matchMedia('(max-width:760px)')
  const syncPanel=()=>{
    const modal=narrow.matches&&!panel.hidden
    panel.setAttribute('role',narrow.matches?'dialog':'complementary')
    if(modal)panel.setAttribute('aria-modal','true');else panel.removeAttribute('aria-modal')
    for(const child of root.children)if(child!==panel&&child instanceof HTMLElement)child.inert=modal
  }
  const visibility=new MutationObserver(syncPanel);visibility.observe(panel,{attributes:true,attributeFilter:['hidden']})
  narrow.addEventListener('change',syncPanel)
  const close = () => { const id=selected; pendingOpen=null; all = false; selected = ''; ticket++; panel.hidden = true; root.classList.remove('has-topic'); syncPanel(); drawRow(); const target=id?row.querySelector(`[data-topic-id="${CSS.escape(id)}"]`):returnFocus; if(target instanceof HTMLElement)target.focus() }
  const button = (/** @type {string} */ label, /** @type {()=>unknown} */ action) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.dataset.topicFocusKey=label; el.onclick = action; return el
  }
  function drawRow() {
    row.replaceChildren(...topics.slice(0,6).map(t => {
      const b = button(t.title, () => { void open(t.id) }); b.dataset.topicId=t.id; b.setAttribute('aria-pressed', String(selected === t.id)); return b
    }))
    if (topics.length) row.append(button('更多话题', () => { all = true; selected = ''; cursor = ''; panel.hidden = false; root.classList.add('has-topic'); void listAll() }))
    row.hidden = !topics.length
  }
  async function refresh() {
    const generation = ++listTicket
    try {
      const capabilities=await v1(call,V1.protocol.capabilities)
      if(!alive||generation!==listTicket)return
      if(capabilities.topics!=='v1'){supported=false;topics=[];detail=null;close();drawRow();return}
      const data = await v1(call,V1.topics.list,{query:{view:'recent',limit:6}})
      if (!alive || generation !== listTicket) return
      if (!Array.isArray(data.topics) || typeof data.revision !== 'string') throw Error('invalid_topics')
      supported=true; topics = data.topics; stale = false; drawRow(); onTopics?.(topics.slice(0,6).map(t=>t.id))
      if (selected && pendingOpen?.id!==selected) await readDetail(selected)
    } catch (error) {
      if (!alive || generation !== listTicket) return
      stale = true
      if (/401|403|404|unauthorized|forbidden/.test(String(error))) { supported=false;topics = []; detail = null; close(); drawRow(); return }
      // No data on an older daemon: conversation remains usable and no dead entry is advertised.
      if (detail && selected) drawDetail()
    }
  }
  async function readDetail(/** @type {string} */ id) {
    const generation = ++ticket
    try {
      const data = await v1(call,V1.topics.detail,{query:{id}})
      if (!alive || generation !== ticket || selected !== id) return
      if(data.topic?.mergedInto&&data.topic.mergedInto!==id){selected=data.topic.mergedInto;pendingOpen=null;void refresh();await readDetail(selected);return}
      detail = data; stale = false; drawDetail()
    } catch (error) {
      if (!alive || generation !== ticket) return
      if (/404|unauthorized|forbidden|not_found|401|403/.test(String(error))) { detail = null; close(); void refresh(); return }
      stale = true; drawDetail()
    }
  }
  async function open(/** @type {string} */ id, /** @type {string|undefined} */ retryRequestId=undefined) {
    returnFocus = /** @type {HTMLElement|null} */ (document.activeElement)
    all = false; selected = id; detail = null; cursor = ''; panel.hidden = false; root.classList.add('has-topic'); drawRow(); drawDetail(); panel.focus()
    const generation = ++ticket
    const requestId=retryRequestId??crypto.randomUUID();pendingOpen={id,requestId}
    try {
      await v1(call,V1.topics.open,{body:{id,requestId}})
      if (!alive || generation !== ticket || selected !== id) return
      pendingOpen=null
      await readDetail(id)
    } catch (error) { if (alive && generation === ticket) { if (/401|403|404|unauthorized|forbidden/.test(String(error))) { topics = []; detail = null; close(); drawRow() } else { stale = true; drawDetail() } } }
  }
  async function editTopic(/** @type {'rename'|'merge'|'delete'|'wrong'} */ action, /** @type {any} */ body) {
    if(stale||editing)return
    const id=selected
    editing=true
    try { await v1(call,V1.topics[action],{body}); if(!alive||selected!==id)return;if(action==='delete'||action==='merge')close();await refresh() }
    catch { if(alive&&selected===id){const note=document.createElement('p');note.role='status';note.textContent='结果待核对，请刷新查看。';panel.append(note)} }
    finally {editing=false}
  }
  function management() {
    const controls=document.createElement('details'),summary=document.createElement('summary');summary.textContent='管理话题';controls.append(summary)
    const name=document.createElement('input');name.value=detail.topic.title;name.maxLength=120;name.ariaLabel='话题名称'
    controls.append(name,button('改名',()=>{if(!name.value.trim()){name.focus();return};void editTopic('rename',{id:selected,title:name.value.trim()})}))
    const target=document.createElement('select');target.ariaLabel='并到哪个话题'
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='选择话题';target.append(placeholder)
    const current=selected
    void (async()=>{
      /** @type {string|undefined} */
      let nextCursor=undefined
      do {
        /** @type {any} */
        const page=await v1(call,V1.topics.list,{query:{view:'all',limit:50,cursor:nextCursor}})
        if(!alive||current!==selected||!target.isConnected)return
        for(const t of page.topics)if(t.id!==current){const option=document.createElement('option');option.value=t.id;option.textContent=t.title;target.append(option)}
        nextCursor=page.nextCursor??undefined
      }while(nextCursor)
    })().catch(()=>{target.disabled=true})
    controls.append(target,button('并到…',()=>{if(target.value)void editTopic('merge',{id:selected,into:target.value})}))
    const confirm=document.createElement('details'),label=document.createElement('summary'),question=document.createElement('p');label.textContent='删话题';question.textContent='删除这个话题和记下的内容？';confirm.append(label,question,button('确认删除',()=>{void editTopic('delete',{id:selected})}));controls.append(confirm)
    return controls
  }
  function drawDetail() {
    if (!selected) return
    const top=panel.scrollTop
    const previous=panel.contains(document.activeElement)?/** @type {HTMLElement|null} */(document.activeElement):null
    const focusKey=previous?.dataset.topicFocusKey
    const expanded=new Set([...panel.querySelectorAll('details[data-entry-id][open]')].map(el=>el.getAttribute('data-entry-id')))
    const restore=()=>{panel.scrollTop=top;if(previous){const target=focusKey?panel.querySelector(`[data-topic-focus-key="${CSS.escape(focusKey)}"]`):panel;(target instanceof HTMLElement?target:panel).focus({preventScroll:true})}}
    panel.replaceChildren(button('收起', close))
    const h = document.createElement('h2'); h.id = 'conversation-topic-title'; panel.setAttribute('aria-labelledby',h.id); h.textContent = detail?.topic?.title ?? topics.find(t => t.id === selected)?.title ?? '话题'; panel.append(h)
    if (stale) { const note = document.createElement('p'); note.role = 'status'; note.textContent = '尚未同步 · 暂时读不到'; panel.append(note, button('重试', () => { if(pendingOpen?.id===selected)void open(selected,pendingOpen.requestId);else void readDetail(selected) })) }
    if (!detail) { if (!stale) panel.append(document.createTextNode('正在读取…')); restore(); return }
    for (const text of [detail.topic.description, detail.topic.summary]) if (text) { const p = document.createElement('p'); p.textContent = text; panel.append(p) }
    let count = 0
    for (const [key,title] of /** @type {[string,string][]} */ ([['matters','相关事项'],['entries','CC 记得'],['messages','最近聊到']])) {
      const items = detail[key] ?? []; if (!items.length) continue
      count += items.length
      const heading = document.createElement('h3'); heading.textContent = title; panel.append(heading)
      for (const item of items) {
        if (key === 'matters') panel.append(button(`${STATUS_WORDS[/** @type {import('../generated/status-table.js').StatusKey} */(item.state)]??'尚未同步'} · ${item.title}`, () => openMatter(item.id)))
        else if (key === 'messages') panel.append(button(`${item.speaker === 'owner' ? '你' : 'CC'} · ${item.ts} · ${item.excerpt}${item.source === 'episode' ? '（相关记录）' : ''}`, () => {close();return locateMessage(item.id,item.excerpt)}))
        else {
          const disclosure = document.createElement('details');disclosure.dataset.entryId=item.id;disclosure.open=expanded.has(item.id)
          disclosure.innerHTML = `<summary>${escapeHtml(item.line)}${item.status==='superseded'?' · 不再采用':''}${item.recalled && item.status === 'live' ? ' · 这次想起' : ''}</summary><p>${escapeHtml(item.body)}</p><small>${escapeHtml(item.source)} · ${escapeHtml(item.updatedTs)}</small>`
          const summary=disclosure.querySelector('summary');if(summary instanceof HTMLElement)summary.dataset.topicFocusKey=`entry:${item.id}`
          if(item.status==='live'&&!stale)disclosure.append(button('这条不对',()=>{void editTopic('wrong',{id:item.id})}))
          panel.append(disclosure)
        }
      }
      const page = detail.pages?.[key]
      if (page?.nextCursor) panel.append(button(`更多${title}（${page.total}）`, () => { void more(key,page.nextCursor) }))
    }
    if (!count) panel.append(document.createTextNode('还没有记下内容'))
    if(!stale)panel.append(management())
    panel.append(button('记忆管理与纠错', manage));restore()
  }
  async function more(/** @type {string} */ section, /** @type {string} */ nextCursor) {
    const id = selected, generation = ticket
    try {
      const data = await v1(call,V1.topics.detail,{query:{id,section,cursor:nextCursor}})
      if (!alive || selected !== id || generation !== ticket) return
      const seen = new Set(detail[section].map((/** @type {any} */ item) => item.id))
      detail[section].push(...data[section].filter((/** @type {any} */ item) => !seen.has(item.id)))
      detail.pages[section] = data.pages[section]; drawDetail()
    } catch(error) { if(!alive||selected!==id||generation!==ticket)return; if(/401|403|404|unauthorized|forbidden/.test(String(error))){topics=[];detail=null;close();drawRow()}else{stale = true; drawDetail()} }
  }
  async function listAll() {
    const generation = ++ticket
    /** @type {any[]} */ const items=[]
    /** @type {string|null} */ let next=null
    let loading=false
    const seen=new Set()
    panel.replaceChildren(button('返回对话',close))
    const title=document.createElement('h2');title.id='conversation-topic-title';title.textContent='更多话题';panel.setAttribute('aria-labelledby',title.id);panel.append(title)
    const search=document.createElement('input');search.type='search';search.placeholder='搜索话题';search.ariaLabel='搜索话题'
    const results=document.createElement('div'),notice=document.createElement('p'),actions=document.createElement('div')
    notice.role='status';panel.append(search,results,notice,actions);search.focus()
    const valid=()=>alive&&all&&generation===ticket
    const paint=()=>{
      results.replaceChildren(...items.filter(topic=>topic.title.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).map(topic=>button(topic.title,()=>{void open(topic.id)})))
      actions.replaceChildren()
      if(next&&!loading)actions.append(button('更多话题',()=>{void load(false)}))
      notice.textContent=loading?'正在读取…':!items.length?'还没有记下内容':search.value&&!results.childElementCount?'没有找到相关话题':''
    }
    const load=async (/** @type {boolean} */ exhaustive)=>{
      if(loading)return
      loading=true;paint()
      const cursors=new Set()
      try {
        do {
          const current=next??''
          if(cursors.has(current))throw Error('repeated_cursor')
          cursors.add(current)
          const data=await v1(call,V1.topics.list,{query:{view:'all',limit:50,cursor:next??undefined}})
          if(!valid())return
          for(const topic of data.topics)if(!seen.has(topic.id)){seen.add(topic.id);items.push(topic)}
          next=data.nextCursor;paint()
        }while(next&&(exhaustive||!!search.value))
        loading=false;paint()
      }catch(error){
        if(!valid())return
        if(/401|403|404|unauthorized|forbidden/.test(String(error))){topics=[];detail=null;close();drawRow();return}
        loading=false;paint();notice.textContent='暂时读不到，重试';actions.append(button('重试',()=>{void load(!!search.value)}))
      }
    }
    search.oninput=()=>{paint();if(next)void load(true)}
    void load(false)
  }
  async function subscribe() {
    if (!alive || supported===false) return
    try {
      const data = await v1(call,V1.topics.subscribe,{query:{since:revision || undefined,wait_ms:25000}})
      if (!alive) return
      if (data.revision !== revision) { revision = data.revision; await refresh() }
      timer = setTimeout(() => { void subscribe() }, 250)
    } catch (error) { if (alive) { if (/401|403|unauthorized|forbidden/.test(String(error))) { topics=[];detail=null;close();drawRow() }; stale = true; if (selected) drawDetail(); timer = setTimeout(() => { void refresh(); void subscribe() },10000) } }
  }
  const escape = (/** @type {KeyboardEvent} */ event) => {
    if(panel.hidden)return
    if(event.key==='Escape'){event.preventDefault();close();return}
    if(event.key==='Tab'&&narrow.matches){
      const controls=[...panel.querySelectorAll('button,input,summary,[tabindex="0"]')].filter(el=>el.getClientRects().length)
      const first=/** @type {HTMLElement|undefined} */(controls[0]),last=/** @type {HTMLElement|undefined} */(controls.at(-1))
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel)){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
    }
  }
  root.addEventListener('keydown',escape)
  void refresh().then(()=>{if(supported!==false)void subscribe()})
  return {close,refresh,destroy() { alive = false; topics=[];detail=null;pendingOpen=null;panel.hidden=true; syncPanel(); visibility.disconnect(); narrow.removeEventListener('change',syncPanel); ticket++; listTicket++; clearTimeout(timer); root.removeEventListener('keydown',escape); row.remove(); panel.remove() }}
}

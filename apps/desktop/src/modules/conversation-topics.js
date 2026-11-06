// @ts-check
import { V1, v1 } from '../daemon-client.js'
import { escapeHtml } from '../view.js'

/** T4 reads never open a bubble. Only a deliberate owner selection writes.
 * @param {{root:HTMLElement,call:(method:any,path:string,body?:any)=>Promise<any>,openMatter:(id:string)=>unknown,locateMessage:(id:string,excerpt?:string)=>unknown,manage:()=>unknown}} deps */
export function mountConversationTopics({root,call,openMatter,locateMessage,manage}) {
  const row = document.createElement('nav'); row.className = 'conversation-topics'; row.ariaLabel = '最近话题'; row.hidden = true
  const panel = document.createElement('section'); panel.className = 'conversation-topic-panel'; panel.ariaLabel = '话题'; panel.hidden = true; panel.tabIndex = -1
  root.querySelector('.converse-compose')?.before(row)
  root.append(panel)
  /** @type {HTMLElement|null} */ let returnFocus = null
  let alive = true, selected = '', revision = '', ticket = 0, listTicket = 0, all = false, cursor = '', stale = false
  /** @type {any[]} */ let topics = []
  /** @type {any} */ let detail = null
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer
  const close = () => { all = false; selected = ''; ticket++; panel.hidden = true; root.classList.remove('has-topic'); drawRow(); returnFocus?.focus() }
  const button = (/** @type {string} */ label, /** @type {()=>unknown} */ action) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.onclick = action; return el
  }
  function drawRow() {
    row.replaceChildren(...topics.slice(0,6).map(t => {
      const b = button(t.title, () => { void open(t.id) }); b.setAttribute('aria-pressed', String(selected === t.id)); return b
    }))
    if (topics.length) row.append(button('更多话题', () => { all = true; selected = ''; cursor = ''; panel.hidden = false; root.classList.add('has-topic'); void listAll() }))
    row.hidden = !topics.length
  }
  async function refresh() {
    const generation = ++listTicket
    try {
      const data = await v1(call,V1.topics.list,{query:{view:'recent',limit:6}})
      if (!alive || generation !== listTicket) return
      if (!Array.isArray(data.topics) || typeof data.revision !== 'string') throw Error('invalid_topics')
      topics = data.topics; stale = false; drawRow()
      if (selected) await readDetail(selected)
    } catch (error) {
      if (!alive || generation !== listTicket) return
      stale = true
      if (/401|403|404|unauthorized|forbidden/.test(String(error))) { topics = []; detail = null; close(); drawRow(); return }
      // No data on an older daemon: conversation remains usable and no dead entry is advertised.
      if (detail && selected) drawDetail()
    }
  }
  async function readDetail(/** @type {string} */ id) {
    const generation = ++ticket
    try {
      const data = await v1(call,V1.topics.detail,{query:{id}})
      if (!alive || generation !== ticket || selected !== id) return
      detail = data; stale = false; drawDetail()
    } catch (error) {
      if (!alive || generation !== ticket) return
      if (/404|unauthorized|forbidden|not_found|401|403/.test(String(error))) { detail = null; close(); void refresh(); return }
      stale = true; drawDetail()
    }
  }
  async function open(/** @type {string} */ id) {
    returnFocus = /** @type {HTMLElement|null} */ (document.activeElement)
    all = false; selected = id; detail = null; cursor = ''; panel.hidden = false; root.classList.add('has-topic'); drawRow(); drawDetail(); panel.focus()
    const generation = ++ticket
    try {
      await v1(call,V1.topics.open,{body:{id,requestId:crypto.randomUUID()}})
      if (!alive || generation !== ticket || selected !== id) return
      await readDetail(id)
    } catch (error) { if (alive && generation === ticket) { if (/401|403|404|unauthorized|forbidden/.test(String(error))) { topics = []; detail = null; close(); drawRow() } else { stale = true; drawDetail() } } }
  }
  function drawDetail() {
    if (!selected) return
    panel.replaceChildren(button('收起', close))
    const h = document.createElement('h2'); h.id = 'conversation-topic-title'; panel.setAttribute('aria-labelledby',h.id); h.textContent = detail?.topic?.title ?? topics.find(t => t.id === selected)?.title ?? '话题'; panel.append(h)
    if (stale) { const note = document.createElement('p'); note.role = 'status'; note.textContent = '尚未同步 · 暂时读不到'; panel.append(note, button('重试', () => { void readDetail(selected) })) }
    if (!detail) { if (!stale) panel.append(document.createTextNode('正在读取…')); return }
    for (const text of [detail.topic.description, detail.topic.summary]) if (text) { const p = document.createElement('p'); p.textContent = text; panel.append(p) }
    let count = 0
    for (const [key,title] of /** @type {[string,string][]} */ ([['matters','相关事项'],['entries','CC 记得'],['messages','最近聊到']])) {
      const items = detail[key] ?? []; if (!items.length) continue
      count += items.length
      const heading = document.createElement('h3'); heading.textContent = title; panel.append(heading)
      for (const item of items) {
        if (key === 'matters') panel.append(button(`${item.state} · ${item.title}`, () => openMatter(item.id)))
        else if (key === 'messages') panel.append(button(`${item.speaker === 'owner' ? '你' : 'CC'} · ${item.ts} · ${item.excerpt}${item.source === 'episode' ? '（相关记录）' : ''}`, () => locateMessage(item.id,item.excerpt)))
        else {
          const disclosure = document.createElement('details')
          disclosure.innerHTML = `<summary>${escapeHtml(item.line)}${item.recalled && item.status === 'live' ? ' · 这次想起' : ''}</summary><p>${escapeHtml(item.body)}</p><small>${escapeHtml(item.source)} · ${escapeHtml(item.updatedTs)}</small>`
          panel.append(disclosure)
        }
      }
      const page = detail.pages?.[key]
      if (page?.nextCursor) panel.append(button(`更多${title}（${page.total}）`, () => { void more(key,page.nextCursor) }))
    }
    if (!count) panel.append(document.createTextNode('还没有记下内容'))
    panel.append(button('记忆管理与纠错', manage))
  }
  async function more(/** @type {string} */ section, /** @type {string} */ nextCursor) {
    const id = selected, generation = ticket
    try {
      const data = await v1(call,V1.topics.detail,{query:{id,section,cursor:nextCursor}})
      if (!alive || selected !== id || generation !== ticket) return
      const seen = new Set(detail[section].map((/** @type {any} */ item) => item.id))
      detail[section].push(...data[section].filter((/** @type {any} */ item) => !seen.has(item.id)))
      detail.pages[section] = data.pages[section]; drawDetail()
    } catch { stale = true; drawDetail() }
  }
  async function listAll() {
    const generation = ++ticket
    panel.replaceChildren(button('返回对话', close))
    try {
      const data = await v1(call,V1.topics.list,{query:{view:'all',limit:50,cursor:cursor || undefined}})
      if (!alive || !all || generation !== ticket) return
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索话题'; search.ariaLabel = '搜索话题'; panel.append(search)
      const results = document.createElement('div'); panel.append(results)
      const paint = () => results.replaceChildren(...data.topics.filter((/** @type {any} */ topic) => topic.title.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).map((/** @type {any} */ topic) => button(topic.title, () => { void open(topic.id) })))
      search.oninput = paint; paint()
      if (data.nextCursor) panel.append(button('更多', () => { cursor = data.nextCursor; void listAll() }))
      if (!data.topics.length) panel.append(document.createTextNode('还没有记下内容'))
    } catch { if (alive && generation === ticket) panel.append(document.createTextNode('暂时读不到，重试'),button('重试', () => { void listAll() })) }
  }
  async function subscribe() {
    if (!alive) return
    try {
      const data = await v1(call,V1.topics.subscribe,{query:{since:revision || undefined,wait_ms:25000}})
      if (!alive) return
      if (data.revision !== revision) { revision = data.revision; await refresh() }
      timer = setTimeout(() => { void subscribe() }, 250)
    } catch (error) { if (alive) { if (/401|403|unauthorized|forbidden/.test(String(error))) { topics=[];detail=null;close();drawRow() }; stale = true; if (selected) drawDetail(); timer = setTimeout(() => { void refresh(); void subscribe() },10000) } }
  }
  const escape = (/** @type {KeyboardEvent} */ event) => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close() } }
  root.addEventListener('keydown',escape)
  void refresh(); void subscribe()
  return {close,refresh,destroy() { alive = false; ticket++; listTicket++; clearTimeout(timer); root.removeEventListener('keydown',escape); row.remove(); panel.remove() }}
}

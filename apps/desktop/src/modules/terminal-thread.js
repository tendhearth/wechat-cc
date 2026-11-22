// @ts-check
import { executorName } from './executor-names.js'
import { V1, v1 } from '../daemon-client.js'
import { createAgentAvatars } from '../shared/agent-avatars.js'
import { bindTerminalDraft } from './conversation-work-detail.js'
import { deskSpeakerHtml } from './desk-page.js'
import { paintConversation, rememberConversationPosition, showConversationLatest, syncConversationLatest } from './converse-reading.js'
import { escapeWorkbenchHtml as esc, renderWorkbenchMarkdown, renderWorkbenchUserText, captureUserSources, restoreUserSources } from './workbench-markdown.js'
import { recapMemoHtml, sketchRecap } from './recap-memo.js'
import { groupActivity, mergeActivity, terminalInputReason } from './thing-thread-model.js'

const { agentAvatarsHtml } = createAgentAvatars()
/** @typedef {import('./thing-thread-model.js').Activity} Activity */
/** @typedef {import('./thing-thread-model.js').Session} Session */
/** @typedef {import('./thing-thread-model.js').Place} Place */
/** @typedef {Omit<import('./converse.js').ConverseMsg,'id'|'role'> & {id:string,role:string} & {steps?:Activity[],running?:boolean,recap?:import('@wechat-cc/protocol').SessionRecapT}} ThreadRow */
/** @typedef {(method:any,path:string,body?:any)=>Promise<any>} Call */

/** @param {Element} element @param {string} value */
function setText(element, value) {
  if (element.textContent === value) return
  const child = element.firstChild
  if (child?.nodeType === Node.TEXT_NODE && !child.nextSibling) child.nodeValue = value
  else element.textContent = value
}

/** @param {Element} label @param {Activity} item */
function updateStepLabel(label, item) {
  const target = item.target
  if (!target || target === item.text || !item.text.endsWith(` ${target}`)) {
    if (label.lastElementChild) label.textContent = item.text
    else setText(label, item.text)
    return
  }
  if (label.lastElementChild?.matches('code') && label.textContent === item.text) return
  const code = document.createElement('code')
  code.textContent = target
  label.replaceChildren(item.text.slice(0, -target.length), code)
}

/** @param {Element} row @param {ThreadRow} message */
function updateSteps(row, message) {
  if (!message.steps) return false
  const list = row.querySelector('ol')
  if (!list) return false
  setText(/** @type {Element} */ (row.querySelector('.thing-step-summary')), message.text)
  const peek = /** @type {HTMLElement} */ (row.querySelector('.thing-step-peek'))
  peek.hidden = !message.running
  setText(peek, message.running ? message.steps.at(-1)?.text ?? '' : '')
  const existing = new Map([...list.children].map(node => [node.getAttribute('data-step-id'), node]))
  let cursor = list.firstElementChild
  for (const item of message.steps) {
    const node = existing.get(item.id) ?? document.createElement('li')
    node.setAttribute('data-step-id', item.id)
    node.toggleAttribute('data-error', !!item.error)
    if (!node.firstElementChild || !!node.querySelector('details') !== !!item.detail) {
      node.innerHTML = item.detail ? '<details><summary></summary><pre></pre></details>' : '<span></span>'
    }
    updateStepLabel(/** @type {Element} */ (node.querySelector('summary') ?? node.firstElementChild), item)
    if (item.detail) setText(/** @type {Element} */ (node.querySelector('pre')), item.detail)
    if (node !== cursor) list.insertBefore(node, cursor)
    cursor = node.nextElementSibling
    existing.delete(item.id)
  }
  for (const node of existing.values()) node.remove()
  return true
}

/** @param {{host:HTMLElement,call:Call,id:string,agent:string,place:()=>Place,ended:()=>boolean,onStatus:(name:string,status:string)=>void,onWaiting:(request:string|null)=>void}} options */
export function mountTerminalThread({host, call, id, agent, place, ended, onStatus, onWaiting}) {
  host.innerHTML = `<div class="converse-scroll thing-scroll"><button type="button" class="converse-earlier" data-converse-lead hidden>更早的</button></div>
    <button type="button" class="converse-latest" hidden>有新回复 · 回到最新</button>
    <div class="desk-waiting thing-waiting" hidden><div class="desk-waiting-row">${deskSpeakerHtml('cc')}<div class="desk-waiting-card">
      <div class="desk-waiting-label">这件要你定</div><div class="desk-waiting-question"></div>
      <div class="desk-waiting-opinion" hidden></div><div class="desk-waiting-reason" hidden></div>
      <div class="place-ask"><button type="button" class="place-allow" data-place-decision="allow">允许</button><button type="button" data-place-decision="deny">不允许</button></div>
    </div></div></div>
    <div class="thing-compose-status"><span role="status"></span><button class="desk-text-button" type="button" hidden>停止这一轮</button></div>
    <p class="thing-ended-note" hidden>这次会话已经结束了，只能看。</p>
    <form class="converse-compose thing-compose">${deskSpeakerHtml('user')}<span class="converse-recipient"></span>
      <textarea rows="1" maxlength="4000" data-terminal-input disabled></textarea><button type="submit" aria-label="发送" disabled>↑</button></form>`
  /** @template {Element} T @param {string} selector @returns {T} */
  const find = selector => /** @type {T} */ (host.querySelector(selector))
  const scroll = /** @type {HTMLElement} */ (find('.thing-scroll'))
  const earlier = /** @type {HTMLButtonElement} */ (find('[data-converse-lead]'))
  const latest = /** @type {HTMLButtonElement} */ (find('.converse-latest'))
  const card = /** @type {HTMLElement} */ (find('.thing-waiting'))
  const form = /** @type {HTMLFormElement} */ (find('form'))
  const input = /** @type {HTMLTextAreaElement} */ (find('textarea'))
  const send = /** @type {HTMLButtonElement} */ (find('[type=submit]'))
  const stop = /** @type {HTMLButtonElement} */ (find('.thing-compose-status button'))
  const note = find('.thing-compose-status [role=status]')
  const recipient = find('.converse-recipient')
  const endedNote = /** @type {HTMLElement} */ (find('.thing-ended-note'))
  const saveDraft = bindTerminalDraft(id, input)
  /** @type {Activity[]} */ let items = []
  /** @type {Session|null} */ let session = null
  /** @type {string|null|undefined} */ let before
  /** @type {Map<string,string>} */ let stepKeys = new Map()
  /** @type {{text:string,sentAt:number,after:Set<string>,receipt?:string}|null} */ let outgoing = null
  let alive = true, polling = false, paging = false, sending = false, deciding = false, stopping = false
  let confirmed = '', answered = '', lastRecipient = '', loaded = false
  const wide = window.matchMedia('(min-width: 900px)')
  /** @type {import('@wechat-cc/protocol').SessionRecapT|undefined} */ let recap
  /** @type {HTMLElement|null} */ let memo = null
  let dismissedAt = -1, recapVersion = 0, archiveLoaded = false
  const redrawFrame = () => { if (memo) sketchRecap(memo, id) }
  const memoSize = typeof ResizeObserver === 'function' ? new ResizeObserver(redrawFrame) : null
  const fonts = document.fonts
  fonts?.addEventListener?.('loadingdone', redrawFrame)
  const resized = () => { reflect(); draw(); void refresh() }
  wide.addEventListener('change', resized)
  let empty = '正在读取…'
  const isVisible = () => document.visibilityState === 'visible' && !host.closest('[hidden], [inert]')
  const name = () => session?.displayName || executorName(session?.source || agent) || '终端'
  const readOnly = () => wide.matches && (ended() || session?.status === 'ended')
  const pending = () => !readOnly() && session?.pending?.actionable && session.pending.hash !== answered ? session.pending : null

  function reflect() {
    const who = name()
    const locked = readOnly()
    endedNote.hidden = !locked
    if (locked) {
      form.remove()
      setText(note, '')
    } else if (!form.isConnected) host.append(form)
    const request = pending()
    const waiting = place().waiting
    const matched = request?.hash && waiting?.requestId === request.hash && (!waiting.sessionId || waiting.sessionId === id)
    const opinion = find('.desk-waiting-opinion'), reason = find('.desk-waiting-reason')
    const question = find('.desk-waiting-question')
    const restore = rememberConversationPosition(scroll)
    card.hidden = !request
    setText(question, request ? [request.tool, request.summary].filter(Boolean).join(' · ') : '')
    const ccOpinion = matched ? waiting?.ccOpinion : ''
    const questionReason = matched ? waiting?.questionReason : ''
    opinion.toggleAttribute('hidden', !ccOpinion)
    reason.toggleAttribute('hidden', !questionReason)
    setText(opinion, ccOpinion ? `我的意见(只看了这条请求)：${ccOpinion}` : '')
    setText(reason, questionReason ? `为什么来问你：${questionReason}` : '')
    onWaiting(request?.hash ?? (answered || null))
    const stopped = document.documentElement.hasAttribute('data-desk-cc-stopped')
    for (const button of card.querySelectorAll('button')) {
      button.disabled = deciding || stopped
      if (stopped) button.title = 'CC 没在运行'
      else button.removeAttribute('title')
    }
    const state = session?.status
    if (locked || session || loaded) onStatus(who, locked ? '已经结束' : request || (state === 'waiting' && !answered) ? '等你定'
      : (!wide.matches && (!session || session.stale)) || state === 'ended' ? '已经结束' : state === 'running' ? '正在做' : '停着')
    const target = agentAvatarsHtml([session?.source || agent]) + ' ' + esc(who) + ' ›'
    if (lastRecipient !== target) { recipient.innerHTML = target; lastRecipient = target }
    const blocked = !session && !loaded ? '正在读取…' : terminalInputReason(session, who, !!request, wide.matches)
    input.disabled = locked || !!blocked
    input.ariaLabel = `对 ${who} 说`
    input.placeholder = stopped ? 'CC 没在运行' : blocked || `接着对 ${who} 说…`
    send.disabled = stopped || !!blocked || sending || !!outgoing || !input.value.trim()
    stop.hidden = locked || !session?.run_id
    stop.disabled = stopping
    setText(stop, confirmed && confirmed === session?.run_id ? '再点一次，确认停止' : '停止这一轮')
    restore()
  }

  /** @param {boolean} prepend */
  function draw(prepend = false) {
    const groups = groupActivity(items)
    const keys = new Map()
    /** @type {ThreadRow[]} */ const rows = groups.map((group, index) => {
      const item = group[0]
      const steps = item.kind === 'step' ? group : undefined
      if (steps) {
        const key = steps.map(step => stepKeys.get(step.id)).find(Boolean) ?? item.id
        for (const step of steps) keys.set(step.id, key)
        const running = !readOnly() && session?.status === 'running' && index === groups.length - 1 && !outgoing
        return { id:key, role:'step', text:running ? `正在做，已经 ${steps.length} 步` : `做了 ${steps.length} 步`, steps, running, at:item.at ?? steps.find(step => step.at != null)?.at ?? undefined }
      }
      return {id:item.id, role:item.kind === 'you' ? 'user' : 'cc', text:item.full ?? item.text, at:item.at ?? undefined}
    })
    stepKeys = keys
    if (outgoing && !readOnly()) rows.push({id:'pending', role:'user', text:outgoing.text, at:outgoing.sentAt, pending:true})
    if (recap && !readOnly() && wide.matches && recap.at > dismissedAt && !sending && !deciding) {
      rows.push({ id: 'session-recap', role: 'recap', text: recap.text, recap })
    }
    const restore = prepend ? rememberConversationPosition(scroll) : null
    earlier.hidden = !before
    paintConversation(scroll, rows, render, `<p class="empty-state">${esc(empty)}</p>`, {
      latest, prepend, decoration: row => {
        if (row.recap) return row.recap
        const {steps, running} = /** @type {ThreadRow} */ (row)
        return steps ? [steps, running] : session?.source || agent
      },
      update: (node,row) => {
        if (row.recap) return false
        const selection = node.ownerDocument.getSelection()
        if (selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) return 'defer'
        if (updateSteps(node, row)) return true
        if (node.contains(node.ownerDocument.activeElement)) return 'defer'
        // Retain the reading position inside code blocks when the daemon expands a reply in place.
        const horizontal = [...node.querySelectorAll('pre')].map(pre => pre.scrollLeft)
        const openSources = captureUserSources(node)
        node.innerHTML = speechHtml(row)
        restoreUserSources(node,openSources)
        node.querySelectorAll('pre').forEach((pre,index)=>{pre.scrollLeft = horizontal[index] ?? 0})
        return true
      },
    })
    const nextMemo = /** @type {HTMLElement|null} */ (scroll.querySelector('.thing-recap'))
    if (nextMemo !== memo) {
      memoSize?.disconnect()
      memo = nextMemo
      if (memo) { redrawFrame(); memoSize?.observe(memo) }
    }
    if (restore) restore()
  }

  /** @param {ThreadRow} row */
  function render(row) {
    if (row.recap) return recapMemoHtml(row.recap)
    if (row.steps) {
      const shell = document.createElement('div')
      shell.className = 'thing-steps'
      shell.innerHTML = '<details><summary class="thing-step-summary"></summary><ol></ol></details><p class="thing-step-peek"></p>'
      updateSteps(shell, row)
      return shell.outerHTML
    }
    const who = row.role === 'user' ? 'user' : 'cc'
    return `<div class="converse-msg converse-msg-${who}"${row.pending ? ' data-sending' : ''}>${speechHtml(row)}</div>`
  }

  /** @param {ThreadRow} row */
  function speechHtml(row) {
    const you = row.role === 'user'
    const avatar = you ? deskSpeakerHtml('user') : `<span class="desk-speaker">${agentAvatarsHtml([session?.source || agent])}</span>`
    const body = you ? renderWorkbenchUserText(row.text, String(row.id)) : renderWorkbenchMarkdown(row.text)
    return `<span class="converse-speaker">${avatar}</span><div class="converse-cc-body">
      <div class="converse-bubble${you ? '' : ' cc-readable-markdown wb-markdown'}">${body}</div></div>`
  }

  /** @param {string} [cursor] */
  const read = cursor => v1(call, V1.cli.activity, {query:{session_id:id,full:1,limit:40,...(cursor ? {before:cursor} : {})}})
  /** @param {any} page @returns {Activity[]} */
  const stepsIn = page => (page.items ?? []).filter((/** @type {Activity} */ step) => typeof step.id === 'string')

  function returnDraft() {
    if (!outgoing) return
    input.value = input.value ? outgoing.text + '\n' + input.value : outgoing.text
    saveDraft()
    outgoing = null
    setText(note, '没送成，请重试')
  }

  async function refresh() {
    if (!alive || polling || !isVisible()) return
    polling = true
    const version = recapVersion
    const archived = readOnly()
    try {
      const [sessions, activity] = await Promise.allSettled([
        archived ? Promise.resolve(null) : v1(call,V1.cli.sessions,{query:{owner:1,session_id:id}}), read(),
      ])
      if (!alive) return
      if (sessions.status === 'fulfilled' && sessions.value) {
        session = sessions.value.sessions?.find((/** @type {Session} */ entry) => entry.session_id === id) ?? null
        loaded = true
        if (session?.pending?.hash && session.pending.hash !== answered) answered = ''
        const receipt = session?.last_say
        if (outgoing?.receipt && receipt?.id === outgoing.receipt && receipt?.state === 'failed') returnDraft()
      }
      if (activity.status === 'fulfilled') {
        const page = activity.value
        if (version === recapVersion) recap = wide.matches && page.recap?.text ? page.recap : undefined
        let fresh = stepsIn(page)
        const known = new Set(items.map(item => item.id))
        // If more than a page arrived between polls, bridge to the last known page.
        let cursor = page.earlier
        while (known.size && fresh.length && !fresh.some(item => known.has(item.id)) && cursor) {
          const bridge = await read(cursor)
          if (!alive) return
          fresh = mergeActivity(fresh, stepsIn(bridge), 'earlier')
          if (bridge.earlier === cursor) break
          cursor = bridge.earlier
        }
        if (before === undefined || !items.length || (archived && !archiveLoaded && !before)) before = page.earlier ?? null
        archiveLoaded = archived
        if (outgoing) {
          const {after, text, sentAt} = outgoing
          const newestKnown = fresh.findLastIndex(step => after.has(step.id))
          if (fresh.slice(newestKnown + 1).some(step => step.kind === 'you' && !after.has(step.id)
            && (step.at == null || step.at >= sentAt - 1000) && (step.full ?? step.text).trim() === text)) outgoing = null
        }
        items = mergeActivity(items, fresh, 'latest')
        empty = '这次会话还没有内容。'
      } else {
        // A session without a readable transcript answers 200 only while it has a recap.
        if (version === recapVersion && /no_transcript/.test(String(activity.reason?.message))) recap = undefined
        if (!items.length) empty = '这次会话还没有内容。'
      }
      if (!readOnly() && (sessions.status === 'rejected' || (activity.status === 'rejected'
        && !/no_transcript|cli_session_remote/.test(String(activity.reason?.message))))) {
        if (!note.textContent) setText(note, '尚未同步，请重试')
      } else if (note.textContent === '尚未同步，请重试') setText(note, '')
    } catch {
      if (alive && !readOnly()) setText(note, '尚未同步，请重试')
    } finally {
      polling = false
      if (alive) { reflect(); draw() }
    }
  }

  earlier.onclick = async () => {
    if (!before || paging) return
    const cursor = before
    paging = earlier.disabled = true
    try {
      const page = await read(cursor)
      if (!alive) return
      items = mergeActivity(items, stepsIn(page), 'earlier')
      before = page.earlier ?? null
      draw(true)
    } catch { if (alive && !readOnly()) setText(note, '尚未同步，请重试') }
    finally { paging = earlier.disabled = false }
  }
  scroll.addEventListener('scroll', () => syncConversationLatest(scroll, latest))
  latest.onclick = () => showConversationLatest(scroll, latest)
  input.addEventListener('input', reflect)
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      form.requestSubmit()
    }
  })
  form.onsubmit = async event => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text || send.disabled || readOnly()) return
    const message = {text, sentAt:Date.now(), after:new Set(items.map(item => item.id))}
    outgoing = message
    sending = true
    input.value = ''
    saveDraft()
    setText(note, '')
    reflect()
    draw()
    try {
      const result = await v1(call,V1.cli.sessionSay,{body:{session_id:id,text}})
      dismissedAt = Date.now()
      if (outgoing === message) Object.assign(outgoing,{receipt:result.say_id})
    } catch {
      if (alive && outgoing === message) returnDraft()
    } finally {
      sending = false
      if (alive) { reflect(); draw(); void refresh() }
    }
  }
  card.onclick = async event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    const hash = pending()?.hash
    if (!button || button.disabled || !hash || deciding) return
    deciding = true
    reflect()
    draw()
    try {
      await v1(call,V1.cli.decide,{body:{session_id:id,hash,decision:button.dataset.placeDecision}})
      if (!alive) return
      answered = hash
      dismissedAt = Date.now()
      setText(note, '')
    } catch { if (alive && !readOnly()) setText(note, '尚未同步，请重试') }
    finally { deciding = false; if (alive) { reflect(); draw(); void refresh() } }
  }
  stop.onclick = async () => {
    const run = session?.run_id
    if (!run || stopping) return
    if (confirmed !== run) { confirmed = run; reflect(); return }
    stopping = true
    reflect()
    try {
      await v1(call,V1.cli.stop,{body:{session_id:id,run_id:run,confirmed:true}})
      confirmed = ''
    } catch { if (alive) setText(note, '这一轮已经结束或换了一轮，请刷新') }
    finally { stopping = false; if (alive) { reflect(); void refresh() } }
  }
  reflect()
  draw()
  void refresh()
  const timer = window.setInterval(refresh, 3000)
  document.addEventListener('visibilitychange', refresh)
  document.addEventListener('desk-cc-availability', reflect)
  return {
    reflect() { reflect(); if (readOnly()) draw() },
    refresh,
    refreshRecap() {
      recapVersion++
      recap = undefined
      draw()
      void refresh()
    },
    destroy() {
      alive = false
      saveDraft()
      memoSize?.disconnect()
      fonts?.removeEventListener?.('loadingdone', redrawFrame)
      wide.removeEventListener('change', resized)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      document.removeEventListener('desk-cc-availability', reflect)
    },
  }
}

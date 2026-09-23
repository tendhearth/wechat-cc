import { icon } from '../../src/modules/icons.js'
import { createState, projects } from './state.js'

const state = createState()
const root = document.querySelector('#app')
const dialog = document.querySelector('#detail-dialog')
let page = 'home'
let projectFilter = null
let drawer = false
let noticeTimer
let dialogTrigger
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const i = name => icon(name, { size: 19 })
const mascot = size => `<img class="mascot ${size}" src="../../src/assets/pet/cc-v1/canonical/lit/front.png" alt="CC">`
const project = id => projects.find(p => p.id === state.tasks[id]?.project)
const label = id => id === 'home' ? '和 CC 聊聊' : `${project(id).name} / ${state.tasks[id].title}`
const button = (action, text, cls = '', attrs = '') => `<button class="${cls}" data-action="${action}" ${attrs}>${text}</button>`

function nav() {
  return `<aside class="navigation"><a class="brand" href="#home" data-action="home">CC<span>和你，一起把生活过好</span></a>
    <nav aria-label="主导航">${button('home', `${i('heart-check')}此刻`, page === 'home' || page === 'chat' ? 'selected' : '')}${button('things', `${i('archive')}我们的事`, page === 'things' || page === 'task' ? 'selected' : '')}${button('keeps', `${i('star')}留下的东西`, page === 'keeps' ? 'selected' : '')}</nav>
    <div class="project-nav"><span class="eyebrow">项目</span>${projects.map(p => `<div class="project-group">${button('project', `<span class="dot ${p.color}"></span>${p.name}`, projectFilter === p.id ? 'project-active' : '', `data-project="${p.id}"`)}${Object.entries(state.tasks).filter(([,t]) => t.project === p.id).map(([id,t]) => button('task', `<span>${t.title}</span><small>${state.scopes[id].paused ? '已暂停' : t.status}</small>`, `task-link ${state.active === id && page === 'task' ? 'selected' : ''}`, `data-id="${id}" ${state.active === id ? 'aria-current="page"' : ''}`)).join('')}</div>`).join('')}</div>
    <footer>${button('chat', `${i('heart-check')}回到 CC 身边`)}${button('devices', `${i('wifi-02')}设备与连接`)}<small>当前为演示环境</small></footer></aside>`
}
function row(id) {
  const t = state.tasks[id], p = project(id)
  return button('task', `<span class="row-symbol ${p.color}">${i(t.project === 'life' ? 'heart-check' : 'archive')}</span><span class="row-copy"><small>${p.name} / ${t.title}</small><strong>${id === 'talk' ? '讲稿和配图准备好了' : id === 'login' ? '正在核对最后两项测试' : t.heading}</strong></span><span class="row-status">${state.scopes[id].paused ? '已暂停' : t.status} <span aria-hidden="true">↗</span></span>`, 'task-row', `data-id="${id}"`)
}
function messages(id) {
  return `<div class="messages" aria-label="${esc(label(id))}的演示对话">${state.scopes[id].messages.map(m => `<article class="message ${m.role}"><small>${m.role === 'user' ? '你' : 'CC · 演示回复'}</small><p>${esc(m.text)}</p>${m.files.map(f => `<span class="file-chip">${i('attachment')}${esc(f)}</span>`).join('')}</article>`).join('')}</div>`
}
function composer(id) {
  const s = state.scopes[id]
  return `<section class="composer-wrap"><div class="scope-line"><span class="scope-chip">${esc(label(id))}</span><small>${id === 'home' ? '聊天不会自动加入项目' : '这件事有自己的草稿与记录'}</small></div><form id="composer" data-scope="${id}"><div class="attachment-list">${s.files.map((f,index) => `<span class="file-chip">${esc(f)} ${button('remove-file','×','',`data-index="${index}" aria-label="移除附件 ${esc(f)}" type="button"`)}</span>`).join('')}</div><div class="input-line">${button('attach', i('attachment'), 'icon-button', 'type="button" aria-label="添加演示附件（只保留文件名）"')}<textarea rows="1" maxlength="6000" aria-label="${esc(label(id))}输入" placeholder="${id === 'home' ? '说说现在的想法，或把一件事交给我…' : '补充这件事，或告诉 CC 下一步…'}">${esc(s.draft)}</textarea><button class="send" type="submit" aria-label="发送演示消息" ${!s.draft.trim() && !s.files.length ? 'disabled' : ''}>↑</button></div><input id="files" type="file" multiple hidden></form><small class="composer-note">仅在本页演示 · 附件只记录名称，不读取或上传内容</small></section>`
}
function home() {
  const chatting = page === 'chat'
  return `<header class="page-header"><span>此刻</span>${chatting ? button('home','看看近况','text-button') : '<span class="subtle">事情有人照看，你可以慢一点。</span>'}</header><div class="content home-content"><section class="greeting ${chatting ? 'chat-greeting' : ''}">${mascot('hero')}<div><p class="eyebrow">${chatting ? '这一会儿，留给你' : 'CC 在这儿'}</p><h1>${chatting ? '想说什么都可以。' : '回来了。先缓一口气。'}</h1><p>${chatting ? '可以说说今天，也可以安静地待一会儿。' : '两件事还在继续，有结果我会告诉你。'}</p>${chatting ? '' : button('chat','陪我聊一会儿 <span>→</span>','warm-link')}</div></section>${chatting ? '' : `<section class="updates" aria-label="近况">${['talk','login','walk'].map(row).join('')}</section>`}${messages('home')}</div>${composer('home')}`
}
function task() {
  const id = state.active, t = state.tasks[id], s = state.scopes[id]
  return `<header class="page-header"><span>${esc(label(id))}</span>${button('process', `${i('time-02')}看看过程`, 'quiet-button', `aria-expanded="${drawer}" aria-controls="process"`)}</header><div class="content task-content"><h1>${t.heading}</h1><p class="intro">材料、对话和改动，留在这件事里。</p><div class="cc-update">${mascot('tiny')}<p>${s.paused ? '这件事先放一放，已有内容都还在。' : t.summary}</p><span class="dot ${s.paused ? 'neutral' : 'sage'}"></span></div><article class="artifact"><div class="eyebrow">${i('archive')}当前成果 · 样例</div><h2>${t.artifact}</h2><ul>${t.items.map(x => `<li>${i('checkmark-circle-02')}<span>${x}</span></li>`).join('')}</ul><p class="finding">${t.detail}</p><footer><span>${i('attachment')}项目材料 · 独立保存</span>${button('artifact','打开成果 →','primary')}</footer></article>${messages(id)}</div>${composer(id)}`
}
function listing() {
  const ids = Object.keys(state.tasks).filter(id => !projectFilter || state.tasks[id].project === projectFilter)
  const keeps = page === 'keeps'
  return `<header class="page-header"><span>${keeps ? '留下的东西' : '我们的事'}</span>${projectFilter ? button('things','全部项目','text-button') : ''}</header><div class="content listing"><p class="eyebrow">${keeps ? '结果和回忆，都有地方放' : '一件一件，慢慢来'}</p><h1>${keeps ? '一起留下的东西。' : projectFilter ? projects.find(p => p.id === projectFilter).name : '交给 CC 的事，都在这里。'}</h1><p class="intro">${keeps ? '打开一份成果，回到它所属的事情。' : '每件事独立保存进度，切换不会带走另一件事的草稿。'}</p><section class="updates">${(keeps ? ['talk','login','walk'] : ids).map(row).join('')}</section></div>`
}
function process() {
  const t = state.tasks[state.active], paused = state.scopes[state.active].paused
  const entries = state.active === 'login' ? [['Codex','完成第一版','14:20','改动对应原会话中的第一轮执行。'],['Claude','复核完成','14:23','指出登录过期的边界问题。'],['CC','交接意见','14:24','将复核意见与对应版本交给 Codex。'],['Codex',paused ? '已暂停' : '正在修正','14:25','沿原会话继续处理。']] : [['CC','整理这件事','14:20','仅使用本项目的样例材料。'],[t.helper,paused ? '已暂停' : t.status,'14:23','这条记录只属于当前事情。']]
  return `<aside id="process" class="process"><header><h2>处理过程</h2>${button('process',i('cancel-01'),'icon-button','aria-label="关闭处理过程"')}</header><p class="subtle">${esc(label(state.active))}</p><span class="demo-tag">以下过程与原会话均为样例</span><ol>${entries.map(([name,status,time,text],index) => `<li class="${index === entries.length-1 ? 'active-step' : ''}"><small>${time}</small><strong>${name} · ${status}</strong><p>${text}</p>${index === entries.length-1 ? button('source','由 CC 代为发送 · 查看原会话 ↗','source-link') : ''}</li>`).join('')}</ol><footer>${button('pause',`${i(paused ? 'play' : 'stop')}${paused ? '继续演示' : '暂停演示'}`,'quiet-button')}${button('focus','补充要求','text-button')}</footer></aside>`
}
function render() {
  root.className = drawer && page === 'task' ? 'with-process' : ''
  root.innerHTML = `${nav()}<main>${page === 'home' || page === 'chat' ? home() : page === 'task' ? task() : listing()}</main>${drawer && page === 'task' ? process() : ''}`
}
function navigate(next, id) {
  page = next; drawer = false
  state.select(next === 'task' ? id : 'home')
  render()
}
function notify(text) {
  const el = document.querySelector('#notice'); el.textContent = text
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { el.textContent = '' }, 4200)
}
function showDialog(title, body) {
  dialogTrigger = document.activeElement
  document.querySelector('#dialog-content').innerHTML = `<p class="eyebrow">交互样板 · 非真实数据</p><h2>${esc(title)}</h2>${body}`
  dialog.showModal()
}
root.addEventListener('click', event => {
  const b = event.target.closest('[data-action]'); if (!b) return
  const action = b.dataset.action
  if (action === 'home' || action === 'chat') { event.preventDefault(); projectFilter = null; navigate(action); if (action === 'chat') root.querySelector('textarea').focus() }
  if (action === 'things' || action === 'keeps') { projectFilter = null; navigate(action) }
  if (action === 'project') { projectFilter = b.dataset.project; navigate('things') }
  if (action === 'task') { projectFilter = state.tasks[b.dataset.id].project; navigate('task', b.dataset.id) }
  if (action === 'process') { drawer = !drawer; render(); root.querySelector(drawer ? '[aria-label="关闭处理过程"]' : '[data-action="process"]').focus() }
  if (action === 'focus') root.querySelector('textarea').focus()
  if (action === 'pause') { state.togglePause(state.active); render(); notify('只改变当前事情的演示状态，没有控制真实进程。') }
  if (action === 'attach') root.querySelector('#files').click()
  if (action === 'remove-file') { state.scopes[state.active].files.splice(Number(b.dataset.index),1); render() }
  if (action === 'devices') showDialog('设备与连接', '<p>样例中有“这台电脑”和“家里的电脑”。此页未检测或连接任何设备、账号及模型。</p><p>正式接入会分别说明：可查看进展、可继续会话，或只能在原应用打开。</p>')
  if (action === 'artifact') { const t = state.tasks[state.active]; showDialog(t.artifact, `<p class="scope-chip">${esc(label(state.active))}</p><div class="document-preview">${t.items.map((x,n) => `<h3>${n+1}. ${x}</h3><p>${state.active === 'talk' ? ['今天想分享的，是一个让日常少一点忙乱的小尝试。','从一件具体的小事开始，留意它真正让人费力的地方。','不急着给出全部答案。先试一小步，再一起看看结果。'][n] : `${x}是这份样例的第 ${n+1} 个要点。这里展示成果阅读方式，未读取真实项目文件。`}</p>`).join('')}</div>`) }
  if (action === 'source') { const t = state.tasks[state.active]; showDialog('原会话记录 · 样例', `<p class="scope-chip">${esc(label(state.active))}</p><p>关联会话：${t.session}</p><div class="transcript"><small>你 · 原始要求</small><p>${esc(t.heading)}</p><small>CC · 代为发送的执行要求</small><p>请结合这件事的复核意见继续，只处理当前项目的对应改动。完成后返回结果与核对依据。</p><small>${t.helper} · 样例回复</small><p>收到，我会继续核对。</p></div><p class="subtle">真实会话接入尚未实现；这不是读取到的 Codex 或 Claude 历史。</p>`) }
})
root.addEventListener('input', event => {
  if (event.target.matches('textarea')) { const id = event.target.closest('form').dataset.scope; state.setDraft(id,event.target.value); root.querySelector('.send').disabled = !event.target.value.trim() && !state.scopes[id].files.length }
})
root.addEventListener('change', event => {
  if (event.target.id === 'files') { const id = event.target.closest('form').dataset.scope; state.addFiles(id,Array.from(event.target.files, f => f.name)); render() }
})
root.addEventListener('submit', event => {
  event.preventDefault()
  const id = event.target.dataset.scope, sent = state.submit(id); if (!sent) return
  if (id === 'home') page = 'chat'
  render(); root.querySelector('textarea').focus()
  const content = root.querySelector('.content'); content.scrollTop = content.scrollHeight
  setTimeout(() => {
    state.reply(sent.scope, id === 'home' ? '我在听。这条消息留在你和 CC 的聊天里，不会送入任何项目。（演示回复）' : `这句补充已留在「${label(sent.scope)}」。切换到别的事情，也不会把它带过去。（演示回复，未调用模型）`)
    if (state.active === sent.scope && ['task','chat','home'].includes(page)) {
      // Update only the conversation so an in-progress draft keeps focus and selection.
      const area = root.querySelector('.messages'); area.outerHTML = messages(sent.scope)
      const content = root.querySelector('.content'); content.scrollTop = content.scrollHeight
    } else notify(`「${label(sent.scope)}」有一条演示回复，已保留在原处。`)
  }, 1400)
})
root.addEventListener('keydown', event => {
  if (event.target.matches('textarea') && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); event.target.closest('form').requestSubmit() }
  if (event.key === 'Escape' && drawer && !dialog.open) { drawer = false; render(); root.querySelector('[data-action="process"]').focus() }
})
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close())
dialog.addEventListener('close', () => { if (dialogTrigger?.isConnected) dialogTrigger.focus() })
render()

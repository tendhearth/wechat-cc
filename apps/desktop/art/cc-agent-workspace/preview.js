import { projects, labels } from './fixtures.js'
import { createStore, descendants, overallStatus, requestStop, acknowledgeStops, decidePermission, handoffRecord, artifactSummary } from './model.js'

const store = createStore()
const app = document.querySelector('#app')
const modal = document.querySelector('#modal')
let lastFocus, toastTimer, modalAction = null, renderedState = null
if (matchMedia('(max-width:1150px)').matches) store.current().panel = false
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const paths = {
  home:'<path d="m3 9 7-6 7 6v8H3zM8 17v-6h4v6"/>', work:'<rect x="3" y="6" width="14" height="11" rx="2"/><path d="M7 6V3h6v3M3 10h14M9 10v2h2v-2"/>',
  time:'<circle cx="10" cy="10" r="7"/><path d="M10 6v5l3 2"/>', folder:'<path d="M2 5h6l2 2h8v10H2z"/>', file:'<path d="M5 2h7l4 4v12H5zM12 2v5h4M8 11h5M8 14h5"/>',
  chevron:'<path d="m7 5 5 5-5 5"/>', down:'<path d="m5 7 5 5 5-5"/>', plus:'<path d="M10 4v12M4 10h12"/>', close:'<path d="m5 5 10 10M15 5 5 15"/>',
  check:'<path d="m4 10 4 4 8-9"/>', code:'<path d="m6 5-4 5 4 5m8-10 4 5-4 5m-3-12-2 14"/>', branch:'<circle cx="5" cy="4" r="2"/><circle cx="15" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><path d="M5 6v8m0-4h5a5 5 0 0 0 5-4"/>',
  arrow:'<path d="M4 10h12m-5-5 5 5-5 5"/>', out:'<path d="M6 4h10v10M16 4 4 16"/>', clip:'<path d="m8 11 5-5a2 2 0 0 1 3 3l-7 7a4 4 0 0 1-6-5l8-8"/>',
  mic:'<rect x="7" y="2" width="6" height="10" rx="3"/><path d="M4 9v1a6 6 0 0 0 12 0V9M10 16v3"/>', send:'<path d="m3 3 15 6-7 3-3 6zM3 3l8 9"/>', settings:'<circle cx="10" cy="10" r="3"/><path d="m7 2 6 0 1 3 3 2 1 5-3 2-2 4H7l-1-4-4-2 1-5 3-2z"/>',
  stop:'<rect x="5" y="5" width="10" height="10" rx="1"/>', link:'<path d="m8 7 4-4a3 3 0 0 1 5 5l-4 4M7 8l-4 4a3 3 0 0 0 5 5l4-4M7 13l6-6"/>', panel:'<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M12 3v14"/>',
}
const icon = (name, size=15, cls='') => `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.file}</svg>`
const button = (action, text, cls='link', attrs='') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${text}</button>`
const status = value => `<span class="status ${esc(value)}">${labels[value] ?? esc(value)}</span>`
const state = () => store.current()
const project = () => projects[store.projectId]
const currentNode = () => state().nodes.find(n => n.id === state().selected)
const canStop = n => state().connected && descendants(state().nodes,n.id).some(item => ['running','queued','permission','blocked'].includes(item.status))

function sidebar() {
  return `<aside class="sidebar"><div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div><div class="brand">CC</div><nav class="main-nav" aria-label="主导航">${button('home',icon('home')+'<span class="nav-text">此刻</span>','', 'aria-label="此刻"')}${button('work',icon('work')+'<span class="nav-text">一起做</span>','active','aria-current="page" aria-label="一起做"')}${button('memory',icon('time')+'<span class="nav-text">回忆</span>','','aria-label="回忆"')}</nav><section class="sidebar-projects"><div class="section-label"><span>项目</span>${button('new-project',icon('plus',13),'icon-button','aria-label="添加项目"')}</div>${Object.entries(projects).map(([id,p])=>`<button class="project-button ${id===store.projectId?'active':''}" data-project="${id}" aria-label="${p.name}" aria-pressed="${id===store.projectId}">${icon(id===store.projectId?'down':'chevron',12)}${icon('folder',15)}<span class="project-name">${p.name}</span></button>${id===store.projectId?`<div class="task-links">${button('work',`<span class="static-dot"></span>${p.title}`,'task-link selected')}${id==='desktop'?button('other-task',icon('check',12)+'首页视觉收尾','task-link'):''}</div>`:''}`).join('')}${button('music',icon('chevron',12)+icon('folder',15)+'<span class="project-name">雨天 EP</span>','project-button','aria-label="雨天 EP"')}</section><div class="sidebar-bottom">${button('settings',icon('settings',15)+'<span class="nav-text">连接与设置</span>','settings','aria-label="连接与设置"')}<small>你的事情，各自在原处。</small></div></aside>`
}

function workHeader() {
  const s=state(), overall=overallStatus(s)
  const subtitles={running:'Codex 正在修改 · Claude 等待复核',permission:'Codex 的一个子任务需要授权',completed:'修改与复核结束 · 成果可以查看',unknown:'连接中断 · 显示最后收到的记录',stopping:'已发出停止请求，等待执行端确认',stopped:'执行已停止 · 已有成果仍保留',blocked:'有子任务未完成，需要调整安排'}
  return `<header class="work-header"><div class="breadcrumb">${esc(project().name)}<span>/</span>${esc(project().title)}${button('scope',icon('folder',13),'link top-help','aria-label="查看项目范围"')}</div><div class="title-row"><h1>${esc(project().title)}</h1>${button('stop-task',icon('stop',11)+'停止任务','button', !s.connected||['completed','stopped','stopping'].includes(overall)?'disabled':'')}</div><p class="task-status">${status(overall)}<span>·</span><span>${subtitles[overall]}</span></p><div class="tabs" role="tablist" aria-label="工作内容">${[['collaboration','协作'],['artifacts','成果'],['materials','资料']].map(([id,label])=>`<button data-main-tab="${id}" role="tab" aria-selected="${s.mainTab===id}">${label}</button>`).join('')}${!s.panel?button('show-panel',icon('panel',14)+'执行详情','right-action','aria-label="打开执行详情"'):''}</div></header>`
}

function childrenSummary(children) {
  if (!state().connected) return `${children.length} 个子任务 · 状态待确认`
  const unfinished=children.filter(n=>n.status!=='completed')
  if (!unfinished.length) return `${children.length} 个子任务 · 均已完成`
  const attention=unfinished.find(n=>['permission','blocked','stopped','stopping'].includes(n.status))
  return `${children.length} 个子任务 · ${attention?labels[attention.status]:`${unfinished.filter(n=>n.status==='running').length} 个执行中`}`
}

function nestedNodes(parentId) {
  const s=state(), children=s.nodes.filter(n=>n.parentId===parentId)
  if (!children.length) return ''
  const expanded=s.expanded.has(parentId)
  return `<div class="children">${button('toggle-children',icon('chevron',11,'chevron')+icon('branch',12)+esc(childrenSummary(children)),'children-toggle',`data-node="${parentId}" aria-expanded="${expanded}" aria-controls="children-${parentId}"`)}${expanded?`<div class="children-list" id="children-${parentId}">${children.map(n=>`<div class="child-row ${s.selected===n.id?'selected':''}">${icon(n.status==='completed'?'check':'branch',12)}${button('inspect',esc(n.title),'child-name',`data-node="${n.id}"`)}${status(s.connected?n.status:'unknown')}</div>${nestedNodes(n.id)}`).join('')}<p class="child-kind">由 ${esc(s.nodes.find(n=>n.id===parentId).owner)} 启动与管理</p></div>`:''}</div>`
}

function step(node) {
  const s=state(), selected=s.selected===node.id || s.nodes.some(n=>n.id===s.selected && n.parentId===node.id)
  return `<article class="step"><span class="step-marker ${node.status}">${icon(node.status==='completed'?'check':node.status==='queued'?'time':'code',12)}</span><div class="step-card ${selected?'selected':''} ${node.status==='queued'?'is-queued':''}"><div class="step-head">${button('inspect',`${node.owner}<span class="separator">·</span>${esc(node.title)}`,'step-title',`data-node="${node.id}"`)}${status(s.connected?node.status:'unknown')}</div><p class="step-copy">${esc(node.summary)}</p><div class="actions">${button('inspect',`${selected&&s.panel?'正在查看':'查看执行'} ${icon('arrow',11)}`,'link',`data-node="${node.id}"`)}${node.status==='running'||node.status==='permission'?button('note','补充要求','link',`data-node="${node.id}" ${!s.connected?'disabled':''}`):''}${canStop(node)?`<span class="separator"></span>${button('stop-node','停止','link danger',`data-node="${node.id}"`)}`:''}</div>${nestedNodes(node.id)}</div></article>`
}

function handoff(review=false) {
  return `<div class="handoff"><div class="handoff-header">${icon('link',11)}<strong>CC → ${review?'Claude':'Codex'}</strong><span class="received">${icon('check',10)} 已接收</span></div><p>${review?'修改与测试结果已交回 Claude 复核。':'结论、相关文件和修改约束已交接。'}</p>${button('handoff','查看交接内容 '+icon('arrow',10),'link',`data-receiver="${review?'review':'codex'}"`)}</div>`
}

function notices() {
  const s=state(), overall=overallStatus(s)
  if (!s.connected) return `<div class="notice"><span>连接已中断，当前显示最后收到的记录。尚不确定执行是否仍在继续。</span>${button('reconnect','模拟重新连接','button')}</div>`
  if (overall==='stopping') return `<div class="notice"><span>停止请求已发出。收到确认前，不将任务标为已停止。</span>${button('ack-stop','模拟收到停止确认','button')}</div>`
  if (overall==='blocked') return `<div class="notice"><span>有子任务未完成，后续复核不会自动开始。可以告诉 CC 怎样调整。</span>${button('focus-input','调整安排','button')}</div>`
  return ''
}

function collaboration() {
  const p=project(), s=state()
  return `${notices()}<article class="message"><div class="avatar">我</div><div><p class="message-label">我 · 这件事的要求</p><p>${esc(p.request)}</p></div></article><article class="message"><div class="avatar cc">CC</div><div><p class="message-label">CC</p><p>${esc(p.response)}</p></div></article><section class="timeline" aria-label="主流程与子任务">${s.nodes.filter(n=>!n.parentId).map((n,i)=>`${step(n)}${i===0?handoff():i===1&&n.status==='completed'?handoff(true):''}`).join('')}</section><p class="end-note">成果与交接记录，会留在这件事里。</p>${s.messages.map(m=>`<article class="message"><div class="avatar">我</div><div><p class="message-label">补充给 ${esc(m.target)}</p><p>${esc(m.text)}</p><p class="message-label">样板已记录 · 未向真实执行者发送</p></div></article>`).join('')}`
}

function diff() {
  return `<div class="mini-diff"><div class="diff-title">${esc(project().files[0])}<span>+3 −0</span></div><div class="diff-line">142   // 示例差异，用于查看布局</div>${(store.projectId==='desktop'?['clearExpiredSession();','resetCachedUser();','return signedOutState;']:['const title = originalTitle;','const copy = conciseIntroduction;','return renderWork(title, copy);']).map((line,i)=>`<div class="diff-line added">${144+i} + ${esc(line)}</div>`).join('')}</div>`
}

function artifacts() {
  const complete=overallStatus(state())==='completed'
  return `${notices()}<div class="artifact-heading"><h2>${complete?'这一版，可以看看了。':'已经留下的工作'}</h2><span class="eyebrow">${complete?'候选成果':'尚未完成复核'}</span></div><div class="artifact-sheet"><span class="eyebrow">${esc(project().name)} / 成果 01</span><h3>${esc(project().artifact)}</h3><p>${esc(artifactSummary(state()))}</p><ul><li>${icon('check',13)} ${esc(project().findings)}</li><li>${icon('check',13)} ${esc(project().constraint)}</li><li>${icon(complete?'check':'time',13)} ${complete?'示例测试与复核通过。':'等待测试结果，不将过程文件当作最终成果。'}</li></ul>${diff()}<div class="actions">${button('file-preview','查看本版修改','button primary')}${button('focus-input','继续调整','button')}</div><div class="artifact-files">${project().files.map(file=>`<div class="artifact-file">${icon('file',15)}<span>${esc(file)}</span><small>示例文件</small></div>`).join('')}</div></div>`
}

function materials() {
  return `<div class="artifact-heading"><h2>这件事的上下文</h2></div><div class="material-item"><h3>已确认的约束</h3><p>${esc(project().constraint)}</p></div><div class="material-item"><h3>Claude 的排查结论</h3><p>${esc(project().findings)}</p>${button('handoff','查看如何交给 Codex '+icon('arrow',12))}</div><div class="material-item"><h3>项目范围</h3><p>${esc(project().path)} · 示例项目。当前页面不读取本地目录。</p></div><div class="material-item"><h3>各自的会话</h3><p>Claude、Codex 与子任务各有自己的记录。CC 保存归属与交接，不把不同项目的全文混进同一个会话。</p></div>`
}

function composer() {
  return `<div class="composer-wrap"><form class="composer" id="composer"><textarea id="draft" aria-label="给 CC 的补充要求" placeholder="继续交代，或随时调整方向…" rows="2" maxlength="4000">${esc(state().draft)}</textarea><div class="composer-bottom">${button('attachment',icon('clip',17),'icon-button','aria-label="添加材料"')}${button('voice',icon('mic',16),'icon-button','aria-label="语音输入"')}<span class="composer-target">发给 CC</span><button class="send" type="submit" aria-label="发送补充要求">${icon('send',15)}</button></div></form><div class="composer-note"><span>只留在「${esc(project().title)}」里</span><span>Enter 发送 · Shift + Enter 换行</span></div></div>`
}

function detailActivity(node) {
  const s=state(), children=s.nodes.filter(n=>n.parentId===node.id)
  const special=['permission','blocked','stopped','stopping'].includes(node.status)
  const permission=node.status==='permission'?`<section class="permission-box"><h3>这个子任务需要一次授权</h3><p>测试将启动一个本机临时服务。请求来自 Codex → 补充与运行测试，仅针对当前任务。</p><div class="actions">${button('allow','允许本次','button primary',`data-node="${node.id}" ${!s.connected?'disabled':''}`)}${button('deny','拒绝','button',`data-node="${node.id}" ${!s.connected?'disabled':''}`)}</div></section>`:''
  let content=`${permission}<p class="detail-brief">${esc(node.summary)}</p>`
  if (children.length) {
    content+=`<div class="child-inspector-heading"><span>由 ${node.owner} 启动的子任务</span><span>${children.length} 个</span></div>${children.map(n=>`<div class="child-inspector">${button('inspect',`${icon('branch',12)} ${esc(n.title)} ${status(s.connected?n.status:'unknown')}`,'',`data-node="${n.id}"`)}<small>${esc(n.summary)}</small></div>`).join('')}`
  }
  if (node.owner==='Codex') {
    content+=`<div class="child-inspector-heading"><span>本轮工作记录</span><span>示例</span></div><div class="activity-entry"><span class="activity-icon">${icon('check',11)}</span><div class="activity-text">${node.id==='codex-test'?'补充验证用例':'更新相关实现'}<small>${esc(project().files[node.id==='codex-test'?1:0])}</small></div></div>${diff()}<div class="activity-entry"><span class="activity-icon">${node.status==='running'&&s.connected?'<i class="spinner"></i>':icon(node.status==='completed'?'check':'time',11)}</span><div class="activity-text">${!s.connected?'执行状态尚未确认':special?labels[node.status]:node.status==='completed'?'本步骤已经结束':'等待验证结果'}<small>${node.status==='completed'?'已交回结果；整体状态见主流程。':'只有收到执行端结果，才标记为完成。'}</small></div></div>`
  } else if (!children.length) {
    content+=`<div class="material-item"><h3>${node.id==='review'?'复核范围':'工作结论'}</h3><p>${node.status==='queued'?'尚未开始，不显示推测出来的检查结果。':esc(project().constraint)}</p></div>`
  }
  content+=`<details class="disclosure" data-output-node="${node.id}" ${s.outputs.has(node.id)?'open':''}><summary>查看命令与原始输出</summary><pre>${node.owner==='Codex'?'$ test login-session\n'+(node.status==='completed'?'[示例] 此步骤已结束。':'[示例] 当前无最终测试结果。'):'[示例] 排查与范围核对记录。'}\n这些输出用于界面设计，不是真实运行日志。</pre></details>`
  return content
}

function detailPanel() {
  const s=state(), node=currentNode()
  if (!s.panel||!node) return ''
  const parent=s.nodes.find(n=>n.id===node.parentId)
  const content=s.detailTab==='activity'?detailActivity(node):s.detailTab==='files'?`<p class="detail-brief">${node.owner==='Codex'?'本轮已产生的修改。':'当前步骤以审查为主，未写入文件。'}</p>${node.owner==='Codex'?diff():''}<p class="detail-brief">这是合成示例，不访问或修改你的项目文件。</p>`:`<p class="session-note">会话标识：${esc(node.session)}（示例）</p><article class="message"><div class="avatar">${parent?parent.owner[0]:'CC'}</div><div><p class="message-label">来自 ${parent?parent.owner:'CC'}</p><p>${esc(project().constraint)} 请完成「${esc(node.title)}」。</p></div></article><article class="message"><div class="avatar">${node.owner[0]}</div><div><p class="message-label">${esc(node.owner)} · ${node.parentId?'子任务':'主执行者'}</p><p>${esc(node.summary)}</p></div></article>`
  return `<button class="panel-mask" data-action="hide-panel" aria-label="收起执行详情"></button><aside class="detail" aria-label="执行详情"><header class="detail-header"><div class="detail-heading"><h2>${esc(node.owner)} · ${esc(node.title)}</h2>${button('hide-panel',icon('close',15),'icon-button','aria-label="收起执行详情"')}</div>${parent?`<p class="parent-label">${icon('branch',12)}由 ${parent.owner} 启动的子任务 · ${button('inspect','回到上一级','link',`data-node="${parent.id}"`)}</p>`:`<p class="parent-label">CC 分派的工作 · ${esc(project().name)}</p>`}<div class="detail-status-row">${status(s.connected?node.status:'unknown')}<div class="actions">${button('note','补充要求','link',`data-node="${node.id}" ${!s.connected?'disabled':''}`)}${canStop(node)?button('stop-node','停止','button danger',`data-node="${node.id}"`):''}</div></div><div class="tabs" role="tablist" aria-label="执行详情内容">${[['activity','执行记录'],['files','文件修改'],['session','会话']].map(([id,label])=>`<button data-detail-tab="${id}" role="tab" aria-selected="${s.detailTab===id}">${label}</button>`).join('')}</div></header><div class="detail-scroll">${!s.connected?'<div class="warning-box"><h3>连接中断</h3>以下是最后收到的记录。停止和授权操作暂不可用。</div>':''}${content}<div class="disclosure">${button('handoff','收到的交接内容 '+icon('arrow',11),'link',`data-node="${node.id}"`)}</div></div><footer class="detail-footer">${button('session','在 CC 内查看原始会话 '+icon('arrow',11))}</footer></aside>`
}

function paint() {
  if (renderedState) {
    renderedState.scroll=app.querySelector('.work-scroll')?.scrollTop??renderedState.scroll
    renderedState.detailScroll=app.querySelector('.detail-scroll')?.scrollTop??renderedState.detailScroll
  }
  const focusAttrs=['data-action','data-node','data-project','data-main-tab','data-detail-tab']
  const focusKey=Object.fromEntries(focusAttrs.map(key=>[key,document.activeElement?.getAttribute(key)]).filter(([,value])=>value!=null))
  app.innerHTML=`<div class="shell ${state().panel?'':'panel-hidden'}">${sidebar()}<main class="work">${workHeader()}<div class="work-scroll" role="tabpanel" aria-label="${({collaboration:'协作',artifacts:'成果',materials:'资料'})[state().mainTab]}">${state().mainTab==='collaboration'?collaboration():state().mainTab==='artifacts'?artifacts():materials()}</div>${composer()}</main>${detailPanel()}</div>`
  app.querySelector('.work-scroll').scrollTop=state().scroll
  if(app.querySelector('.detail-scroll'))app.querySelector('.detail-scroll').scrollTop=state().detailScroll
  renderedState=state()
  document.querySelectorAll('[data-scenario]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scenario===state().scenario)))
  if(Object.keys(focusKey).length) Array.from(app.querySelectorAll('button')).find(b=>Object.entries(focusKey).every(([key,value])=>b.getAttribute(key)===value))?.focus({preventScroll:true})
}

function notify(text) {
  const el=document.querySelector('#toast'); el.textContent=text; el.classList.add('visible')
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('visible'),3500)
}
function show(title,content,action=null) {
  lastFocus=document.activeElement; modalAction=action
  document.querySelector('#modal-content').innerHTML=`<h2 id="modal-title">${esc(title)}</h2>${content}`
  modal.showModal()
}
function stopDialog(id) {
  const s=state(), node=s.nodes.find(n=>n.id===id)
  const scope=id?descendants(s.nodes,id):s.nodes
  const affected=scope.filter(n=>['running','queued','permission','blocked'].includes(n.status))
  show(id?`停止「${node.title}」？`:'停止整件事？',`<p>${id?'只向这个步骤及其子任务发出停止请求，其他步骤不一并停止。':'向所有未结束的步骤与子任务发出停止请求。'}</p><ul>${affected.map(n=>`<li>${esc(n.owner)} · ${esc(n.title)}</li>`).join('')}</ul><p>已有文件保留。只有收到执行端确认，状态才变为「已停止」。</p><div class="actions">${button('close-modal','继续工作','button')}${button('confirm-stop','模拟发出停止请求','button danger')}</div>`,()=>{requestStop(s,id);paint();notify('演示：停止请求已发出，等待确认。')})
}
function handoffDialog(nodeId, review=false) {
  const p=project(), r=handoffRecord(state(), nodeId??(review?'review':'codex'))
  show(`${r.from} → ${r.to}`, `<div class="receipt-row"><span>发送方</span><strong>${esc(r.from)}</strong></div><div class="receipt-row"><span>接收方</span><strong>${esc(r.to)}</strong></div><div class="receipt-row"><span>要做什么</span><strong>${esc(r.request)}</strong></div><div class="receipt-row"><span>约束</span><strong>${esc(p.constraint)}</strong></div>${r.received?`<div class="receipt-row"><span>资料版本</span><strong>${esc(r.version)}（示例）</strong></div><div class="receipt-row"><span>接收记录</span><strong>已接收 · ${esc(r.receiptId)}（示例）</strong></div>`:'<div class="warning-box">尚未交接。正在等待前一步结束，没有已接收的资料或确认记录。</div>'}<p class="receipt-footnote">正式接入时，版本、接收确认和父子关系必须来自执行数据。这份样板不会发送任何内容。</p>`)
}

document.addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b||b.disabled)return
  if(b.dataset.project){store.select(b.dataset.project);paint();return}
  if(b.dataset.scenario){store.scenario(b.dataset.scenario);paint();return}
  if(b.dataset.mainTab){state().mainTab=b.dataset.mainTab;paint();return}
  if(b.dataset.detailTab){state().detailTab=b.dataset.detailTab;paint();return}
  const id=b.dataset.node
  switch(b.dataset.action){
    case 'toggle-children':state().expanded.has(id)?state().expanded.delete(id):state().expanded.add(id);paint();break
    case 'inspect':state().selected=id;state().panel=true;state().detailTab='activity';paint();break
    case 'hide-panel':state().panel=false;paint();break
    case 'show-panel':state().panel=true;paint();break
    case 'session':state().detailTab='session';paint();break
    case 'stop-task':stopDialog(null);break
    case 'stop-node':stopDialog(id);break
    case 'confirm-stop':modalAction?.();modal.close();break
    case 'ack-stop':acknowledgeStops(state());paint();notify('演示：收到执行端停止确认。');break
    case 'allow':case 'deny':decidePermission(state(),id,b.dataset.action==='allow');paint();notify(b.dataset.action==='allow'?'演示：允许本次测试，子任务继续。':'演示：已拒绝，等待调整验证方式。');break
    case 'reconnect':state().connected=true;state().scenario='running';paint();notify('演示：重新连接，恢复显示执行状态。');break
    case 'handoff':handoffDialog(id,b.dataset.receiver==='review');break
    case 'close-modal':modal.close();break
    case 'work':state().mainTab='collaboration';paint();break
    case 'focus-input':document.querySelector('#draft').focus();break
    case 'file-preview':show('本版修改 · 示例',diff()+'<p>这里只预览合成差异。正式版本会绑定成果快照与对应文件，不会通过示例内容修改代码。</p>');break
    case 'note':{
      const n=state().nodes.find(n=>n.id===id), s=state()
      show(`补充给 ${n.owner} · ${n.title}`,`<p>通过 CC 传递，并保留在当前任务中。</p><textarea id="node-note" class="note-input" aria-label="给执行者的补充要求" maxlength="4000" placeholder="例如：保留已经确认的范围…"></textarea><div class="actions">${button('close-modal','取消','button')}${button('confirm-note','记下这条要求','button primary')}</div>`,()=>{
        const text=document.querySelector('#node-note').value.trim();if(!text)return false
        s.messages.push({target:`${n.owner} / ${n.title}`,text});paint();notify('演示已记录，没有向真实执行者发送。');return true
      });break
    }
    case 'confirm-note':if(modalAction?.())modal.close();break
    case 'scope':show('项目各自独立',`<p>当前：${esc(project().name)}</p><p>任务、会话、子任务、交接资料和成果归属于这个项目。切换项目会保留各自草稿与查看位置。</p><p>真实执行还需要独立的文件工作范围；会话隔离不等于文件隔离。</p>`);break
    case 'design':show('工作在一个地方接得上',`<p>这是已经确认的三栏方向的交互样板，所有内容与状态均为合成示例，刷新重置。没有调用模型、接管会话或改动真实项目。</p><h3>主流程与子任务分开</h3><p>CC 分派的工作在主流程上；Claude/Codex 自己启动的子任务收在各自步骤里。点子任务可看归属、执行记录与单独操作。</p><h3>让状态可信</h3><p>等待授权、连接中断、停止请求和停止确认分别展示。子任务未完成，不把整件事标成完成。已有成果不随停止消失。</p><h3>现在可以试</h3><ul><li>展开子任务，点击一项查看详情。</li><li>切换顶部四种演示状态。</li><li>停止单个子任务，再模拟收到确认。</li><li>输入草稿，切换项目，再切回来。</li></ul><p>现有生产执行接口仍是单层事件；父子关系和交接接收记录需要后续真实接入。提供方不暴露的数据，应明确标成不可见。</p>`);break
    default:if(b.dataset.action)show(({home:'此刻',memory:'回忆',settings:'连接与设置',music:'雨天 EP', 'new-project':'开始新项目','other-task':'首页视觉收尾',attachment:'添加材料',voice:'语音输入'})[b.dataset.action]??'设计范围',`<p>${({home:'CC 自己的生活留在此刻，一起做专注当前工作。',memory:'过去的经历、作品和共同决定留在回忆。',settings:'正式接入时在这里管理执行者与授权；工作现场不重复展示配置表单。',music:'这个项目入口用于展示多项目布局。本轮交互覆盖 CC 桌面应用与个人网站。','new-project':'新项目入口会先接住一句要求或一个文件夹，再确认执行范围。这份样板先验证已有任务的协作现场。','other-task':'这件事已经完成。当前样板聚焦登录问题的执行过程。',attachment:'正式版本可添加文件与链接。本样板不读取你的文件。',voice:'正式版本可通过语音给 CC 补充要求。本样板不启用麦克风。'})[b.dataset.action]??'本轮为交互样板。'}</p>`)
  }
})
app.addEventListener('toggle',e=>{const id=e.target.dataset.outputNode;if(id) e.target.open?state().outputs.add(id):state().outputs.delete(id)},true)
app.addEventListener('input',e=>{if(e.target.id==='draft')state().draft=e.target.value})
app.addEventListener('submit',e=>{
  if(e.target.id!=='composer')return
  e.preventDefault();const text=state().draft.trim();if(!text)return
  state().messages.push({target:'CC',text});state().draft='';state().mainTab='collaboration';paint()
  const scroll=app.querySelector('.work-scroll');scroll.scrollTop=scroll.scrollHeight
  document.querySelector('#draft').focus();notify('演示已记录，只属于当前项目。')
})
app.addEventListener('keydown',e=>{if(e.target.id==='draft'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();document.querySelector('#composer').requestSubmit()}})
modal.addEventListener('close',()=>{modalAction=null;if(lastFocus?.isConnected)lastFocus.focus();else document.querySelector('#draft')?.focus()})
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!modal.open&&state().panel){state().panel=false;paint();app.querySelector('[data-action="show-panel"]')?.focus()}})
paint()

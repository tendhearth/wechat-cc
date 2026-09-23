import { icon } from '../../src/modules/icons.js'
import { projects } from '../cc-companion-entry/state.js'
import { makePreview } from './model.js'

const state = makePreview()
const app = document.querySelector('#app'), dialog = document.querySelector('#detail')
let page = 'now', work = 'login', chatting = false, lastFocus, noticeTimer
const labels = { running:'正在推进', decision:'需要你决定', complete:'已经完成' }
const workIds = ['login','website','talk']
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const glyph = n => icon(n,{size:19})
const btn = (a,text,cls='',attrs='') => `<button data-action="${a}" class="${cls}" ${attrs}>${text}</button>`
const mascot = cls => `<img class="cc ${cls}" src="../../src/assets/pet/cc-v1/canonical/lit/front.png" alt="CC">`
const scope = () => page === 'work' ? work : 'home'
const workLabel = id => `${projects.find(p=>p.id===state.tasks[id].project).name} / ${state.tasks[id].title}`
function show(title,body) {
  lastFocus=document.activeElement
  document.querySelector('#detail-body').innerHTML=`<span class="eyebrow">示例内容</span><h2>${esc(title)}</h2>${body}`
  dialog.showModal()
}
function notify(text) {
  document.querySelector('#notice').textContent=text; clearTimeout(noticeTimer)
  noticeTimer=setTimeout(()=>{document.querySelector('#notice').textContent=''},3500)
}
function navigation() {
  return `<aside class="nav"><a class="brand" href="#now" data-action="now">CC<span>一起生活，也一起做事</span></a><nav aria-label="主导航">${btn('now',`${glyph('heart-check')}<span>此刻</span>`,page==='now'?'selected':'')}${btn('work',`${glyph('archive')}<span>一起做</span>`,page==='work'?'selected':'')}${btn('memories',`${glyph('time-02')}<span>回忆</span>`,page==='memories'?'selected':'')}</nav><footer>${btn('settings',`${glyph('more-horizontal')}<span>连接与设置</span>`)}</footer></aside>`
}
function conversation(id) {
  return `<div class="conversation" aria-label="本页对话">${state.scopes[id].messages.map(m=>`<article class="message ${m.role}"><small>${m.role==='user'?'你':'CC · 演示回复'}</small><p>${esc(m.text)}</p></article>`).join('')}</div>`
}
function composer(id) {
  const s=state.scopes[id]
  return `<section class="composer"><span class="composer-scope">${id==='home'?'和 CC 聊聊':esc(workLabel(id))}</span><form data-scope="${id}"><textarea rows="1" maxlength="4000" aria-label="${id==='home'?'和 CC 聊聊':esc(workLabel(id))}输入" placeholder="${id==='home'?'想说什么，叫我就好。':'交代下一步，或补充这件事…'}">${esc(s.draft)}</textarea><button type="submit" aria-label="发送演示消息" ${!s.draft.trim()?'disabled':''}>↑</button></form></section>`
}
function now() {
  return `<header class="topline"><span>此刻</span><small>CC 的小空间</small></header><div class="now-content ${chatting?'is-chatting':''}"><section class="presence"><div class="scene">${mascot('large')}<button class="small-art" data-action="painting" aria-label="看看 CC 正在画的画"><img src="../cc-postcards/sample.svg" alt="烘豆机旁的橘猫，样例画作"></button><div class="ground"></div></div><div class="current-activity"><span class="eyebrow"><span class="status-dot"></span>${chatting?'在听你说':'小画室'}</span><h1>${chatting?'我在。':'正在给小猫添一点颜色。'}</h1><p>${chatting?'这一会儿，留给你。':'“这里留一点白，好像更安静。”'}</p>${chatting?'':btn('painting','凑近看看 →','text-link')}</div></section>${conversation('home')}</div>${composer('home')}`
}
function summary(id,phase) {
  const t=state.tasks[id]
  if(phase==='decision') return id==='login' ? ['有一处，需要你拿主意。','登录过期后，重新登录应该回到哪里？','原页面能保留操作上下文；首页更适合重新开始。'] : ['先定一个方向，再交给助手继续。',id==='talk'?'这次分享，先讲故事还是先讲结论？':'官网第一屏，先介绍陪伴还是工作能力？','我会把你的选择交给执行助手，并在完成后核对。']
  if(phase==='complete') return ['这件事做好了。',id==='login'?'登录修复已完成，复核也已通过。':`${t.artifact}已经整理好，可以查看了。`,'结果和核对记录都留在这件事里。']
  return ['我在跟进这件事。',state.choices[id]?`你的选择已交给 ${t.helper}，正在继续处理。`:`${t.helper} 正在${id==='login'?'修复登录问题':'整理这份初稿'}。` ,id==='login'?'完成后，我会安排 Claude 复核，再把结果交给你。':'完成后，我会核对要求是否落实，再向你汇报。']
}
function workPage() {
  const t=state.tasks[work], phase=state.phase(work), copy=summary(work,phase)
  const options = work==='login'?['回到原页面','回到首页']:work==='talk'?['先讲故事','先讲结论']:['先介绍陪伴','先介绍工作能力']
  return `<header class="topline"><span>一起做</span><small>由 CC 跟进与交付</small></header><div class="work-layout"><nav class="work-nav" aria-label="事情列表"><span class="eyebrow">共同的事</span>${workIds.map(id=>btn('select-work',`<small>${projects.find(p=>p.id===state.tasks[id].project).name}</small><strong>${state.tasks[id].title}</strong><span>${labels[state.phase(id)]}</span>`,id===work?'active-work':'',`data-id="${id}" ${id===work?'aria-current="page"':''}`)).join('')}</nav><section class="work-detail"><div class="demo-phases" aria-label="切换演示状态"><span>演示状态</span>${Object.entries(labels).map(([key,value])=>btn('phase',value,phase===key?'chosen':'',`data-phase="${key}" aria-pressed="${phase===key}"`)).join('')}</div><div class="work-scroll"><div class="work-heading"><p class="eyebrow">${esc(workLabel(work))}</p><h1>${t.title}</h1><span class="phase ${phase}">${labels[phase]}</span></div><section class="report">${mascot('small')}<div><h2>${copy[0]}</h2><p>${esc(copy[1])}</p><span class="muted">${copy[2]}</span>${state.choices[work]?`<p class="decision-note">你的决定：${esc(state.choices[work])}</p>`:''}</div></section>${phase==='decision'?`<div class="decisions">${options.map(o=>btn('decide',o,'option',`data-choice="${o}"`)).join('')}</div>`:''}${phase==='complete'?`<article class="delivery"><span class="document-symbol">${glyph('archive')}</span><div><small>交付成果 · 样例</small><h3>${t.artifact}</h3><p>${t.items.join(' · ')}</p></div>${btn('result','查看结果 →','primary')}</article>`:''}<div class="process-link">${btn('process',`${glyph('time-02')}查看过程与记录`,'text-link')}<small>${t.helper} 执行${work==='login'?' · Claude 复核':''}</small></div>${conversation(work)}</div>${composer(work)}</section></div>`
}
const memories = [
  { date:'昨天', type:'CC 的画', title:'烘豆机旁，睡着的橘猫', text:'那天从阿柚那里听说了这只猫，回来试着画了一张。', image:true },
  { date:'前天', type:'串门见闻', title:'阿柚说，店里来了一个新朋友', text:'“它总爱趴在最暖和的地方。”这句话被 CC 留在了本子里。' },
  { date:'更早一些', type:'关于你', title:'你喜欢安静、能坐一会儿的小店', text:'来自一次聊天的样例记忆。可以纠正，也可以让 CC 忘记。', editable:true },
]
function memoryPage() {
  return `<header class="topline"><span>回忆</span><small>过去的故事，放在这里</small></header><div class="memory-content"><h1>留下来的小事。</h1><p class="muted">画过的画、带回的见闻，还有关于你的记忆。</p><div class="memory-list">${memories.map((m,n)=>`<article><span class="memory-date">${m.date}</span><div><span class="eyebrow">${m.type}</span><h2>${m.title}</h2><p>${esc(m.text)}</p>${btn('memory',m.editable?'查看这条记忆 →':'打开看看 →','text-link',`data-index="${n}"`)}</div>${m.image?'<img src="../cc-postcards/sample.svg" alt="样例画作：烘豆机旁的橘猫">':''}</article>`).join('')}</div></div>`
}
function render(){app.className=page;app.innerHTML=`${navigation()}<main>${page==='now'?now():page==='work'?workPage():memoryPage()}</main>`}
function move(next){page=next;state.select(scope());render()}
app.addEventListener('click',e=>{
  const b=e.target.closest('[data-action]');if(!b)return
  const a=b.dataset.action
  if(['now','work','memories'].includes(a)){e.preventDefault();move(a)}
  if(a==='select-work'){work=b.dataset.id;move('work')}
  if(a==='phase'){state.setPhase(work,b.dataset.phase);render();app.querySelector(`[data-phase="${b.dataset.phase}"]`).focus()}
  if(a==='decide'){state.decide(work,b.dataset.choice);render();notify('选择已保留在这件事里。仅演示，未发送给模型。')}
  if(a==='painting')show('CC 正在画的画','<img class="painting-preview" src="../cc-postcards/sample.svg" alt="样例画作"><p>“想把这只猫画得再懒一点。”</p><p class="muted">当前使用已有 SVG 样例呈现活动，后台没有实际生图任务。</p>')
  if(a==='process'){
    const t=state.tasks[work],p=state.phase(work)
    show(`${t.title} · 处理记录`,`<p class="muted">${esc(workLabel(work))} · 以下记录均为演示</p><ol class="record"><li><strong>CC · 明确要求</strong><p>只使用当前项目的材料，记录目标与交付要求。</p></li><li><strong>${t.helper} · ${p==='complete'?'执行完成':'处理任务'}</strong><p>${p==='complete'?'已产出可核对的结果。':'沿这件事关联的会话继续。'}</p></li>${work==='login'?`<li><strong>Claude · ${p==='complete'?'复核通过':p==='decision'?'提出待决问题':'等待复核'}</strong><p>${p==='running'?'执行完成后安排复核。':'核对登录过期后的返回行为。'}</p></li>`:''}<li><strong>CC · ${labels[p]}</strong><p>${esc(summary(work,p)[1])}</p></li></ol><details><summary>查看 CC 代发的要求与原会话样例</summary><div class="transcript"><small>${t.session} · 非真实会话</small><p>CC：请处理「${t.title}」，仅使用当前项目的材料。完成后提供成果及核对依据。</p><p>${t.helper}：收到，按这些要求继续。</p></div></details>`)
  }
  if(a==='result'){const t=state.tasks[work];show(t.artifact,`<p class="muted">${esc(workLabel(work))} · 成果样例</p><div class="result-document">${t.items.map((x,n)=>`<h3>${n+1}. ${x}</h3><p>${work==='talk'?['从一件真实的小事开始，让大家知道你为什么关心它。','讲清楚其中最费力的部分，再说说你试过什么。','留一个可以尝试的小行动，让讨论继续。'][n]:'此处展示交付内容的位置。正式接入后显示真实文件与对应的核对结果。'}</p>`).join('')}</div>`)}
  if(a==='memory'){const m=memories[Number(b.dataset.index)];show(m.title,`<p>${esc(m.text)}</p>${m.image?'<img class="painting-preview" src="../cc-postcards/sample.svg" alt="样例画作">':''}${m.editable?'<form id="memory-form"><label>这条记忆<textarea aria-label="编辑样例记忆">'+esc(m.text)+'</textarea></label><button type="submit" class="primary">保存修改</button><button type="button" id="forget">忘记这条</button></form>':''}`)}
  if(a==='settings')show('连接与设置','<p>这版只试交互方式，没有连接真实设备或模型。</p><p>CC 的自主活动、模型选择和工作授权会在这里设置。</p>')
})
app.addEventListener('input',e=>{if(e.target.matches('textarea')){const id=e.target.closest('form').dataset.scope;state.setDraft(id,e.target.value);e.target.closest('form').querySelector('button').disabled=!e.target.value.trim()}})
app.addEventListener('submit',e=>{
  e.preventDefault();const id=e.target.dataset.scope,sent=state.submit(id);if(!sent)return
  if(id==='home')chatting=true
  render();app.querySelector('textarea').focus()
  setTimeout(()=>{
    state.reply(id,id==='home'?'我在听。这里的话留在我们之间，不会自动放进工作项目。（演示回复）':`收到，我会把这句补充留在「${workLabel(id)}」，并据此跟进。（演示回复，未派发任务）`)
    if(scope()===id&&page!=='memories'){app.querySelector('.conversation').outerHTML=conversation(id);const area=app.querySelector(page==='work'?'.work-scroll':'.now-content');area.scrollTop=area.scrollHeight}
    else notify(`「${id==='home'?'和 CC 聊聊':workLabel(id)}」的演示回复已保留在原处。`)
  },1000)
})
app.addEventListener('keydown',e=>{if(e.target.matches('textarea')&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();e.target.closest('form').requestSubmit()}})
document.querySelector('#close').addEventListener('click',()=>dialog.close())
dialog.addEventListener('close',()=>{if(lastFocus?.isConnected)lastFocus.focus()})
dialog.addEventListener('submit',e=>{if(e.target.id==='memory-form'){e.preventDefault();memories[2].text=e.target.querySelector('textarea').value;dialog.close();render();notify('样例记忆已修改，刷新后重置。')}})
dialog.addEventListener('click',e=>{if(e.target.id==='forget'){memories.splice(2,1);dialog.close();render();notify('本页的样例记忆已移除。')}})
render()

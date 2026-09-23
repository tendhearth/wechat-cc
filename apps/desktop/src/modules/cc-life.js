// Read-only presentation of current signals and retained records. No invented activity.
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const unknown = () => ({kind:'unknown',title:'暂时不知道 CC 在做什么。',detail:'连接恢复后，这里会更新。',pane:null})

export function currentActivity(p) {
  if (!p || !['ok','degraded','offline'].includes(p.presence) || !p.activity?.kind) return unknown()
  const entries = {
    idle:['安静地待一会儿。','想说什么，叫我就好。',null],
    chatting:['刚刚在和你聊。','想继续的话，我在这里。','converse'],
    hosting_human:['刚刚和客人聊过。','这一会儿，家里有人来过。','a2a-agents'],
    visiting:[p.activity.label || '出门串门了。','回来后的见闻，会收进回忆。','a2a-agents'],
    hosting_peer:[p.activity.label || '有朋友来串门。','正和朋友待一会儿。','a2a-agents'],
    foraging:['正在外面找些东西。','带回来的东西，会留在觅食里。','a2a-agents'],
    working:['在忙一件事。','等忙完了，再和你聊。','workbench'],
  }
  const copy=entries[p.activity.kind]
  if(!copy)return unknown()
  return {kind:p.activity.kind,title:copy[0],detail:p.presence==='offline'?'外部联系暂时不通，这是本机刚确认的活动。':copy[1],pane:copy[2]}
}

/** @param {(()=>void)|null} [openCare] */
export function mountCurrentActivity(host, poller, navigate, openCare = null) {
  let expires
  function draw(p) {
    clearTimeout(expires)
    const a=currentActivity(p)
    const image=`<img src="./assets/pet/cc-v1/canonical/${a.kind==='unknown'?'unlit':'lit'}/front.png" alt="CC">`
    host.innerHTML=`<div class="cc-now-scene">${openCare?`<button type="button" class="cc-care-avatar" data-life-care aria-haspopup="dialog" aria-label="看看 CC 正在照看什么">${image}</button>`:image}</div><span class="cc-life-kicker">${a.kind==='unknown'?'等一等连接':a.kind==='idle'?'在这里':'这一会儿'}</span><h1>${esc(a.title)}</h1><p>${esc(a.detail)}</p><div class="cc-now-actions">${openCare?'<button type="button" data-life-care>正在照看的事 →</button>':''}${a.pane&&a.pane!=='converse'&&(!openCare||a.pane!=='workbench')?`<button type="button" data-life-go="${a.pane}">凑近看看 →</button>`:''}</div>`
    if(p)expires=setTimeout(()=>draw(null),60000)
  }
  host.addEventListener('click',e=>{if(e.target.closest?.('[data-life-care]')){openCare?.();return}const b=e.target.closest?.('[data-life-go]');if(b)navigate(b.dataset.lifeGo)})
  draw(null)
  const unsubscribe=poller.subscribe(draw)
  return ()=>{clearTimeout(expires);unsubscribe()}
}

const paths={paintings:'/v1/atelier/works?limit=24',thoughts:'/v1/companion/thoughts',stories:'/v1/journal?limit=500'}
function date(v) { const d=new Date(v);return Number.isNaN(d.getTime())?'日期未记录':d.toLocaleDateString('zh-CN') }
function rowsFor(category,data) {
  if(category==='paintings') {
    if(!Array.isArray(data?.works))throw new Error('invalid_works')
    return data.works.map(w=>({ts:w.createdAt,title:w.background?.title||w.caption||w.impulse?.subject||'未命名作品',note:w.background?.origin||'',extra:w.background?.approach||'',image:/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(w.image_data||'')?w.image_data:null,test:w.background?.kind==='test'}))
  }
  if(!Array.isArray(data?.items))throw new Error('invalid_history')
  return data.items.filter(w=>category!=='stories'||w.kind==='visit'&&!w.image_svg).map(w=>({ts:w.ts,title:w.title,note:w.note,image:null,extra:''}))
}
export function createLifeArchive(host,{call}) {
  let generation=0, category='thoughts'
  async function load(next) {
    if(!paths[next])throw new Error('unknown_archive')
    category=next;const ticket=++generation
    host.innerHTML='<p role="status" class="cc-life-empty">正在翻开…</p>'
    try {
      const data=await call('GET',paths[next]);if(ticket!==generation)return
      const rows=rowsFor(next,data).sort((a,b)=>String(b.ts).localeCompare(String(a.ts)))
      const hints={thoughts:'CC 当时留下的想法与选择，按天收好；这些想法不代表事情已经做完。最近 14 个有记录的日子。',paintings:'最近 24 幅作品；打开画室可以继续查看作品信息。',stories:'从最近 500 条记录中翻出的串门见闻，带图的故事收在明信片册。'}
      let content
      if(next==='thoughts') {
        const days=new Map()
        for(const row of rows){const key=date(row.ts);if(!days.has(key))days.set(key,[]);days.get(key).push(row)}
        content=[...days].map(([day,items])=>`<details class="cc-thought-day"><summary><time>${esc(day)}</time><div><h2>${esc(items[0].title)}</h2><p>${esc(items[0].note)}</p><small>${items.length} 段想法 · 展开这一天</small></div></summary><div class="cc-thought-notes">${items.map(w=>`<article><h3>${esc(w.title)}</h3><p>${esc(w.note)}</p></article>`).join('')}</div></details>`).join('')
      } else {
        content=rows.map(w=>`<article class="cc-memory-entry"><time>${esc(date(w.ts))}</time><div><h2>${esc(w.title||'留下的一点想法')}</h2>${w.test?'<small>本地测试作品</small>':''}<p>${esc(w.note)}</p>${w.extra?`<details><summary>创作手记</summary><p>${esc(w.extra)}</p></details>`:''}</div>${w.image?`<a href="${esc(w.image)}" download="CC-作品.png" aria-label="保存作品：${esc(w.title)}"><img src="${esc(w.image)}" alt="${esc(w.title)}" loading="lazy"></a>`:''}</article>`).join('')
      }
      host.innerHTML=`<p class="cc-life-note">${hints[next]}</p>${content||'<p class="cc-life-empty">还没有留下这类记录。有了以后，会收在这里。</p>'}`

    } catch {
      if(ticket===generation)host.innerHTML='<div class="cc-life-empty" role="status">这次没能读取记录，已有内容不会因此丢失。<button type="button" data-life-retry>重新读取</button></div>'
    }
  }
  host.addEventListener('click',e=>{if(e.target.closest?.('[data-life-retry]'))void load(category)})
  return {load,cancel(){generation++}}
}

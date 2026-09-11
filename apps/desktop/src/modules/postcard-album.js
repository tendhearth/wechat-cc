import { invokeApi } from '../api.js'
import { showToast } from '../view.js'

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const imageUrl = svg => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
const dateLabel = ts => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN', {year:'numeric',month:'long',day:'numeric'})
}
const picture = card => card.image_svg
  ? `<img src="${esc(imageUrl(card.image_svg))}" alt="${esc(card.title || '串门明信片')}" loading="lazy">`
  : '<span class="pc-image-missing">这张图片暂时无法显示，文字仍在。</span>'

export function postcardMarkup(card) {
  return `<article class="pc-card">
    <button class="pc-cover" type="button" data-pc-action="open" data-pc-id="${esc(card.id)}" aria-label="查看明信片：${esc(card.title)}">${picture(card)}</button>
    <div class="pc-card-body"><time>${esc(dateLabel(card.ts))}</time><h3>${esc(card.title || '串门明信片')}</h3><p>${esc(card.note)}</p>
    <button class="pc-favorite" type="button" data-pc-action="favorite" data-pc-id="${esc(card.id)}" aria-pressed="${!!card.favorite}">${card.favorite ? '已收藏' : '收藏'}</button></div>
  </article>`
}

export function postcardDocument(card) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(card.title || 'CC 明信片')}</title>
  <style>body{max-width:760px;margin:40px auto;padding:24px;background:#faf9f5;color:#403a31;font:18px/1.8 system-ui}img{display:block;width:100%;height:auto;border-radius:12px}p{white-space:pre-wrap;overflow-wrap:anywhere}time{color:#746d62;font-size:14px}h1{font-size:24px}</style>
  <h1>${esc(card.title || '串门明信片')}</h1><time>${esc(dateLabel(card.ts))}</time>${picture(card)}<p>${esc(card.note)}</p></html>`
}

export async function changePostcardFavorite(card, call = invokeApi) {
  const favorite = !card.favorite
  const result = await call('POST', '/v1/journal/favorite', {id:card.id, favorite})
  if (!result?.ok) throw new Error('favorite_not_saved')
  return favorite
}

export async function savePostcard(card) {
  const content = postcardDocument(card)
  const filename = `CC-明信片-${String(card.ts).slice(0,10).replace(/[^0-9-]/g,'')}-${Date.now()}.html`
  if (window.__TAURI__?.core?.invoke) {
    await window.__TAURI__.core.invoke('save_text_file', {filename,content})
    showToast('已保存到下载文件夹，图和文字在同一个文件里')
  } else {
    const url=URL.createObjectURL(new Blob([content],{type:'text/html;charset=utf-8'}))
    const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove()
    setTimeout(()=>URL.revokeObjectURL(url),30000)
    showToast('已开始下载明信片，包含图片和文字')
  }
}

/** Isolated state per mounted album; dependency injection also serves the fixture preview. */
export function createPostcardAlbum(host, {call=invokeApi, toast=showToast, save=savePostcard} = {}) {
  let items=[], total=0, favorites=false, generation=0, busy=false, failed=false
  let modal=null, selected=null, opener=null, openerId=null
  const pending=new Set()
  function render() {
    host.innerHTML=`<div class="pc-toolbar" role="group" aria-label="明信片筛选">
      <button type="button" data-pc-action="all" aria-pressed="${!favorites}">全部</button>
      <button type="button" data-pc-action="collected" aria-pressed="${favorites}">已收藏</button>
      <span class="pc-count" aria-live="polite">${busy ? '正在翻开…' : failed ? '读取失败' : `${total} 张`}</span></div>
      ${failed ? '<div class="pc-empty" role="status">暂时没能打开明信片册，已有记录不会因此丢失。<button type="button" data-pc-action="retry">重试</button></div>' : ''}
      ${!busy && !failed && !items.length ? `<div class="pc-empty">${favorites ? '还没有收藏。遇到喜欢的明信片，点一下“收藏”，就会一直留着。' : 'CC 寄回来的图和话，会一起收在这里。还没有明信片时，不用额外配置画室。'}</div>` : ''}
      <div class="pc-grid">${items.map(postcardMarkup).join('')}</div>
      ${items.length<total ? `<button class="pc-more" type="button" data-pc-action="more" ${busy ? 'disabled' : ''}>${busy ? '正在读取…' : '再翻一些'}</button>` : ''}`
    for (const button of host.querySelectorAll('[data-pc-action="favorite"]')) button.disabled=pending.has(button.dataset.pcId)
  }
  async function refresh(append=false) {
    const ticket=++generation;busy=true;failed=false
    const offset=append ? items.length : 0
    if (!append) {items=[];total=0}
    render()
    try {
      const result=await call('GET',`/v1/journal/postcards?limit=24&offset=${offset}&favorites=${favorites}`)
      if(ticket!==generation)return
      if(!Array.isArray(result?.items) || !Number.isFinite(result?.total))throw new Error('invalid_album')
      const merged=append ? [...items,...result.items] : result.items
      items=[...new Map(merged.map(row=>[row.id,row])).values()];total=result.total
    } catch {
      if(ticket!==generation)return
      failed=true
    } finally {
      if(ticket===generation){busy=false;render()}
    }
  }
  function closeModal() {
    if(modal){modal.close();modal.remove();modal=null;selected=null}
    if(opener?.isConnected)opener.focus()
    else {
      const cover=[...host.querySelectorAll('[data-pc-action="open"]')].find(b=>b.dataset.pcId===openerId)
      ;(cover || host.querySelector('[data-pc-action="all"]'))?.focus()
    }
  }
  function open(card,button) {
    closeModal();opener=button;openerId=card.id;selected=card
    modal=document.createElement('dialog');modal.className='pc-dialog';modal.setAttribute('aria-labelledby','pc-detail-title')
    modal.innerHTML=`<div class="pc-detail"><button class="pc-close" type="button" data-pc-action="close" aria-label="关闭明信片">关闭</button>
      <time>${esc(dateLabel(card.ts))}</time><h2 id="pc-detail-title">${esc(card.title)}</h2>${picture(card)}<p>${esc(card.note)}</p>
      <div class="pc-detail-actions"><button type="button" data-pc-action="favorite" aria-pressed="${!!card.favorite}">${card.favorite?'已收藏':'收藏'}</button><button type="button" data-pc-action="save">保存图和话</button></div><small>保存为可离线打开的网页，图片已包含在文件里。</small></div>`
    modal.addEventListener('click',async event=>{
      const action=event.target.closest?.('[data-pc-action]')?.dataset.pcAction
      if(action==='close' || event.target===modal)closeModal()
      else if(action==='favorite')await favorite(card,event.target)
      else if(action==='save') {
        event.target.disabled=true
        try{await save(card)}catch{toast('保存失败，请重试。明信片仍在册子里。')}finally{event.target.disabled=false}
      }
    })
    modal.addEventListener('cancel',event=>{event.preventDefault();closeModal()})
    document.body.append(modal);modal.showModal()
  }
  async function favorite(card,button) {
    if(pending.has(card.id))return
    pending.add(card.id);button.disabled=true
    try {
      const value=await changePostcardFavorite(card,call)
      card.favorite=value?1:0
      toast(value?'已收藏，会为你保留':'已取消收藏')
      if(modal && selected?.id===card.id){const b=modal.querySelector('[data-pc-action="favorite"]');b.textContent=value?'已收藏':'收藏';b.setAttribute('aria-pressed',String(value))}
      items=items.map(row=>row.id===card.id ? {...row,favorite:card.favorite} : row)
      if(favorites && !value && items.some(row=>row.id===card.id)) {
        items=items.filter(row=>row.id!==card.id);total=Math.max(0,total-1)
      } else if(favorites && value && !items.some(row=>row.id===card.id)) {
        items=[...items,{...card}].sort((a,b)=>b.ts.localeCompare(a.ts));total+=1
      }
    } catch {toast('收藏状态没有保存成功，请重试。')}
    finally {
      pending.delete(card.id);button.disabled=false;render()
      if(!modal) {
        const replacement=[...host.querySelectorAll('[data-pc-action="favorite"]')].find(b=>b.dataset.pcId===card.id)
        ;(replacement || host.querySelector('[data-pc-action="collected"]'))?.focus()
      }
    }
  }
  host.addEventListener('click',async event=>{
    const b=event.target.closest?.('[data-pc-action]');if(!b)return
    const action=b.dataset.pcAction
    if(action==='all'||action==='collected'){favorites=action==='collected';await refresh();return}
    if(action==='retry'){await refresh();return}
    if(action==='more'){if(!busy)await refresh(true);return}
    const card=items.find(x=>x.id===b.dataset.pcId);if(!card)return
    if(action==='open')open(card,b)
    if(action==='favorite')await favorite(card,b)
  })
  return {refresh}
}

let album
export function initPostcardAlbum() {
  const host=document.getElementById('postcard-album')
  if(host && !album)album=createPostcardAlbum(host)
}
export async function refreshPostcardAlbum() {initPostcardAlbum();await album?.refresh()}

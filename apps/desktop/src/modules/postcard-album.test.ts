import { describe, it, expect, vi } from 'vitest'
vi.mock('../api.js',()=>({invokeApi:vi.fn()}))
vi.mock('../view.js',()=>({showToast:vi.fn()}))
const { postcardMarkup, postcardDocument, changePostcardFavorite } = await import('./postcard-album.js')
const card={id:'v1',title:'去朋友家',note:'猫睡得很香。\n烘豆机还在响。',ts:'2026-09-11T12:00:00Z',image_svg:'<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',favorite:0}
describe('postcard presentation',()=>{
 it('keeps image, narration, title, date and favorite together',()=>{
  const s=postcardMarkup(card)
  expect(s).toContain('猫睡得很香。')
  expect(s).toContain('去朋友家')
  expect(s).toContain('2026')
  expect(s).toContain('data:image/svg+xml')
  expect(s).toContain('aria-pressed="false"')
  expect(s).toContain('查看明信片')
 })
 it('exports a self-contained document and never interprets narration as HTML',()=>{
  const s=postcardDocument({...card,title:'<img src=x onerror=bad>',note:'</p><script>bad()</script>'})
  expect(s).not.toContain('<script>')
  expect(s).not.toContain('<img src=x')
  expect(s).toContain('&lt;script&gt;')
  expect(s).toContain('data:image/svg+xml')
  expect(s).not.toContain('src="http')
 })
 it('does not silently report a failed favorite as success',async()=>{
  const call=vi.fn().mockResolvedValue({ok:false})
  await expect(changePostcardFavorite(card,call)).rejects.toThrow()
  expect(card.favorite).toBe(0)
  call.mockResolvedValue({ok:true})
  expect(await changePostcardFavorite(card,call)).toBe(true)
  expect(call).toHaveBeenLastCalledWith('POST','/v1/journal/favorite',{id:'v1',favorite:true})
 })
})

describe('album loading and export',()=>{
 it('ignores an old request after the user switches to favorites',async()=>{
  const {createPostcardAlbum}=await import('./postcard-album.js')
  let click:any
  const host={innerHTML:'',querySelectorAll:()=>[],addEventListener:(_n:string,f:any)=>{click=f}}
  let resolveOld:any
  const call=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolveOld=r})).mockResolvedValue({items:[],total:0})
  const album=createPostcardAlbum(host,{call,toast:vi.fn(),save:vi.fn()})
  const old=album.refresh()
  await click({target:{closest:()=>({dataset:{pcAction:'collected'}})}})
  resolveOld({items:[card],total:1});await old
  expect(host.innerHTML).toContain('还没有收藏')
  expect(host.innerHTML).not.toContain('猫睡得很香')
 })
 it('shows an error rather than an empty album on request failure',async()=>{
  const {createPostcardAlbum}=await import('./postcard-album.js')
  const host={innerHTML:'',querySelectorAll:()=>[],addEventListener:()=>{}}
  const album=createPostcardAlbum(host,{call:vi.fn().mockRejectedValue(new Error('offline'))})
  await album.refresh()
  expect(host.innerHTML).toContain('暂时没能打开')
  expect(host.innerHTML).not.toContain('还没有明信片时')
 })
 it('uses the native save command for the complete image-and-text document',async()=>{
  const {savePostcard}=await import('./postcard-album.js')
  const invoke=vi.fn().mockResolvedValue('/Downloads/card.html')
  vi.stubGlobal('window',{__TAURI__:{core:{invoke}}})
  try {
    await savePostcard(card)
    expect(invoke.mock.calls[0]?.[0]).toBe('save_text_file')
    expect(invoke.mock.calls[0]?.[1].content).toContain('猫睡得很香')
    expect(invoke.mock.calls[0]?.[1].content).toContain('data:image/svg+xml')
  } finally {vi.unstubAllGlobals()}
 })
})

it('favoriting an older page preserves the loaded cards instead of resetting to page one',async()=>{
 const {createPostcardAlbum}=await import('./postcard-album.js')
 let click:any
 const host={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null,addEventListener:(_n:string,f:any)=>{click=f}}
 const call=vi.fn().mockResolvedValueOnce({items:[card],total:2}).mockResolvedValueOnce({items:[{...card,id:'old',note:'older postcard'}],total:2}).mockResolvedValueOnce({ok:true})
 const album=createPostcardAlbum(host,{call,toast:vi.fn()});await album.refresh()
 await click({target:{closest:()=>({dataset:{pcAction:'more'}})}})
 await click({target:{closest:()=>({dataset:{pcAction:'favorite',pcId:'old'},disabled:false})}})
 expect(host.innerHTML).toContain('older postcard')
 expect(host.innerHTML).toContain('猫睡得很香')
 expect(call).toHaveBeenCalledTimes(3)
})

it('restores a postcard re-favorited while its detail remains open',async()=>{
 const {createPostcardAlbum}=await import('./postcard-album.js')
 let click:any,detailClick:any
 const host={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null,addEventListener:(_n:string,f:any)=>{click=f}}
 const button={textContent:'',setAttribute:()=>{},disabled:false}
 const dialog={className:'',innerHTML:'',setAttribute:()=>{},addEventListener:(n:string,f:any)=>{if(n==='click')detailClick=f},showModal:()=>{},querySelector:()=>button}
 vi.stubGlobal('document',{createElement:()=>dialog,body:{append:()=>{}}})
 try {
  const call=vi.fn().mockResolvedValueOnce({items:[{...card,favorite:1}],total:1}).mockResolvedValue({ok:true})
  createPostcardAlbum(host,{call,toast:vi.fn()})
  await click({target:{closest:()=>({dataset:{pcAction:'collected'}})}})
  await click({target:{closest:()=>({dataset:{pcAction:'open',pcId:'v1'}})}})
  const target={...button,closest:()=>({dataset:{pcAction:'favorite'}})}
  await detailClick({target})
  expect(host.innerHTML).not.toContain('猫睡得很香')
  await detailClick({target})
  expect(host.innerHTML).toContain('猫睡得很香')
 } finally {vi.unstubAllGlobals()}
})

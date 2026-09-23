import { describe, it, expect, vi } from 'vitest'
import { currentActivity, createLifeArchive, mountCurrentActivity } from './cc-life.js'

describe('CC current activity', () => {
  const sample = (kind: string) => ({ presence: 'ok', activity: {kind, label: '', since: null}, news: {latest_title:'昨天画了一只猫', unread:9} })
  it('never promotes past news or idle into a made-up activity', () => {
    expect(currentActivity(sample('idle')).title).toBe('安静地待一会儿。')
    expect(JSON.stringify(currentActivity(sample('idle')))).not.toContain('猫')
    expect(currentActivity(sample('chatting')).title).toContain('刚刚')
  })
  it('distinguishes unreachable, malformed and active signals', () => {
    expect(currentActivity(null).kind).toBe('unknown')
    expect(currentActivity({presence:'down'}).kind).toBe('unknown')
    expect(currentActivity({presence:'ok'}).kind).toBe('unknown')
    expect(currentActivity(sample('working')).title).toBe('在忙一件事。')
    expect(currentActivity({...sample('visiting'), activity:{kind:'visiting',label:'去阿柚家串门了'}}).title).toBe('去阿柚家串门了')
  })
  it('opens the care sheet from the CC avatar without changing the current page', () => {
    let click!:(event:any)=>void
    const host={innerHTML:'',addEventListener:(_name:string,cb:any)=>{click=cb}}
    const navigate=vi.fn(),openCare=vi.fn()
    const stop=mountCurrentActivity(host,{subscribe:()=>()=>{}},navigate,openCare)
    expect(host.innerHTML).toContain('data-life-care')
    expect(host.innerHTML).toContain('aria-label="看看 CC 正在照看什么"')
    click({target:{closest:(selector:string)=>selector==='[data-life-care]'?{}:null}})
    expect(openCare).toHaveBeenCalledOnce();expect(navigate).not.toHaveBeenCalled()
    stop()
  })
})

describe('life archive read lifecycle', () => {
  const host = () => ({innerHTML:'',addEventListener:vi.fn()})
  it('loads only the requested category and distinguishes failures from empty history', async () => {
    const h=host(), call=vi.fn().mockRejectedValue(new Error('offline'))
    const archive=createLifeArchive(h,{call})
    await archive.load('thoughts')
    expect(call).toHaveBeenCalledWith('GET','/v1/companion/thoughts')
    expect(h.innerHTML).toContain('没能读取')
    expect(h.innerHTML).not.toContain('还没有留下')
  })
  it('escapes private text, rejects external images, and preserves date and full note', async () => {
    const h=host(), call=vi.fn().mockResolvedValue({works:[{id:'w',createdAt:'2026-09-11',background:{title:'<script>bad</script>',origin:'第一段\n第二段'},image_data:'https://tracking.invalid/pixel'}]})
    await createLifeArchive(h,{call}).load('paintings')
    expect(h.innerHTML).toContain('&lt;script&gt;')
    expect(h.innerHTML).toContain('第一段\n第二段')
    expect(h.innerHTML).toContain('2026')
    expect(h.innerHTML).not.toContain('https://tracking')
  })
  it('a slow prior category cannot overwrite the selected one', async () => {
    let finish!: (v:unknown)=>void
    const call=vi.fn().mockImplementationOnce(()=>new Promise(r=>{finish=r})).mockResolvedValue({items:[]})
    const h=host(), archive=createLifeArchive(h,{call})
    const old=archive.load('paintings');await archive.load('thoughts')
    finish({works:[{caption:'过时的画'}]});await old
    expect(h.innerHTML).not.toContain('过时的画')
    expect(h.innerHTML).toContain('还没有留下')
  })
  it('collapses same-day thoughts instead of flooding the archive', async () => {
    const h=host(), call=vi.fn().mockResolvedValue({items:[{ts:'2026-09-11T12:00:00Z',title:'休息',note:'想法一'},{ts:'2026-09-11T13:00:00Z',title:'画画',note:'想法二'}]})
    await createLifeArchive(h,{call}).load('thoughts')
    expect(h.innerHTML.match(/class="cc-thought-day"/g)).toHaveLength(1)
    expect(h.innerHTML).toContain('2 段想法')
    expect(h.innerHTML).toContain('想法一')
    expect(h.innerHTML).toContain('想法二')
  })
  it('leaving invalidates an in-flight read', async () => {
    let finish!: (v:unknown)=>void
    const h=host(), archive=createLifeArchive(h,{call:()=>new Promise(r=>{finish=r})})
    const old=archive.load('thoughts');archive.cancel();h.innerHTML='elsewhere'
    finish({items:[]});await old
    expect(h.innerHTML).toBe('elsewhere')
  })
})

it('expires a stale live signal instead of claiming CC is still visiting', () => {
  vi.useFakeTimers()
  try {
    let update!: (p:any)=>void
    const host={innerHTML:'',addEventListener:vi.fn()}, unsubscribe=vi.fn()
    const stop=mountCurrentActivity(host,{subscribe:(cb:any)=>{update=cb;return unsubscribe}},vi.fn())
    update({presence:'ok',activity:{kind:'visiting',label:'去朋友家串门了'}})
    expect(host.innerHTML).toContain('去朋友家串门了')
    vi.advanceTimersByTime(60000)
    expect(host.innerHTML).toContain('暂时不知道')
    expect(host.innerHTML).not.toContain('去朋友家串门了')
    stop();expect(unsubscribe).toHaveBeenCalledOnce()
  } finally {vi.useRealTimers()}
})

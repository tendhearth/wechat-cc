import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {Window} from 'happy-dom'
import {refreshQr,stopQr} from './qr.js'

type QrState=Parameters<typeof refreshQr>[1]
const qr=(token:string)=>({ok:true,qrcode:token,qrcode_img_content:`wx://${token}`,expires_in_ms:120000})
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
let win:Window
const el=(id:string)=>win.document.getElementById(id)!
const state=():QrState=>({setup:null,currentBaseUrl:null,qrTimer:null,qrErrors:0})
beforeEach(()=>{
  vi.useFakeTimers()
  win=new Window()
  win.document.body.innerHTML='<div id="qr-box"></div><p id="qr-title"></p><div id="qr-poll" hidden><span id="qr-message"></span></div><span id="qr-ttl"></span><button id="continue-service" disabled></button><button id="qr-refresh">刷新二维码</button><button id="qr-raw-toggle">技术详情</button><pre id="qr-raw"></pre>'
  vi.stubGlobal('document',win.document);vi.stubGlobal('sessionStorage',win.sessionStorage)
})
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();win.happyDOM.abort()})

describe('WeChat QR lifecycle',()=>{
  it('clears the previous successful code and disables continuing before a new code arrives',async()=>{
    const s=state(),pending=deferred<unknown>()
    const invoke=vi.fn().mockResolvedValueOnce(qr('old')).mockResolvedValueOnce({status:'confirmed',accountId:'bot',scenario:'reconnect'}).mockReturnValueOnce(pending.promise)
    const deps={invoke,mock:true}
    await refreshQr(deps,s)
    await vi.advanceTimersByTimeAsync(2000)
    expect((el('continue-service') as any).disabled).toBe(false)
    const next=refreshQr(deps,s)
    expect((el('continue-service') as any).disabled).toBe(true)
    expect(s.setup).toBeNull()
    expect(s.qrTimer).toBeNull()
    pending.resolve(qr('new'));await next
    expect(s.setup?.qrcode).toBe('new')
    expect(el('qr-box').innerHTML).toContain('wx://new')
  })
  it('keeps a visible recovery action when generation fails',async()=>{
    const s=state(),deps={invoke:vi.fn().mockRejectedValue(new Error('private diagnostic')),mock:true}
    await refreshQr(deps,s)
    expect((el('continue-service') as any).disabled).toBe(true)
    expect((el('qr-refresh') as any).disabled).toBe(false)
    expect(el('qr-title').textContent).toContain('没能生成')
    expect((el('qr-poll') as any).hidden).toBe(false)
    expect(el('qr-message').textContent).toContain('重试')
    expect(el('qr-box').textContent).not.toContain('private diagnostic')
    expect(s.setup).toBeNull();expect(s.qrTimer).toBeNull()
  })
  it('ignores an older generation response that arrives after a replacement',async()=>{
    const s=state(),first=deferred<unknown>()
    const deps={invoke:vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(qr('new')),mock:true}
    const old=refreshQr(deps,s)
    await refreshQr(deps,s)
    first.resolve(qr('old'));await old
    expect(s.setup?.qrcode).toBe('new')
    expect(el('qr-box').innerHTML).toContain('wx://new')
  })
  it('shows phone confirmation and reconnect preservation text',async()=>{
    const s=state(),deps={invoke:vi.fn().mockResolvedValueOnce(qr('a')).mockResolvedValueOnce({status:'scaned'}).mockResolvedValueOnce({status:'confirmed',scenario:'reconnect',accountId:'bot'}),mock:true}
    await refreshQr(deps,s);await vi.advanceTimersByTimeAsync(2000)
    expect((el('qr-poll') as any).hidden).toBe(false)
    expect(el('qr-message').textContent).toContain('微信里确认')
    await vi.advanceTimersByTimeAsync(2000)
    expect((el('qr-poll') as any).hidden).toBe(false)
    expect(el('qr-message').textContent).toContain('之前的记忆和对话')
    expect(s.qrTimer).toBeNull()
    expect((el('qr-box') as any).hidden).toBe(true)
  })
  it('leaving a scan invalidates pending polling and a new scan starts fresh',async()=>{
    const s=state(),poll=deferred<unknown>()
    const deps={invoke:vi.fn().mockResolvedValueOnce(qr('first')).mockReturnValueOnce(poll.promise).mockResolvedValueOnce(qr('second')),mock:true}
    await refreshQr(deps,s)
    vi.advanceTimersByTime(2000)
    stopQr(s)
    await refreshQr(deps,s)
    poll.resolve({status:'confirmed',scenario:'first',accountId:'old'})
    await Promise.resolve();await Promise.resolve()
    expect(s.setup?.qrcode).toBe('second')
    expect((el('continue-service') as any).disabled).toBe(true)
    expect(el('qr-box').innerHTML).toContain('wx://second')
  })
  it('does not overlap slow polls or let a late SVG replace the latest code',async()=>{
    const s=state(),svg=deferred<unknown>()
    const invoke=vi.fn().mockResolvedValueOnce(qr('old')).mockReturnValueOnce(svg.promise).mockResolvedValueOnce(qr('new')).mockResolvedValueOnce('<svg id="new-code"></svg>')
    const deps={invoke,mock:false},old=refreshQr(deps,s)
    await Promise.resolve();await refreshQr(deps,s)
    svg.resolve('<svg id="old-code"></svg>');await old
    expect(el('qr-box').innerHTML).toContain('new-code')
    const poll=deferred<unknown>()
    invoke.mockReturnValue(poll.promise)
    const before=invoke.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(invoke.mock.calls.length-before).toBe(1)
    stopQr(s);poll.resolve({status:'wait'})
  })
})

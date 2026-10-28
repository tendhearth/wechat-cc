import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { assembleMobilePage } from './assemble'
import { readMobileSource } from './sources'

// 审计 10-20:/set 链接(10 分钟、能转发)打开的手机网页,看得见但不能送话给执行者 —— 门在服务端(不在链接白名单 LINK_READ_OK / LINK_WRITE_OK 里)。
// 收敛 5b(2026-10-21):网页本来就只剩「看」和「停下」,没有要按令牌种类藏起来的控件了;链接会话只多一条配对条。
const windows: Window[] = []
afterEach(async () => { await Promise.all(windows.splice(0).map(w => w.happyDOM.abort())) })
function boot(T: string) {
  const window = new Window({ url: 'https://fixture.test/m' }); windows.push(window)
  const document = window.document; document.body.innerHTML = assembleMobilePage(readMobileSource).phone
  const env = { T, REMOTE: null, document, window, localStorage: window.localStorage, navigator: {} }
  const fns = new Function(...Object.keys(env), `${readMobileSource('boot.js')}\nreturn { ccLinkSession }`)(...Object.values(env)) as { ccLinkSession: () => boolean }
  return { document, ...fns }
}

describe('link session on the phone page', () => {
  it('a link token marks the page as a link session and shows the pairing bar; a device token does not', () => {
    const l = boot('t' + 'a'.repeat(32))
    expect(l.ccLinkSession()).toBe(true)
    expect(l.document.body.classList.contains('link-session')).toBe(true)
    expect((l.document.getElementById('pairbar') as unknown as HTMLElement).hidden).toBe(false)
    const d = boot('d' + 'b'.repeat(40))
    expect(d.ccLinkSession()).toBe(false)
    expect(d.document.body.classList.contains('link-session')).toBe(false)
    expect((d.document.getElementById('pairbar') as unknown as HTMLElement).hidden).toBe(true)
  })
  // 链接令牌对对话 / 记忆 / 电脑会话 / 终端会话的读在 5b 收回了:页面自己也不许再去读它们,
  // 只读配对前那一版要的几条(此刻、一起做的列表与详情、形象画)和「停下」。
  it('the page only calls the routes a link session may still reach', () => {
    const page = assembleMobilePage(readMobileSource).phone
    const called = new Set([...page.matchAll(/["'](\/(?:m|set)\/api\/[a-z/-]+)/g)].map(m => m[1]!))
    expect([...called].sort()).toEqual(['/m/api/art/presence', '/m/api/home', '/m/api/matter', '/m/api/matter/stop', '/m/api/matters', '/set/api/pair'])
  })
})

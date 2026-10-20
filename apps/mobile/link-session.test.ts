import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { assembleMobilePage } from './assemble'
import { readMobileSource } from './sources'

// 审计 10-20:/set 链接(10 分钟、能转发)打开的手机网页,看得见但不能送话给执行者 —— 门在服务端(LINK_EXCLUDED),
// 页面只按令牌种类换说法:补充 / 批准 / 回答 / 交办 / 接着做 换成一句「配对过的手机才能…」,旁边就是配对按钮。
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
  it('a link token marks the page as a link session; a device token does not', () => {
    const l = boot('t' + 'a'.repeat(32))
    expect(l.ccLinkSession()).toBe(true)
    expect(l.document.body.classList.contains('link-session')).toBe(true)
    const d = boot('d' + 'b'.repeat(40))
    expect(d.ccLinkSession()).toBe(false)
    expect(d.document.body.classList.contains('link-session')).toBe(false)
  })
  it('the page carries the notes and hides the device-only controls in a link session', () => {
    const page = assembleMobilePage(readMobileSource).phone
    expect(page).toContain('配对过的手机才能补充、批准或回答')
    expect(page).toContain('配对过的手机才能交办')
    expect(page).toContain('.link-session :is(#m-say-box,#entry-form,#m-controls [data-control],[data-handoff="confirm"],[data-ss-action="confirm"]){display:none}')
  })
})

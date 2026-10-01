// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { PHONE_COPY } from './phone-connect-copy.js'
import { linkView, makePhoneLinkFlow, mountOnboardPhone, mountPhoneConnect, newDevice, pairedLine } from './phone-connect.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL1 = `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
const dev = (id: string, label?: string, at = '2026-10-01T10:00:00.000Z') => ({ id, created_at: at, last_seen_at: at, ...(label ? { label } : {}) })

/** 假时钟 + 立即返回的 sleep;call 按脚本回。 */
function harness(script: { link: Array<object | Error>; devices: Array<object[] | Error> }) {
  let clock = 1_000_000
  const views: Array<{ kind: string; [k: string]: unknown }> = []
  const link = [...script.link], devices = [...script.devices]
  const next = <T,>(q: T[]) => (q.length > 1 ? q.shift()! : q[0]!)
  const call = vi.fn(async (method: string, path: string, _body?: unknown) => {
    if (method === 'POST' && path === '/v1/phone/link') { const r = next(link); if (r instanceof Error) throw r; return r }
    if (method === 'GET' && path === '/v1/phone/devices') { const r = next(devices); if (r instanceof Error) throw r; return { ok: true, devices: r } }
    throw new Error(`unexpected ${method} ${path}`)
  })
  const flow = makePhoneLinkFlow({ call, onView: v => views.push(v as never), now: () => clock, sleep: async ms => { clock += ms }, pollMs: 2000, startTimeoutMs: 45_000 })
  return { flow, views, call, tick: (ms: number) => { clock += ms } }
}
const ready = (expiresIn = 600_000) => ({ ok: true, state: 'ready', url: URL1, expires_at: 1_000_000 + expiresIn, check_code: 'FHWL' })

describe('文案(D6)', () => {
  it('zh / en 键一致、没有空串;中文不用半角逗号句号', () => {
    expect(Object.keys(PHONE_COPY.zh).sort()).toEqual(Object.keys(PHONE_COPY.en).sort())
    for (const v of [...Object.values(PHONE_COPY.zh), ...Object.values(PHONE_COPY.en)]) expect(v.trim()).not.toBe('')
    for (const [k, v] of Object.entries(PHONE_COPY.zh)) expect(v, k).not.toMatch(/[一-鿿][,.:?]|[,.:?][一-鿿]/)
  })
  it('桌面面向用户处不再有「手机扫码改设置」', () => {
    const files = ['index.html', 'main.js', ...readdirSync(join(SRC, 'modules')).filter(f => f.endsWith('.js')).map(f => join('modules', f))]
    for (const f of files) expect(readFileSync(join(SRC, f), 'utf8'), f).not.toContain('手机扫码改设置')
    expect(readFileSync(join(SRC, 'index.html'), 'utf8')).toMatch(/id="open-phone-settings"[^>]*>\s*连接手机\s*</)
  })
})

describe('linkView', () => {
  it('每个 state 一种画法;中继没开通不出码', () => {
    expect(linkView(ready() as never)).toEqual({ kind: 'qr', url: URL1, expiresAt: 1_600_000, checkCode: 'FHWL' })
    expect(linkView({ ok: false, state: 'starting' })).toEqual({ kind: 'starting' })
    expect(linkView({ ok: false, state: 'relay_not_configured' })).toEqual({ kind: 'notice', title: '手机连接服务还没开通', body: '开通之后，这里会出现二维码。' })
    expect(linkView({ ok: false, state: 'relay_unavailable' })).toMatchObject({ kind: 'notice', title: '手机连接服务这次没启动起来' })
    expect(linkView({ ok: false, state: 'remote_off' })).toMatchObject({ kind: 'notice', title: '手机连接没打开' })
    expect(linkView({ ok: false, state: 'no_owner' })).toEqual({ kind: 'notice', title: '先用微信扫码登录，再来连接手机。', body: '' })
  })
})

describe('出码前设备快照失败', () => {
  it('缝隙里配上的手机也认得(按创建时间),出码前就有的旧设备不算', async () => {
    // 假时钟起点 1_000_000ms = 1970-01-01T00:16:40Z
    const oldD = dev('old', 'Old phone', '1970-01-01T00:10:00.000Z')
    const newD = dev('new', 'Tendhearth · iPhone', '1970-01-01T00:20:00.000Z')
    const t = harness({ link: [ready()], devices: [new Error('down'), [oldD, newD]] })
    await t.flow.start()
    expect(t.views.at(-1)).toEqual({ kind: 'paired', line: '已连上 Tendhearth · iPhone' })
  })
})

describe('newDevice / pairedLine', () => {
  it('出码前没有的 id 才算新;多台取最新', () => {
    expect(newDevice(new Set(['a']), [dev('a')])).toBeNull()
    expect(newDevice(new Set(['a']), [dev('a'), dev('b', 'x', '2026-10-01T10:00:00.000Z'), dev('c', 'y', '2026-10-01T11:00:00.000Z')])?.id).toBe('c')
  })
  it('有名字说名字,没有说「已连上手机」', () => {
    expect(pairedLine(dev('b', 'Tendhearth · iPhone'))).toBe('已连上 Tendhearth · iPhone')
    expect(pairedLine(dev('b'))).toBe('已连上手机')
  })
})

describe('makePhoneLinkFlow', () => {
  it('ready ⇒ 出码 ⇒ 新设备出现 ⇒ 已连上;请求带 enable_remote: true', async () => {
    const h = harness({ link: [ready()], devices: [[dev('old')], [dev('old')], [dev('old'), dev('new1', 'Tendhearth · iPhone')]] })
    await h.flow.start()
    expect(h.views.map(v => v.kind)).toEqual(['loading', 'qr', 'paired'])
    expect(h.views.at(-1)).toEqual({ kind: 'paired', line: '已连上 Tendhearth · iPhone' })
    expect(h.call).toHaveBeenCalledWith('POST', '/v1/phone/link', { enable_remote: true })
  })
  it('starting ⇒ 重试;重启中请求抛错也继续等(Review Focus 2)⇒ ready', async () => {
    const h = harness({ link: [{ ok: false, state: 'starting' }, new Error('workbench_connection_unavailable'), ready()], devices: [[], [dev('n', 'Tendhearth · Android')]] })
    await h.flow.start()
    expect(h.views.map(v => v.kind)).toEqual(['loading', 'starting', 'starting', 'qr', 'paired'])
  })
  it('I1:每次 start() 只有第一次 POST 带 enable_remote: true,之后的轮询不带(免得反复触发重启)', async () => {
    const h = harness({ link: [{ ok: false, state: 'starting' }, { ok: false, state: 'starting' }, ready()], devices: [[], [dev('n', 'x')]] })
    await h.flow.start()
    const posts = h.call.mock.calls.filter(c => c[0] === 'POST')
    expect(posts.length).toBe(3)
    expect(posts[0]![2]).toEqual({ enable_remote: true })
    for (const p of posts.slice(1)) expect(p[2]).toEqual({})
    // 再来一轮 start():第一次又带上
    h.call.mockClear()
    await h.flow.start()
    expect(h.call.mock.calls.filter(c => c[0] === 'POST')[0]![2]).toEqual({ enable_remote: true })
  })
  it('一上来就抛错(不是重启中)⇒ 报错,不重试', async () => {
    const h = harness({ link: [new Error('boom')], devices: [[]] })
    await h.flow.start()
    expect(h.views.at(-1)).toEqual({ kind: 'error', text: '生成不了二维码：boom' })
    expect(h.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1)
  })
  it('45 秒还在 starting ⇒ 「还没打开」', async () => {
    const h = harness({ link: [{ ok: false, state: 'starting' }], devices: [[]] })
    await h.flow.start()
    expect(h.views.at(-1)).toEqual({ kind: 'notice', title: '手机连接还没打开。稍后再点一次「连接手机」。', body: '' })
  })
  it('到期没人扫 ⇒ 过期', async () => {
    const h = harness({ link: [ready(5_000)], devices: [[]] })
    await h.flow.start()
    expect(h.views.at(-1)).toEqual({ kind: 'expired' })
  })
  it('新设备还没名字 ⇒ 再等两轮;仍没有 ⇒ 「已连上手机」', async () => {
    const h = harness({ link: [ready()], devices: [[], [dev('n')]] })
    await h.flow.start()
    expect(h.views.at(-1)).toEqual({ kind: 'paired', line: '已连上手机' })
    expect(h.call.mock.calls.filter(c => c[0] === 'GET').length).toBe(4)   // 出码前快照 + 3 轮(看到没名字、再等、放弃等)
  })
  it('出码之后轮询只 GET 设备列表,绝不再 POST(每次 POST 都会作废上一个码)', async () => {
    const h = harness({ link: [ready()], devices: [[], [], [], [], [dev('n', 'x')]] })
    await h.flow.start()
    expect(h.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1)
    expect(h.call.mock.calls.filter(c => c[0] === 'GET').length).toBeGreaterThan(3)
  })
  it('stop 之后不再回调', async () => {
    const h = harness({ link: [{ ok: false, state: 'starting' }], devices: [[]] })
    const p = h.flow.start()
    h.flow.stop()
    await p
    expect(h.views.map(v => v.kind)).toEqual(['loading'])
  })
})

describe('mountPhoneConnect(弹层)', () => {
  it('出码、可复制;连上后按钮变「完成」;设备名按文字渲染(Review Focus 3)', async () => {
    document.body.innerHTML = ''
    const h = harness({ link: [ready()], devices: [[], [dev('x', '<img src=x onerror=alert(1)>')]] })
    const writeClipboard = vi.fn(async () => {})
    const m = mountPhoneConnect({ call: h.call, renderQr: async t => `<svg data-text="${t.length}"></svg>`, writeClipboard, flowDeps: { now: () => 1_000_000, sleep: async () => {}, labelWaits: 0 } })
    m.open()
    await vi.waitFor(() => expect(document.querySelector('#phone-connect-paired')).not.toBeNull())
    expect(document.querySelector('#phone-connect-paired')!.textContent).toBe('已连上 <img src=x onerror=alert(1)>')
    expect(document.querySelector('#phone-settings-modal img')).toBeNull()
    expect(document.querySelector('#phone-connect-close')!.textContent).toBe('完成')
    expect(document.querySelector('#phone-connect-title')!.textContent).toBe('连接手机')
    m.close()
    expect(document.querySelector('#phone-settings-modal')).toBeNull()
  })
  it('Esc 关闭并停轮询', async () => {
    document.body.innerHTML = ''
    const h = harness({ link: [ready()], devices: [[]] })
    const m = mountPhoneConnect({ call: h.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) } })
    m.open()
    await vi.waitFor(() => expect(document.querySelector('#phone-connect-qr')).not.toBeNull())
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('#phone-settings-modal')).toBeNull()
    const n = h.call.mock.calls.length
    await new Promise(r => setTimeout(r, 30))
    expect(h.call.mock.calls.length).toBeLessThanOrEqual(n + 1)
  })
})

describe('mountOnboardPhone(引导页,裁决 3)', () => {
  function host() {
    document.body.innerHTML = `<div id="onboard-phone" hidden><h3 id="onboard-phone-title"></h3><div id="onboard-phone-qr"></div><p id="onboard-phone-status"></p><p id="onboard-phone-check" hidden></p><button id="onboard-phone-renew" hidden></button><p id="onboard-phone-later"></p></div>`
    return document.getElementById('onboard-phone')!
  }
  const fast = { now: () => 1_000_000, sleep: async () => {} }
  const posts = (t: { call: { mock: { calls: unknown[][] } } }) => t.call.mock.calls.filter(c => c[0] === 'POST').length
  it('拿到 ready 才显示整块;文案来自文案模块', async () => {
    const h = host()
    const t = harness({ link: [ready()], devices: [[], [dev('n', 'Tendhearth · iPhone')]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg id="q"></svg>', flowDeps: fast })
    expect(h.hidden).toBe(true)
    m.sync({ active: true, alive: true })
    await vi.waitFor(() => expect(document.getElementById('onboard-phone-status')!.textContent).toBe('已连上 Tendhearth · iPhone'))
    expect(h.hidden).toBe(false)
    expect(document.getElementById('onboard-phone-title')!.textContent).toBe('连接手机')
    expect(document.getElementById('onboard-phone-later')!.textContent).toBe('之后再连也可以：在设置里点「连接手机」。')
    m.sync({ active: false, alive: true })
  })
  it('starting ⇒ 亮出整块并说 CC 会重启一下;出码后换成码;离开后迟到的视图不能亮出来', async () => {
    const h = host()
    const t = harness({ link: [{ ok: false, state: 'starting' }, ready()], devices: [[]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 300)) } })
    m.sync({ active: true, alive: true })
    const st = document.getElementById('onboard-phone-status')!
    await vi.waitFor(() => expect(st.textContent).toBe('正在准备连接手机的二维码，CC 会重启一下……'))
    expect(h.hidden).toBe(false)
    await vi.waitFor(() => expect(st.textContent).toBe('用手机相机扫一下。10 分钟内有效，只能用一次。'))
    m.sync({ active: false, alive: true })
    expect(h.hidden).toBe(true)
    await new Promise(r => setTimeout(r, 80))
    expect(h.hidden).toBe(true)
  })
  it('中继没开通 ⇒ 整块一直藏着', async () => {
    const h = host()
    const t = harness({ link: [{ ok: false, state: 'relay_not_configured' }], devices: [[]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: fast, retryMs: 100_000 })
    m.sync({ active: true, alive: true })
    await vi.waitFor(() => expect(t.call).toHaveBeenCalledWith('POST', '/v1/phone/link', { enable_remote: true }))
    await new Promise(r => setTimeout(r, 10))
    expect(h.hidden).toBe(true)
    m.sync({ active: false, alive: true })
  })
  it('daemon 没活 ⇒ 不请求;离开这一步 ⇒ 停、藏;同一步里重复 sync 不重开;出码后只轮询设备、不再 POST', async () => {
    const h = host()
    const t = harness({ link: [ready()], devices: [[]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) } })
    m.sync({ active: true, alive: false })
    expect(t.call).not.toHaveBeenCalled()
    m.sync({ active: true, alive: true })
    m.sync({ active: true, alive: true })
    await vi.waitFor(() => expect(h.hidden).toBe(false))
    await new Promise(r => setTimeout(r, 40))
    expect(posts(t)).toBe(1)
    expect(t.call.mock.calls.filter(c => c[0] === 'GET').length).toBeGreaterThan(1)
    m.sync({ active: false, alive: true })
    expect(h.hidden).toBe(true)
  })
  it('第一次失败(非 starting)⇒ 窗口重新聚焦时重试,出码', async () => {
    const h = host()
    const t = harness({ link: [new Error('boom'), ready()], devices: [[]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) }, retryMs: 100_000 })
    m.sync({ active: true, alive: true })
    await vi.waitFor(() => expect(posts(t)).toBe(1))
    await new Promise(r => setTimeout(r, 10))
    expect(h.hidden).toBe(true)
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(h.hidden).toBe(false))
    expect(posts(t)).toBe(2)
    m.sync({ active: false, alive: true })
  })
  it('第一次是 notice ⇒ 每隔 retryMs 重试;离开这一步 ⇒ 不再重试', async () => {
    const h = host()
    const t = harness({ link: [{ ok: false, state: 'relay_unavailable' }, ready()], devices: [[]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) }, retryMs: 20 })
    m.sync({ active: true, alive: true })
    await vi.waitFor(() => expect(h.hidden).toBe(false))
    expect(posts(t)).toBe(2)
    m.sync({ active: false, alive: true })
    const n = t.call.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    await new Promise(r => setTimeout(r, 60))
    expect(t.call.mock.calls.length).toBe(n)
  })
  it('码在显示时 ⇒ 聚焦 / 定时都不再 POST(每次 POST 会作废上一个码)', async () => {
    const h = host()
    const t = harness({ link: [ready()], devices: [[]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) }, retryMs: 10 })
    m.sync({ active: true, alive: true })
    await vi.waitFor(() => expect(h.hidden).toBe(false))
    window.dispatchEvent(new Event('focus'))
    await new Promise(r => setTimeout(r, 50))
    expect(posts(t)).toBe(1)
    m.sync({ active: false, alive: true })
  })
})

describe('核对码(Task 9 fix round 1:共用中继上分清「我的电脑」)', () => {
  it('linkView:daemon 给的 check_code 合格才用;缺了 / 畸形 ⇒ null(不显示,不瞎编)', () => {
    expect(linkView({ ...ready(), check_code: undefined } as never)).toMatchObject({ kind: 'qr', checkCode: null })
    expect(linkView({ ...ready(), check_code: 'fhwl' } as never)).toMatchObject({ checkCode: null })
    expect(linkView({ ...ready(), check_code: 'O0I1' } as never)).toMatchObject({ checkCode: null })
    expect(linkView({ ...ready(), check_code: '<b>X' } as never)).toMatchObject({ checkCode: null })
  })
  it('文案:zh「核对码 XXXX」/ en「Check code XXXX」', () => {
    expect(PHONE_COPY.zh.checkCode.replace('{code}', 'FHWL')).toBe('核对码 FHWL')
    expect(PHONE_COPY.en.checkCode.replace('{code}', 'FHWL')).toBe('Check code FHWL')
  })
  it('弹层:码下面显示核对码;没有核对码就不出那一行', async () => {
    document.body.innerHTML = ''
    const h = harness({ link: [ready()], devices: [[]] })
    const m = mountPhoneConnect({ call: h.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) } })
    m.open()
    await vi.waitFor(() => expect(document.querySelector('#phone-connect-check')?.textContent).toBe('核对码 FHWL'))
    m.close()
    const h2 = harness({ link: [{ ...ready(), check_code: undefined }], devices: [[]] })
    const m2 = mountPhoneConnect({ call: h2.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) } })
    m2.open()
    await vi.waitFor(() => expect(document.querySelector('#phone-connect-qr')).not.toBeNull())
    expect(document.querySelector('#phone-connect-check')).toBeNull()
    m2.close()
  })
  it('引导页:出码时显示核对码,连上 / 过期后藏起来', async () => {
    document.body.innerHTML = `<div id="onboard-phone" hidden><h3 id="onboard-phone-title"></h3><div id="onboard-phone-qr"></div><p id="onboard-phone-status"></p><p id="onboard-phone-check" hidden></p><button id="onboard-phone-renew" hidden></button><p id="onboard-phone-later"></p></div>`
    const host = document.getElementById('onboard-phone')!
    const t = harness({ link: [ready()], devices: [[], [], [dev('n', 'Tendhearth · iPhone')]] })
    const m = mountOnboardPhone({ host, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 30)) } })
    m.sync({ active: true, alive: true })
    const check = document.getElementById('onboard-phone-check')!
    await vi.waitFor(() => expect(check.hidden).toBe(false))
    expect(check.textContent).toBe('核对码 FHWL')
    await vi.waitFor(() => expect(document.getElementById('onboard-phone-status')!.textContent).toBe('已连上 Tendhearth · iPhone'))
    expect(check.hidden).toBe(true)
    m.sync({ active: false, alive: true })
  })
  it('index.html 引导块里有核对码那一行(默认藏着)', () => {
    expect(readFileSync(join(SRC, 'index.html'), 'utf8')).toMatch(/<p id="onboard-phone-check" class="qr-check" hidden><\/p>/)
  })
})

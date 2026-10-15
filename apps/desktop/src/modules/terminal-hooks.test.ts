// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { HOOKS_CONFIRM, HOOKS_INSTALL_PATH, makeHooksAction, mountOnboardTerminal, runHooksInstall } from './terminal-hooks.js'
import { mountNowConnections } from './now-connections.js'

const settle = () => new Promise(r => setTimeout(r, 0))
const host = () => { document.body.innerHTML = '<div id="h"></div>'; return document.getElementById('h') as HTMLElement }
const click = (root: HTMLElement, text: string) => {
  const b = [...root.querySelectorAll('button')].find(x => x.textContent === text)
  if (!b) throw new Error(`no button ${text}: ${root.innerHTML}`)
  b.click()
}
const termCap = (over: Record<string, unknown> = {}) => ({ id: 'terminal', name: '终端里的 Claude Code / Codex', state: 'off', code: 'terminal.not_connected', reason: '装了 Claude Code / Codex，还没接上。', action: { label: '接上', where: 'desktop', run: 'cli_hooks_install' }, ...over })
const snap = (caps: unknown[]) => ({ generatedAt: 1, sources: [], computers: [{ id: 'home', label: 'Mac', online: true, since: null, version: null }], recent: [], outputs: [], capabilities: caps })

describe('runHooksInstall', () => {
  it('POST 空正文;路由说 ok:false ⇒ 带第一条错误;抛错也不抛出来', async () => {
    const call = vi.fn().mockResolvedValueOnce({ ok: true, results: [], status: [] })
    expect(await runHooksInstall(call)).toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith('POST', HOOKS_INSTALL_PATH, {})
    expect(await runHooksInstall(vi.fn().mockResolvedValue({ ok: false, results: [{ ok: true }, { ok: false, error: 'cannot parse x' }] }))).toEqual({ ok: false, error: 'cannot parse x' })
    expect(await runHooksInstall(vi.fn().mockRejectedValue(new Error('route_not_allowed')))).toEqual({ ok: false, error: 'route_not_allowed' })
  })
})

describe('makeHooksAction —— 先确认,点了确定才调路由', () => {
  it('按钮 → 一句确认 + 确定 / 取消;取消不调;确定调一次并 onDone', async () => {
    const h = host()
    const call = vi.fn().mockResolvedValue({ ok: true, results: [], status: [] })
    const onDone = vi.fn()
    const a = makeHooksAction({ call, rerender: () => h.replaceChildren(a.node('接上')), onDone })
    h.replaceChildren(a.node('接上'))
    click(h, '接上')
    expect(h.querySelector('.hooks-confirm')!.textContent).toBe(HOOKS_CONFIRM)
    expect(HOOKS_CONFIRM).toContain('~/.claude/settings.json')
    expect(HOOKS_CONFIRM).toContain('撤掉')
    click(h, '取消')
    expect(call).not.toHaveBeenCalled()
    click(h, '接上'); click(h, '确定接上')
    await settle()
    expect(call).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })
  it('失败 ⇒ 说没接上 + 原因,能再试', async () => {
    const h = host()
    const a = makeHooksAction({ call: vi.fn().mockRejectedValue(new Error('boom')), rerender: () => h.replaceChildren(a.node('修复')), onDone: vi.fn() })
    h.replaceChildren(a.node('修复'))
    click(h, '修复'); click(h, '确定修复')
    await settle()
    expect(h.querySelector('.hooks-error')!.textContent).toBe('没接上：boom')
    click(h, '再修复一次')
    expect(a.state.phase).toBe('confirm')
  })
})

describe('「CC 现在怎么样」里的终端那一行', () => {
  it('接上之后重拉一次,行变成已接上;30 秒刷新不会冲掉「确认中」', async () => {
    const h = host()
    const call = vi.fn(async (method: string, path: string) => {
      if (method === 'POST') return { ok: true, results: [], status: [] }
      return path === '/v1/connections' && call.mock.calls.filter(c => c[0] === 'POST').length > 0
        ? snap([termCap({ state: 'ok', code: 'terminal.ok', reason: '已接上，最近 7 天 0 个终端会话。', action: undefined })])
        : snap([termCap()])
    })
    const c = mountNowConnections({ host: h, call: call as never, now: () => 1 })
    await c.refresh()
    const row = () => h.querySelector('.nc-capability') as HTMLElement
    click(row(), '接上')
    await c.refresh()   // 定时刷新整块重画
    expect(row().querySelector('.hooks-confirm')).not.toBeNull()
    click(row(), '确定接上')
    await settle(); await settle()
    expect(call).toHaveBeenCalledWith('POST', '/v1/cli/hooks/install', {})
    expect(row().textContent).toContain('已接上')
    expect(row().querySelector('button')).toBeNull()
  })
  it('接了一部分(ok 行)也给按钮;别的 ok 行照旧没有动作', async () => {
    const h = host()
    const call = vi.fn().mockResolvedValue(snap([termCap({ state: 'ok', code: 'terminal.partial' }), { id: 'phone', name: '手机', state: 'ok', code: 'phone.ok', reason: '已连接 1 台。', action: { label: 'x', where: 'desktop' } }]))
    const c = mountNowConnections({ host: h, call, now: () => 1 })
    await c.refresh()
    const rows = h.querySelectorAll('.nc-capability')
    expect(rows[0]!.querySelector('button')!.textContent).toBe('接上')
    expect(rows[1]!.querySelector('button, .nc-action-hint')).toBeNull()
  })
})

describe('mountOnboardTerminal(引导页最后一步,可选)', () => {
  it('不在这一步 / daemon 没活 ⇒ 不问;有没接上的 ⇒ 出现;接上后说一句', async () => {
    const h = host()
    const call = vi.fn(async (method: string) => method === 'POST' ? { ok: true, results: [], status: [] } : snap([termCap()]))
    const m = mountOnboardTerminal({ host: h, call })
    m.sync({ active: false, alive: true }); m.sync({ active: true, alive: false })
    expect(call).not.toHaveBeenCalled()
    expect(h.hidden).toBe(true)
    m.sync({ active: true, alive: true })
    await settle()
    expect(h.hidden).toBe(false)
    expect(h.textContent).toContain('可选')
    click(h, '接上'); click(h, '确定接上')
    await settle()
    expect(h.textContent).toContain('接上了')
    m.sync({ active: false, alive: true })
    expect(h.hidden).toBe(true)
  })
  it('已接上 / 没装 ⇒ 不出现;读失败最多再问两次', async () => {
    const h = host()
    const ok = mountOnboardTerminal({ host: h, call: vi.fn().mockResolvedValue(snap([termCap({ state: 'ok', code: 'terminal.ok', action: undefined })])) })
    ok.sync({ active: true, alive: true }); await settle()
    expect(h.hidden).toBe(true)
    const failing = vi.fn().mockRejectedValue(new Error('503'))
    const m = mountOnboardTerminal({ host: h, call: failing })
    for (let i = 0; i < 5; i++) { m.sync({ active: true, alive: true }); await settle() }
    expect(failing).toHaveBeenCalledTimes(3)
    expect(h.hidden).toBe(true)
  })
})

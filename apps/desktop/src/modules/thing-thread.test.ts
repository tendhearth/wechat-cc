// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { mountTerminalThread } from './terminal-thread.js'
import { mountThingThread } from './thing-thread.js'
import type { Place } from './thing-thread-model.js'

it('终端会话卡在请求补全后把允许这一步放回先不做右边', async () => {
  const host = document.createElement('section')
  document.body.replaceChildren(host)
  const place: Place = {
    key: 'p:0000000000000000', name: '花园', line: null, status: null, waiting: null, unseen: false, moving: false,
    updatedAt: 100, matterIds: [], messageIds: [], sessionIds: ['terminal'],
  }
  let truncated = true
  const thread = mountTerminalThread({
    host, id: 'terminal', agent: 'claude', place: () => place, ended: () => false, onStatus() {}, onWaiting() {},
    call: async (_method, path) => {
      if (path.startsWith('/v1/cli/sessions')) {
        return { sessions: [{
          session_id: 'terminal', status: 'waiting', pending: {
            actionable: true, hash: 'req01', tool: 'Bash', cwd: '/work',
            display: { body: { kind: 'command', command: 'printf sample' }, truncated },
          },
        }] }
      }
      if (path.startsWith('/v1/cli/activity')) return { items: [] }
      throw Error(path)
    },
  })
  const labels = () => [...host.querySelectorAll('.thing-waiting:not([hidden]) .place-ask button')].map(button => button.textContent)
  try {
    await expect.poll(labels).toEqual(['先不做'])
    truncated = false
    await thread.refresh()
    expect(labels()).toEqual(['先不做', '允许这一步'])
    expect(host.querySelector('.place-ask .place-allow')?.textContent).toBe('允许这一步')
  } finally {
    thread.destroy()
    host.remove()
  }
})

it('终端会话卡用大白话说要做什么，摘要里保留原始工具名', async () => {
  const host = document.createElement('section')
  document.body.replaceChildren(host)
  const place: Place = {
    key: 'p:0000000000000000', name: '花园', line: null, status: null, waiting: null, unseen: false, moving: false,
    updatedAt: 100, matterIds: [], messageIds: [], sessionIds: ['terminal'],
  }
  const thread = mountTerminalThread({
    host, id: 'terminal', agent: 'codex', place: () => place, ended: () => false, onStatus() {}, onWaiting() {},
    call: async (_method, path) => {
      if (path.startsWith('/v1/cli/sessions')) return { sessions: [{
        session_id: 'terminal', source: 'codex', displayName: 'Codex', status: 'waiting',
        pending: { actionable: true, hash: 'req01', tool: 'Read', summary: '读备份目录？' },
      }] }
      if (path.startsWith('/v1/cli/activity')) return { items: [] }
      throw Error(path)
    },
  })
  try {
    await expect.poll(() => host.querySelector('.desk-waiting-question')?.textContent).toBe('Codex 想看一个文件')
    expect(host.querySelector('.approval-disclosure')?.textContent).toContain('工具：Read')
    expect(host.querySelector('.approval-panel')?.textContent).toBe('读备份目录？')
  } finally {
    thread.destroy()
    host.remove()
  }
})

it('终端会话卡在 CC 停止时仍能叫它起来，恢复后收起提示', async () => {
  const host = document.createElement('section')
  document.body.replaceChildren(host)
  const place: Place = {
    key: 'p:0000000000000000', name: '花园', line: null, status: null, waiting: null, unseen: false, moving: false,
    updatedAt: 100, matterIds: [], messageIds: [], sessionIds: ['terminal'],
  }
  const thread = mountTerminalThread({
    host, id: 'terminal', agent: 'codex', place: () => place, ended: () => false, onStatus() {}, onWaiting() {},
    call: async (_method, path) => {
      if (path.startsWith('/v1/cli/sessions')) return { sessions: [{
        session_id: 'terminal', status: 'waiting',
        pending: { actionable: true, hash: 'req01', tool: 'Read', summary: '读备份目录？' },
      }] }
      if (path.startsWith('/v1/cli/activity')) return { items: [] }
      throw Error(path)
    },
  })
  const setStopped = (stopped: boolean) => {
    document.documentElement.toggleAttribute('data-desk-cc-stopped', stopped)
    document.dispatchEvent(new Event('desk-cc-availability'))
  }
  try {
    await expect.poll(() => host.querySelector<HTMLElement>('.thing-waiting')?.hidden).toBe(false)
    setStopped(true)
    const notes = host.querySelectorAll<HTMLElement>('.desk-waiting-card .desk-offline-note')
    expect(notes).toHaveLength(1)
    const note = notes[0]!
    expect(note.hidden).toBe(false)
    expect(note.textContent).toContain('CC 没在运行，叫它起来以后才能回答。')
    const wake = note.querySelector<HTMLButtonElement>('[data-wake-cc]')!
    expect(wake.textContent).toBe('叫它起来')
    expect(wake.disabled).toBe(false)
    const deny = host.querySelector<HTMLButtonElement>('[data-place-decision="deny"]')!
    expect(deny.disabled).toBe(true)
    expect(deny.title).toBe('CC 没在运行')
    setStopped(false)
    expect(note.hidden).toBe(true)
    expect(deny.disabled).toBe(false)
    expect(deny.hasAttribute('title')).toBe(false)
  } finally {
    thread.destroy()
    setStopped(false)
    host.remove()
  }
})

it('直接打开页签名单以外的出处时，把它放到并排的最后', () => {
  const root = document.createElement('section')
  root.innerHTML = `<h1 class="thing-name"></h1><div class="thing-status">
    <span class="thing-agent"></span><span class="thing-state"></span></div>
    <div class="thing-sessions"></div><div class="thing-content"></div>`
  document.body.replaceChildren(root)
  const sessions: NonNullable<Place['sessions']> = Array.from({length: 30}, (_, i) =>
    ({sessionId: `recent-${i}`, agent: 'codex', status: 'replied', updatedAt: 100 - i, endedAt: null}))
  const place: Place = {
    key: 'p:0000000000000000', name: '花园', line: null, status: null, waiting: null, unseen: false, moving: false,
    updatedAt: 100, matterIds: [], messageIds: [], sessionIds: [...sessions.map(s => s.sessionId), 'earlier'], sessions,
  }
  const thread = mountThingThread({
    root, call: async () => ({}), openTask: async () => {}, closeTask() {}, home() {}, onSession() {}, onWaiting() {},
  })
  const visible = () => [...root.querySelectorAll<HTMLElement>('.thing-sessions > [data-thread-session]')]
  const keys = () => visible().map(tab => tab.dataset.threadSession)
  try {
    thread.open(place)
    const first = keys()
    expect(first.length).toBeGreaterThan(1)
    const target = thread.linkedItem(place, {kind: 'terminal', id: 'earlier'})!
    thread.open(place, target.key, target)
    expect(keys()).toEqual([...first.slice(0, -1), 'terminal:earlier'])
    expect(visible().at(-1)?.getAttribute('aria-pressed')).toBe('true')
    thread.setRoster([])
    expect(thread.current()?.id).toBe('earlier')
    expect(keys().at(-1)).toBe('terminal:earlier')
  } finally {
    thread.destroy()
  }
})

it.each([false, true])('桌面终端会话头按宿主与会话位置显示「到终端」(native=%s)', async focusEnabled => {
  const host = document.createElement('section')
  document.body.replaceChildren(host)
  const place: Place = {
    key: 'p:0000000000000000', name: '花园', line: null, status: null, waiting: null, unseen: false, moving: false,
    updatedAt: 100, matterIds: [], messageIds: [], sessionIds: ['terminal'],
  }
  let pos: object = { terminal: { bundle_id: 'com.googlecode.iterm2' } }
  let denied = false
  const thread = mountTerminalThread({
    host, focusEnabled, id: 'terminal', agent: 'claude', place: () => place, ended: () => false, onStatus() {}, onWaiting() {},
    call: async (_method, path, body) => {
      if (path.startsWith('/v1/cli/sessions')) return { sessions: [{ session_id: 'terminal', status: 'idle', ...pos }] }
      if (path === '/v1/cli/focus') {
        expect(body).toEqual({ session_id: 'terminal' })
        if (!denied) throw Error('offline')
        return { ok: true, method: 'app', reason: 'automation_denied' }
      }
      return { items: [] }
    },
  })
  const button = () => host.querySelector<HTMLButtonElement>('header:not([hidden]) [data-terminal-focus]')
  const status = () => host.querySelector('.terminal-focus [role=status]')?.textContent
  try {
    await thread.refresh()
    expect(button()).toBeNull()
    pos = { ...pos, can_focus: true }
    await expect.poll(async () => { await thread.refresh(); return !!button() }).toBe(focusEnabled)
    if (!focusEnabled) return
    button()!.click()
    await expect.poll(status).toBe('暂时打不开终端，请重试')
    denied = true
    button()!.click()
    await expect.poll(status).toContain('自动化')
  } finally {
    thread.destroy()
    host.remove()
  }
})

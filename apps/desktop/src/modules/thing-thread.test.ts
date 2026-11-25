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

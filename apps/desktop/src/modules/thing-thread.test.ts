// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { mountThingThread } from './thing-thread.js'
import type { Place } from './thing-thread-model.js'

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

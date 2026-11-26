// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitingOfflineNoteHtml } from './desk-page.js'
import { wireDeskWake } from './desk-wake.js'

const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!
const error = (selector: string) => document.querySelector<HTMLElement>(selector)!

let listeners: AbortController
beforeEach(() => {
  listeners = new AbortController()
  document.documentElement.setAttribute('data-desk-cc-stopped', '')
  document.body.innerHTML = `
    <div id="desk-waiting"><article id="first" class="desk-waiting-card" data-place-key="first" data-item-key="matter:first" data-request-id="q1">${waitingOfflineNoteHtml}</article></div>
    <section id="converse-root">
      <button type="button" data-wake-cc>叫 CC 起来</button>
      <p id="converse-wake-error" hidden>没叫起来。</p>
    </section>
    <article id="session">${waitingOfflineNoteHtml}</article>`
  document.querySelectorAll('[data-waiting-offline]').forEach(note => note.removeAttribute('hidden'))
})
afterEach(() => {
  listeners.abort()
  document.documentElement.removeAttribute('data-desk-cc-stopped')
  document.body.replaceChildren()
})

it('从纸条和会话卡唤醒失败时，只在发起处提示，对话区按钮用自己的提示', async () => {
  const wake = vi.fn(async () => { throw new Error('模拟启动失败') })
  wireDeskWake(wake, listeners.signal)
  const surfaces = [
    ['#first button', '#first [data-wake-cc-error]'],
    ['#session button', '#session [data-wake-cc-error]'],
    ['#converse-root button', '#converse-wake-error'],
  ] as const
  for (const [trigger, target] of surfaces) {
    button(trigger).click()
    await Promise.resolve()
    for (const [, status] of surfaces) expect(error(status).hidden, status).toBe(status !== target)
  }
  expect(wake).toHaveBeenCalledTimes(3)
})

it('发起唤醒的纸条重画后，失败提示仍跟着原请求', async () => {
  const attempt = Promise.withResolvers<void>()
  wireDeskWake(() => attempt.promise, listeners.signal)
  const card = error('#first')
  const replacement = card.cloneNode(true) as HTMLElement
  const other = card.cloneNode(true) as HTMLElement
  other.id = 'other'
  other.dataset.requestId = 'q2'
  button('#first button').click()
  card.replaceWith(other, replacement)
  attempt.resolve()
  await attempt.promise
  expect(error('#first [data-wake-cc-error]').hidden).toBe(false)
  expect(error('#other [data-wake-cc-error]').hidden).toBe(true)
})

it('唤醒期间现有和新画的按钮都禁用，结束后恢复各自原文', async () => {
  const attempt = Promise.withResolvers<void>()
  const wake = vi.fn(() => attempt.promise)
  wireDeskWake(wake, listeners.signal)
  const first = button('#first button')
  const conversation = button('#converse-root button')
  const session = button('#session button')
  let added: HTMLButtonElement
  first.click()
  try {
    for (const control of [first, conversation, session]) {
      expect(control.textContent).toBe('在叫…')
      expect(control.disabled).toBe(true)
    }
    conversation.click()
    error('#desk-waiting').insertAdjacentHTML('beforeend', `<article id="added">${waitingOfflineNoteHtml}</article>`)
    added = button('#added button')
    await vi.waitFor(() => {
      expect(added.textContent).toBe('在叫…')
      expect(added.disabled).toBe(true)
    })
    added.click()
    expect(wake).toHaveBeenCalledTimes(1)
  } finally {
    document.documentElement.removeAttribute('data-desk-cc-stopped')
    attempt.resolve()
    await attempt.promise
  }

  for (const control of [first, session, added]) {
    expect(control.textContent).toBe('叫它起来')
    expect(control.disabled).toBe(false)
  }
  expect(conversation.textContent).toBe('叫 CC 起来')
  expect(conversation.disabled).toBe(false)
  expect(error('#first [data-wake-cc-error]').hidden).toBe(true)
})

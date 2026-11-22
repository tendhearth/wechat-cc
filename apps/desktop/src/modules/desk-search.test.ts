// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDeskSearch } from './desk-search.js'
import { initWorkbenchPage, stopWorkbenchPolling } from './workbench.js'

beforeEach(() => {
  vi.useFakeTimers()
  document.documentElement.setAttribute('data-desk-wide', '')
  document.body.innerHTML = '<main class="dash-main"><div class="workbench-pane" data-workbench-view="search"><div id="workbench-root"></div></div></main>'
})

afterEach(() => {
  stopWorkbenchPolling()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-desk-wide')
  vi.useRealTimers()
})

const paths = ['/v1/places', '/v1/terminal/search', '/v1/matter/owner-chat/window', '/v1/workbench']
function setup(read: (path: string) => Promise<unknown> = async () => ({ places: [], hits: [], messages: [], tasks: [] })) {
  const requests: string[] = []
  const call = vi.fn(async (_method: string, path: string) => {
    const url = new URL(path, 'http://localhost')
    if (url.pathname === paths[0] || url.searchParams.get('q') === '花园') {
      requests.push(url.pathname)
      return read(url.pathname)
    }
    return { tasks: [] }
  })
  const deskSearch = createDeskSearch({ call, openProject: vi.fn(), openTerminal: vi.fn(), openMessage: vi.fn() })
  const mount = () => initWorkbenchPage({ deskSearch, invokeWorkbenchApi: call })
  mount()
  const field = () => document.querySelector<HTMLInputElement>('#wb-search')!
  const input = (text: string) => {
    field().value = text
    field().dispatchEvent(new Event('input', { bubbles: true }))
  }
  const compose = (phase: 'start' | 'end') => field().dispatchEvent(new Event('composition' + phase, { bubbles: true }))
  const expectOneRound = () => expect(requests.toSorted()).toEqual(paths.toSorted())
  return { requests, mount, field, input, compose, expectOneRound }
}

it('普通输入后，工作台轮询与同词输入事件不会重复搜索', async () => {
  const search = setup()
  await vi.advanceTimersByTimeAsync(0)
  search.input('花园')
  await vi.advanceTimersByTimeAsync(249)
  expect(search.requests).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  search.expectOneRound()
  search.input('花园')
  await vi.advanceTimersByTimeAsync(6_000)
  search.expectOneRound()
})

it('组字时不搜，组字结束和随后的同词输入只触发一轮', async () => {
  const search = setup()
  await vi.advanceTimersByTimeAsync(0)
  search.compose('start')
  search.input('花')
  await vi.advanceTimersByTimeAsync(300)
  expect(search.requests).toEqual([])
  search.input('花园')
  search.compose('end')
  await vi.advanceTimersByTimeAsync(250)
  search.expectOneRound()
  search.input('花园')
  await vi.advanceTimersByTimeAsync(250)
  search.expectOneRound()
})

it('回到同词搜索时交办重读一次，其他段和停留期间都不重读', async () => {
  let archived = false
  const search = setup(async path => ({
    places: [], hits: [], messages: [],
    tasks: path === '/v1/workbench' && !archived ? [{
      id: 'aabbccdd', title: '花园交办', path: '/offline/garden', providerId: 'codex',
      status: 'completed', createdAt: 1, updatedAt: 2,
    }] : [],
  }))
  await vi.advanceTimersByTimeAsync(0)
  search.input('花园')
  await vi.advanceTimersByTimeAsync(250)
  search.expectOneRound()
  expect(document.querySelector('.desk-search-tasks .wb-task')?.textContent).toContain('花园交办')
  stopWorkbenchPolling()
  archived = true
  search.mount()
  await vi.advanceTimersByTimeAsync(0)
  expect(search.field().value).toBe('花园')
  expect(document.querySelector('.desk-search-tasks .wb-task')).toBeNull()
  const afterReturn = [...paths, '/v1/workbench'].toSorted()
  expect(search.requests.toSorted()).toEqual(afterReturn)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(search.requests.toSorted()).toEqual(afterReturn)
})

it('交办读取尚未完成时重新挂载，接回原请求', async () => {
  const response = Promise.withResolvers<{ places: []; hits: []; messages: []; tasks: [] }>()
  const search = setup(path => path === '/v1/workbench' ? response.promise
    : Promise.resolve({ places: [], hits: [], messages: [], tasks: [] }))
  await vi.advanceTimersByTimeAsync(0)
  search.input('花园')
  await vi.advanceTimersByTimeAsync(250)
  search.mount()
  response.resolve({ places: [], hits: [], messages: [], tasks: [] })
  await vi.advanceTimersByTimeAsync(3_000)
  expect(document.querySelector('.desk-search-empty')?.textContent).toBe('没有找到「花园」。')
  search.expectOneRound()
})

it.each([
  ['/v1/terminal/search', '[data-desk-search-section="terminals"]'],
  ['/v1/workbench', '.desk-search-tasks'],
])('%s 失败提示留到用户重读，且只重读这一段', async (route, section) => {
  let attempts = 0
  const search = setup(async path => {
    if (path === route && ++attempts === 1) throw new Error('unavailable')
    return { places: [], hits: [], messages: [], tasks: [] }
  })
  await vi.advanceTimersByTimeAsync(0)
  search.input('花园')
  await vi.advanceTimersByTimeAsync(250)
  search.mount()
  search.input('花园')
  await vi.advanceTimersByTimeAsync(3_000)
  const onReturn = route === '/v1/workbench' ? paths : [...paths, '/v1/workbench']
  expect(search.requests.toSorted()).toEqual(onReturn.toSorted())
  const retry = document.querySelector<HTMLButtonElement>(section + ' .desk-search-note button')
  expect(retry?.textContent).toBe('重新读取')
  retry?.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(search.requests.toSorted()).toEqual([...onReturn, route].toSorted())
  expect(document.querySelector(section + ' .desk-search-note')).toBeNull()
})

it('清除按钮清空搜索框并将焦点留在框内', async () => {
  const search = setup()
  await vi.advanceTimersByTimeAsync(0)
  search.input('花园')
  const button = document.querySelector<HTMLButtonElement>('.desk-search-clear')!
  expect(button.getAttribute('aria-label')).toBe('清除')
  expect(button.hidden).toBe(false)
  button.click()
  await vi.advanceTimersByTimeAsync(250)
  expect(search.field().value).toBe('')
  expect(document.activeElement).toBe(search.field())
  expect(document.querySelector<HTMLButtonElement>('.desk-search-clear')?.hidden).toBe(true)
  expect(search.requests).toEqual([])
})

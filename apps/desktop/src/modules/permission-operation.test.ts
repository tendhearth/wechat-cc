// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { PermissionDisplay } from '../../../../packages/protocol/src/permission-display'
import { renderPermissionOperation } from './permission-operation.js'

function render(body: PermissionDisplay['body'], options?: Parameters<typeof renderPermissionOperation>[1], extra?: PermissionDisplay['extra']) {
  const root = document.createElement('div')
  root.innerHTML = renderPermissionOperation({ body, extra }, options)
  return root
}

it('lays out the command prompt separately and expands everything after eight lines', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
  const root = render({ kind: 'command', command: lines.join('\r\n') })
  expect(root.querySelector('[data-kind="command"] .approval-command > span')?.textContent).toBe('$ ')
  expect(root.querySelector('.approval-source')?.textContent).toBe(lines.slice(0, 8).join('\n'))
  const more = root.querySelector('details')!
  expect(more.open).toBe(false)
  expect(more.querySelector('summary')?.textContent).toBe('还有 2 行 · 看全部')
  more.querySelector('summary')?.click()
  expect(more.open).toBe(true)
  expect(more.querySelector('.approval-source')?.textContent).toBe(lines.slice(8).join('\n'))
})

it('folds each edit independently after twelve lines and keeps the replace-all label', () => {
  const before = Array.from({ length: 12 }, (_, i) => `old ${i + 1}`).join('\r')
  const root = render({ kind: 'edit', path: '/work/src/a.ts', replaceAll: true,
    changes: [{ before, after: 'new' }, { before: 'old', after: 'next', path: '/work/src/b.ts' }],
  }, { cwd: '/work' })
  expect(root.querySelector('.approval-path')?.textContent).toBe('src/a.ts（全部替换）')
  const [first, second] = root.querySelectorAll('.approval-change')
  expect(first!.querySelectorAll('.approval-diff:not(details *) [data-line="deleted"]')).toHaveLength(12)
  expect(first!.querySelector('[data-line="deleted"]')?.textContent).toBe('− old 1')
  expect(first!.querySelector('details [data-line="added"]')?.textContent).toBe('+ new')
  expect(second!.querySelector('.approval-path')?.textContent).toBe('src/b.ts')
  expect(second!.querySelector('[data-line="added"]')?.textContent).toBe('+ next')
})

it('renders writes and each patch file with the review diff classes and shows rename destinations', () => {
  const write = render({ kind: 'write', path: '/work/a', content: 'new\r\nnext' }, { projectPath: '/work' })
  expect(write.querySelector('[data-kind="write"] .approval-path')?.textContent).toBe('a')
  expect([...write.querySelectorAll('.wb-review-diff [data-line="added"]')].map(row => row.textContent)).toEqual(['+ new', '+ next'])
  const patch = render({ kind: 'patch', files: [
    { path: '/work/a', movePath: '/work/b', change: 'move', diff: '@@\r-old\r+new' },
    { path: '/elsewhere/c', change: 'delete', diff: '-gone' },
  ] }, { projectPath: '/work' })
  expect([...patch.querySelectorAll('[data-kind="patch"] .approval-path')].map(path => path.textContent)).toEqual(['a（改名 → b）', '/elsewhere/c（删除）'])
  expect([...patch.querySelectorAll('.wb-review-diff [data-line]')].map(row => row.textContent)).toEqual(['@@', '−old', '+new', '−gone'])
})

it('renders a full URL, a quoted query, an extra table without the panel and raw text', () => {
  const url = render({ kind: 'url', url: 'https://example.test/a?q=b&n=1', prompt: '列出标题' })
  expect(url.querySelector('[data-kind="url"] .approval-source')?.textContent).toBe('https://example.test/a?q=b&n=1')
  expect(url.querySelector('.approval-meta')?.textContent).toBe('列出标题')
  const query = render({ kind: 'query', query: '天气预报' })
  expect(query.querySelector('[data-kind="query"] .approval-source')?.textContent).toBe('“天气预报”')
  const fields = render({ kind: 'fields', fields: [{ name: 'mode', value: 'read\r\nonly' }] },
    {}, [{ name: 'limit', value: '10' }])
  expect(fields.querySelector('[data-kind="fields"] dl dt')?.textContent).toBe('mode')
  expect(fields.querySelector('[data-kind="fields"] dl dd')?.textContent).toBe('read\nonly')
  expect(fields.querySelector('.approval-panel .approval-extra')).toBeNull()
  expect(fields.querySelector('.approval-extra dl dd')?.textContent).toBe('10')
  const text = render({ kind: 'text', text: '\r\nopaque' }, { raw: '\r\nopaque' })
  expect(text.querySelector('[data-kind="text"] .approval-source')?.textContent).toBe('\nopaque')
  expect(text.querySelector('details summary')?.textContent).toBe('看完整原文')
  expect(text.querySelector('details .approval-source')?.textContent).toBe('\nopaque')
})

it('uses only the supplied directory, and hides full-content controls for incomplete data', () => {
  const body = { kind: 'command', command: 'line\r\n'.repeat(10), cwd: '/unverified' } as const
  expect(render(body, { cwd: '/verified', projectPath: '/project' }).querySelector('.approval-meta')?.textContent).toBe('在 /verified')
  expect(render(body, { projectPath: '/project' }).querySelector('.approval-meta')?.textContent).toBe('项目目录 /project')
  expect(render(body).querySelector('.approval-meta')).toBeNull()
  const root = document.createElement('div')
  root.innerHTML = renderPermissionOperation({ body, truncated: true }, { raw: 'legacy' })
  expect(root.querySelector('.approval-meta')?.textContent).toBe('这里可能不是全部内容。')
  expect(root.querySelectorAll('summary')).toHaveLength(0)
  expect(root.querySelector('.approval-source')?.textContent?.replace(/\r\n?/g, '\n').split('\n')).toHaveLength(8)
})

it('keeps command, diff, paths and raw source as literal text nodes', () => {
  const hostile = '<script>window.approvalRan=1</script><img src=x onerror="window.approvalRan=2">\' "&'
  const command = render({ kind: 'command', command: hostile }, { raw: hostile })
  const edit = render({ kind: 'edit', path: '/work/' + hostile, changes: [{ before: hostile, after: hostile }] }, { cwd: '/work' })
  for (const [root, selectors] of [[command, ['.approval-command .approval-source', 'details .approval-source']], [edit, ['.approval-path', '[data-line="deleted"]', '[data-line="added"]']]] as const) {
    expect(root.querySelectorAll('script,img,[onerror]')).toHaveLength(0)
    for (const selector of selectors) {
      const node = root.querySelector(selector)!
      expect(node.childNodes).toHaveLength(1)
      expect(node.firstChild?.nodeType).toBe(Node.TEXT_NODE)
      expect(node.textContent?.endsWith(hostile)).toBe(true)
    }
  }
})

it('folds writes and patch files at twelve diff lines, with the last line available on expansion', () => {
  const lines = Array.from({ length: 13 }, (_, i) => `+line ${i + 1}`)
  const panels = [
    render({ kind: 'write', path: 'sample', content: lines.map(line => line.slice(1)).join('\r\n') }),
    render({ kind: 'patch', files: [{ path: 'sample', change: 'update', diff: lines.join('\r\n') }] }),
  ]
  for (const panel of panels) {
    expect(panel.querySelector('.approval-diff')?.querySelectorAll('[data-line]')).toHaveLength(12)
    const more = panel.querySelector('details')!
    expect(more.open).toBe(false)
    expect(more.querySelector('summary')?.textContent).toBe('还有 1 行 · 看全部')
    more.querySelector('summary')?.click()
    expect(more.open).toBe(true)
    expect(more.querySelectorAll('[data-line="added"]')).toHaveLength(1)
    expect(more.querySelector('[data-line="added"]')?.textContent).toMatch(/line 13$/)
  }
})

it('folds text and field values at eight lines and keeps the rest in the disclosure', () => {
  const lines = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`)
  const raw = lines.join('\r\n')
  const panels = [render({ kind: 'text', text: raw }), render({ kind: 'fields', fields: [{ name: 'field', value: raw }] })]
  for (const panel of panels) {
    expect(panel.querySelector('.approval-source')?.textContent).toBe(lines.slice(0, 8).join('\n'))
    expect(panel.querySelector('details summary')?.textContent).toBe('还有 1 行 · 看全部')
    expect(panel.querySelector('details .approval-source')?.textContent).toBe('line 9')
  }
})

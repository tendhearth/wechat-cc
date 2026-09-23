import { describe, expect, it } from 'vitest'
import { renderWorkbenchArtifactText } from './workbench.js'
import { renderReviewFileDiff } from './workbench-code-review.js'

const mime = 'application/vnd.cc.workbench-review+json'
const report = (overrides = {}) => ({ version: 1, scope: 'working-tree-before-after', startedAt: 1_780_000_000_000, finishedAt: 1_780_000_060_000, headBefore: 'a'.repeat(40), headAfter: 'b'.repeat(40), status: 'complete', preexistingPaths: [], notes: [], files: [], ...overrides })
const render = (value: unknown) => renderWorkbenchArtifactText('本轮文件对比.json', mime, JSON.stringify(value))

describe('saved code review artifact preview', () => {
  it('renders unified changes with explicit scope, file kinds, and pre-existing attribution limits', () => {
    const html = render(report({ preexistingPaths: ['src/app.ts'], files: [
      { path: 'src/app.ts', preexisting: true, kind: 'modified', diff: '@@ -1,2 +1,2 @@\n const stable = 1\n-old()\n+new()\n' },
      { path: 'new.txt', preexisting: false, kind: 'added', diff: '@@ -0,0 +1 @@\n+Hello\n' },
      { path: 'old.txt', preexisting: false, kind: 'deleted', diff: '@@ -1 +0,0 @@\n-Goodbye\n' },
    ] }))
    expect(html).toContain('本轮开始与结束时的文件对比')
    expect(html).toContain('外部程序在此期间的修改也会包含')
    expect(html).toContain('初始 Git 状态中的修改')
    expect(html).toContain('开始时已有修改')
    expect(html).toContain('src/app.ts')
    expect(html).toContain('新增')
    expect(html).toContain('删除')
    expect(html).toMatch(/data-line="added"[^>]*>\+new\(\)/)
    expect(html).toMatch(/data-line="deleted"[^>]*>-old\(\)/)
    expect(html).toMatch(/data-line="hunk"[^>]*>@@ -1,2 \+1,2 @@/)
    expect(html).toContain('id="wb-artifact-source"')
    expect(html).toContain('原始 JSON')
  })

  it('shows incomplete coverage and skipped reasons without presenting unavailable or empty reports as success', () => {
    const partial = render(report({ status: 'partial', notes: ['读取数量超过限制'], files: [{ path: 'large.bin', kind: 'not_reviewed', preexisting: false, reason: '二进制文件未展开' }] }))
    expect(partial).toContain('部分文件未能比较')
    expect(partial).toContain('未展开')
    expect(partial).toContain('二进制文件未展开')
    expect(partial).toContain('读取数量超过限制')
    const unavailable = render(report({ status: 'unavailable', notes: ['结束时项目状态无法读取'] }))
    expect(unavailable).toContain('无法完成对比')
    expect(unavailable).toContain('不能据此判断有没有修改')
    expect(unavailable).not.toContain('暂无可展示差异')
    const empty = render(report())
    expect(empty).toContain('已检查范围内暂无可展示差异')
    expect(empty).not.toContain('任务成功')
    expect(empty).not.toContain('没有修改任何文件')
  })

  it('escapes malicious paths, notes, original JSON and diff content without executable markup', () => {
    const html = render(report({ notes: ['<img src=x onerror=alert(1)>'], preexistingPaths: ['<script>before()</script>'], files: [{ path: '"><img src=x>', kind: 'added', preexisting: true, diff: '@@ -0,0 +1 @@\n+<script>attack()</script>', reason: '<iframe src=javascript:bad>' }] }))
    expect(html).toContain('class="wb-code-review"')
    expect(html).toContain('&lt;script&gt;attack()&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
    expect(html).not.toContain('<iframe ')
  })

  it.each(['{invalid', 'null', JSON.stringify(report({ version: 2 })), JSON.stringify(report({ files: {} })), JSON.stringify(report({ files: [{ path: 'a', kind: 'modified', preexisting: 'yes', diff: {} }] })), JSON.stringify(report({ startedAt: -1 })), JSON.stringify(report({ files: [{ path: 'a', kind: { toString: null }, preexisting: false }] })), JSON.stringify(report({ status: { toString: null } }))])('falls back honestly for malformed or unsupported schema: %s', source => {
    expect(() => renderWorkbenchArtifactText('review.json', mime, source)).not.toThrow()
    const html = renderWorkbenchArtifactText('review.json', mime, source)
    expect(html).toContain('暂时无法解读这份文件对比')
    expect(html).toContain('原始 JSON')
    expect(html).not.toContain('data-review-file=')
  })

  it('renders one file\u0027s diff on its own budget for the review panel, still as text only', () => {
    const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
    const html = renderReviewFileDiff({ path: 'a.ts', preexisting: false, kind: 'added', diff: '@@ -0,0 +1 @@\n+<script>bad()</script>' } as never, escape)
    expect(html).toContain('class="wb-review-diff"')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(renderReviewFileDiff({ path: 'big.bin', preexisting: false, kind: 'not_reviewed', reason: '二进制' } as never, escape)).toBe('')
    expect(renderReviewFileDiff({ path: 'empty.ts', preexisting: false, kind: 'modified' } as never, escape)).toContain('没有可展开的文本差异')
    // 每次调用自带额度:同一个大文件连渲两次,第二次不会因为第一次用光了而空掉。
    const big = { path: 'big.ts', preexisting: false, kind: 'added', diff: '@@ -0,0 +5000 @@\n' + '+x\n'.repeat(5000) } as never
    expect(renderReviewFileDiff(big, escape)).toBe(renderReviewFileDiff(big, escape))
  })

  it('requires the custom MIME so an ordinary JSON artifact cannot impersonate a generated review', () => {
    const source = JSON.stringify(report({ files: [{ path: 'file.ts', kind: 'added', preexisting: false, diff: '+code' }] }))
    const plain = renderWorkbenchArtifactText('review.json', 'application/json', source)
    expect(plain).toMatch(/^<pre>/)
    expect(plain).not.toContain('class="wb-code-review"')
    expect(renderWorkbenchArtifactText('review.json', mime, source)).toContain('class="wb-code-review"')
  })

  it('bounds file and line rendering and exposes preview truncation without changing the saved report', () => {
    const files = Array.from({ length: 201 }, (_, index) => ({ path: `file-${index}.ts`, kind: 'added', preexisting: false, diff: '@@ -0,0 +1 @@\n+code\n' }))
    const html = render(report({ files }))
    expect(html.match(/data-review-file=/g)).toHaveLength(200)
    expect(html).toContain('预览已限量显示')
    expect(html).toContain('下载完整记录')
    const manyLines = render(report({ files: [{ ...files[0], diff: '@@ -0,0 +5000 @@\n' + '+x\n'.repeat(5000) }] }))
    expect((manyLines.match(/data-line=/g) ?? []).length).toBeLessThanOrEqual(4000)
    expect(manyLines).toContain('预览已限量显示')
    const oversized = renderWorkbenchArtifactText('review.json', mime, 'x'.repeat(9 * 1024 * 1024))
    expect(oversized).toContain('预览大小限制')
    expect(oversized.length).toBeLessThan(1_000_000)
  })
})

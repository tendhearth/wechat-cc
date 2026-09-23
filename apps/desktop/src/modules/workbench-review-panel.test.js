import { describe, expect, it } from 'vitest'
import { renderReviewPanel, reviewSummary, reviewsSignature } from './workbench-review-panel.js'
import { createReviewDiffBudget, renderReviewFileDiff } from './workbench-code-review.js'

/** @param {string} value */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
const formatTime = (/** @type {number} */ value) => `T${value}`
const renderDiff = (/** @type {{diff?:string}} */ file) => file.diff ? `<pre class="wb-review-diff"><code>${escapeHtml(file.diff)}</code></pre>` : ''
const options = (/** @type {Record<string,unknown>} */ extra = {}) => ({ escapeHtml, formatTime, renderDiff, ...extra })

const file = (/** @type {Record<string,unknown>} */ overrides = {}) => ({ path: 'src/app.ts', preexisting: false, kind: 'modified', diff: '@@ -1 +1 @@\n-old\n+new', ...overrides })
const turn = (/** @type {Record<string,unknown>} */ overrides = {}) => ({
  artifactId: 'ART-1', sha256: 'a'.repeat(64), name: '本轮文件对比.json', createdAt: 100,
  status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files: [file()], ...overrides,
})

describe('改动面板', () => {
  it('按回合汇总轮数、文件数与标记数', () => {
    const reviews = [
      turn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), files: [file({ path: 'a.ts', mark: { mark: 'accepted', comment: '', createdAt: 5 } }), file({ path: 'b.ts' })] }),
      turn({ files: [file({ path: 'c.ts', mark: { mark: 'returned', comment: '再改一版', createdAt: 4 } })] }),
    ]
    expect(reviewSummary(reviews)).toEqual({ turns: 2, files: 3, accepted: 1, returned: 1 })
    const html = renderReviewPanel(reviews, options())
    expect(html).toContain('2 轮 · 3 个文件 · 已接受 1 · 已打回 1')
    expect(html).toContain('id="wb-review"')
    expect(html).toContain('data-review-disclosure')
    // 新的一轮排在最前面,轮次号从最早的一轮往后数。
    expect(html.indexOf('第 2 轮')).toBeLessThan(html.indexOf('第 1 轮'))
    expect(html).toContain('已接受')
    expect(html).toContain('已打回')
    expect(html).toContain('再改一版')
    expect(reviewSummary([])).toEqual({ turns: 0, files: 0, accepted: 0, returned: 0 })
    expect(renderReviewPanel([], options())).toBe('')
  })

  it('逐文件展开 diff:种类徽章、开始时已有修改、稳定的展开 id', () => {
    const html = renderReviewPanel([turn({ preexistingPaths: ['src/app.ts'], notes: ['读取数量超过限制'], files: [file({ preexisting: true, kind: 'added' })] })], options())
    expect(html).toContain('新增')
    expect(html).toContain('开始时已有修改')
    expect(html).toContain('读取数量超过限制')
    expect(html).toContain(`id="wb-review-${'a'.repeat(8)}-0"`)
    expect(html).toContain('data-review-file-path="src/app.ts"')
    expect(html).toContain('<pre class="wb-review-diff">')
    expect(html).toContain('data-review-turn="' + 'a'.repeat(64) + '"')
    expect(html).toContain('T100')
  })

  it('未展开的文件不给按钮;已接受的文件按钮变「已接受」且仍可打回', () => {
    const skipped = renderReviewPanel([turn({ files: [file({ path: 'big.bin', kind: 'not_reviewed', diff: undefined, reason: '二进制文件未展开' })] })], options())
    expect(skipped).toContain('未展开')
    expect(skipped).toContain('二进制文件未展开')
    expect(skipped).not.toContain('data-action="review-accept"')
    expect(skipped).not.toContain('data-action="review-return"')
    const accepted = renderReviewPanel([turn({ files: [file({ mark: { mark: 'accepted', comment: '', createdAt: 5 } })] })], options())
    expect(accepted).toContain('data-action="review-accept"')
    expect(accepted).toContain('data-action="review-return"')
    expect(accepted).toMatch(/data-action="review-accept"[^>]*>已接受</)
    expect(accepted).toContain('data-artifact-id="ART-1"')
    expect(accepted).toContain('data-path="src/app.ts"')
  })

  it('打回表单只在被点开的那一轮出现,勾选与草稿都留住', () => {
    const reviews = [turn(), turn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), files: [file({ path: 'x.ts' }), file({ path: 'y.ts', kind: 'not_reviewed', diff: undefined })] })]
    expect(renderReviewPanel(reviews, options())).not.toContain('review-return-submit')
    const html = renderReviewPanel(reviews, options({ returnOpen: { artifactId: 'ART-2', paths: ['x.ts'], comment: '把命名改回来' } }))
    expect(html).toContain('<form class="wb-review-return-form" data-action="review-return-submit" data-artifact-id="ART-2">')
    expect(html).toContain('name="paths" value="x.ts" checked')
    // 未展开的文件不能打回,所以也不出现在勾选列表里。
    expect(html).not.toContain('value="y.ts"')
    expect(html).toContain('把命名改回来')
    expect(html).toContain('data-action="review-return-cancel"')
    expect(html.match(/review-return-submit/g)).toHaveLength(1)
  })

  it('读不到改动记录时照实说,不把空当成没改动', () => {
    const html = renderReviewPanel([], options({ error: true }))
    expect(html).toContain('改动记录暂时读不到')
    expect(html).toContain('id="wb-review"')
    expect(renderReviewPanel([turn()], options({ error: true }))).toContain('改动记录暂时读不到')
  })

  it('路径、意见、说明一律转义', () => {
    const html = renderReviewPanel([turn({
      artifactId: '"><img src=x>', notes: ['<script>note()</script>'],
      files: [file({ path: '"><script>path()</script>', reason: '<iframe src=javascript:bad>', mark: { mark: 'returned', comment: '<img src=x onerror=alert(1)>', createdAt: 1 } })],
    })], options({ returnOpen: { artifactId: '"><img src=x>', paths: ['"><script>path()</script>'], comment: '</textarea><script>draft()</script>' } }))
    expect(html).toContain('&lt;script&gt;path()&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;/textarea&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
    expect(html).not.toContain('<iframe ')
  })

  it('只有最近三轮就地展开 diff,更早的一轮指回「成果」', () => {
    const reviews = Array.from({ length: 5 }, (_, index) => turn({ artifactId: `ART-${index}`, sha256: String(index).repeat(8) + 'a'.repeat(56) }))
    const html = renderReviewPanel(reviews, options())
    expect(new Set(html.match(/id="wb-review-[^"]+"/g)).size).toBe(5)
    const sections = html.split('<section class="wb-review-turn"').slice(1)
    expect(sections).toHaveLength(5)
    for (const inline of sections.slice(0, 3)) {
      expect(inline).toContain('<pre class="wb-review-diff">')
      expect(inline).not.toContain('较早的一轮')
    }
    for (const older of sections.slice(3)) {
      expect(older).not.toContain('<pre class="wb-review-diff">')
      expect(older).toContain('较早的一轮')
      // 更早的一轮照样能接受 / 打回:只是差异不就地展开。
      expect(older).toContain('data-action="review-accept"')
    }
  })

  it('整块面板共用一份预览额度,用完了只在底下说一次', () => {
    const budget = createReviewDiffBudget()
    const big = (/** @type {string} */ path) => file({ path, diff: '@@ -0,0 +9000 @@\n' + '+x\n'.repeat(9000) })
    const reviews = [
      turn({ artifactId: 'ART-1', sha256: 'a'.repeat(64), files: [big('one.ts'), big('two.ts')] }),
      turn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), files: [big('three.ts')] }),
    ]
    const html = renderReviewPanel(reviews, options({ budget, renderDiff: (/** @type {any} */ f) => renderReviewFileDiff(f, escapeHtml, budget) }))
    expect(budget.limited).toBe(true)
    expect(html.match(/预览已限量显示/g)).toHaveLength(1)
    expect(html.lastIndexOf('预览已限量显示')).toBeGreaterThan(html.lastIndexOf('<section class="wb-review-turn"'))
    // 额度是整块面板共享的:后面的文件拿不到行数了,也不会假装自己完整。
    expect((html.match(/data-line=/g) ?? []).length).toBeLessThanOrEqual(4000)
    const roomy = renderReviewPanel([turn()], options({ budget: createReviewDiffBudget() }))
    expect(roomy).not.toContain('预览已限量显示')
  })

  it('签名跟着标记与快照内容走', () => {
    const base = [turn()]
    expect(reviewsSignature(base)).toBe(reviewsSignature([turn()]))
    expect(reviewsSignature(base)).not.toBe(reviewsSignature([turn({ files: [file({ mark: { mark: 'accepted', comment: '', createdAt: 1 } })] })]))
    expect(reviewsSignature(base)).not.toBe(reviewsSignature([turn({ sha256: 'c'.repeat(64) })]))
    expect(reviewsSignature(base)).not.toBe(reviewsSignature([...base, turn({ artifactId: 'ART-2', sha256: 'd'.repeat(64) })]))
    expect(reviewsSignature([])).toBe(reviewsSignature([]))
  })
})

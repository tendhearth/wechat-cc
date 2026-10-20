import { describe, expect, it } from 'vitest'
import { isScriptApprovalRequired, renderScriptsApproveDialog, scriptErrorMessage, worktreeScriptsHtml } from './workbench-scripts-approve.js'

const base = { configured: true, approved: true, hash: 'h'.repeat(64), config: { setup: 'bun install', run: 'bun dev --port $TENDHEARTH_PORT', archive: null }, setup: 'done', run: 'idle', archiving: false }

describe('工作区脚本:纯函数', () => {
  it('认得出 428 script_approval_required(Error / 裸字符串 / {error})', () => {
    expect(isScriptApprovalRequired(new Error('script_approval_required'))).toBe(true)
    expect(isScriptApprovalRequired('script_approval_required')).toBe(true)
    expect(isScriptApprovalRequired({ error: 'script_approval_required' })).toBe(true)
    expect(isScriptApprovalRequired(new Error('unattended_ack_required'))).toBe(false)
    expect(isScriptApprovalRequired(null)).toBe(false)
  })

  it('没配脚本 / 读不懂 / 工作区删了 ⇒ 一点都不多画', () => {
    expect(worktreeScriptsHtml(undefined)).toBe('')
    expect(worktreeScriptsHtml({ removed: false })).toBe('')
    expect(worktreeScriptsHtml({ removed: false, scripts: { configured: false, invalid: 'invalid_json' } })).toBe('')
    expect(worktreeScriptsHtml({ removed: true, scripts: base })).toBe('')
  })

  it('一行状态 + 一个按钮:待确认 / 运行中 · 端口 / 排在 setup 后面 / 收尾中没有按钮 / 只有 setup 时给「确认脚本」', () => {
    const pending = worktreeScriptsHtml({ removed: false, scripts: { ...base, approved: false, setup: 'pending' } })
    expect(pending).toContain('工作区脚本：待确认')
    expect(pending).toContain('data-action="worktree-run"')
    const running = worktreeScriptsHtml({ removed: false, port: 47100, scripts: { ...base, run: 'running' } })
    expect(running).toContain('运行中 · 端口 47100')
    expect(running).toContain('data-action="worktree-stop"')
    expect(running.match(/<button/g)).toHaveLength(1)
    expect(worktreeScriptsHtml({ removed: false, scripts: { ...base, setup: 'running', run: 'queued' } })).toContain('setup 进行中 · setup 跑完就运行')
    expect(worktreeScriptsHtml({ removed: false, scripts: { ...base, archiving: true } })).not.toContain('<button')
    expect(worktreeScriptsHtml({ removed: false, scripts: { ...base, approved: false, run: 'none' } })).toContain('data-action="worktree-approve-scripts"')
    expect(worktreeScriptsHtml({ removed: false, scripts: { ...base, run: 'none' } })).not.toContain('<button')
  })

  it('确认框逐字给出脚本原文(转义),没写的那条不出现', () => {
    const html = renderScriptsApproveDialog({ setup: 'echo "<b>" && npm ci', run: 'npm run dev', archive: null })
    expect(html).toContain('echo &quot;&lt;b&gt;&quot; &amp;&amp; npm ci')
    expect(html).toContain('npm run dev')
    expect(html).not.toContain('archive<small>')
    expect(html).toContain('data-scripts="approve"')
    expect(html).toContain('data-scripts="cancel"')
  })

  it('拒绝原因说成人话;不认识的码 ⇒ null(交给通用错误)', () => {
    expect(scriptErrorMessage(new Error('script_config_changed'))).toContain('重新看一遍')
    expect(scriptErrorMessage({ error: 'no_scripts' })).toContain('没有 run 脚本')
    expect(scriptErrorMessage(new Error('internal'))).toBeNull()
  })
})

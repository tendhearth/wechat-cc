import { describe, expect, it } from 'vitest'
import { UNATTENDED_NOTES, isAckRequiredError, isUnattendedProvider, renderUnattendedDialog, unattendedLabelSuffix } from './workbench-unattended.js'

describe('免审执行者:纯函数', () => {
  it('按能力认出免审执行者,只给它加后缀', () => {
    const unattended = { id: 'agy', displayName: 'agy', capabilities: { permissions: 'unattended' } }
    const managed = { id: 'codex', displayName: 'Codex', capabilities: { permissions: 'ask', attachments: true } }
    expect(isUnattendedProvider(unattended)).toBe(true)
    expect(isUnattendedProvider(managed)).toBe(false)
    expect(isUnattendedProvider({ id: 'claude', displayName: 'Claude Code' })).toBe(false)
    expect(isUnattendedProvider(undefined)).toBe(false)
    expect(unattendedLabelSuffix(unattended)).toBe('（免审）')
    expect(unattendedLabelSuffix(managed)).toBe('')
    expect(unattendedLabelSuffix(undefined)).toBe('')
  })

  it('无论代理抛的是 Error 还是原始字符串,都认得出这次要先确认', () => {
    expect(isAckRequiredError(new Error('unattended_ack_required'))).toBe(true)
    expect(isAckRequiredError('unattended_ack_required')).toBe(true)
    expect(isAckRequiredError({ error: 'unattended_ack_required' })).toBe(true)
    expect(isAckRequiredError(new Error('HTTP 428'))).toBe(false)
    expect(isAckRequiredError(new Error('workbench_busy'))).toBe(false)
    expect(isAckRequiredError('unattended_ack_required 之外的话')).toBe(false)
    expect(isAckRequiredError(null)).toBe(false)
    expect(isAckRequiredError(undefined)).toBe(false)
  })

  it('对话框把四条限制和两个按钮都写出来,而且逐字不改', () => {
    expect(UNATTENDED_NOTES).toEqual([
      '看不到、拦不下单步操作:没有权限卡和提问,只能停止。',
      '它用的工具凭据不是按任务隔离的。',
      '时间线只有文字,没有逐条工具调用。',
      '不能带附件,不能选模型和推理档。',
    ])
    const html = renderUnattendedDialog()
    expect(html).toContain('免审执行者')
    for (const note of UNATTENDED_NOTES) expect(html).toContain(note)
    expect(html).toContain('data-unattended="ack"')
    expect(html).toContain('data-unattended="cancel"')
  })
})

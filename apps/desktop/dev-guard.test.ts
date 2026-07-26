import { describe, it, expect } from 'vitest'
import { isMutatingCli, guardCliInvoke } from './dev-guard'

describe('isMutatingCli', () => {
  it('认出会改真实状态的命令(按子命令前缀)', () => {
    expect(isMutatingCli(['setup'])).toBe(true)
    expect(isMutatingCli(['setup-poll'])).toBe(true)
    expect(isMutatingCli(['service', 'install'])).toBe(true)
    expect(isMutatingCli(['daemon', 'kill'])).toBe(true)
    expect(isMutatingCli(['daemon', 'kill-residual'])).toBe(true)
    expect(isMutatingCli(['update'])).toBe(true)
  })

  it('读类命令不算(整理/画像走 daemon 路由,不经这里)', () => {
    expect(isMutatingCli(['memory', 'list', '--json'])).toBe(false)
    expect(isMutatingCli(['memory', 'read', 'u', 'p', '--json'])).toBe(false)
    expect(isMutatingCli(['doctor', '--json'])).toBe(false)
    expect(isMutatingCli(['sessions', 'list', '--json'])).toBe(false)
    expect(isMutatingCli(['daemon', 'api-info', '--json'])).toBe(false)  // daemon 但只读
    expect(isMutatingCli([])).toBe(false)
  })
})

describe('guardCliInvoke', () => {
  const live = { dryRun: false, allowMutations: false }

  it('live 模式拦危险命令,给结构化错误 + hint', () => {
    const r = guardCliInvoke(['service', 'install'], live)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('mutating_command_blocked_in_dev')
      expect(r.hint).toContain('--allow-mutations')
    }
  })

  it('live 模式放行读类命令', () => {
    expect(guardCliInvoke(['memory', 'list', '--json'], live).ok).toBe(true)
  })

  it('--allow-mutations 显式放行', () => {
    expect(guardCliInvoke(['setup'], { dryRun: false, allowMutations: true }).ok).toBe(true)
  })

  it('mock 模式不拦(本就不碰真实状态)', () => {
    expect(guardCliInvoke(['setup'], { dryRun: true, allowMutations: false }).ok).toBe(true)
  })
})

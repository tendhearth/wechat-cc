import { describe, it, expect, vi } from 'vitest'
import { machineIdleSeconds, parseIoregIdle, parseMillis } from './machine-idle'

describe('machine-idle', () => {
  it('macOS:ioreg 的 HIDIdleTime 纳秒 → 秒', () => {
    expect(parseIoregIdle('  |   "HIDIdleTime" = 18225241000\n')).toBeCloseTo(18.225, 2)
    expect(parseIoregIdle('nothing')).toBeNull()
  })
  it('Windows / Linux:毫秒 → 秒;乱输出 → null', () => {
    expect(parseMillis('125000\r\n')).toBe(125)
    expect(parseMillis('')).toBeNull()
  })
  it('按平台挑命令;探针抛错 / 不支持的平台 → null', async () => {
    const exec = vi.fn(async (cmd: string) => cmd === 'ioreg' ? '"HIDIdleTime" = 5000000000' : '7000')
    expect(await machineIdleSeconds('darwin', exec)).toBe(5)
    expect(await machineIdleSeconds('linux', exec)).toBe(7)
    expect(exec).toHaveBeenLastCalledWith('xprintidle', [], 1500)
    expect(await machineIdleSeconds('win32', exec)).toBe(7)
    expect(await machineIdleSeconds('freebsd', exec)).toBeNull()
    expect(await machineIdleSeconds('darwin', async () => { throw new Error('no ioreg') })).toBeNull()
  })
})

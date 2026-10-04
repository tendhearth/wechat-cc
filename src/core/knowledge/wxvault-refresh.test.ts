// src/core/knowledge/wxvault-refresh.test.ts
//
// makeWxvaultRefresh drives wxvault's real CLI contract (`sync.py
// --changed-only --json`, status JSON on the last stdout line). A stub
// sync.py stands in for wxvault so the test needs no WeChat data: it checks
// the argv/env we pass and how the status line and failures are surfaced.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateRefreshOnFullDiskAccess, makeWxvaultRefresh } from './wxvault-refresh'

const PY = process.platform === 'win32' ? 'python' : 'python3'

describe('makeWxvaultRefresh', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wxvault-refresh-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function stub(body: string): void {
    writeFileSync(join(dir, 'sync.py'), `import json, os, sys\n${body}\n`)
  }

  it('runs sync.py --changed-only with WXVAULT_STATE_DIR and reads the status line', async () => {
    stub([
      'assert sys.argv[1:] == ["--changed-only", "--json"], sys.argv',
      'print("==> 待解 1 个库")',
      'print(json.dumps({"up_to_date": os.environ["WXVAULT_STATE_DIR"] == "/the/state"}))',
    ].join('\n'))
    const refresh = makeWxvaultRefresh({ pythonBin: PY, pluginDir: dir, stateDir: '/the/state' })
    await expect(refresh()).resolves.toEqual({ upToDate: true })
  })

  it('reports up_to_date null when wxvault cannot read the WeChat container', async () => {
    stub('print(json.dumps({"state": "success", "up_to_date": None}))')
    const refresh = makeWxvaultRefresh({ pythonBin: PY, pluginDir: dir, stateDir: dir })
    await expect(refresh()).resolves.toEqual({ upToDate: null })
  })

  it('rejects with the last stderr line when sync.py fails', async () => {
    stub('sys.stderr.write("!! 同步失败：解密程序退出码 1\\n"); sys.exit(1)')
    const refresh = makeWxvaultRefresh({ pythonBin: PY, pluginDir: dir, stateDir: dir })
    await expect(refresh()).rejects.toThrow(/解密程序退出码 1/)
  })

  it('rejects when the refresh exceeds its timeout', async () => {
    stub('import time; time.sleep(5)')
    const refresh = makeWxvaultRefresh({ pythonBin: PY, pluginDir: dir, stateDir: dir, timeoutMs: 300 })
    await expect(refresh()).rejects.toThrow(/failed/)
  })
})

describe('gateRefreshOnFullDiskAccess —— 没有 FDA 就不在后台碰微信的容器', () => {
  it('没有 FDA ⇒ 不跑 sync.py、只记一次日志;有了 FDA ⇒ 恢复', async () => {
    let fda: boolean | null = false
    let runs = 0
    const logs: string[] = []
    const gated = gateRefreshOnFullDiskAccess(async () => { runs++; return { upToDate: true } }, {
      hasFda: () => fda, log: (_t, l) => { logs.push(l) }, hint: 'HINT',
    })
    expect(await gated()).toEqual({ upToDate: null })
    expect(await gated()).toEqual({ upToDate: null })
    expect(runs).toBe(0)
    expect(logs.filter(l => l.includes('skipped'))).toHaveLength(1)   // 每 5 分钟一次的 tick 不刷屏
    expect(logs[0]).toContain('HINT')
    fda = true
    expect(await gated()).toEqual({ upToDate: true })
    expect(runs).toBe(1)
    expect(logs.some(l => l.includes('resumed'))).toBe(true)
  })

  it('说不清(非 macOS / 探针无结论)⇒ 照常刷新,不改变别的平台', async () => {
    let runs = 0
    const gated = gateRefreshOnFullDiskAccess(async () => { runs++; return { upToDate: true } }, { hasFda: () => null, log: () => {}, hint: '' })
    await gated()
    expect(runs).toBe(1)
  })
})

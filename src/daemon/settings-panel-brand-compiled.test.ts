import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { removeTempDir } from '../lib/test-temp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('compiled phone brand icon', () => {
  it.skipIf(!process.versions.bun)('serves the logo from an isolated executable without source or resource directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-brand-compiled-'))
    try {
      const entry = join(dir, 'entry.ts')
      const executable = join(dir, process.platform === 'win32' ? 'phone.exe' : 'phone')
      const runDir = join(dir, 'empty')
      mkdirSync(runDir)
      writeFileSync(entry, `
import { makeSettingsPanel } from ${JSON.stringify(fileURLToPath(new URL('./settings-panel.ts', import.meta.url)))}
const panel = makeSettingsPanel({
  stateDir: process.cwd(), ownerChatId: () => null,
  chatPrefs: { get: () => ({}), set: (_id, patch) => patch },
  getUserName: () => null, setUserName: async () => {}, log: () => {},
})
try {
  const { port } = await panel.start(0)
  const icon = await fetch('http://127.0.0.1:' + port + '/m/icon.png')
  console.log(JSON.stringify({ status: icon.status, type: icon.headers.get('content-type'), png: Buffer.from(await icon.arrayBuffer()).toString('base64') }))
} finally { await panel.stop() }
`)
      const built = spawnSync(process.execPath, ['build', '--compile', entry, '--outfile', executable], { encoding: 'utf8', timeout: 45_000 })
      expect(built.error, built.stderr).toBeUndefined()
      expect(built.status, built.stderr).toBe(0)
      rmSync(entry)
      const run = spawnSync(executable, [], { cwd: runDir, encoding: 'utf8', timeout: 15_000 })
      expect(run.error, run.stderr).toBeUndefined()
      expect(run.status, run.stderr).toBe(0)
      const icon = JSON.parse(run.stdout) as { status: number; type: string; png: string }
      expect(icon.status).toBe(200)
      expect(icon.type).toBe('image/png')
      expect(Buffer.from(icon.png, 'base64').equals(readFileSync(new URL('../../apps/desktop/src/wechat-cc-logo.png', import.meta.url)))).toBe(true)
    } finally {
      // 刚 spawn 过一个可执行文件就删它所在的目录:Windows 上句柄还没落地,
      // 裸 rmSync 会抛 EBUSY,而这里在 finally 里 ⇒ 抛出来就把用例判红。
      // removeTempDir 重试 20 次后降级成一条 warning(AGENTS.md 的临时目录约定)。
      removeTempDir(dir)
    }
  }, 60_000)
})

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hookCommandLine, installHooks } from './hook'

describe('Codex trust definition byte contract', () => {
  it('freezes every field and command across CC upgrades, preserving positional trust', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-trust-contract-')), file = join(dir, 'hooks.json')
    try {
      const command = hookCommandLine({ execPath: '/Applications/Tendhearth CC.app/Contents/MacOS/tendhearth-cc-cli', compiled: true, cliEntry: '/ignored/versioned/path', source: 'codex' })
      expect(command).toBe('"/Applications/Tendhearth CC.app/Contents/MacOS/tendhearth-cc-cli" hook codex')
      expect(hookCommandLine({ execPath: '/opt/bun', compiled: false, cliEntry: '/repo/cli.ts', source: 'codex' })).toBe('"/opt/bun" "/repo/cli.ts" hook codex')
      installHooks(file, 'codex', command)
      const expected = { hooks: Object.fromEntries([
        ['SessionStart', 1, false], ['Stop', 5, true], ['PermissionRequest', 150, false], ['UserPromptSubmit', 5, true], ['SessionEnd', 5, true],
      ].map(([event, timeout, async]) => [event, [{ hooks: [{ type: 'command', command, timeout, async, statusMessage: 'wechat-cc → 微信' }] }]])) }
      expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(expected, null, 2) + '\n')
      const cfg = JSON.parse(readFileSync(file, 'utf8'))
      cfg.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'other' }] })
      cfg.hooks.Stop[0].hooks[0] = Object.fromEntries(Object.entries(cfg.hooks.Stop[0].hooks[0]).reverse())
      writeFileSync(file, JSON.stringify(cfg, null, 4))
      const before = readFileSync(file, 'utf8')
      expect(installHooks(file, 'codex', command)).toEqual({ changed: false })
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(installHooks(file, 'codex', '"/new/path" hook codex')).toEqual({ changed: true, reconfirmationRequired: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

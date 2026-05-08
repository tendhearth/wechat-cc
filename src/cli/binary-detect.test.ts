import { describe, it, expect } from 'vitest'
import { detectServiceBinaryPath } from './binary-detect'

// Why this exists: pre-2026-05-08 `wechat-cc update` only ran git pull +
// optional bun install. It never refreshed the compiled `wechat-cc-cli`
// binary that systemd / launchd / scheduled-task points at, so any code
// fix sat in git but never reached the running daemon (incident: image
// 2026-05-08, where the chatroom model fix landed in master but the user's
// daemon kept hitting the bug because update silently no-op'd the rebuild).
//
// Step 1 of the framework fix: detect whether the installed service points
// at a `wechat-cc-cli` binary (=> rebuild required) or runs `bun cli.ts`
// directly (=> dev mode, no rebuild). Pure parser — IO is injected so the
// caller can read filesystem (Linux/macOS) or shell out to PowerShell
// (Windows). Returns absolute binary path on match, null otherwise.

const FAKE_HOME = '/home/u'

function makeReadFile(map: Record<string, string>) {
  return (path: string) => map[path] ?? null
}

describe('detectServiceBinaryPath', () => {
  describe('linux (systemd user unit)', () => {
    const unitPath = `${FAKE_HOME}/.config/systemd/user/wechat-cc.service`

    it('extracts binary path from ExecStart when it points at wechat-cc-cli', () => {
      const r = detectServiceBinaryPath({
        homeDir: FAKE_HOME,
        platform: 'linux',
        readFile: makeReadFile({
          [unitPath]: [
            '[Service]',
            'Type=simple',
            'WorkingDirectory=/home/u/.local/bin',
            'ExecStart=/home/u/.local/bin/wechat-cc-cli run --dangerously',
            'Restart=always',
          ].join('\n'),
        }),
      })
      expect(r).toBe('/home/u/.local/bin/wechat-cc-cli')
    })

    it('returns null when ExecStart points at bun (dev mode)', () => {
      const r = detectServiceBinaryPath({
        homeDir: FAKE_HOME,
        platform: 'linux',
        readFile: makeReadFile({
          [unitPath]: [
            '[Service]',
            'ExecStart=/usr/local/bin/bun /home/u/.../cli.ts run',
          ].join('\n'),
        }),
      })
      expect(r).toBeNull()
    })

    it('returns null when systemd unit is absent', () => {
      const r = detectServiceBinaryPath({
        homeDir: FAKE_HOME,
        platform: 'linux',
        readFile: () => null,
      })
      expect(r).toBeNull()
    })

    it('handles ExecStart with quoted binary path (whitespace tolerant)', () => {
      const r = detectServiceBinaryPath({
        homeDir: FAKE_HOME,
        platform: 'linux',
        readFile: makeReadFile({
          [unitPath]: 'ExecStart=  "/opt/wechat tools/wechat-cc-cli" run --dangerously',
        }),
      })
      expect(r).toBe('/opt/wechat tools/wechat-cc-cli')
    })
  })

  describe('darwin (launchd plist)', () => {
    const plistPath = `${FAKE_HOME}/Library/LaunchAgents/com.wechat-cc.daemon.plist`

    it('extracts first ProgramArguments string when it points at wechat-cc-cli', () => {
      const r = detectServiceBinaryPath({
        homeDir: FAKE_HOME,
        platform: 'darwin',
        readFile: makeReadFile({
          [plistPath]: `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.wechat-cc.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/u/.local/bin/wechat-cc-cli</string>
    <string>run</string>
    <string>--dangerously</string>
  </array>
</dict></plist>`,
        }),
      })
      expect(r).toBe('/Users/u/.local/bin/wechat-cc-cli')
    })

    it('returns null when first arg is bun (dev mode)', () => {
      const r = detectServiceBinaryPath({
        homeDir: FAKE_HOME,
        platform: 'darwin',
        readFile: makeReadFile({
          [plistPath]: `<plist><dict>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/bun</string>
    <string>/Users/u/repo/cli.ts</string>
    <string>run</string>
  </array>
</dict></plist>`,
        }),
      })
      expect(r).toBeNull()
    })

    it('returns null when plist is missing', () => {
      const r = detectServiceBinaryPath({
        homeDir: FAKE_HOME,
        platform: 'darwin',
        readFile: () => null,
      })
      expect(r).toBeNull()
    })
  })

  describe('win32 (scheduled task)', () => {
    it('uses readSchTask probe and returns binary path when wechat-cc-cli.exe', () => {
      const r = detectServiceBinaryPath({
        homeDir: 'C:\\Users\\u',
        platform: 'win32',
        readFile: () => null,
        readSchTask: () => 'C:\\Users\\u\\AppData\\Local\\wechat-cc\\wechat-cc-cli.exe',
      })
      expect(r).toBe('C:\\Users\\u\\AppData\\Local\\wechat-cc\\wechat-cc-cli.exe')
    })

    it('returns null when scheduled task points at bun.exe', () => {
      const r = detectServiceBinaryPath({
        homeDir: 'C:\\Users\\u',
        platform: 'win32',
        readFile: () => null,
        readSchTask: () => 'C:\\Users\\u\\.bun\\bin\\bun.exe',
      })
      expect(r).toBeNull()
    })

    it('returns null when readSchTask probe is not provided', () => {
      const r = detectServiceBinaryPath({
        homeDir: 'C:\\Users\\u',
        platform: 'win32',
        readFile: () => null,
      })
      expect(r).toBeNull()
    })
  })
})

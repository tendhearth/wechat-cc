import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notifyStartup, renderStartupText, WARM_FIRST_STARTUP_TEXT } from './notify-startup'

function makeStateDir() {
  return mkdtempSync(join(tmpdir(), 'notify-startup-'))
}

describe('notify-startup', () => {
  it('first-ever startup sends the warm hello, not the technical template', async () => {
    const stateDir = makeStateDir()
    try {
      const sent: Array<{ chatId: string; text: string }> = []
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['owner-wxid'] }),
          send: async (chatId, text) => { sent.push({ chatId, text }) },
          log: () => {},
          now: () => 1_700_000_000_000,
        },
        { pid: 42, accounts: 1, dangerously: true }
      )
      expect(result).toEqual({ notified: true, recipients: ['owner-wxid'], sinceLastMs: null })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.chatId).toBe('owner-wxid')
      expect(sent[0]!.text).toBe(WARM_FIRST_STARTUP_TEXT)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('errcode=-2(推送窗口关闭)记成平静态,不喊 failed;真错才喊 failed', async () => {
    for (const [err, expectCalm] of [
      ['ilink/sendmessage errcode=-2: prepare failed', true],
      ['ilink/sendmessage errcode=500: internal', false],
    ] as const) {
      const stateDir = makeStateDir()
      try {
        const logs: string[] = []
        await notifyStartup(
          {
            stateDir,
            loadAccess: () => ({ allowFrom: ['owner-wxid'] }),
            send: async () => ({ error: err }),   // 每轮都失败
            log: (_tag, line) => { logs.push(line) },
            now: () => 1_700_000_000_000,
            retryDelayMs: 0,                        // 别让 4 轮退避拖慢测试
          },
          { pid: 42, accounts: 1, dangerously: true }
        )
        const joined = logs.join('\n')
        if (expectCalm) {
          expect(joined).toContain('暂不可推送')
          expect(joined).not.toContain('send to owner-wxid failed')
        } else {
          expect(joined).toContain('send to owner-wxid failed')
          expect(joined).not.toContain('暂不可推送')
        }
      } finally {
        rmSync(stateDir, { recursive: true, force: true })
      }
    }
  })

  it('first-ever startup writes the one-time notified marker', async () => {
    const stateDir = makeStateDir()
    try {
      await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['owner-wxid'] }),
          send: async () => {},
          log: () => {},
          now: () => 1_700_000_000_000,
        },
        { pid: 42, accounts: 1, dangerously: true }
      )
      expect(existsSync(join(stateDir, 'startup-notified.json'))).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('later restart (marker already present) keeps the technical "已启动/已重启" template', async () => {
    const stateDir = makeStateDir()
    try {
      // First-ever startup: warm hello + marker written.
      await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: ['owner-wxid'] }), send: async () => {}, log: () => {}, now: () => 0 },
        { pid: 1, accounts: 1, dangerously: true }
      )
      const sent: Array<{ chatId: string; text: string }> = []
      const HOUR = 60 * 60 * 1000
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['owner-wxid'] }),
          send: async (chatId, text) => { sent.push({ chatId, text }) },
          log: () => {},
          now: () => 3 * HOUR,
        },
        { pid: 2, accounts: 1, dangerously: true }
      )
      expect(result.notified).toBe(true)
      expect(sent[0]!.text).toMatch(/已重启/)
      expect(sent[0]!.text).toMatch(/pid=2/)
      expect(sent[0]!.text).not.toBe(WARM_FIRST_STARTUP_TEXT)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('an EXISTING install upgrading onto this feature (last-startup.json already present from a prior boot, but no startup-notified.json marker yet — this feature never having shipped before) sends the technical text, NOT the warm hello, and backfills the marker (fix round 2)', async () => {
    const stateDir = makeStateDir()
    try {
      // Simulate a pre-upgrade install: last-startup.json exists (the daemon
      // has demonstrably started before), but startup-notified.json does
      // not (this marker feature didn't exist in the version that wrote it).
      writeFileSync(join(stateDir, 'last-startup.json'), JSON.stringify({ ts: 0, pid: 1 }) + '\n')
      expect(existsSync(join(stateDir, 'startup-notified.json'))).toBe(false)

      const sent: Array<{ chatId: string; text: string }> = []
      const HOUR = 60 * 60 * 1000
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['owner-wxid'] }),
          send: async (chatId, text) => { sent.push({ chatId, text }) },
          log: () => {},
          now: () => 3 * HOUR,
        },
        { pid: 2, accounts: 1, dangerously: true }
      )
      expect(result.notified).toBe(true)
      expect(sent[0]!.text).not.toBe(WARM_FIRST_STARTUP_TEXT)
      expect(sent[0]!.text).toMatch(/已重启/)
      expect(sent[0]!.text).toMatch(/pid=2/)
      // Backfilled so no LATER boot mistakes this install for fresh.
      expect(existsSync(join(stateDir, 'startup-notified.json'))).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('skips notification when restart is within 60s of previous (KeepAlive crash-loop)', async () => {
    const stateDir = makeStateDir()
    try {
      // First startup persists last-startup.json.
      await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: ['x'] }), send: async () => {}, log: () => {}, now: () => 1_000_000 },
        { pid: 1, accounts: 1, dangerously: true }
      )
      // Restart 5s later.
      const sent: unknown[] = []
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['x'] }),
          send: async (...args) => { sent.push(args) },
          log: () => {},
          now: () => 1_005_000,
        },
        { pid: 2, accounts: 1, dangerously: true }
      )
      expect(result.notified).toBe(false)
      expect(result.reason).toBe('too-soon')
      expect(result.sinceLastMs).toBe(5_000)
      expect(sent).toHaveLength(0)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('renders 重启 template with elapsed time when restart is well after previous', async () => {
    const stateDir = makeStateDir()
    try {
      await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: ['x'] }), send: async () => {}, log: () => {}, now: () => 0 },
        { pid: 1, accounts: 1, dangerously: true }
      )
      const sent: Array<{ chatId: string; text: string }> = []
      const HOUR = 60 * 60 * 1000
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['x'] }),
          send: async (chatId, text) => { sent.push({ chatId, text }) },
          log: () => {},
          now: () => 3 * HOUR,
        },
        { pid: 2, accounts: 1, dangerously: false }
      )
      expect(result.notified).toBe(true)
      expect(sent[0]!.text).toMatch(/已重启/)
      expect(sent[0]!.text).toMatch(/3.0 小时前/)
      expect(sent[0]!.text).toMatch(/⚠️ strict/)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('prefers admins over allowFrom when both present', async () => {
    const stateDir = makeStateDir()
    try {
      const sent: string[] = []
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['user-a', 'user-b'], admins: ['admin-x'] }),
          send: async (chatId) => { sent.push(chatId) },
          log: () => {},
        },
        { pid: 1, accounts: 1, dangerously: true }
      )
      expect(result.notified).toBe(true)
      expect(sent).toEqual(['admin-x'])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('reports no-recipients when access is empty', async () => {
    const stateDir = makeStateDir()
    try {
      const result = await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: [] }), send: async () => {}, log: () => {} },
        { pid: 1, accounts: 0, dangerously: true }
      )
      expect(result).toEqual({ notified: false, reason: 'no-recipients', recipients: [], sinceLastMs: null })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('reports send-failed-all when every recipient send throws', async () => {
    const stateDir = makeStateDir()
    try {
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['owner'] }),
          send: async () => { throw new Error('network down') },
          log: () => {},
          retryDelayMs: 1,
        },
        { pid: 1, accounts: 1, dangerously: true }
      )
      expect(result.notified).toBe(false)
      expect(result.reason).toBe('send-failed-all')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('persists last-startup.json so the next call can compare', async () => {
    const stateDir = makeStateDir()
    try {
      await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: ['x'] }), send: async () => {}, log: () => {}, now: () => 12345 },
        { pid: 99, accounts: 1, dangerously: true }
      )
      const persisted = JSON.parse(readFileSync(join(stateDir, 'last-startup.json'), 'utf8'))
      expect(persisted.ts).toBe(12345)
      expect(persisted.pid).toBe(99)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('renderStartupText: dangerously toggles the mode tag', () => {
    expect(renderStartupText({ pid: 1, accounts: 1, dangerously: true }, null)).toMatch(/✅ unattended/)
    expect(renderStartupText({ pid: 1, accounts: 1, dangerously: false }, null)).toMatch(/⚠️ strict/)
  })
})

describe('send-result honesty + not-ready retry (2026-08-24)', () => {
  it('a send that RESOLVES with an error field is a failure, not a success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-'))
    const logs: string[] = []
    const r = await notifyStartup({
      stateDir: dir,
      loadAccess: () => ({ allowFrom: ['owner1'] }),
      // glue-shaped failure: resolves, carries error (ilink-glue never throws)
      send: async () => ({ msgId: 'err:1', error: 'ilink/sendmessage errcode=-2: prepare failed' }),
      log: (t, l) => logs.push(`${t} ${l}`),
      retryDelayMs: 1,
    }, { pid: 1, accounts: 1, dangerously: true })
    expect(r.notified).toBe(false)
    expect(r.reason).toBe('send-failed-all')
    expect(logs.some(l => l.includes('sent to 1/1'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('retries once after a delay when the channel is not ready yet, and succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-'))
    let calls = 0
    const r = await notifyStartup({
      stateDir: dir,
      loadAccess: () => ({ allowFrom: ['owner1'] }),
      send: async () => {
        calls++
        return calls === 1
          ? { msgId: 'err:1', error: 'errcode=-2: prepare failed' }
          : { msgId: 'sent:2' }
      },
      log: () => {},
      retryDelayMs: 1,
    }, { pid: 1, accounts: 1, dangerously: true })
    expect(calls).toBe(2)
    expect(r.notified).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

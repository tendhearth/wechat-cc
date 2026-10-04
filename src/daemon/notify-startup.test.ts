import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyRestart, DEFAULT_RESTART_NOTICE, describeDowntime, notifyStartup, renderUnplannedRestartText,
  resolveRestartNoticeSettings, WARM_FIRST_STARTUP_TEXT, type StartupNotifyDeps,
} from './notify-startup'
import { consumePreviousRunEvidence, markCleanShutdown, markPlannedRestart, type PreviousRunEvidence } from '../lib/restart-markers'

const NOW = 1_700_000_000_000
const NONE: PreviousRunEvidence = { planned: null, cleanShutdown: null, lastHeartbeatAt: null }

function withDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-startup-'))
    try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

/** 已经开过机、打过招呼的老安装:上次启动 1 小时前,上次通知 1 天前。 */
function seedPreviousRun(dir: string, opts: { prevStartAgoMs?: number; lastNoticeAgoMs?: number } = {}): void {
  writeFileSync(join(dir, 'last-startup.json'), JSON.stringify({ ts: NOW - (opts.prevStartAgoMs ?? 3600_000), pid: 1 }))
  writeFileSync(join(dir, 'startup-notified.json'), JSON.stringify({ ts: NOW - (opts.lastNoticeAgoMs ?? 24 * 3600_000) }))
}

function deps(dir: string, over: Partial<StartupNotifyDeps> & { sent?: Array<{ chatId: string; text: string }>; logs?: string[] } = {}): StartupNotifyDeps {
  const sent = over.sent ?? []
  const logs = over.logs ?? []
  return {
    stateDir: dir,
    loadAccess: () => ({ allowFrom: ['owner-wxid'] }),
    send: async (chatId, text) => { sent.push({ chatId, text }); return { msgId: 'ok' } },
    log: (_t, l) => { logs.push(l) },
    now: () => NOW,
    retryDelayMs: 0,
    ...over,
  }
}

describe('notifyStartup — 首次问候', () => {
  it('真正的第一次开机发温暖问候,并写下标记', withDir(async (dir) => {
    const sent: Array<{ chatId: string; text: string }> = []
    const r = await notifyStartup(deps(dir, { sent }), { pid: 42 })
    expect(r).toMatchObject({ notified: true, kind: 'first-boot', recipients: ['owner-wxid'] })
    expect(sent).toEqual([{ chatId: 'owner-wxid', text: WARM_FIRST_STARTUP_TEXT }])
    expect(existsSync(join(dir, 'startup-notified.json'))).toBe(true)
  }))

  it('第二次开机绝不再发问候', withDir(async (dir) => {
    await notifyStartup(deps(dir), { pid: 1 })
    const sent: Array<{ chatId: string; text: string }> = []
    await notifyStartup(deps(dir, { sent, now: () => NOW + 3600_000, evidence: { ...NONE, cleanShutdown: { cause: 'SIGTERM', pid: 1, ts: NOW + 1000 } } }), { pid: 2 })
    expect(sent).toEqual([])
  }))
})

describe('notifyStartup — 计划内重启永远不说话', () => {
  for (const reason of ['self-deploy', 'self-deploy-rollback', 'self-restart-stale-code', 'provider-change', 'internal-api', 'app-update', 'cli-upgrade']) {
    it(`planned 纸条(${reason})⇒ 不发`, withDir(async (dir) => {
      seedPreviousRun(dir)
      const sent: Array<{ chatId: string; text: string }> = []
      const r = await notifyStartup(deps(dir, { sent, evidence: { planned: { reason, ts: NOW - 5000 }, cleanShutdown: null, lastHeartbeatAt: NOW - 10 * 60_000 } }), { pid: 2 })
      expect(r).toMatchObject({ notified: false, kind: 'planned', reason: 'planned-restart' })
      expect(sent).toEqual([])
    }))
  }

  it('优雅退出纸条(launchctl kickstart -k 的 SIGTERM)⇒ 不发,哪怕停了很久', withDir(async (dir) => {
    seedPreviousRun(dir)
    const sent: Array<{ chatId: string; text: string }> = []
    const r = await notifyStartup(deps(dir, { sent, evidence: { planned: null, cleanShutdown: { cause: 'SIGTERM', pid: 1, ts: NOW - 30 * 60_000 }, lastHeartbeatAt: NOW - 30 * 60_000 } }), { pid: 2 })
    expect(r).toMatchObject({ notified: false, kind: 'planned', reason: 'planned-restart' })
    expect(sent).toEqual([])
  }))
})

describe('notifyStartup — 意外重启', () => {
  const crash = (downMs: number | null): PreviousRunEvidence => ({ planned: null, cleanShutdown: null, lastHeartbeatAt: downMs === null ? null : NOW - downMs })

  it('停机够久 ⇒ 说一次人话:没有 pid / accounts / unattended', withDir(async (dir) => {
    seedPreviousRun(dir)
    const sent: Array<{ chatId: string; text: string }> = []
    const r = await notifyStartup(deps(dir, { sent, evidence: crash(5 * 60_000) }), { pid: 70239 })
    expect(r).toMatchObject({ notified: true, kind: 'unplanned', downtimeMs: 5 * 60_000 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('CC 刚才意外重启了一次(大约 5 分钟没在线),现在已经恢复。')
    expect(sent[0]!.text).not.toMatch(/pid|accounts|unattended|daemon|70239/)
  }))

  it('很快就恢复(launchd 秒级拉起)⇒ 不打扰,只记日志', withDir(async (dir) => {
    seedPreviousRun(dir)
    const sent: Array<{ chatId: string; text: string }> = []
    const logs: string[] = []
    const r = await notifyStartup(deps(dir, { sent, logs, evidence: crash(20_000) }), { pid: 2 })
    expect(r).toMatchObject({ notified: false, kind: 'unplanned', reason: 'quick-recovery' })
    expect(sent).toEqual([])
    expect(logs.join('\n')).toContain('unplanned restart detected')
  }))

  it('阈值可配:min_downtime_s 调低后短停机也说', withDir(async (dir) => {
    seedPreviousRun(dir)
    const sent: Array<{ chatId: string; text: string }> = []
    const settings = resolveRestartNoticeSettings({ min_downtime_s: 10 })
    await notifyStartup(deps(dir, { sent, settings, evidence: crash(20_000) }), { pid: 2 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('20 秒')
  }))

  it('enabled=false ⇒ 意外重启也不说', withDir(async (dir) => {
    seedPreviousRun(dir)
    const sent: Array<{ chatId: string; text: string }> = []
    const r = await notifyStartup(deps(dir, { sent, settings: resolveRestartNoticeSettings({ enabled: false }), evidence: crash(3600_000) }), { pid: 2 })
    expect(r.reason).toBe('disabled')
    expect(sent).toEqual([])
  }))

  it('限频:上一条重启通知在 N 小时内 ⇒ 不再说', withDir(async (dir) => {
    seedPreviousRun(dir, { lastNoticeAgoMs: 60 * 60_000 })
    const sent: Array<{ chatId: string; text: string }> = []
    const r = await notifyStartup(deps(dir, { sent, evidence: crash(10 * 60_000) }), { pid: 2 })
    expect(r.reason).toBe('rate-limited')
    expect(sent).toEqual([])
  }))

  it('限频以发出去的那条为准:发完后紧接着的第二次意外重启被压住', withDir(async (dir) => {
    seedPreviousRun(dir)
    const sent: Array<{ chatId: string; text: string }> = []
    await notifyStartup(deps(dir, { sent, evidence: crash(10 * 60_000) }), { pid: 2 })
    await notifyStartup(deps(dir, { sent, now: () => NOW + 30 * 60_000, evidence: { ...crash(null), lastHeartbeatAt: NOW + 10 * 60_000 } }), { pid: 3 })
    expect(sent).toHaveLength(1)
  }))

  it('一小时内反复意外重启 ⇒ 哪怕每次都很快恢复,也说一次', withDir(async (dir) => {
    seedPreviousRun(dir)
    const sent: Array<{ chatId: string; text: string }> = []
    for (let i = 0; i < 3; i++) {
      await notifyStartup(deps(dir, { sent, now: () => NOW + i * 60_000, evidence: { ...crash(null), lastHeartbeatAt: NOW + i * 60_000 - 15_000 } }), { pid: 10 + i })
    }
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('意外重启了 3 次')
    expect(sent[0]!.text).not.toMatch(/pid|accounts/)
  }))

  it('发不出去 ⇒ 短窗口后放弃,不排队补发(不写 pending-notify.json)', withDir(async (dir) => {
    seedPreviousRun(dir)
    let calls = 0
    const logs: string[] = []
    const r = await notifyStartup(deps(dir, {
      logs,
      send: async () => { calls++; return { error: 'ilink/sendmessage errcode=-2: prepare failed' } },
      evidence: crash(10 * 60_000),
    }), { pid: 2 })
    expect(r).toMatchObject({ notified: false, reason: 'send-failed-all' })
    expect(calls).toBe(4)
    expect(existsSync(join(dir, 'pending-notify.json'))).toBe(false)
    expect(logs.join('\n')).toContain('not queued')
    expect(logs.join('\n')).toContain('暂不可推送')
    // 没发出去就不算「通知过」:不会因此把下一次压住。
    expect(JSON.parse(readFileSync(join(dir, 'startup-notified.json'), 'utf8')).ts).toBe(NOW - 24 * 3600_000)
  }))

  it('通道刚好在窗口内就绪 ⇒ 重试后发出', withDir(async (dir) => {
    seedPreviousRun(dir)
    let calls = 0
    const r = await notifyStartup(deps(dir, {
      send: async () => { calls++; return calls === 1 ? { error: 'errcode=-2: prepare failed' } : { msgId: 'ok' } },
      evidence: crash(10 * 60_000),
    }), { pid: 2 })
    expect(calls).toBe(2)
    expect(r.notified).toBe(true)
  }))

  it('老版本留下的 pending-notify.json 开机即删,永不补发', withDir(async (dir) => {
    seedPreviousRun(dir)
    writeFileSync(join(dir, 'pending-notify.json'), JSON.stringify({ text: '🔄 wechat-cc daemon 已重启', recipients: ['owner-wxid'], ts: NOW - 3600_000 }))
    await notifyStartup(deps(dir, { evidence: { planned: { reason: 'self-deploy', ts: NOW }, cleanShutdown: null, lastHeartbeatAt: null } }), { pid: 2 })
    expect(existsSync(join(dir, 'pending-notify.json'))).toBe(false)
  }))
})

describe('classifyRestart', () => {
  it('上一个进程开机之前的优雅退出纸条不算数', () => {
    const r = classifyRestart({ prevStartTs: NOW - 1000, now: NOW, evidence: { planned: null, cleanShutdown: { cause: 'SIGTERM', pid: 1, ts: NOW - 5000 }, lastHeartbeatAt: NOW - 500 } })
    expect(r).toEqual({ kind: 'unplanned', downtimeMs: 500 })
  })
  it('没有心跳 ⇒ 停机时长未知', () => {
    expect(classifyRestart({ prevStartTs: NOW - 1000, now: NOW, evidence: NONE })).toEqual({ kind: 'unplanned', downtimeMs: null })
  })
})

describe('restart-markers —— 纸条只用一次、会过期', () => {
  it('planned 纸条读一次就删', withDir(async (dir) => {
    markPlannedRestart(dir, 'self-deploy', NOW - 1000)
    expect(consumePreviousRunEvidence(dir, NOW).planned).toEqual({ reason: 'self-deploy', ts: NOW - 1000 })
    expect(consumePreviousRunEvidence(dir, NOW).planned).toBeNull()
  }))

  it('过期的 planned 纸条当没有(也被删掉)', withDir(async (dir) => {
    markPlannedRestart(dir, 'self-deploy', NOW - 20 * 60_000)
    expect(consumePreviousRunEvidence(dir, NOW).planned).toBeNull()
    expect(existsSync(join(dir, 'planned-restart.json'))).toBe(false)
  }))

  it('优雅退出纸条与心跳都读得到,纸条读完即删', withDir(async (dir) => {
    markCleanShutdown(dir, 'SIGTERM', 123, NOW - 2000)
    writeFileSync(join(dir, 'server.heartbeat'), String(NOW - 4000))
    const e = consumePreviousRunEvidence(dir, NOW)
    expect(e.cleanShutdown).toEqual({ cause: 'SIGTERM', pid: 123, ts: NOW - 2000 })
    expect(e.lastHeartbeatAt).toBe(NOW - 4000)
    expect(consumePreviousRunEvidence(dir, NOW).cleanShutdown).toBeNull()
  }))

  it('坏 JSON 不抛错,照样删', withDir(async (dir) => {
    writeFileSync(join(dir, 'planned-restart.json'), '{nope')
    expect(consumePreviousRunEvidence(dir, NOW).planned).toBeNull()
    expect(existsSync(join(dir, 'planned-restart.json'))).toBe(false)
  }))
})

describe('文案与设置', () => {
  it('describeDowntime 用人话', () => {
    expect(describeDowntime(45_000)).toBe('45 秒')
    expect(describeDowntime(5 * 60_000)).toBe('5 分钟')
    expect(describeDowntime(3 * 3600_000)).toBe('3.0 小时')
  })
  it('停机未知时不编时长', () => {
    expect(renderUnplannedRestartText({ downtimeMs: null, recentCount: 1, crashLoop: false })).toBe('CC 刚才意外重启了一次,现在已经恢复。')
  })
  it('坏设置落回缺省', () => {
    expect(resolveRestartNoticeSettings({ min_downtime_s: -1, min_interval_h: Number.NaN })).toEqual(DEFAULT_RESTART_NOTICE)
    expect(resolveRestartNoticeSettings({ min_interval_h: 1 }).minIntervalMs).toBe(3600_000)
  })
})

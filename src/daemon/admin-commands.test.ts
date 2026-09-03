import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeAdminCommands, matchDelegate, matchHandJoin, friendlyDelegateReason, formatOverviewForDisplay, isDelegateName, type AdminCommandsDeps } from './admin-commands'
import { makeSessionStateStore } from '../core/session-state'
import { openTestDb, type Db } from '../lib/db'
import type { InboundMsg } from '../core/prompt-format'
import packageJson from '../../package.json'

describe('admin-commands', () => {
  let stateDir: string
  let db: Db
  let sessionState: ReturnType<typeof makeSessionStateStore>
  let sendMessage: ReturnType<typeof vi.fn>
  let stopAccount: ReturnType<typeof vi.fn>
  let stopAccountAndWait: ReturnType<typeof vi.fn>
  let running: ReturnType<typeof vi.fn>
  let isAdmin: ReturnType<typeof vi.fn>
  let log: ReturnType<typeof vi.fn>
  let loadHearthApi: ReturnType<typeof vi.fn>

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'admin-cmd-'))
    db = openTestDb()
    sessionState = makeSessionStateStore(db)
    sendMessage = vi.fn().mockResolvedValue({ msgId: 'm1' })
    stopAccount = vi.fn()
    stopAccountAndWait = vi.fn(async () => {})
    running = vi.fn(() => ['bot-active-1', 'bot-active-2'])
    isAdmin = vi.fn(() => true)
    log = vi.fn()
    loadHearthApi = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'not_found',
      checked: ['hearth'],
    })
  })
  afterEach(() => {
    db.close()
    rmSync(stateDir, { recursive: true, force: true })
  })

  function make(overrides: Partial<AdminCommandsDeps> = {}) {
    return makeAdminCommands({
      stateDir,
      isAdmin: isAdmin as unknown as AdminCommandsDeps['isAdmin'],
      sessionState,
      pollHandle: {
        stopAccount: stopAccount as unknown as AdminCommandsDeps['pollHandle']['stopAccount'],
        stopAccountAndWait: stopAccountAndWait as unknown as AdminCommandsDeps['pollHandle']['stopAccountAndWait'],
        running: running as unknown as AdminCommandsDeps['pollHandle']['running'],
      },
      resolveUserName: () => undefined,
      sendMessage: sendMessage as unknown as AdminCommandsDeps['sendMessage'],
      loadHearthApi: loadHearthApi as unknown as NonNullable<AdminCommandsDeps['loadHearthApi']>,
      log: log as unknown as AdminCommandsDeps['log'],
      startedAt: '2026-04-24T00:00:00Z',
      // Defaults that make legacy tests opt-out of the AI admin surface; new
      // tests inject real fakes via overrides.
      resolveProject: () => null,
      registry: { list: () => [] },
      sessionManager: { release: async () => {}, list: () => [] },
      sessionStore: { get: () => null, delete: () => {} },
      // /botname deps — no-op defaults so legacy tests don't need to care
      getBotName: () => null,
      setBotName: async () => {},
      botNameFallback: () => 'cc',
      ...overrides,
    })
  }

  function sentBody(call = 0): string {
    const args = sendMessage.mock.calls[call]
    expect(args).toBeDefined()
    return args![1] as string
  }

  function msg(text: string, chatId = 'admin-chat'): InboundMsg {
    return {
      chatId, userId: chatId, accountId: 'bot-active-1',
      text, msgType: 'text', createTimeMs: Date.now(),
    }
  }

  it('returns false for non-matching messages', async () => {
    const cmds = make()
    expect(await cmds.handle(msg('hello'))).toBe(false)
    expect(await cmds.handle(msg('/project list'))).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('/health with no expired bots shows clean state', async () => {
    const cmds = make()
    expect(await cmds.handle(msg('/health'))).toBe(true)
    expect(sendMessage).toHaveBeenCalledOnce()
    const body = sentBody()
    expect(body).toContain('活跃 bot (2)')
    expect(body).toContain('bot-active-1')
    expect(body).toContain('无过期 bot')
  })

  it('/health with expired bots shows cleanup hint', async () => {
    sessionState.markExpired('bot-dead-im-bot', 'getupdates errcode=-14')
    const cmds = make()
    await cmds.handle(msg('/health'))
    const body = sentBody()
    expect(body).toContain('过期 bot (1)')
    expect(body).toContain('bot-dead-im-bot')
    expect(body).toContain('清理 bot-dead-im-bot')
    expect(body).toContain('清理所有过期')
  })

  it('non-admin sender is silently dropped (no reply)', async () => {
    isAdmin.mockReturnValue(false)
    const cmds = make()
    expect(await cmds.handle(msg('/health'))).toBe(true)  // still consumed
    expect(sendMessage).not.toHaveBeenCalled()             // but no response
    expect(log).toHaveBeenCalledWith('ADMIN_CMD', expect.stringContaining('non-admin'))
  })

  describe('/update', () => {
    it('starts the external updater and replies with a restart notice', async () => {
      const updateSelf = vi.fn(async () => ({ ok: true as const, pid: 1234 }))
      const cmds = make({ updateSelf })

      expect(await cmds.handle(msg('/update'))).toBe(true)

      expect(updateSelf).toHaveBeenCalledOnce()
      expect(sentBody()).toContain('开始更新 wechat-cc')
      expect(sentBody()).toContain('短暂重启')
      expect(sentBody()).toContain('pid=1234')
    })

    it('accepts /updata as a typo-tolerant alias', async () => {
      const updateSelf = vi.fn(async () => ({ ok: true as const, pid: 1234 }))
      const cmds = make({ updateSelf })

      expect(await cmds.handle(msg('/updata'))).toBe(true)

      expect(updateSelf).toHaveBeenCalledOnce()
      expect(sentBody()).toContain('开始更新 wechat-cc')
    })

    it('reports updater startup failure without dispatching to the agent', async () => {
      const updateSelf = vi.fn(async () => ({ ok: false as const, reason: 'bun_not_found' }))
      const cmds = make({ updateSelf })

      expect(await cmds.handle(msg('/update'))).toBe(true)

      expect(updateSelf).toHaveBeenCalledOnce()
      expect(sentBody()).toContain('更新没有启动')
      expect(sentBody()).toContain('bun_not_found')
    })

    it('non-admin /update is consumed but does not start the updater', async () => {
      isAdmin.mockReturnValue(false)
      const updateSelf = vi.fn(async () => ({ ok: true as const, pid: 1234 }))
      const cmds = make({ updateSelf })

      expect(await cmds.handle(msg('/update', 'guest-chat'))).toBe(true)

      expect(updateSelf).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  it('清理 <bot-id> removes dir + stops poll + clears state', async () => {
    sessionState.markExpired('bot-dead-im-bot')
    const botDir = join(stateDir, 'accounts', 'bot-dead-im-bot')
    mkdirSync(botDir, { recursive: true })
    writeFileSync(join(botDir, 'token'), 'stale-token')

    const cmds = make()
    await cmds.handle(msg('清理 bot-dead-im-bot'))

    // Phase 3: now uses stopAccountAndWait so the loop's full unwind
    // completes before the rmSync below.
    expect(stopAccountAndWait).toHaveBeenCalledWith('bot-dead-im-bot')
    expect(existsSync(botDir)).toBe(false)
    expect(sessionState.isExpired('bot-dead-im-bot')).toBe(false)
    expect(sentBody()).toContain('清理完成')
  })

  it('清理所有过期 clears multiple at once', async () => {
    sessionState.markExpired('bot-a-im-bot')
    sessionState.markExpired('bot-b-im-bot')
    mkdirSync(join(stateDir, 'accounts', 'bot-a-im-bot'), { recursive: true })
    mkdirSync(join(stateDir, 'accounts', 'bot-b-im-bot'), { recursive: true })

    const cmds = make()
    await cmds.handle(msg('清理所有过期'))

    expect(stopAccountAndWait).toHaveBeenCalledTimes(2)
    expect(sessionState.listExpired()).toHaveLength(0)
    expect(sentBody()).toContain('清理完成 (2)')
  })

  it('清理 <unknown bot> reports error without side effects', async () => {
    sessionState.markExpired('bot-dead-im-bot')
    const cmds = make()
    await cmds.handle(msg('清理 bot-never-existed-im-bot'))

    expect(stopAccountAndWait).not.toHaveBeenCalled()
    expect(sessionState.isExpired('bot-dead-im-bot')).toBe(true)
    expect(sentBody()).toContain('不在过期列表')
  })

  it('does not declare hearth as a hard runtime dependency', () => {
    expect(packageJson.dependencies).not.toHaveProperty('hearth')
  })

  it('/hearth commands report setup guidance when hearth is not installed', async () => {
    const cmds = make()
    expect(await cmds.handle(msg('/hearth list'))).toBe(true)

    expect(loadHearthApi).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledOnce()
    const body = sentBody()
    expect(body).toContain('hearth 未安装或未配置')
    expect(body).toContain('HEARTH_HOME')
    expect(body).toContain('/hearth')
  })

  describe('/reset (AI session reset)', () => {
    it('releases every registered provider\'s in-memory session and clears stored resume ids', async () => {
      const release = vi.fn(async () => {})
      const del = vi.fn()
      const cmds = make({
        resolveProject: () => ({ alias: 'foo', path: '/p/foo' }),
        registry: { list: () => ['claude', 'codex'] },
        sessionManager: { release, list: () => [] },
        sessionStore: { get: () => null, delete: del },
      })
      expect(await cmds.handle(msg('/reset'))).toBe(true)
      // One release call per registered provider, keyed to the chat's alias.
      expect(release).toHaveBeenCalledTimes(2)
      // /reset releases the admin's own (alias, provider, chatId) sessions.
      expect(release).toHaveBeenCalledWith({ alias: 'foo', providerId: 'claude', chatId: 'admin-chat' })
      expect(release).toHaveBeenCalledWith({ alias: 'foo', providerId: 'codex', chatId: 'admin-chat' })
      // Persisted resume ids for the admin's chat are wiped so the next
      // dispatch from that chat starts fresh.
      expect(del).toHaveBeenCalledWith({ alias: 'foo', chatId: 'admin-chat' })
      // User-facing confirmation mentions reset + the chat alias.
      const body = sentBody()
      expect(body).toMatch(/重置|reset/i)
      expect(body).toContain('foo')
    })

    it('/重置 is an accepted alias', async () => {
      const release = vi.fn(async () => {})
      const cmds = make({
        resolveProject: () => ({ alias: 'bar', path: '/p/bar' }),
        registry: { list: () => ['claude'] },
        sessionManager: { release, list: () => [] },
        sessionStore: { get: () => null, delete: () => {} },
      })
      expect(await cmds.handle(msg('/重置'))).toBe(true)
      expect(release).toHaveBeenCalledWith({ alias: 'bar', providerId: 'claude', chatId: 'admin-chat' })
    })

    it('reports a clear message and no side effects when the chat has no project mapped', async () => {
      const release = vi.fn(async () => {})
      const del = vi.fn()
      const cmds = make({
        resolveProject: () => null,
        registry: { list: () => ['claude'] },
        sessionManager: { release, list: () => [] },
        sessionStore: { get: () => null, delete: del },
      })
      expect(await cmds.handle(msg('/reset'))).toBe(true)
      expect(release).not.toHaveBeenCalled()
      expect(del).not.toHaveBeenCalled()
      expect(sentBody()).toMatch(/未绑定|no project|未映射/i)
    })
  })

  describe('/health ai', () => {
    it('lists every registered provider with stored-session age for the chat', async () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
      const cmds = make({
        resolveProject: () => ({ alias: 'foo', path: '/p/foo' }),
        registry: { list: () => ['claude', 'codex'] },
        sessionManager: { release: async () => {}, list: () => [] },
        sessionStore: {
          get: ({ alias, provider, chatId }) => {
            // /health ai now reads the admin's own session row.
            if (alias === 'foo' && provider === 'claude' && chatId === 'admin-chat') {
              return { alias, session_id: 'sid-1', last_used_at: fiveMinAgo, provider: 'claude', chat_id: chatId }
            }
            return null
          },
          delete: () => {},
        },
      })
      expect(await cmds.handle(msg('/health ai'))).toBe(true)
      const body = sentBody()
      // Both providers appear, with their status.
      expect(body).toContain('claude')
      expect(body).toContain('codex')
      // claude has a session (5m fresh); codex doesn't.
      expect(body).toMatch(/5m|5 min/i)
      expect(body).toMatch(/无.*会话|no.*session/i)
    })

    it('reports gracefully when the chat has no project mapped', async () => {
      const cmds = make({
        resolveProject: () => null,
        registry: { list: () => ['claude'] },
        sessionManager: { release: async () => {}, list: () => [] },
        sessionStore: { get: () => null, delete: () => {} },
      })
      expect(await cmds.handle(msg('/health ai'))).toBe(true)
      expect(sentBody()).toMatch(/未绑定|no project|未映射/i)
    })
  })

  describe('整理记忆 (memory synthesis)', () => {
    // runSynthesize is fire-and-forget, so flush the macrotask queue before
    // asserting on the async replies.
    const flush = () => new Promise(r => setTimeout(r, 0))

    it('admin triggers synthesis and replies with the result', async () => {
      const synthesizeMemory = vi.fn().mockResolvedValue({
        projectsFound: 3, projectNames: ['alpha', 'beta', 'gamma'], filesScanned: 9,
        written: { path: '_overview.md', bytesWritten: 500 },
      })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()
      expect(synthesizeMemory).toHaveBeenCalledWith('admin-chat')
      expect(sendMessage).toHaveBeenCalledTimes(2)
      expect(sentBody(0)).toContain('正在重新整理')
      expect(sentBody(1)).toContain('整理完成')
      expect(sentBody(1)).toContain('alpha')
    })

    it('surfaces the life-side counts folded into the synthesis', async () => {
      const synthesizeMemory = vi.fn().mockResolvedValue({
        projectsFound: 1, projectNames: ['alpha'], filesScanned: 2,
        observationsFound: 7, milestonesFound: 2, memoryNotesFound: 3,
        written: { path: '_overview.md', bytesWritten: 500 },
      })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      await cmds.handle(msg('整理记忆'))
      await flush()
      const body = sentBody(1)
      expect(body).toContain('生活侧')
      expect(body).toContain('7 条观察')
      expect(body).toContain('2 个里程碑')
      expect(body).toContain('3 篇记忆笔记')
    })

    it('reports nothing-to-synthesize when both work and life are empty', async () => {
      const synthesizeMemory = vi.fn().mockResolvedValue({ projectsFound: 0, projectNames: [], filesScanned: 0 })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      await cmds.handle(msg('整理记忆'))
      await flush()
      expect(sentBody(1)).toContain('没找到可整理的记忆')
    })

    // Fix 4a: success message includes file-survey folder count when > 0
    it('includes file folder count in the synthesis summary when survey was folded in', async () => {
      const synthesizeMemory = vi.fn().mockResolvedValue({
        projectsFound: 1, projectNames: ['alpha'], filesScanned: 2,
        foldersScanned: 12,
        written: { path: '_overview.md', bytesWritten: 500 },
      })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      await cmds.handle(msg('整理记忆'))
      await flush()
      expect(sentBody(1)).toContain('本机文件 12 个文件夹')
    })

    // Fix 4b: empty-state message also mentions the file side
    it('empty-state message mentions the file side alongside projects and life', async () => {
      const synthesizeMemory = vi.fn().mockResolvedValue({ projectsFound: 0, projectNames: [], filesScanned: 0 })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      await cmds.handle(msg('整理记忆'))
      await flush()
      expect(sentBody(1)).toContain('本机文件')
    })

    it('matches natural-language phrasings and slash aliases', async () => {
      const synthesizeMemory = vi.fn().mockResolvedValue({ projectsFound: 0, projectNames: [], filesScanned: 0 })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      // Distinct chats so the per-chat in-flight guard doesn't drop the later
      // ones — we're only asserting the regex matches each phrasing here.
      const phrases = ['重新整理你对我的理解', '更新记忆', '/synthesize']
      for (let i = 0; i < phrases.length; i++) {
        expect(await cmds.handle(msg(phrases[i]!, `admin-${i}`))).toBe(true)
      }
      await flush()
      expect(synthesizeMemory).toHaveBeenCalledTimes(3)
    })

    it('double-tap is guarded: second trigger waits, only one LLM run', async () => {
      // First run hangs until we release it, so the second tap lands while
      // it's in flight.
      let release: () => void = () => {}
      const gate = new Promise<void>(r => { release = r })
      const synthesizeMemory = vi.fn().mockImplementation(async () => {
        await gate
        return { projectsFound: 1, projectNames: ['x'], filesScanned: 1, written: { path: '_overview.md', bytesWritten: 1 } }
      })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()  // first run is now awaiting the gate
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()  // second run hits the guard
      expect(synthesizeMemory).toHaveBeenCalledTimes(1)
      expect(sendMessage.mock.calls.some(c => String(c[1]).includes('稍等'))).toBe(true)
      release()
      await flush()
    })

    // busy-registry hold (spec 2026-08-11 §2, code review — "微信管理命令
    // 两条 fire-and-forget 是清点漏掉的第七类"). runSynthesize is dispatched
    // `void runSynthesize(...)` — outside SessionManager, invisible to the
    // idle self-restart check unless it holds a token itself.
    it('holds a busy-registry token for the whole run, released after it settles', async () => {
      let release: (r: unknown) => void = () => {}
      const gate = new Promise(r => { release = r })
      const synthesizeMemory = vi.fn().mockImplementation(() => gate)
      const releaseBusy = vi.fn()
      const holdBusy = vi.fn((label: string) => { expect(label).toBe('admin-synthesize'); return releaseBusy })
      const cmds = make({
        synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'],
        holdBusy,
      })
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()
      expect(holdBusy).toHaveBeenCalledWith('admin-synthesize')
      expect(releaseBusy).not.toHaveBeenCalled()
      release({ projectsFound: 0, projectNames: [], filesScanned: 0 })
      await flush()
      expect(releaseBusy).toHaveBeenCalledTimes(1)
    })

    it('releases the busy-registry token even when synthesizeMemory throws', async () => {
      const synthesizeMemory = vi.fn().mockRejectedValue(new Error('boom'))
      const releaseBusy = vi.fn()
      const holdBusy = vi.fn(() => releaseBusy)
      const cmds = make({
        synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'],
        holdBusy,
      })
      await cmds.handle(msg('整理记忆'))
      await flush()
      expect(releaseBusy).toHaveBeenCalledTimes(1)
    })

    it('non-admin is consumed but does NOT synthesize or reply', async () => {
      isAdmin.mockReturnValue(false)
      const synthesizeMemory = vi.fn()
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()
      expect(synthesizeMemory).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('看记忆 / 你对我的理解 (read back the overview)', () => {
    it('replies with the synthesized overview', async () => {
      const readOverview = vi.fn().mockResolvedValue('## 整体理解\n你是个设计师，喜欢猫。')
      const cmds = make({ readOverview: readOverview as unknown as AdminCommandsDeps['readOverview'] })
      expect(await cmds.handle(msg('你对我的理解'))).toBe(true)
      expect(readOverview).toHaveBeenCalledWith('admin-chat')
      expect(sentBody(0)).toContain('我目前对你的理解')
      expect(sentBody(0)).toContain('喜欢猫')
    })

    it('strips the machine stamp comment from the read-back', async () => {
      const stamped = '<!-- 由 wechat-cc 从本机 Claude 记忆整理生成 · 2026-06-15T14:58:22.979Z -->\n\n## 整体理解\n喜欢猫。'
      const readOverview = vi.fn().mockResolvedValue(stamped)
      const cmds = make({ readOverview: readOverview as unknown as AdminCommandsDeps['readOverview'] })
      await cmds.handle(msg('看记忆'))
      const body = sentBody(0)
      expect(body).not.toContain('<!--')          // raw comment never shown
      expect(body).not.toContain('wechat-cc 从本机')
      expect(body).toContain('整理于')             // timestamp surfaced friendly
      expect(body).toContain('喜欢猫')
    })

    it('matches several phrasings + the /overview alias', async () => {
      const readOverview = vi.fn().mockResolvedValue('x')
      const cmds = make({ readOverview: readOverview as unknown as AdminCommandsDeps['readOverview'] })
      for (const p of ['看记忆', '你眼中的我', '你怎么理解我', '你记得我什么', '/overview']) {
        expect(await cmds.handle(msg(p))).toBe(true)
      }
      expect(readOverview).toHaveBeenCalledTimes(5)
    })

    it('guides to synthesize when no overview exists yet', async () => {
      const readOverview = vi.fn().mockResolvedValue(null)
      const cmds = make({ readOverview: readOverview as unknown as AdminCommandsDeps['readOverview'] })
      await cmds.handle(msg('看记忆'))
      expect(sentBody(0)).toContain('整理记忆')
    })

    it('does NOT collide with synthesis phrasings (重新整理你对我的理解 → synthesize, not show)', async () => {
      const readOverview = vi.fn().mockResolvedValue('x')
      const synthesizeMemory = vi.fn().mockResolvedValue({ projectsFound: 0, projectNames: [], filesScanned: 0 })
      const cmds = make({
        readOverview: readOverview as unknown as AdminCommandsDeps['readOverview'],
        synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'],
      })
      await cmds.handle(msg('重新整理你对我的理解'))
      await new Promise(r => setTimeout(r, 0))
      expect(readOverview).not.toHaveBeenCalled()
      expect(synthesizeMemory).toHaveBeenCalled()
    })
  })

  describe('让/派 <hand> 执行/跑 <task> (delegate to a hand)', () => {
    const flush = () => new Promise(r => setTimeout(r, 0))

    it('parses hand + task, calls delegateToHand, replies the result', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: true, response: '家里 README: 项目X' })
      const cmds = make({
        delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'],
        knownHandNames: () => ['家里'],
      })
      expect(await cmds.handle(msg('让家里执行 看下README'))).toBe(true)
      await flush()
      expect(delegateToHand).toHaveBeenCalledWith('家里', '看下README')
      expect(sentBody(1)).toContain('家里 README: 项目X')
    })

    it('does NOT hijack casual pronoun phrases ("让我执行一下X" → normal chat)', async () => {
      const delegateToHand = vi.fn()
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'], knownHandNames: () => ['家里', '公司'] })
      // Not consumed as a command → falls through to the normal conversation path.
      expect(await cmds.handle(msg('让我执行一下这个脚本'))).toBe(false)
      expect(await cmds.handle(msg('让它跑起来再说'))).toBe(false)
      await flush()
      expect(delegateToHand).not.toHaveBeenCalled()
    })

    it('also matches 派…跑 form and a colon', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: true, response: 'r' })
      const cmds = make({
        delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'],
        knownHandNames: () => ['公司'],
      })
      expect(await cmds.handle(msg('派公司跑：跑下测试'))).toBe(true)
      await flush()
      expect(delegateToHand).toHaveBeenCalledWith('公司', '跑下测试')
    })

    it('unknown hand → replies the known list (discovery)', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: false, reason: 'unknown_hand', knownHands: ['家里', '公司'] })
      // 手名在触发时就已经命中过一次,能走到 unknown_hand 说明**这中间手被
      // 摘掉了**(移除/暂停)—— 这条分支因此仍然是活的,而且是唯一会报它的
      // 场景。触发器本身不再拿未知名字去猜(见 matchDelegate 的取舍说明)。
      const cmds = make({
        delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'],
        knownHandNames: () => ['火星'],
      })
      await cmds.handle(msg('让火星执行 X'))
      await flush()
      expect(sentBody(1)).toContain('已注册的')
      expect(sentBody(1)).toContain('家里')
    })

    it('unknown hand with NO hands registered → guides to pair one', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: false, reason: 'unknown_hand', knownHands: [] })
      const cmds = make({
        delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'],
        knownHandNames: () => ['家里'],
      })
      await cmds.handle(msg('让家里执行 X'))
      await flush()
      expect(sentBody(1)).toContain('hand invite')
      expect(sentBody(1)).not.toContain('unknown_hand')   // no raw code leak
    })

    it('a failure reason is shown in friendly form, not a raw code', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: false, reason: 'http_401' })
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'], knownHandNames: () => ['家里', '公司'] })
      await cmds.handle(msg('让家里执行 X'))
      await flush()
      expect(sentBody(1)).toContain('重新配对')
    })

    it('认得出手名、但派活能力没接上 → 明说没启用', async () => {
      // 接线不一致才会走到这里(有手名、没有 delegateToHand)。触发器现在
      // 按名字认,所以这条分支只在这种不一致下可达 —— 保留它是防御性的。
      const cmds = make({ knownHandNames: () => ['家里'] })  // no delegateToHand
      expect(await cmds.handle(msg('让家里执行 X'))).toBe(true)
      await flush()
      expect(sentBody(0)).toContain('派活功能未启用')
    })

    // busy-registry hold (spec 2026-08-11 §2, code review — "微信管理命令
    // 两条 fire-and-forget 是清点漏掉的第七类"). runDelegate is dispatched
    // `void runDelegate(...)` — outside SessionManager, waits on a remote
    // hand's A2A exec, invisible to the idle self-restart check unless it
    // holds a token itself.
    it('holds a busy-registry token for the whole run, released after it settles', async () => {
      let release: (r: unknown) => void = () => {}
      const gate = new Promise(r => { release = r })
      const delegateToHand = vi.fn().mockImplementation(() => gate)
      const releaseBusy = vi.fn()
      const holdBusy = vi.fn((label: string) => { expect(label).toBe('admin-delegate'); return releaseBusy })
      const cmds = make({
        delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'],
        knownHandNames: () => ['家里'],
        holdBusy,
      })
      expect(await cmds.handle(msg('让家里执行 看下README'))).toBe(true)
      await flush()
      expect(holdBusy).toHaveBeenCalledWith('admin-delegate')
      expect(releaseBusy).not.toHaveBeenCalled()
      release({ ok: true, response: 'done' })
      await flush()
      expect(releaseBusy).toHaveBeenCalledTimes(1)
    })

    it('releases the busy-registry token even when delegateToHand throws', async () => {
      const delegateToHand = vi.fn().mockRejectedValue(new Error('boom'))
      const releaseBusy = vi.fn()
      const holdBusy = vi.fn(() => releaseBusy)
      const cmds = make({
        delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'],
        knownHandNames: () => ['家里'],
        holdBusy,
      })
      await cmds.handle(msg('让家里执行 X'))
      await flush()
      expect(releaseBusy).toHaveBeenCalledTimes(1)
    })

    it('non-admin is consumed but does NOT delegate', async () => {
      isAdmin.mockReturnValue(false)
      const delegateToHand = vi.fn()
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'], knownHandNames: () => ['家里', '公司'] })
      expect(await cmds.handle(msg('让家里执行 X'))).toBe(true)
      await flush()
      expect(delegateToHand).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('/botname command', () => {
    let getBotName: ReturnType<typeof vi.fn>
    let setBotName: ReturnType<typeof vi.fn>
    let botNameFallback: ReturnType<typeof vi.fn>

    function mkMsg(text: string, chatId = 'admin-1'): InboundMsg {
      return {
        chatId, userId: chatId, userName: undefined, accountId: 'a1',
        text, msgType: 'text', createTimeMs: 0,
      }
    }

    function build(): ReturnType<typeof makeAdminCommands> {
      return makeAdminCommands({
        stateDir,
        isAdmin: isAdmin as unknown as AdminCommandsDeps['isAdmin'],
        sessionState,
        pollHandle: {
          stopAccount: stopAccount as unknown as AdminCommandsDeps['pollHandle']['stopAccount'],
          stopAccountAndWait: stopAccountAndWait as unknown as AdminCommandsDeps['pollHandle']['stopAccountAndWait'],
          running: running as unknown as AdminCommandsDeps['pollHandle']['running'],
        },
        resolveUserName: () => undefined,
        sendMessage: sendMessage as unknown as AdminCommandsDeps['sendMessage'],
        resolveProject: () => null,
        registry: { list: () => [] },
        sessionManager: { release: vi.fn(), list: vi.fn(() => []) },
        sessionStore: { get: vi.fn(() => null), delete: vi.fn() },
        log: log as unknown as AdminCommandsDeps['log'],
        startedAt: '2026-05-25T00:00:00.000Z',
        getBotName: getBotName as unknown as AdminCommandsDeps['getBotName'],
        setBotName: setBotName as unknown as AdminCommandsDeps['setBotName'],
        botNameFallback: botNameFallback as unknown as AdminCommandsDeps['botNameFallback'],
      })
    }

    beforeEach(() => {
      getBotName = vi.fn(() => null)
      setBotName = vi.fn(async () => {})
      botNameFallback = vi.fn(() => 'cc')
      isAdmin.mockReturnValue(true)
    })

    it('/botname <valid> from admin → setBotName called + ack', async () => {
      const handler = build()
      const consumed = await handler.handle(mkMsg('/botname 小希'))
      expect(consumed).toBe(true)
      expect(setBotName).toHaveBeenCalledWith('小希')
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('小希'))
    })

    it('/botname <valid> from non-admin → silently consumed, no setBotName', async () => {
      isAdmin.mockReturnValue(false)
      const handler = build()
      const consumed = await handler.handle(mkMsg('/botname 偷偷改'))
      expect(consumed).toBe(true)  // matches existing admin-cmd convention: drop silently
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('/botname 跳过 → setBotName(null) + ack with fallback', async () => {
      botNameFallback.mockReturnValue('cc')
      const handler = build()
      await handler.handle(mkMsg('/botname 跳过'))
      expect(setBotName).toHaveBeenCalledWith(null)
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('cc'))
    })

    it('/botname (bare, bot_name set) → show current', async () => {
      getBotName.mockReturnValue('小希')
      const handler = build()
      await handler.handle(mkMsg('/botname'))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('小希'))
    })

    it('/botname (bare, bot_name null) → show fallback', async () => {
      getBotName.mockReturnValue(null)
      botNameFallback.mockReturnValue('cc')
      const handler = build()
      await handler.handle(mkMsg('/botname'))
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('cc'))
    })

    it('/botname <too long> → validation reply, no setBotName', async () => {
      const longName = 'a'.repeat(25)
      const handler = build()
      await handler.handle(mkMsg(`/botname ${longName}`))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('太长'))
    })

    it('/botname <illegal chars> → validation reply, no setBotName', async () => {
      const handler = build()
      await handler.handle(mkMsg('/botname 🌸emoji🌸'))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('不行'))
    })

    it('setBotName throws → ack with retry hint, no crash', async () => {
      setBotName.mockRejectedValueOnce(new Error('disk full'))
      const handler = build()
      const consumed = await handler.handle(mkMsg('/botname 小希'))
      expect(consumed).toBe(true)
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('稍后再试'))
    })

    // Regression guard for the /name vs /botname collision (final-review C1):
    // /name is mode-commands' pre-existing user-self-rename, and admin-commands
    // must NOT consume it — otherwise it'd silently drop non-admin renames and
    // hijack admin's own user-rename. The pipeline runs mw-admin before
    // mw-mode, so admin-commands.handle() must return false for /name to let
    // mw-mode see it.
    it('/name <X> from admin → NOT consumed (falls through to mode-commands)', async () => {
      const handler = build()
      const consumed = await handler.handle(mkMsg('/name Nate'))
      expect(consumed).toBe(false)
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('/name <X> from non-admin → NOT consumed either', async () => {
      isAdmin.mockReturnValue(false)
      const handler = build()
      const consumed = await handler.handle(mkMsg('/name 丸子'))
      expect(consumed).toBe(false)
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('粘码加手 —— 端到端行为', () => {
    const flush = () => new Promise(r => setTimeout(r, 0))

    it('配对成功 → 显出 url,然后当场试一次派活', async () => {
      const joinHandByCode = vi.fn().mockResolvedValue({ ok: true, id: 'win', name: 'win-test', url: 'http://10.0.0.5:8717/a2a' })
      const delegateToHand = vi.fn().mockResolvedValue({ ok: true, response: '收到' })
      const cmds = make({
        joinHandByCode: joinHandByCode as unknown as AdminCommandsDeps['joinHandByCode'],
        delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'],
      })
      expect(await cmds.handle(msg('WCCP1abcdef'))).toBe(true)
      await flush()
      expect(joinHandByCode).toHaveBeenCalledWith('WCCP1abcdef')
      // url 必须出现 —— 粘错别人给的码,这是唯一能一眼看见的地方
      expect(sentBody(1)).toContain('http://10.0.0.5:8717/a2a')
      expect(delegateToHand).toHaveBeenCalled()
      expect(sentBody(2)).toContain('通了')
    })

    it('配上了但派活不通 → **分开说**,不让半成功冒充成功', async () => {
      // 这正是 owner 今天撞到的形态:配对成功、第一次派活才发现连不上。
      const joinHandByCode = vi.fn().mockResolvedValue({ ok: true, id: 'win', name: 'win', url: 'http://10.0.0.5:8717/a2a' })
      const delegateToHand = vi.fn().mockResolvedValue({ ok: false, reason: 'Was there a typo in the url or port?' })
      const cmds = make({
        joinHandByCode: joinHandByCode as unknown as AdminCommandsDeps['joinHandByCode'],
        delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'],
      })
      await cmds.handle(msg('WCCP1abcdef'))
      await flush()
      expect(sentBody(2)).toContain('配上了,但派活没通')
      expect(sentBody(2)).toContain('连不上')      // 走 friendlyDelegateReason,不透传 Bun 原文
    })

    it('配对失败 → 友好原因,不透传裸错误', async () => {
      const joinHandByCode = vi.fn().mockResolvedValue({ ok: false, error: 'invalid_or_expired_invite' })
      const cmds = make({ joinHandByCode: joinHandByCode as unknown as AdminCommandsDeps['joinHandByCode'] })
      await cmds.handle(msg('WCCP1abcdef'))
      await flush()
      expect(sentBody(1)).toContain('配对失败')
    })

    it('非 admin 粘码 → 消费掉但绝不配对', async () => {
      const joinHandByCode = vi.fn()
      const cmds = make({
        isAdmin: () => false,
        joinHandByCode: joinHandByCode as unknown as AdminCommandsDeps['joinHandByCode'],
      })
      expect(await cmds.handle(msg('WCCP1abcdef'))).toBe(true)
      await flush()
      expect(joinHandByCode).not.toHaveBeenCalled()
    })

    it('/hands 列出已配对的手(补回上一轮为精确性删掉的发现性)', async () => {
      const cmds = make({ listHands: () => [{ id: 'win', name: 'win-test', url: 'http://10.0.0.5:8717/a2a' }] })
      expect(await cmds.handle(msg('/hands'))).toBe(true)
      await flush()
      expect(sentBody(0)).toContain('win-test')
      expect(sentBody(0)).toContain('让win-test')
    })

    it('一台手都没有 → 告诉他怎么加,而不是一句「没有」', async () => {
      const cmds = make({ listHands: () => [] })
      await cmds.handle(msg('有哪些手'))
      await flush()
      expect(sentBody(0)).toContain('hand invite')
    })
  })
})

describe('friendlyDelegateReason', () => {
  it('maps known reason codes to readable lines', () => {
    expect(friendlyDelegateReason('paused')).toContain('暂停')
    expect(friendlyDelegateReason('timeout')).toContain('超时')
    expect(friendlyDelegateReason('http_401')).toContain('重新配对')
    expect(friendlyDelegateReason('http_500')).toContain('http_500')   // shown verbatim inside the line
    expect(friendlyDelegateReason('fetch failed')).toContain('连不上')
  })
  it('passes through an unrecognized (already-readable) reason', () => {
    expect(friendlyDelegateReason('某个自定义说明')).toBe('某个自定义说明')
  })
})

describe('formatOverviewForDisplay', () => {
  it('strips the stamp comment and surfaces its timestamp', () => {
    const out = formatOverviewForDisplay('<!-- 由 wechat-cc 整理 · 2026-06-15T14:58:22.979Z -->\n\n正文内容')
    expect(out).not.toContain('<!--')
    expect(out).toContain('整理于')
    expect(out).toContain('正文内容')
    expect(out.indexOf('整理于')).toBeLessThan(out.indexOf('正文内容'))  // timestamp leads
  })
  it('returns content unchanged when there is no stamp', () => {
    expect(formatOverviewForDisplay('  纯内容，没有戳  ')).toBe('纯内容，没有戳')
  })
  it('drops the comment even when it lacks a parseable timestamp', () => {
    const out = formatOverviewForDisplay('<!-- no ts here -->\n正文')
    expect(out).toBe('正文')
  })
})

describe('isDelegateName', () => {
  it('accepts real hand names', () => {
    for (const n of ['家里', '公司', 'home', 'office-mac']) expect(isDelegateName(n)).toBe(true)
  })
  it('rejects pronouns (so casual speech is not a delegate command)', () => {
    for (const n of ['我', '你', '他', '她', '它', '我们', '大家', '自己']) expect(isDelegateName(n)).toBe(false)
  })
})

// 2026-09-02,真机:owner 在微信里发「让win执行1+1=？」,收到
//
//   派活失败:Was there a typo in the url or port?
//
// 那台手当时瞬时掉线(它走 WLAN,会掉 —— 见 win-test 备忘)。真实原因是
// 「对方现在连不上」,而 owner 看到的是「你 URL 是不是打错了」——他的
// 合理反应是去查 URL,白费功夫。
//
// 根因不是没人管:friendlyDelegateReason **本来就有**「连不上」那条分支,
// 但它是照着 **Node 的错误词汇**写的(fetch failed / ECONNREFUSED /
// ENOTFOUND)。**这个 daemon 跑在 Bun 上,Bun 说的是另一套话。** 于是分支
// 形同虚设,原始串直通用户。
//
// 下面两条是这一轮真机日志里**实际出现过**的 Bun 措辞,不是想象出来的。
describe('friendlyDelegateReason —— 必须认识 Bun 的连接错误措辞,不只是 Node 的', () => {
  const BUN_CONNECT_ERRORS = [
    'Was there a typo in the url or port?',              // Bun: 连接被拒
    'Unable to connect. Is the computer able to access the url?',  // Bun: 连不上
    'ConnectionRefused',
  ]

  it.each(BUN_CONNECT_ERRORS)('%s → 说成「连不上」,不是原样透传', (raw) => {
    const out = friendlyDelegateReason(raw)
    expect(out).toContain('连不上')
    expect(out).not.toBe(raw)
  })

  it('Node 的老措辞继续认识(没有为了新的把旧的弄丢)', () => {
    for (const raw of ['fetch failed', 'ECONNREFUSED', 'ENOTFOUND host']) {
      expect(friendlyDelegateReason(raw)).toContain('连不上')
    }
  })

  // 兜底刻意保持原样透传:我们自己产出的 reason 本来就是给人看的中文
  // (如「unknown_peer: claude —— 这台机器可用的是 [openai]」),包一层
  // 「我看不懂的错误」只会把好消息弄糟。见同文件已有的 passthrough 用例。
  it('我们自己产出的、已经能读的原因照旧原样透传', () => {
    const own = 'unknown_peer: claude —— 这台机器可用的是 [openai]'
    expect(friendlyDelegateReason(own)).toBe(own)
  })

  it('已经认识的原因不受影响', () => {
    expect(friendlyDelegateReason('paused')).toContain('暂停')
    expect(friendlyDelegateReason('http_401')).toContain('配对密钥')
    expect(friendlyDelegateReason('timeout')).toContain('超时')
  })
})

// 2026-09-02。owner 在微信里发「让win想一想1+1=？」—— 没触发派活,本机答了。
// 因为触发器卡的是**动词**:
//
//   /^\s*(?:让|派)\s*(\S+?)\s*(?:执行|跑)\s*.../
//
// 注释解释得很好(「让/派 + 执行/跑 才能挡住日常语句」),但**判别维度选错
// 了**:按动词卡是打地鼠 —— 想一想、看看、查一下、帮我、试试……补不完。
//
// 天然的判别器是**名字**:手名是 owner 亲手注册的,一共就那么几个。命中
// 已注册的手名才算派活,没命中就落回正常聊天 —— 反而比动词表更严,因为
// 动词表要跟整个汉语日常表达竞争,而名字集合小且由人指定。
//
// 中文没有词间空格,所以不能靠分隔符切「名字|任务」,只能拿已知的手名去
// 前缀匹配。
describe('matchDelegate —— 按已注册的手名认,不按动词认', () => {
  const hands = ['win', '家里', '公司那台']

  it('owner 撞到的那句:让win想一想1+1=？', () => {
    expect(matchDelegate('让win想一想1+1=？', hands)).toEqual({ hand: 'win', task: '想一想1+1=？' })
  })

  it.each([
    ['让win看看日志', 'win', '看看日志'],
    ['派家里查一下磁盘', '家里', '查一下磁盘'],
    ['让公司那台帮我跑测试', '公司那台', '帮我跑测试'],
    ['让win：git status', 'win', 'git status'],
    ['让win, 重启一下', 'win', '重启一下'],
  ])('%s', (text, hand, task) => {
    expect(matchDelegate(text, hands)).toEqual({ hand, task })
  })

  it('名字后紧跟的「执行/跑」当语气词剥掉,不混进任务', () => {
    expect(matchDelegate('让win执行1+1=？', hands)).toEqual({ hand: 'win', task: '1+1=？' })
    expect(matchDelegate('派家里跑一下测试', hands)).toEqual({ hand: '家里', task: '一下测试' })
  })

  it('句中的「跑」不会把名字吃掉(中文没有词间空格,这正是旧触发器的坑)', () => {
    // 旧版 `让(\S+?)\s*(?:执行|跑)` 会把这句切成 名字=公司那台帮我 / 任务=测试。
    expect(matchDelegate('让公司那台帮我跑测试', hands)).toEqual({ hand: '公司那台', task: '帮我跑测试' })
  })

  it('大小写不敏感,但回的是注册时的原名(下游要按它查)', () => {
    expect(matchDelegate('让Win看看日志', hands)).toEqual({ hand: 'win', task: '看看日志' })
    expect(matchDelegate('让WIN看看日志', hands)).toEqual({ hand: 'win', task: '看看日志' })
    // 边界检查也要跟着不区分大小写,别从更长的词里匹出来
    expect(matchDelegate('让WINNER去吧', hands)).toBeNull()
  })

  it('长名字优先 —— 别被短名字抢先匹配', () => {
    expect(matchDelegate('让win-office看看', ['win', 'win-office']))
      .toEqual({ hand: 'win-office', task: '看看' })
  })

  it('没命中任何手名 → null,落回正常聊天(不再回「没找到叫X的手」的噪音)', () => {
    expect(matchDelegate('让张三跑一趟', hands)).toBeNull()
    expect(matchDelegate('让我看看这个', hands)).toBeNull()
    expect(matchDelegate('让它跑起来', hands)).toBeNull()
  })

  it('代词永远不算手名,哪怕真有人把手起名叫「我」', () => {
    expect(matchDelegate('让我执行一下X', ['我'])).toBeNull()
  })

  it('只有名字没有任务 → null(「让win」不是一条指令)', () => {
    expect(matchDelegate('让win', hands)).toBeNull()
    expect(matchDelegate('让win  ', hands)).toBeNull()
  })

  it('不以让/派开头 → null', () => {
    expect(matchDelegate('win 你在吗', hands)).toBeNull()
    expect(matchDelegate('我让win去做了', hands)).toBeNull()
  })

  it('一个手都没注册 → 永远 null(不会把日常语句吃掉)', () => {
    expect(matchDelegate('让win想一想', [])).toBeNull()
  })

  it('手名打错 → null,落回正常聊天', () => {
    // **刻意的取舍**:旧版在这里会回「没找到叫「winn」的手,已注册的:…」,
    // 是个发现性入口。但要保住它就得让「未知名字 + 动词」也算触发,而中文
    // 句中的动词到处都是 —— 「让张三跑一趟」会被同一条规则劫走并回一句
    // 噪音。精确性比发现性值钱:名字从 `hand join` 的输出里就能看到。
    expect(matchDelegate('让winn执行ls', hands)).toBeNull()
    expect(matchDelegate('让winner去吧', hands)).toBeNull()   // 不能从更长的英文词里匹出来
  })
})

// 2026-09-02 C:把 `hand join` 搬进微信 —— 大脑那台是**绑了微信的那台**,
// 让 owner 为了粘一串码去开终端是没道理的。配完流程变成:
//   手那台跑一条 `wechat-cc hand invite`,微信里粘一次码。
describe('粘配对码进微信 = 加一台手', () => {
  it('裸码直接触发(不用记命令前缀 —— 你刚从终端复制完,别再要求你想一个)', () => {
    expect(matchHandJoin('WCCP1eyJoYW5kVXJsIjoieCJ9')).toBe('WCCP1eyJoYW5kVXJsIjoieCJ9')
  })

  it('前后有空白照样认(复制粘贴常带)', () => {
    expect(matchHandJoin('  WCCP1abc  \n')).toBe('WCCP1abc')
  })

  it('/hand <码> 作为显式别名', () => {
    expect(matchHandJoin('/hand WCCP1abc')).toBe('WCCP1abc')
    expect(matchHandJoin('/配对 WCCP1abc')).toBe('WCCP1abc')
  })

  it('普通聊天不会误撞 —— WCCP1 前缀在真实对话里不存在', () => {
    for (const t of ['今天天气不错', 'WCC 是什么', 'wccp1abc（小写不算）', '帮我看看 WCCP 这个缩写']) {
      expect(matchHandJoin(t)).toBeNull()
    }
  })

  it('码中间有换行(微信长文本会折行)→ 拼回去', () => {
    expect(matchHandJoin('WCCP1abc\ndef')).toBe('WCCP1abcdef')
  })

  it('空的 /hand → null(当普通消息处理,别回一个语法错误)', () => {
    expect(matchHandJoin('/hand')).toBeNull()
    expect(matchHandJoin('/hand   ')).toBeNull()
  })
})

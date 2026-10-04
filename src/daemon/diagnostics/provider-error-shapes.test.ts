/**
 * 钉住**今天**的判定对真实 provider 失败样本各说什么 —— 记录,不是期望。
 *
 * 样本:`__fixtures__/provider-errors/*.json`(真机日志采集 + 沙箱诱发,已脱敏)。
 * 背景与错判清单:docs/reference/provider-error-shapes.md。
 *
 * 这个测试**故意**把错判也钉住(例如 cursor ACP 上 `-32603` 的假 key 判
 * `provider_error` ⇒ unknown —— 与死代理逐字相同,不猜)。改判定时它会红 —— 那是
 * 预期的:把 fixture 里对应样本的 `current` / `errorCode` 改成新答案,并在文档里
 * 划掉那一条错判。第 2 步(2026-10-02)起每条样本的 `errorCode` 是 provider 边界
 * 现在挂上的码,各家边界的测试(codex-errors / cursor-errors / agy-errors /
 * claude-cheap-eval-error …)对拍同一份 fixture。
 * 不要为了让它绿而改样本的 `message`:那是真机原文(唯一的例外是我们自己加的包装,
 * 比如 openai 一次性评估以前加的 `auth_failed:` 前缀,第 2 步删掉了)。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentVerdicts, expectedHealthKind, type ProviderErrorSample } from './provider-error-verdicts'
import { classifyFailure } from '../health/classify'
import { errorWithProviderCode } from '../../lib/provider-error-code'
import { authFailNotice } from '../../core/conversation-coordinator'

const DIR = join(__dirname, '__fixtures__', 'provider-errors')
const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
const samples: ProviderErrorSample[] = files.flatMap(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as ProviderErrorSample[])

describe('provider 失败样本 —— 语料本身', () => {
  it('每家 provider 都有样本,id 不重复', () => {
    expect(new Set(samples.map(s => s.provider))).toEqual(new Set(['claude', 'codex', 'cursor', 'agy', 'openai', 'gemini']))
    expect(new Set(samples.map(s => s.id)).size).toBe(samples.length)
  })

  it('已脱敏:不含真实请求 id / 会话 uuid / 微信聊天 id / 未打码的 key', () => {
    for (const s of samples) {
      expect(s.message, s.id).not.toMatch(/req_[0-9a-f]{16,}/)
      expect(s.message, s.id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
      expect(s.message, s.id).not.toMatch(/@im\.wechat|wxid_|@openim/)
      expect(s.message, s.id).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/)
    }
  })
})

describe('provider 失败样本 —— 今天的判定(钉住现状,不是期望)', () => {
  it.each(samples.map(s => [s.id, s] as const))('%s', (_id, s) => {
    expect(currentVerdicts(s)).toEqual(s.current)
  })
})

describe('provider 失败样本 —— 两条 owner 红线今天守住了没有', () => {
  // 这两条是**已定**的规矩,不是第 2 步才定的东西,所以这里断言的是期望,
  // 而且今天就成立。第 2 步重构时它们必须一直绿。
  it('agy 的歧义句(auth 与超时搅在一起)在决定是否通知主人的那处判成网络,不是登录失效', () => {
    const agy = samples.filter(s => s.truth === 'auth_ambiguous')
    expect(agy.length).toBeGreaterThan(0)
    for (const s of agy) {
      expect(s.current.healthKind, s.id).toBe('network')
      expect(s.current.providerFailure, s.id).toBe('transient')
      expect(s.current.registryAuthCode, s.id).toBe(false)
      // 第 2 步:「测试连接」(llm-health)也守住了 —— 以前它直接跑宽档散文正则,报 AUTH FAILED + 去重新登录。
      expect(s.current.llmHealthAuth, s.id).toBe(false)
    }
  })

  it('claude 会话路径只在双哨兵上产出 auth_failed 码', () => {
    for (const s of samples.filter(x => x.provider === 'claude' && x.path === 'session')) {
      expect(s.errorCode === 'auth_failed', s.id).toBe(s.current.claudeSentinel)
    }
  })

  // 红线 A 的 owner 细化(2026-10-02):SDK 标了 authentication_failed 但哨兵没中
  // ⇒ 仍判认证失败(要主人动手),但给人看的话**不说**登录过期 / 重新登录。
  it('claude 非哨兵的认证失败:码 auth_rejected,判 llm_auth,但通知与微信提示都不说登录过期', () => {
    const rejected = samples.filter(x => x.provider === 'claude' && x.path === 'session' && x.truth === 'auth' && !x.current.claudeSentinel)
    expect(rejected.map(s => s.id).sort()).toEqual(['claude.bad_key.session', 'claude.forbidden_403.session'])
    for (const s of rejected) {
      expect(s.errorCode, s.id).toBe('auth_rejected')
      const klass = classifyFailure(errorWithProviderCode(s.message, s.errorCode ?? undefined))
      expect(klass.kind, s.id).toBe('llm_auth')
      expect(klass.actionable, s.id).toBe(true)
      expect(`${klass.title}${klass.body}`, s.id).not.toMatch(/登录|过期/)
      expect(authFailNotice('claude', s.errorCode ?? undefined), s.id).not.toMatch(/登录|过期|login/)
    }
  })

  it('claude 哨兵:登录过期的文案只出在这里', () => {
    const s = samples.find(x => x.id === 'claude.not_logged_in.session')!
    const klass = classifyFailure(errorWithProviderCode(s.message, s.errorCode ?? undefined))
    expect(klass.title).toBe('模型登录已失效')
    expect(authFailNotice('claude', s.errorCode ?? undefined)).toMatch(/登录已过期/)
  })

  it('claude 会话路径不再有「当成正文的错误」(text_event 通道清零)', () => {
    expect(samples.filter(x => x.provider === 'claude' && x.channel === 'text_event').map(s => s.id)).toEqual([])
  })

  it('claude 会话的网络 / 超时样本按码判网络,不是认证', () => {
    for (const s of samples.filter(x => x.provider === 'claude' && x.path === 'session' && (x.truth === 'network' || x.truth === 'timeout'))) {
      expect(s.errorCode, s.id).toBe('network')
      expect(s.current.healthKind, s.id).toBe('network')
    }
  })
})

describe('第 2 步:每家边界都产码(arch backlog #4,2026-10-02)', () => {
  it('除了信息在边界就丢光的、daemon 自己的错误与对照样本,每条 provider 失败都带码', () => {
    const uncoded = samples.filter(s => !s.errorCode).map(s => s.id).sort()
    expect(uncoded).toEqual([
      'claude.turn_watchdog.session',            // daemon 的回合看门狗,不是 provider 错误
      'codex.empty_error.session',               // 空错误
      'codex.exec_exit_bare.session',            // stderr 只剩一行
      'openai.bad_key_moonshot.status_lost',     // 对照样本:「假如 status 丢了」
      'openai.step_budget.session',              // daemon 的步数预算
    ])
  })

  it('认证码只来自认证真相;歧义句永远不是认证码(红线 B)', () => {
    for (const s of samples) {
      if (s.errorCode === 'auth_failed' || s.errorCode === 'auth_rejected') expect(s.truth, s.id).toBe('auth')
    }
    for (const s of samples.filter(x => x.truth === 'auth_ambiguous')) expect(s.errorCode, s.id).toBe('network')
  })

  it('除了 Cursor ACP 上那两条不猜的,决定通知的判定不再有 ✗', () => {
    const wrong = samples.filter(s => {
      const exp = expectedHealthKind(s.truth)
      return exp === 'not_llm_auth' ? s.current.healthKind === 'llm_auth' : s.current.healthKind !== exp
    }).map(s => s.id).sort()
    expect(wrong).toEqual(['cursor.bad_key.acp', 'cursor.net_proxy.acp'])
  })
})

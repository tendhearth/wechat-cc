import { describe, it, expect } from 'vitest'
import { AUTH_CODE, classifyProviderFailure, hasAuthCode, looksLikeAuthFailure } from './auth-failure'
import { isConnectFailure } from './net-errors'

const transient = (t: string) => isConnectFailure(t) || /timed out|timeout/i.test(t)

describe('两档精度 —— 不同职责该有不同精度', () => {
  it('窄档只认结构化码', () => {
    expect(hasAuthCode('auth_failed: credentials stale')).toBe(true)
    expect(hasAuthCode('401 unauthorized')).toBe(false)   // 冷却决策不该被散文带偏
  })

  it('宽档码和散文都认', () => {
    expect(looksLikeAuthFailure('auth_failed: x')).toBe(true)
    expect(looksLikeAuthFailure('401 unauthorized')).toBe(true)
    expect(looksLikeAuthFailure('Not logged in')).toBe(true)
    expect(looksLikeAuthFailure('请重新登录')).toBe(true)
  })

  it('宽档不误伤无关错误', () => {
    for (const t of ['ENOSPC no space left', 'Codex Exec exited with code 1', '']) {
      expect(looksLikeAuthFailure(t)).toBe(false)
    }
  })
})

// owner 2026-09-02 把两次个案决定升成通则。这一组就是那条通则本身。
describe('classifyProviderFailure —— 歧义一律归 transient', () => {
  it('干净的 auth → auth_failed', () => {
    expect(classifyProviderFailure('auth_failed', 'credentials stale', transient)).toBe('auth_failed')
    expect(classifyProviderFailure(null, '401 unauthorized', transient)).toBe('auth_failed')
  })

  it('agy 那句「authentication failed or timed out」→ transient,不是 auth', () => {
    // 2026-08-27 的个案决定,现在是通则的一个实例。
    expect(classifyProviderFailure(null, 'authentication failed or timed out', transient)).toBe('transient')
  })

  it('**连结构化码也让位给瞬时信号** —— 代价不对称:误报「去重新登录」比多等一轮贵', () => {
    expect(classifyProviderFailure('auth_failed', 'connection refused', transient)).toBe('transient')
  })

  it('纯瞬时 → transient', () => {
    expect(classifyProviderFailure(null, 'Was there a typo in the url or port?', transient)).toBe('transient')
    expect(classifyProviderFailure(null, 'turn timed out after 600000ms', transient)).toBe('transient')
  })

  it('认不出来 → unknown,不硬塞进任何一档', () => {
    expect(classifyProviderFailure(null, 'Codex Exec exited with code 1', transient)).toBe('unknown')
  })

  it('闭集只有三档 —— 分得越细误分类机会越多', () => {
    const kinds = new Set(['auth_failed', 'transient', 'unknown'])
    for (const m of ['401', 'timeout', 'whatever', 'rate limited', 'quota exceeded']) {
      expect(kinds.has(classifyProviderFailure(null, m, transient))).toBe(true)
    }
  })

  it('AUTH_CODE 就是仓库里到处在抛的那个串', () => {
    expect(AUTH_CODE).toBe('auth_failed')
  })
})

// ── 仓库守卫 ──────────────────────────────────────────────────────────────
//
// 病不在「有四处判定」—— 四个使用点的职责不同,精度理应不同。病在于它们
// 曾是**四条互不知情的散文正则**:没有共享词汇、没写明彼此关系,于是必然
// 有几条是旧的(classify 那条就漏了 auth_failed,整整漏到 2026-09-02)。
//
// 所以守的不是「只能有一处」,是「不许再手写这套词汇」。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'target'].includes(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
  return out
}

/**
 * 显式豁免 —— **每一条都要写明它属于哪个域**,不能默默加。
 * 加新条目 = 一次有意识的判断,而不是把守卫调绿。
 */
const EXEMPT: Array<{ file: string; why: string }> = [
  {
    file: join('daemon', 'admin-commands.ts'),
    why: '这是**配对密钥**失效(对端返 401 ⇒ 该重新 hand invite/join),不是 LLM 登录失效。'
      + '两个域的词汇不能混:对端 agent 吐一句「not logged in」不代表配对密钥坏了。',
  },
]

describe('仓库守卫 —— auth 判定的词汇只能有一份', () => {
  it('没有别的文件自己手写 unauthorized / invalid api key 这类匹配', () => {
    const offenders: string[] = []
    for (const file of walk(join(REPO_ROOT, 'src'))) {
      if (file.endsWith(join('lib', 'auth-failure.ts'))) continue
      // auth-fail.ts 是**另一件事**:从 provider 输出文本里认哨兵(决定要不要
      // 抛 auth_failed),不是判定「这个错误是不是 auth」。它有自己的红线注释。
      if (file.endsWith(join('core', 'auth-fail.ts'))) continue
      if (EXEMPT.some(e => file.endsWith(e.file))) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trimStart()
        if (t.startsWith('//') || t.startsWith('*')) return
        // **只抓正则字面量**,不抓普通字符串。a2a-server 返回的
        // `{error:'unauthorized'}` 是 HTTP 响应体,不是判定 —— 一个会误报的
        // 守卫会被人关掉,那比没有守卫更糟。
        const inRegexLiteral = /\/[^/\n]*(unauthorized|invalid api key|unauthenticated|login required)[^/\n]*\/[gimsuy]*/i.test(line)
        const inRegExpCtor = /new RegExp\([^)]*(unauthorized|invalid api key|unauthenticated|login required)/i.test(line)
        if (inRegexLiteral || inRegExpCtor) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}`)
        }
      })
    }
    expect(
      offenders,
      offenders.length === 0 ? '' :
        `这些地方在手写 auth 判定的词汇 —— 改用 lib/auth-failure：\n  ${offenders.join('\n  ')}\n`
        + `为什么:2026-09-02 之前有四条互不知情的散文正则,其中 health/classify 那条`
        + `漏了本仓库自己的 auth_failed 码,导致 claude 登录真死时主人只收到一句「你等着」。`,
    ).toEqual([])
  })
})

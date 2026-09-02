import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isConnectFailure } from './net-errors'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// 这一轮真机日志里**实际出现过**的原文,两套运行时都要认。
const REAL_WORLD = [
  'Was there a typo in the url or port?',                          // Bun,派活失败那次
  'Unable to connect. Is the computer able to access the url?',    // Bun,win 的 getUpdates
  'fetch failed',                                                  // Node
  'connect ECONNREFUSED 10.84.6.254:8717',
  'getaddrinfo ENOTFOUND cc.tendhearth.com',
  'socket hang up',
]

describe('isConnectFailure', () => {
  it.each(REAL_WORLD)('认得出:%s', (s) => { expect(isConnectFailure(s)).toBe(true) })

  it('不把无关错误当成连不上', () => {
    for (const s of ['HTTP 401 unauthorized', 'malformed hand response', 'unknown_peer: claude', '']) {
      expect(isConnectFailure(s)).toBe(false)
    }
  })

  it('非字符串不炸', () => {
    expect(isConnectFailure(undefined)).toBe(false)
    expect(isConnectFailure(null)).toBe(false)
    expect(isConnectFailure(new Error('x'))).toBe(false)
  })
})

// ── 仓库守卫 ──────────────────────────────────────────────────────────────
//
// 判定散成好几份正则,就一定会有几份是旧的 —— 这个 bug 就是这么来的:
// admin-commands 认 Node 的词、health/classify 认一半、tts/stt 只认两个。
// 新的措辞必须只加一处。
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'target'].includes(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
  return out
}

describe('仓库守卫 —— 连接失败的判定只能有一处', () => {
  it('没有别的文件自己手写 ECONNREFUSED 之类的匹配', () => {
    const offenders: string[] = []
    for (const file of walk(join(REPO_ROOT, 'src'))) {
      if (file.endsWith(join('lib', 'net-errors.ts'))) continue
      const text = readFileSync(file, 'utf8')
      text.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
        if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|typo in the url/.test(line)) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}`)
        }
      })
    }
    expect(
      offenders,
      offenders.length === 0 ? '' :
        `这些地方在自己手写连接错误的匹配 —— 改用 lib/net-errors 的 isConnectFailure：\n  ${offenders.join('\n  ')}\n`
        + `为什么:Node 和 Bun 的措辞是两套。散成几份正则,就一定会有几份只认其中一套 —— `
        + `2026-09-02 owner 在微信里收到的「Was there a typo in the url or port?」就是这么漏出去的。`,
    ).toEqual([])
  })
})

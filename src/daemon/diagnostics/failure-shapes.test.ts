import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFailureShape, classifyAll, recordFailureShape, redactSecrets,
  FAILURE_SHAPES_FILE, MAX_SHAPES, MESSAGE_KEEP,
} from './failure-shapes'

const tmp = () => mkdtempSync(join(tmpdir(), 'shapes-'))

describe('redactSecrets —— 错误消息里带凭证是常有的事', () => {
  it.each([
    ['Authorization: Bearer sk_live_abcdefgh12345678', 'sk_live_abcdefgh12345678'],
    ['bad key sk-proj-AAAABBBBCCCCDDDD', 'sk-proj-AAAABBBBCCCCDDDD'],
    ['api_key="abcdefgh12345678"', 'abcdefgh12345678'],
    ['token 0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
  ])('%s 里的密文不落库', (input, secret) => {
    expect(redactSecrets(input)).not.toContain(secret)
  })

  it('普通错误文本原样保留(擦得太狠就看不出形状了)', () => {
    const t = 'Claude Code process exited with code 1'
    expect(redactSecrets(t)).toBe(t)
  })

  it('长的普通词不是密文 —— 兜底规则要求同时含字母和数字', () => {
    // 不加这个约束的话,一段 1000 个 x 的堆栈也会被整段抹成 «opaque»,
    // 而采集的全部意义就是看形状。
    const long = 'x'.repeat(200)
    expect(redactSecrets(long)).toBe(long)
    expect(redactSecrets('z'.repeat(30) + '1' + 'y'.repeat(30))).toContain('«opaque»')
  })
})

// 这是这次采集的**全部目的**:四处判定对同一段文本给不同答案,
// 而分歧发生在哪些真实输入上,此前没有任何地方看得到。
describe('classifyAll —— 如实记录四处判定,不做裁决', () => {
  it('claude 的哨兵串:窄判定命中,宽判定也命中 → 一致', () => {
    const s = buildFailureShape({ provider: 'claude', op: 'turn', message: 'Please run /login to continue' })
    expect(s.verdicts.authFailClaudeSentinel).toBe(true)
    expect(s.verdicts.llmHealthAuthRe).toBe(false)   // 宽集里没有 /login 这个词
    expect(s.agreed).toBe(false)                      // ← 分歧,正是要采的
  })

  it('agy 的模糊报错:宽集会说是 auth,而 owner 已定为按瞬时处理', () => {
    // 2026-08-27 的判定:「authentication failed or timed out」按瞬时。
    // 采集只如实记录分歧,不替谁改判。
    const s = buildFailureShape({ provider: 'agy', op: 'cheap_eval', message: 'authentication failed or timed out' })
    expect(s.verdicts.llmHealthAuthRe).toBe(false)
    expect(s.verdicts.healthClassify).toBe('network')  // 靠 timed out 先命中
    expect(s.verdicts.providerRegistryIsAuthError).toBe(false)
  })

  it('带 auth_failed: 前缀 → 最窄那处才认', () => {
    const s = buildFailureShape({ provider: 'claude', op: 'turn', errorCode: 'auth_failed', message: 'credentials stale' })
    expect(s.verdicts.providerRegistryIsAuthError).toBe(true)
    expect(s.errorCode).toBe('auth_failed')
  })

  it('errorCode 为 null 是**重点信号** —— 这一家什么结构都没产出', () => {
    const s = buildFailureShape({ provider: 'agy', op: 'cheap_eval', message: 'something went wrong' })
    expect(s.errorCode).toBeNull()
  })

  it('毫无关系的错误 → 四处都说不是 → 一致,不值得看', () => {
    expect(buildFailureShape({ provider: 'codex', op: 'turn', message: 'ENOSPC no space left' }).agreed).toBe(true)
  })
})

describe('buildFailureShape', () => {
  it('原文截断到 MESSAGE_KEEP,但长度和哈希留全(同种失败能计数)', () => {
    const long = 'x'.repeat(1000)
    const s = buildFailureShape({ provider: 'p', op: 'turn', message: long })
    expect(s.messageHead).toHaveLength(MESSAGE_KEEP)
    expect(s.messageLen).toBe(1000)
    expect(s.messageHash).toHaveLength(16)
    expect(buildFailureShape({ provider: 'p', op: 'turn', message: long }).messageHash).toBe(s.messageHash)
  })
})

describe('recordFailureShape', () => {
  it('追加成 jsonl,并裁到上限(这是临时语料,不是永久日志)', () => {
    const dir = tmp()
    for (let i = 0; i < MAX_SHAPES + 20; i++) {
      recordFailureShape(dir, { provider: 'p', op: 'turn', message: `e${i}` })
    }
    const lines = readFileSync(join(dir, FAILURE_SHAPES_FILE), 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(MAX_SHAPES)
    expect(JSON.parse(lines.at(-1)!).messageHead).toBe(`e${MAX_SHAPES + 19}`)
  })

  it('**绝不抛** —— 采集失败不能把它正在观察的那条路径带塌', () => {
    expect(() => recordFailureShape('/proc/nonexistent/nope', { provider: 'p', op: 'turn', message: 'x' })).not.toThrow()
  })

  it('不该建的时候不建文件(路径不可写就安静放弃)', () => {
    const dir = '/proc/nonexistent/nope'
    recordFailureShape(dir, { provider: 'p', op: 'turn', message: 'x' })
    expect(existsSync(join(dir, FAILURE_SHAPES_FILE))).toBe(false)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeTempDir } from '../../lib/test-temp'
import { acquireLock, makeStateStore, newSelfChangeId, newState, type SelfChangeState } from './state'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'self-change-state-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })

function make(id: string, startedAt: number): SelfChangeState {
  return newState({ id, request: `做 ${id}`, from: 'cli', noDeploy: false, now: startedAt })
}

describe('newState', () => {
  it('分支叫 self/<id>,步在 intake,计数全零', () => {
    const s = newState({ id: 'a1b2c3d4', request: '加一行文档', from: 'wechat', noDeploy: true, now: 1000 })
    expect(s.id).toBe('a1b2c3d4')
    expect(s.branch).toBe('self/a1b2c3d4')
    expect(s.step).toBe('intake')
    expect(s.from).toBe('wechat')
    expect(s.noDeploy).toBe(true)
    expect(s.startedAt).toBe(1000)
    expect(s.updatedAt).toBe(1000)
    expect(s.baseSha).toBeNull()
    expect(s.implement).toEqual({ sessionId: null, costUsd: 0, turns: 0, summary: '', rounds: { tests: 0, review: 0, ci: 0 } })
    expect(s.review).toEqual({ sessionId: null, costUsd: 0, verdict: null, findings: [] })
    expect(s.ci).toEqual({ runId: null, url: null, verdict: null, sha: null })
    expect(s.approval).toEqual({ hash: null, code: null, decision: null, askedAt: null, delivered: null })
    expect(s.merge).toEqual({ sha: null, rebased: false })
    expect(s.deploy).toEqual({ ok: null, version: null })
    expect(s.selftest).toEqual({ workbench: null, chat: null })
    expect(s.result).toBeNull()
    expect(s.error).toBeNull()
    expect(s.stderrTail).toEqual([])
    expect(s.notices).toEqual([])
  })
})

describe('makeStateStore', () => {
  it('存了能读回来,一模一样', () => {
    const dir = tempDir()
    const store = makeStateStore(dir)
    const s = make('aaaaaaaa', 100)
    s.step = 'review'
    s.review.findings = [{ severity: 'important', file: 'src/x.ts', line: 3, summary: '漏了边界' }]
    store.save(s)
    expect(store.load('aaaaaaaa')).toEqual(s)
  })

  it('没有的 id 读出 null,坏 JSON 也读出 null', () => {
    const dir = tempDir()
    const store = makeStateStore(dir)
    expect(store.load('nosuchid')).toBeNull()
    store.save(make('bbbbbbbb', 1))
    writeFileSync(join(dir, 'self-change', 'bbbbbbbb.json'), '{ 半个')
    expect(store.load('bbbbbbbb')).toBeNull()
  })

  it('id 里带 .. / 斜杠一律拒绝(不让 --resume 跳出状态目录)', () => {
    const dir = tempDir()
    const store = makeStateStore(dir)
    expect(store.load('../../etc/passwd')).toBeNull()
    expect(store.load('a/b')).toBeNull()
  })

  it('写进 STATE_DIR/self-change/,原子写不留 .tmp', () => {
    const dir = tempDir()
    const store = makeStateStore(dir)
    store.save(make('cccccccc', 1))
    const files = readdirSync(join(dir, 'self-change'))
    expect(files).toEqual(['cccccccc.json'])
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('状态文件是 0600(里面有需求原文)', () => {
    const dir = tempDir()
    makeStateStore(dir).save(make('dddddddd', 1))
    expect(statSync(join(dir, 'self-change', 'dddddddd.json')).mode & 0o777).toBe(0o600)
  })

  it('list 按 startedAt 倒序,忽略非 .json 与读不动的文件', () => {
    const dir = tempDir()
    const store = makeStateStore(dir)
    store.save(make('11111111', 100))
    store.save(make('33333333', 300))
    store.save(make('22222222', 200))
    writeFileSync(join(dir, 'self-change', 'lock'), '{"pid":1}')
    writeFileSync(join(dir, 'self-change', 'junk.json'), 'not json')
    expect(store.list().map(s => s.id)).toEqual(['33333333', '22222222', '11111111'])
  })

  it('目录还不存在时 list 是空的,不抛', () => {
    expect(makeStateStore(tempDir()).list()).toEqual([])
  })

  it('countSince 只数 startedAt ≥ ts 的(日配额)', () => {
    const dir = tempDir()
    const store = makeStateStore(dir)
    store.save(make('11111111', 100))
    store.save(make('22222222', 200))
    store.save(make('33333333', 300))
    expect(store.countSince(200)).toBe(2)
    expect(store.countSince(301)).toBe(0)
    expect(store.countSince(0)).toBe(3)
  })
})

describe('acquireLock', () => {
  const fs = { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync }

  it('空场:拿到锁,文件里写着 pid', () => {
    const dir = tempDir()
    const r = acquireLock(dir, 4242, undefined, () => true)
    expect(r.ok).toBe(true)
    const raw = readFileSync(join(dir, 'self-change', 'lock'), 'utf8')
    expect(raw).toContain('4242')
    if (r.ok) r.release()
  })

  it('持有者还活着 ⇒ 拒绝,报出 holder', () => {
    const dir = tempDir()
    const first = acquireLock(dir, 111, undefined, () => true)
    expect(first.ok).toBe(true)
    const second = acquireLock(dir, 222, undefined, pid => pid === 111)
    expect(second).toEqual({ ok: false, holder: 111 })
  })

  it('持有者已经死了 ⇒ 抢过来', () => {
    const dir = tempDir()
    const first = acquireLock(dir, 111, undefined, () => true)
    expect(first.ok).toBe(true)
    const second = acquireLock(dir, 222, undefined, () => false)
    expect(second.ok).toBe(true)
    expect(readFileSync(join(dir, 'self-change', 'lock'), 'utf8')).toContain('222')
  })

  it('锁文件坏了 ⇒ 当没人持有(别让一个烂文件把流水线永久堵死)', () => {
    const dir = tempDir()
    acquireLock(dir, 111, undefined, () => true)
    writeFileSync(join(dir, 'self-change', 'lock'), 'garbage')
    const r = acquireLock(dir, 222, undefined, () => true)
    expect(r.ok).toBe(true)
  })

  it('release 删掉锁文件;别人的锁不会被我 release 掉', () => {
    const dir = tempDir()
    const mine = acquireLock(dir, 111, undefined, () => false)
    expect(mine.ok).toBe(true)
    if (!mine.ok) return
    mine.release()
    expect(existsSync(join(dir, 'self-change', 'lock'))).toBe(false)

    const a = acquireLock(dir, 111, undefined, () => false)
    expect(a.ok).toBe(true)
    acquireLock(dir, 222, undefined, () => false)  // 抢占
    if (a.ok) a.release()
    expect(existsSync(join(dir, 'self-change', 'lock'))).toBe(true)
  })

  it('重复 release 不抛', () => {
    const dir = tempDir()
    const r = acquireLock(dir, 111, undefined, () => false)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    r.release()
    expect(() => r.release()).not.toThrow()
  })

  it('注入的 fs 就是它用的那个', () => {
    const dir = tempDir()
    const r = acquireLock(dir, 7, fs, () => false)
    expect(r.ok).toBe(true)
  })

  // 2026-09-21 审查 #5:老写法是「先读一眼没人持有,再写 .tmp + rename」——
  // 两个进程都先读到空,于是都拿到了锁。下面这三条把交错演出来:建锁必须排他。
  describe('排他(两个人同时来抢)', () => {
    /** 在第一个人「建锁」这一刻插进第二个人的整次 acquireLock。 */
    function interleaved(dir: string, outer: number, inner: number, alive: (pid: number) => boolean): {
      first: ReturnType<typeof acquireLock>
      second: ReturnType<typeof acquireLock> | null
    } {
      let second: ReturnType<typeof acquireLock> | null = null
      const hooked = {
        ...fs,
        writeFileSync: ((...args: Parameters<typeof writeFileSync>) => {
          if (second === null) second = acquireLock(dir, inner, undefined, alive)
          return writeFileSync(...args)
        }) as typeof writeFileSync,
      }
      const first = acquireLock(dir, outer, hooked, alive)
      return { first, second }
    }

    it('空场上两个人交错来 ⇒ 只有一个 ok,锁文件记的就是那个人', () => {
      const dir = tempDir()
      const { first, second } = interleaved(dir, 1111, 2222, () => true)
      expect([first.ok, second?.ok].filter(Boolean)).toHaveLength(1)
      // 插进来的那个先建成了文件,外面这个撞上 EEXIST ⇒ 报出真正的持有者。
      expect(second?.ok).toBe(true)
      expect(first).toEqual({ ok: false, holder: 2222 })
      expect(JSON.parse(readFileSync(join(dir, 'self-change', 'lock'), 'utf8')).pid).toBe(2222)
    })

    it('抢一把死锁时两个人交错来 ⇒ 还是只有一个 ok', () => {
      const dir = tempDir()
      const dead = acquireLock(dir, 999, undefined, () => true)
      expect(dead.ok).toBe(true)
      // 999 已经死了:两个人都想抢。isAlive 只对活着的 1111/2222 说真话。
      const { first, second } = interleaved(dir, 1111, 2222, pid => pid !== 999)
      expect([first.ok, second?.ok].filter(Boolean)).toHaveLength(1)
      expect(second?.ok).toBe(true)
      expect(first.ok).toBe(false)
      expect(JSON.parse(readFileSync(join(dir, 'self-change', 'lock'), 'utf8')).pid).toBe(2222)
    })

    it('输掉的那个拿不到 release;赢家放手之后下一个人才拿得到', () => {
      const dir = tempDir()
      const { first, second } = interleaved(dir, 1111, 2222, () => true)
      expect('release' in first).toBe(false)
      expect(existsSync(join(dir, 'self-change', 'lock'))).toBe(true)

      // 赢家还没放手 ⇒ 第三个人照样被挡。
      expect(acquireLock(dir, 3333, undefined, () => true)).toEqual({ ok: false, holder: 2222 })
      if (second?.ok) second.release()
      expect(existsSync(join(dir, 'self-change', 'lock'))).toBe(false)
      expect(acquireLock(dir, 3333, undefined, () => true).ok).toBe(true)
    })
  })
})

describe('newSelfChangeId', () => {
  it('8 位小写 hex', () => {
    expect(newSelfChangeId()).toMatch(/^[0-9a-f]{8}$/)
  })

  it('用注入的随机源(4 字节)', () => {
    const calls: number[] = []
    const id = newSelfChangeId(n => { calls.push(n); return Buffer.from([0xde, 0xad, 0xbe, 0xef]) })
    expect(calls).toEqual([4])
    expect(id).toBe('deadbeef')
  })
})

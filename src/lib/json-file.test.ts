import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConcurrentJsonUpdateError, UnreadableJsonError, updateJsonFile, writeFileAtomic, writeJsonAtomic } from './json-file'

const dirs: string[] = []
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'json-file-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('writeJsonAtomic', () => {
  it('writes pretty JSON with a trailing newline and leaves no tmp file behind', () => {
    const d = fresh(), p = join(d, 'a.json')
    writeJsonAtomic(p, { a: 1 })
    expect(readFileSync(p, 'utf8')).toBe('{\n  "a": 1\n}\n')
    expect(readdirSync(d)).toEqual(['a.json'])
  })
  it('new files default to 0o600; an existing file keeps its mode', () => {
    if (process.platform === 'win32') return  // Windows 上 mode 恒为 0o666,没有可断言的
    const d = fresh(), p = join(d, 'a.json')
    writeJsonAtomic(p, {})
    expect(statSync(p).mode & 0o777).toBe(0o600)
    chmodSync(p, 0o644)
    writeJsonAtomic(p, { b: 2 })
    expect(statSync(p).mode & 0o777).toBe(0o644)
  })
  // 9d 评审:Windows 上目标被杀毒 / 索引器占着,rename 偶发 EPERM / EBUSY —— 短重试,再不行照实抛、不留 tmp。
  it('on win32 retries a busy rename, then gives up and cleans the tmp file', () => {
    const d = fresh(), p = join(d, 'a.json')
    let calls = 0
    const flaky = (from: string, to: string) => { calls++; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); renameSync(from, to) }
    writeJsonAtomic(p, { ok: true }, { platform: 'win32', rename: flaky, retryDelayMs: 1 })
    expect(calls).toBe(3)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ ok: true })
    const never = () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }) }
    expect(() => writeFileAtomic(join(d, 'b.json'), '{}', { platform: 'win32', rename: never, retryDelayMs: 1 })).toThrow('locked')
    expect(readdirSync(d).sort()).toEqual(['a.json'])
  })
  it('does not retry off Windows', () => {
    const d = fresh()
    let calls = 0
    const busy = () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
    expect(() => writeFileAtomic(join(d, 'c.json'), '{}', { platform: 'darwin', rename: busy })).toThrow('busy')
    expect(calls).toBe(1)
  })
})

describe('updateJsonFile', () => {
  it('starts from {} when the file does not exist, and keeps keys it does not touch', () => {
    const d = fresh(), p = join(d, 'cfg.json')
    updateJsonFile(p, raw => { raw.a = 1 })
    updateJsonFile(p, raw => { raw.b = 2 })
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1, b: 2 })
  })
  // 3e 的起因:以前读不出来就当成 {},再写回 —— 主人整份配置只剩一个键。
  it.each([['half-written', '{"provider":"claude","a2a_ag'], ['not an object', '[1,2]'], ['empty', '']])('refuses to write over a %s file and leaves it untouched', (_why, body) => {
    const d = fresh(), p = join(d, 'cfg.json')
    writeFileSync(p, body)
    expect(() => updateJsonFile(p, raw => { raw.x = 1 })).toThrow(UnreadableJsonError)
    expect(readFileSync(p, 'utf8')).toBe(body)
  })
  it('the refusal carries the config_unreadable code the internal API maps to 409', () => {
    const d = fresh(), p = join(d, 'cfg.json')
    writeFileSync(p, '{')
    try { updateJsonFile(p, () => {}); expect.unreachable() } catch (err) { expect((err as { code?: string }).code).toBe('config_unreadable') }
  })
  // Windows 上 PowerShell 写的文件带 BOM(真机出过事):读得出来,不能当成坏文件拒写。
  it('tolerates a UTF-8 BOM', () => {
    const d = fresh(), p = join(d, 'cfg.json')
    writeFileSync(p, '﻿{"a":1}')
    updateJsonFile(p, raw => { raw.b = 2 })
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1, b: 2 })
  })
  it('re-reads once when the file changes under it, and refuses (does not overwrite) if it keeps changing', () => {
    const d = fresh(), p = join(d, 'cfg.json')
    writeFileSync(p, '{"n":0}')
    let runs = 0
    updateJsonFile(p, raw => { runs++; if (runs === 1) writeFileSync(p, '{"n":1,"other":"kept"}'); raw.mine = true })
    expect(runs).toBe(2)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ n: 1, other: 'kept', mine: true })
    let k = 0
    expect(() => updateJsonFile(p, () => { writeFileSync(p, JSON.stringify({ n: ++k, pad: 'x'.repeat(k) })) })).toThrow(ConcurrentJsonUpdateError)
  })
})

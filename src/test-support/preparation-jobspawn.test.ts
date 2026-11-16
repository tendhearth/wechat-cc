import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sharedJobspawnBinary } from './preparation-jobspawn'

describe('sharedJobspawnBinary', () => {
  it('编一次、按内容缓存;内容变了才重编;编译失败不留半成品和锁', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobspawn-cache-test-'))
    try {
      const src = join(dir, 'a.rs'), cache = join(dir, 'cache')
      writeFileSync(src, 'fn main(){}')
      let compiles = 0
      const fake = (_s: string, out: string) => { compiles++; writeFileSync(out, 'bin') }
      const first = sharedJobspawnBinary(src, cache, fake)
      expect(sharedJobspawnBinary(src, cache, fake)).toBe(first)
      expect(compiles).toBe(1)
      writeFileSync(src, 'fn main(){ }')
      expect(sharedJobspawnBinary(src, cache, fake)).not.toBe(first)
      expect(compiles).toBe(2)
      expect(readdirSync(cache).filter(n => n.endsWith('.tmp.exe') || n.endsWith('.lock'))).toEqual([])
      // 编译失败:不留半成品,不留锁
      writeFileSync(src, 'broken')
      expect(() => sharedJobspawnBinary(src, cache, () => { throw Error('rustc failed') })).toThrow('rustc failed')
      expect(readdirSync(cache).filter(n => n.endsWith('.tmp.exe') || n.endsWith('.lock'))).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

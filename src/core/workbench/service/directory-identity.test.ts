import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../../lib/test-temp'
import { directoryIdentity } from './directory-identity'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })

describe('directoryIdentity', () => {
  it('目录 ⇒ "dev:ino"(bigint,和 statSync 一致);同一目录两次相同', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-dir-id-'))); dirs.push(dir)
    const st = statSync(dir, { bigint: true })
    expect(directoryIdentity(dir)).toBe(`${st.dev}:${st.ino}`)
    expect(directoryIdentity(dir)).toBe(directoryIdentity(dir))
  })
  it('普通文件 / 不存在 ⇒ 抛(文件是 invalid_path)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-dir-id-'))); dirs.push(dir)
    const file = join(dir, 'f.txt'); writeFileSync(file, 'x')
    expect(() => directoryIdentity(file)).toThrow('invalid_path')
    expect(() => directoryIdentity(join(dir, 'missing'))).toThrow()
  })
})

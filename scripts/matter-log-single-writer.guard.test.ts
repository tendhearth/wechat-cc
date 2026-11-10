/**
 * 一件事的轮与步只有一个写口(设计稿 docs/superpowers/specs/2026-10-31-one-companion-one-skeleton-design.md §3.1、M1):
 * `matter_turns` / `matter_items` / `matter_log_cursor` 的 INSERT / UPDATE / DELETE 只许出现在 src/adapters/store/matter-log.ts
 * (建表在迁移里,另有 schema-ddl 守卫管)。基线 0。只扫生产代码(排除 *.test.ts 与 __e2e__/);注释行按行跳。
 * 状态也一样:matters.state 只有 matter-log.ts 推 working / waiting;setLifecycle(以前的 setStatus)只碰做完 / 重开那半边(matters-store.ts)。
 */
import { isTaskCachePath } from './task-cache-paths'
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRITER = 'src/adapters/store/matter-log.ts'
const WRITE = /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+matter_(turns|items|log_cursor)\b/i
// 这件事的游标(v96,P1a)也只有写口推进:订阅只认它,别处改了就会有人漏看或白醒。
const CURSOR = /\bUPDATE\s+matters\s+SET\b[^'"`]*\bcursor\s*=/i
export const writesMatterLog = (src: string) => src.split('\n').some(l => !/^\s*(\/\/|\/\*|\*)/.test(l) && (WRITE.test(l) || CURSOR.test(l)))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (isTaskCachePath(p)) continue
    if (statSync(p).isDirectory()) { if (name !== '__e2e__' && name !== 'migrations') walk(p, out) }
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('轮与步只经 MatterLog 写(M1,基线 0)', () => {
  it('没有别的生产文件写这三张表', () => {
    const offenders = [...walk(join(ROOT, 'src')), join(ROOT, 'cli.ts')].map(f => relative(ROOT, f).split('\\').join('/'))
      .filter(rel => rel !== WRITER && writesMatterLog(readFileSync(join(ROOT, rel), 'utf8')))
    expect(offenders, '写一件事的轮 / 步走 MatterLog(src/ports/matters.ts),别直接写表').toEqual([])
    expect(writesMatterLog(readFileSync(join(ROOT, WRITER), 'utf8'))).toBe(true)
  })
  it('识别得出', () => {
    expect(writesMatterLog("db.query('INSERT INTO matter_items(matter_id) VALUES(?)')")).toBe(true)
    expect(writesMatterLog('db.exec(`insert or replace into matter_turns ...`)')).toBe(true)
    expect(writesMatterLog("db.query('UPDATE matter_log_cursor SET value=value+1')")).toBe(true)
    expect(writesMatterLog("db.query('DELETE FROM matter_items WHERE id=?')")).toBe(true)
    expect(writesMatterLog("db.query('SELECT * FROM matter_items')")).toBe(false)
    expect(writesMatterLog("// UPDATE matter_items SET x")).toBe(false)
    expect(writesMatterLog("db.query('UPDATE matters SET cursor=MAX(cursor,?) WHERE id=?')")).toBe(true)
    expect(writesMatterLog("db.query('UPDATE matters SET state=?,updated_at=? WHERE id=?')")).toBe(false)
  })
})

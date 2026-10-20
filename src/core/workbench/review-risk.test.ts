import { describe, it, expect } from 'vitest'
import { fileRisk } from './review-risk'

const f = (path: string, kind: 'added' | 'deleted' | 'modified' | 'not_reviewed' = 'modified', diff = '') => ({ path, kind, preexisting: false, diff })

describe('fileRisk (手机 / 桌面审阅里标「注意」,对标 B6)', () => {
  it('flags the classes a phone reviewer is most likely to rubber-stamp', () => {
    expect(fileRisk(f('src/auth/session.ts'))).toEqual(['鉴权 / 权限'])
    expect(fileRisk(f('src/lib/permission-rules.ts'))).toEqual(['鉴权 / 权限'])
    expect(fileRisk(f('src/foo.test.ts', 'deleted'))).toEqual(['删了测试'])
    expect(fileRisk(f('tests/api/x.py', 'deleted'))).toEqual(['删了测试'])
    expect(fileRisk(f('src/lib/db.ts'))).toEqual(['数据库迁移'])
    expect(fileRisk(f('migrations/0042_add.sql', 'added'))).toEqual(['数据库迁移'])
    expect(fileRisk(f('.github/workflows/ci.yml'))).toEqual(['CI / 依赖'])
    expect(fileRisk(f('package.json'))).toEqual(['CI / 依赖'])
    expect(fileRisk(f('bun.lock'))).toEqual(['CI / 依赖'])
    expect(fileRisk(f('.env.production', 'added'))).toEqual(['密钥文件'])
  })
  it('a test whose assertions were removed is flagged even when only modified', () => {
    expect(fileRisk(f('src/a.test.ts', 'modified', '-  expect(x).toBe(1)\n+  // removed'))).toEqual(['删了断言'])
    expect(fileRisk(f('src/a.test.ts', 'modified', '+  expect(x).toBe(2)\n-  expect(x).toBe(1)'))).toEqual([])
  })
  it('ordinary files are not flagged; several reasons stack, deduped', () => {
    expect(fileRisk(f('src/ui/button.tsx'))).toEqual([])
    expect(fileRisk(f('README.md'))).toEqual([])
    expect(fileRisk(f('src/auth/migrations/001.sql', 'added'))).toEqual(['鉴权 / 权限', '数据库迁移'])
  })
})

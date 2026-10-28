/**
 * 审阅里该多看一眼的文件(2026-10-20,对标 B6:Cursor 手机审阅被抱怨「一路点通过」)。
 * 只按路径与改动形状粗判,宁可多标:标出来只是一个「注意」,不拦任何操作。
 * 界面上统一画成一个强调色的「注意 · 原因」,不用红黄绿(设计原则:一个强调色)。
 */
import type { ReviewFile } from './git-review'

const AUTH = /(?:^|[/_.-])(?:auth|login|logout|session|token|oauth|permission|acl|rbac|secret|credential|crypt|password|passwd)/i
const TEST = /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$/
const MIGRATION = /(?:^|\/)migrations?\/|(?:^|\/)migrate[^/]*$|(?:^|\/)schema\.(?:sql|prisma)$|(?:^|\/)db\.ts$/i
const CI_DEPS = /(?:^|\/)\.github\/workflows\/|(?:^|\/)(?:package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|requirements[^/]*\.txt|Dockerfile)$/
const SECRET_FILE = /(?:^|\/)\.env(?:\.|$)|\.(?:pem|p8|p12|key)$/
const ASSERT = /\b(?:expect|assert|should|t\.(?:equal|deepEqual|ok))\b/

export function fileRisk(file: Pick<ReviewFile, 'path' | 'kind' | 'diff'>): string[] {
  const out: string[] = []
  const p = file.path
  if (AUTH.test(p)) out.push('鉴权 / 权限')
  if (TEST.test(p)) {
    if (file.kind === 'deleted') out.push('删了测试')
    else if (file.diff) {
      const lines = file.diff.split('\n')
      const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---') && ASSERT.test(l)).length
      const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++') && ASSERT.test(l)).length
      if (removed > added) out.push('删了断言')
    }
  }
  if (MIGRATION.test(p)) out.push('数据库迁移')
  if (CI_DEPS.test(p)) out.push('CI / 依赖')
  if (SECRET_FILE.test(p)) out.push('密钥文件')
  return [...new Set(out)]
}

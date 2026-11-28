import { createHash } from 'node:crypto'
import { join } from 'node:path'
import z from 'zod'
import { readJsonObject, writeJsonAtomic } from '../lib/json-file'
import type { Git } from './self-change/git'

export const gitObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const record = z.object({ sha: gitObjectId, tree: gitObjectId, content: gitObjectId.optional(), stage: z.string() })

export function gitTree(git: Git, sha: string): string {
  const r = git.run(['rev-parse', '--verify', `${sha}^{tree}`])
  if (r.code !== 0) throw new Error('无法读取部署目标的 Git tree。')
  return gitObjectId.parse(r.stdout.trim())
}

/** Git's quoted paths preserve raw filename bytes across clones. Tree entries include mode, type and object ID. */
function contentWithoutMarkdown(git: Git, tree: string): string {
  const r = git.run(['-c', 'core.quotePath=true', 'ls-tree', '-r', '--full-tree', tree])
  if (r.code !== 0) throw new Error('无法读取部署目标的 Git tree 内容。')
  const files = r.stdout.split('\n').filter(line => !/\.md"?$/.test(line))
  return createHash('sha256').update(files.join('\n')).digest('hex')
}

export function matchesFailedTree(git: Git, candidate: string, records: z.infer<typeof record>[]): boolean {
  const tree = gitTree(git, candidate)
  if (records.some(r => r.tree === tree)) return true
  if (records.length === 0) return false
  const content = contentWithoutMarkdown(git, tree)
  return records.some(r => r.content === content)
}

export function deploymentFailures(homeDir: string) {
  const path = join(homeDir, '.wechat-cc-deploy-failures.json')
  const load = () => z.array(record).parse(readJsonObject(path).failures ?? [])
  return {
    load,
    // 所有写入都持部署事务锁。记录 SHA 供跨克隆排查，tree 用于比对构建内容。
    add(git: Git, sha: string, stage: string) {
      const tree = gitTree(git, sha)
      const failures = load()
      if (!failures.some(r => r.tree === tree)) {
        const content = contentWithoutMarkdown(git, tree)
        writeJsonAtomic(path, { failures: [...failures, { sha, tree, content, stage }] }, { mode: 0o600 })
      }
    },
  }
}

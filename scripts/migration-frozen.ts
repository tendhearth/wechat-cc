/**
 * 进了 dev 的迁移一字不许改(第三批 3e,设计稿 docs/superpowers/specs/2026-10-23-db-migrations-per-file-design.md §4 第 3 条)。
 *
 * 主人真机跑的就是 dev:一个迁移合进 dev、部署一次,就已经在他的库里跑过了。`PRAGMA user_version` 只记跑了几个,
 * 改一个已经跑过的迁移,对已过那一位的库毫无作用(v49 / v59 那次),还会让新库和老库的 schema 悄悄分叉。所以:
 *
 *   origin/dev 上 src/lib/db/migrations/ 里的每个 v*.ts(和三个迁移共用的 shared-ddl.ts),以及知识库四个库
 *   src/adapters/knowledge/migrations/<库>/ 里的每个 v*.ts(架构终态 G1),在这一版里必须还在、而且一字不差。只有新加的文件能改。
 *
 * 紧急要改老迁移:PR 标题带 `[migration-edit]`、描述写理由 —— 放行,但把改了哪几个打出来。
 * 标题从环境变量 PR_TITLE 读(workflow 用 env 传,不在 run 里插值:标题是不可信输入)。
 * 拿不到 origin/dev:本机跳过并说一句;CI(CI=true)里判红 —— 不然 checkout 一改(fetch-depth 回到 1),这道闸门就悄悄没了。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIRS = [
  'src/lib/db/migrations',
  'src/adapters/knowledge/migrations/source',
  'src/adapters/knowledge/migrations/semantic',
  'src/adapters/knowledge/migrations/graph',
  'src/adapters/knowledge/migrations/facts',
]
/** 迁移本身(v*.ts),加上被冻结迁移调用的共用建表语句 —— 它变了,v056–v058 的内容就变了。 */
const FROZEN_FILE = /^(v\d+|shared-ddl)\.ts$/
const BASE = 'origin/dev'
const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const inCi = process.env.CI === 'true'
const hasBase = git(['rev-parse', '--verify', '--quiet', `${BASE}^{commit}`]).status === 0
if (!hasBase) {
  if (inCi) {
    console.error(`✗ migration-frozen:CI 里拿不到 ${BASE}(checkout 要 fetch-depth: 0)。这道检查不能悄悄跳过。`)
    process.exit(1)
  }
  console.log(`migration-frozen:本机没有 ${BASE},跳过(CI 里会查)。`)
  process.exit(0)
}

const frozen: string[] = []
const changed: string[] = []
for (const dir of DIRS) {
  const listed = git(['ls-tree', '--name-only', `${BASE}:${dir}`])
  // dev 上还没有这个目录(拆文件之前 / 这个库还没进迁移框架):没有已冻结的迁移
  if (listed.status !== 0) continue
  for (const f of listed.stdout.split('\n').filter(f => FROZEN_FILE.test(f))) {
    const path = `${dir}/${f}`
    frozen.push(path)
    const onDev = git(['show', `${BASE}:${path}`])
    if (onDev.status !== 0) { changed.push(`${path}(读不出 dev 上的版本)`); continue }
    const local = join(process.cwd(), path)
    if (!existsSync(local)) { changed.push(`${path}(被删掉或改名了)`); continue }
    if (readFileSync(local, 'utf8') !== onDev.stdout) changed.push(path)
  }
}

if (changed.length === 0) {
  console.log(`✓ migration-frozen:dev 上已有的 ${frozen.length} 个迁移一字未改。`)
  process.exit(0)
}
const exempt = (process.env.PR_TITLE ?? '').includes('[migration-edit]')
const list = changed.map(c => `  - ${c}`).join('\n')
if (exempt) {
  console.log(`⚠ migration-frozen:PR 标题带 [migration-edit],放行。改了已进 dev 的迁移:\n${list}\n  —— 描述里要写为什么,以及已经跑过旧版的库怎么办。`)
  process.exit(0)
}
console.error(`✗ migration-frozen:这些迁移已经进了 dev(主人的库已经跑过它们),不能改:\n${list}\n  要修,追加一个新的 vNNN.ts。真要改老的,PR 标题带 [migration-edit] 并在描述里写理由。`)
process.exit(1)

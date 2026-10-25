/**
 * 总览 _overview.md 最前面一节是主人原话(记忆编辑设计稿 docs/superpowers/specs/2026-10-23-memory-edits-stick-design.md §2)。
 * 带出主人自己对话的读者必须经 lib/memory-owner 的 overviewForOthers 去掉那一节 —— 主人写给 CC 看的,不等于同意说给别人的 CC 听。
 *
 * 守法:src/ 里每个提到 _overview.md / OVERVIEW_FILENAME 的文件都得在下面登记成一类,并写明为什么:
 *  - owner:只在主人这一侧用(桌面 / 主人自己微信里看 / 合成与整理自己 / 内部素材);
 *  - outward:会带到别人那里 ⇒ 文件里必须调 overviewForOthers(。
 * 新文件提到它 ⇒ 红:先想清楚是哪一类。只扫生产代码;注释行按行跳。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const READERS: Record<string, { kind: 'owner' | 'outward'; why: string }> = {
  'src/features/social/wire-visit.ts': { kind: 'outward', why: '串门「CC 眼中的主人」,进别人 CC 的 prompt' },
  'src/lib/memory-synthesis.ts': { kind: 'owner', why: '写它的人(合成)' },
  'src/lib/memory-artifacts.ts': { kind: 'owner', why: '清单登记它是生成物' },
  'src/lib/memory-edit.ts': { kind: 'owner', why: '记忆编辑能编辑的路径之一' },
  'packages/protocol/src/desktop-api.ts': { kind: 'owner', why: '记忆编辑请求的 path 枚举(/v1 契约,架构终态 F1 从 daemon 搬过来)' },
  'src/daemon/memory/nightly-runtime.ts': { kind: 'owner', why: '记忆编辑的 view / edit(admin + operator)' },
  'src/daemon/memory/nightly.ts': { kind: 'owner', why: '首次整理 memory.md 的素材;memory.md 只在主人对话注入' },
  'src/daemon/memory/fs-api.ts': { kind: 'owner', why: '过期就藏、写回时剥过期标签;MCP 读只限各自对话的目录' },
  'src/daemon/memory/snapshot.ts': { kind: 'owner', why: '主人对话的 introspect / 会话总结素材' },
  'src/daemon/memory-llm-ops.ts': { kind: 'owner', why: '画像 / 小像的素材,给主人看' },
  'src/daemon/wiring/introspect-steps.ts': { kind: 'owner', why: '小像自动刷新看主人档案新不新(introspect 那一拍的一步)' },
  'src/daemon/wiring/pipeline-deps.ts': { kind: 'owner', why: '主人自己在微信里「看记忆」' },
  'src/daemon/internal-api/routes-memory-review.ts': { kind: 'owner', why: '桌面证据审阅(trusted 档,桌面 / CLI)' },
  'src/cli/commands/memory.ts': { kind: 'owner', why: 'CLI 本机读写(主人自己)' },
  'src/daemon/config-surface.ts': { kind: 'owner', why: '只是设置项的说明文字,不读文件' },
}

const MENTION = /_overview\.md|OVERVIEW_FILENAME/

export function mentionsOverview(src: string): boolean {
  return src.split('\n').some(line => !/^\s*(\/\/|\/\*|\*)/.test(line) && MENTION.test(line))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('_overview.md 的读者都登记过;对外的去掉主人原话', () => {
  it('提到 _overview.md 的文件都在名单里', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'packages', 'protocol', 'src')), join(ROOT, 'cli.ts')].map(f => relative(ROOT, f).split('\\').join('/'))
    expect(files.filter(rel => !(rel in READERS) && mentionsOverview(read(rel))), '新读者:登记成 owner 或 outward(outward 要经 overviewForOthers)').toEqual([])
  })
  it('对外的读者都调了 overviewForOthers', () => {
    const missing = Object.entries(READERS).filter(([rel, r]) => r.kind === 'outward' && !/\boverviewForOthers\(/.test(read(rel))).map(([rel]) => rel)
    expect(missing).toEqual([])
  })
  it('名单里没有过期的(不再提到就删掉那一行)', () => {
    expect(Object.keys(READERS).filter(rel => !mentionsOverview(read(rel)))).toEqual([])
  })
})

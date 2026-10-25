/**
 * core 不碰 `node:*`(第三批 3f,理念 5「规矩交给机器,数违规条数,不数行数」)。
 *
 * src/core 是「做什么」的那一层,运行时(文件、进程、网络、系统)应该从外面注入 —— 这样它在 node / bun / 测试里
 * 都是同一份、能在没有真机的地方证明。2026-10-22 盘点:101 个文件、179 处值导入 `node:*`(类型导入不算:
 * 它不在运行时出现)。一次搬不完,所以跟 speech-send / daemon-module 守卫一个做法 —— 棘轮:
 *  - **没登记的文件出现值导入 `node:*` ⇒ 红**:新代码把运行时能力从参数传进来,或放到 src/lib/runtime / daemon 那一层;
 *  - **登记过的文件次数只许降**:多一处红;少了也红,提示你把数字调下来;降到 0 删掉那一行。
 * 只扫生产代码(排除 *.test.ts);注释里的不算。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(ROOT, 'src', 'core')

/** 一个文件里值导入 `node:*` 的处数:静态 import / export … from(跨行也算,`import type` / `export type` 不算)+ 动态 import() / require()。 */
export function nodeValueImports(src: string): number {
  // 注释按行判(行首是 // 、/* 或 * 的整行不算),不用跨行的块注释正则:字符串里的 `/*`(比如 glob 'src/**/*.ts')
  // 会被当成注释开头,一路吞到下一个 `*/`,把中间的真导入吃掉 —— daemon-module 守卫第一版踩过(整合者评审 #568)。
  const code = src.split('\n').map(l => /^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l).join('\n')
  const statics = code.match(/(?:^|\n)\s*(?:import|export)\s+(?!type[\s{])[^;'"`]*?\bfrom\s+['"]node:[^'"]+['"]/g) ?? []
  const sideEffect = code.match(/(?:^|\n)\s*import\s+['"]node:[^'"]+['"]/g) ?? []
  const dynamic = code.match(/\b(?:import|require)\(\s*['"]node:[^'"]+['"]\s*\)/g) ?? []
  return statics.length + sideEffect.length + dynamic.length
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}
function current(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const file of walk(CORE)) {
    const n = nodeValueImports(readFileSync(file, 'utf8'))
    if (n > 0) out[relative(ROOT, file).split('\\').join('/')] = n
  }
  return out
}

// 2026-10-22 基线(按文件)。搬走一处减一;降到 0 删掉那一行。
// @debt src/core 里还在直接用 node 的地方(core 要能换运行时,node 的东西搬进 src/lib 的适配层)
const BASELINE: Record<string, number> = {
  'src/core/a2a-registry.ts': 2,
  'src/core/avatar/store.ts': 3,
  'src/core/cli-permission-relay.ts': 1,
  'src/core/cli-upgrade/detect.ts': 3,
  'src/core/cli-upgrade/layout.ts': 2,
  'src/core/cli-upgrade/locate.ts': 1,
  'src/core/cli-upgrade/state.ts': 1,
  'src/core/journal-seen.ts': 1,
  'src/core/knowledge/js-embedder.ts': 2,
  'src/core/knowledge/source-adapter.ts': 3,
  'src/core/knowledge/store.ts': 2,
  'src/core/knowledge/wxvault-refresh.ts': 2,
  'src/core/mailbox-crypto.ts': 3,
  'src/core/matters/say-receipts.ts': 1,
  'src/core/matters/service.ts': 1,
  'src/core/pairing-crypto.ts': 1,
  'src/core/penpal-crypto.ts': 1,
  'src/core/permission-rules/floor.ts': 1,
  'src/core/permission-rules/paths.ts': 1,
  'src/core/permission-rules/rules-file.ts': 1,
  'src/core/scheduled-jobs-store.ts': 2,
  'src/core/self-agent-id.ts': 2,
  // 工作台的服务、十个域、微信命令那一族搬进 src/features/workbench(架构终态 A5):这里少 32 行(那边不归这个守卫管);
  // 留下的是 store 和执行者 / 协调器 / 「一件事」也在用的零件,等 E3 拆 core
  'src/core/workbench/anchored-fs.ts': 2,
  'src/core/workbench/artifact-deliveries.ts': 1,
  'src/core/workbench/artifacts.ts': 3,
  'src/core/workbench/attachment-uploads.ts': 3,
  'src/core/workbench/attachments.ts': 3,
  'src/core/workbench/execution-claims.ts': 1,
  'src/core/workbench/native-adoption.ts': 1,
  'src/core/workbench/native-history.ts': 2,
  'src/core/workbench/permissions.ts': 1,
  'src/core/workbench/project-catalog.ts': 3,
  'src/core/workbench/rewind-store.ts': 1,
  'src/core/workbench/scheduler.ts': 1,
  'src/core/workbench/site-artifact.ts': 1,
  'src/core/workbench/store.ts': 3,
  'src/core/workbench/task-entry.ts': 1,
  'src/core/workbench/until.ts': 1,
  'src/core/workbench/user-input.ts': 1,
  'src/core/workbench/wechat-notifications.ts': 1,
  'src/core/workbench/worktree-workspaces.ts': 3,
}

describe('core 不碰 node:*(棘轮)', () => {
  it('counts the shapes it should and skips type-only imports and comments', () => {
    expect(nodeValueImports("import { readFileSync } from 'node:fs'")).toBe(1)
    expect(nodeValueImports("import {\n  join,\n  dirname,\n} from 'node:path'")).toBe(1)
    expect(nodeValueImports("import type { ChildProcess } from 'node:child_process'")).toBe(0)
    expect(nodeValueImports("export type { Stats } from 'node:fs'")).toBe(0)
    expect(nodeValueImports("// import { x } from 'node:fs'\n/* import { y } from 'node:os' */")).toBe(0)
    expect(nodeValueImports("const m = await import('node:crypto')")).toBe(1)
    // 字符串里的 `/*` 不能把后面的真导入吞掉
    expect(nodeValueImports("const glob = 'src/**/*.ts'\nimport { spawn } from 'node:child_process'\nconst end = '*/'")).toBe(1)
  })
  it('no new file imports node:* at runtime, and registered files only go down', () => {
    const now = current()
    const problems: string[] = []
    for (const [file, n] of Object.entries(now)) {
      const allowed = BASELINE[file]
      if (allowed === undefined) problems.push(`${file}: 新出现 ${n} 处值导入 node:* —— 把运行时能力从参数注入,或放到 src/lib/runtime / daemon 那一层`)
      else if (n > allowed) problems.push(`${file}: ${n} > 基线 ${allowed}`)
      else if (n < allowed) problems.push(`${file}: 降到 ${n} 了(基线 ${allowed}),把 BASELINE 调下来`)
    }
    for (const [file, allowed] of Object.entries(BASELINE)) if (!(file in now)) problems.push(`${file}: 已经是 0(基线 ${allowed}),删掉这一行`)
    expect(problems).toEqual([])
  })
})

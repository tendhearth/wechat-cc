/**
 * 状态文件只有一种写法(第三批 3e):lib/json-file 的 writeJsonAtomic / writeFileAtomic / updateJsonFile。
 *
 * 2026-10-22 盘点:约 40 处手写 tmp + rename(二十几处固定 `.tmp` 名,两个写者会撞同一个 tmp)、约 20 处
 * `writeFileSync(path, JSON.stringify(…))` 直接覆盖(写到一半崩了就是半个文件),都不 fsync。第 1、2 步迁了最要命的
 * (agent-config、access、令牌、account.json…),其余按目录一批批迁。棘轮(跟 core-no-node / daemon-module 守卫一个做法):
 *  - **没登记的文件出现手写 tmp 名或直写 JSON ⇒ 红**:改用 lib/json-file;
 *  - **登记过的只许降**,降了也红(提示调基线),降到 0 删掉那一行。
 * 数两种:① 正在拼的 tmp 文件名(`${x}.tmp…` 或 `+ '.tmp'`;列目录时跳过 `.tmp-` 的过滤不算);② 同一行里 `writeFileSync(` + `JSON.stringify(`。
 * 只扫生产代码(排除 *.test.ts);注释行按行跳(见记忆:块注释正则会吞代码)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = 'src/lib/json-file.ts'
/** 不算的(写明为什么)。 */
const EXEMPT: Record<string, string> = {
  'src/daemon/__e2e__/harness.ts': 'e2e 测试夹具,给假 daemon 铺状态目录,不是生产写法',
  'src/daemon/relay-identity.ts': '只建不换:`wx` 直接建目标文件,已经有了就失败、改读别人先写的那一份(并发启动时两个进程不能各留一个种子)。原子替换在这里是错的',
}

const TMP_NAME = /\}\.tmp\b|\+\s*['"`]\.tmp/
const DIRECT_JSON = /\bwriteFileSync\([^\n]*JSON\.stringify\(/

export function handRolledWrites(src: string): number {
  let n = 0
  for (const line of src.split('\n')) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue
    if (TMP_NAME.test(line)) n++
    if (DIRECT_JSON.test(line)) n++
  }
  return n
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
  for (const file of [...walk(join(ROOT, 'src')), join(ROOT, 'cli.ts')]) {
    const rel = relative(ROOT, file).split('\\').join('/')
    if (rel === HOME || rel in EXEMPT) continue
    const n = handRolledWrites(readFileSync(file, 'utf8'))
    if (n > 0) out[rel] = n
  }
  return out
}

// 2026-10-22 基线(3e 第 3 步迁完 src/lib、src/core,第 4 步迁完 daemon 的配置 / 状态存储之后)。迁一处减一;降到 0 删掉那一行。
const BASELINE: Record<string, number> = {
  'src/cli/account-remove.ts': 1,
  'src/cli/commands/plugin.ts': 1,
  'src/cli/commands/service.ts': 2,
  'src/cli/handoff.ts': 1,
  'src/cli/hook.ts': 2,
  'src/cli/install-user-mcp.ts': 2,
  'src/cli/rules.ts': 1,
  'src/cli/self-change/state.ts': 3,
  'src/cli/update.ts': 1,
  'src/daemon/activity-log.ts': 1,
  'src/daemon/atelier-provision.ts': 2,
  'src/daemon/atelier-runtime.ts': 2,
  'src/daemon/atelier-store.ts': 3,
  'src/daemon/bootstrap/agy-mcp-config.ts': 2,
  'src/daemon/bootstrap/cursor-mcp-config.ts': 2,
  'src/daemon/calendar/calendar.ts': 2,
  'src/daemon/cc-starter-pack.ts': 1,
  'src/daemon/internal-api/federation-grant.ts': 1,
  'src/daemon/internal-api/index.ts': 2,
  'src/daemon/letters/runtime.ts': 3,
  'src/daemon/local-import.ts': 1,
  'src/daemon/memory-llm-ops.ts': 1,
  'src/daemon/memory/fs-api.ts': 1,
  'src/daemon/memory/gardener.ts': 3,
  'src/daemon/memory/nightly-runtime.ts': 2,
  'src/daemon/memory/nightly.ts': 4,
  'src/daemon/memory/sources.ts': 2,
  'src/daemon/notify-startup.ts': 3,
  'src/daemon/scheduled-jobs/brief.ts': 1,
}

describe('状态文件只有一种写法(棘轮)', () => {
  it('counts the two shapes and skips comment lines', () => {
    expect(handRolledWrites("const tmp = `${file}.tmp`")).toBe(1)
    expect(handRolledWrites("const tmp = `${file}.tmp-${process.pid}`")).toBe(1)
    expect(handRolledWrites("writeFileSync(p, JSON.stringify(x, null, 2))")).toBe(1)
    expect(handRolledWrites("// const tmp = `${file}.tmp`\n * writeFileSync(p, JSON.stringify(x))")).toBe(0)
    expect(handRolledWrites("writeJsonAtomic(p, x)")).toBe(0)
    expect(handRolledWrites("const tmp = accessFile() + '.tmp'")).toBe(1)
    expect(handRolledWrites("if (e.name.includes('.tmp-')) continue")).toBe(0)
  })
  it('no new hand-rolled writes; registered files only go down', () => {
    const now = current()
    const problems: string[] = []
    for (const [file, n] of Object.entries(now)) {
      const allowed = BASELINE[file]
      if (allowed === undefined) problems.push(`${file}: 新出现 ${n} 处手写 tmp / 直写 JSON —— 改用 src/lib/json-file 的 writeJsonAtomic / updateJsonFile`)
      else if (n > allowed) problems.push(`${file}: ${n} > 基线 ${allowed}`)
      else if (n < allowed) problems.push(`${file}: 降到 ${n} 了(基线 ${allowed}),把 BASELINE 调下来`)
    }
    for (const [file, allowed] of Object.entries(BASELINE)) if (!(file in now)) problems.push(`${file}: 已经是 0(基线 ${allowed}),删掉这一行`)
    expect(problems).toEqual([])
  })
})

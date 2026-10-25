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
  'src/cli/self-change/state.ts': '走注入的 fs(测试拿假文件系统替身),第三处是 `wx` 只建不换的锁文件 —— 换成 lib/json-file 会绕开注入的 fs',
  'src/cli/update.ts': '换的是可执行文件本身:bun build 直接输出到 tmp,再 rename(Windows 先 unlink 旧的)。不是状态文件,也不是 JSON',
  'src/daemon/__e2e__/harness.ts': 'e2e 测试夹具,给假 daemon 铺状态目录,不是生产写法',
  'src/features/atelier/store.ts': '图 + 元数据两个文件一起提交:各自用独一无二的 scratch 名(randomUUID)+ `wx`,两个都写好才依次 rename。单文件的 writeFileAtomic 表达不了这种两步提交',
  'src/features/phone/relay-identity.ts': '只建不换:`wx` 直接建目标文件,已经有了就失败、改读别人先写的那一份(并发启动时两个进程不能各留一个种子)。原子替换在这里是错的',
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

// 2026-10-22:3e 第 3–6 步迁完 src/lib、src/core、src/daemon、src/cli,基线清零。这张表以后只该是空的:新代码写状态文件
// 一律用 lib/json-file;真有理由不用(像上面的豁免),写进 EXEMPT 并说清为什么。
const BASELINE: Record<string, number> = {}

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

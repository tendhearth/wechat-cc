/**
 * `bun tools/mutation/unique-kills.ts <mutation.json>... [--only <源文件前缀>]... [--md]`
 *
 * 读一份或几份**不 bail**(`--disableBail`)的 Stryker 报告,按测试文件数「唯一杀」:一个被杀的变异,如果杀死它的测试
 * 全在同一个测试文件里,就算那个文件的唯一杀。打印每个跑到过目标代码的测试文件的 唯一杀 / 能杀 / 覆盖,再单列其中「唯一杀为 0」的
 * 测试文件 —— 删 / 并测试的候选清单(删之前仍要看它断言了什么,见 mutation-baseline-2026-10.md「怎么用这份基线」)。
 *
 * 几份报告(`--mutate` 一次一个文件跑出来的)可以一起给:测试 id 是每份报告各自编的,按报告分别换成测试文件再合计。
 * 只认 Killed(Timeout 没有「谁杀的」,不计);`--only` 只统计这些源文件上的变异(可多次)。
 * 默认 bail 的报告不能拿来数:那份 killedBy 只记第一个杀死它的测试,唯一杀会被高估、能杀会被低估 —— 报告里
 * 只要有一个被杀的变异 killedBy 多于一条就说明是不 bail 跑的;一条都没有就警告。
 */
import { readFileSync } from 'node:fs'

interface Mutant { status: string; killedBy?: string[]; coveredBy?: string[] }
interface Report { files: Record<string, { mutants: Mutant[] }>; testFiles?: Record<string, { tests: Array<{ id: string }> }> }

const args = process.argv.slice(2)
const only = args.flatMap((a, i) => a === '--only' && args[i + 1] ? [args[i + 1]!] : [])
const md = args.includes('--md')
const paths = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only')
if (paths.length === 0) { console.error('用法: bun tools/mutation/unique-kills.ts <mutation.json>... [--only <源文件前缀>]... [--md]'); process.exit(2) }

type Row = { unique: number; kills: number; covered: number }
const rows = new Map<string, Row>()
const row = (f: string) => { let r = rows.get(f); if (!r) rows.set(f, r = { unique: 0, kills: 0, covered: 0 }); return r }

let killed = 0, multi = 0
for (const path of paths) {
  const report = JSON.parse(readFileSync(path, 'utf8')) as Report
  const fileOf = new Map<string, string>()
  for (const [file, tf] of Object.entries(report.testFiles ?? {})) for (const t of tf.tests) fileOf.set(t.id, file)
  for (const f of fileOf.values()) row(f)
  for (const [src, fd] of Object.entries(report.files)) {
    if (only.length && !only.some(p => src.startsWith(p))) continue
    for (const m of fd.mutants) {
      for (const f of new Set((m.coveredBy ?? []).map(id => fileOf.get(id) ?? `?${id}`))) row(f).covered++
      if (m.status !== 'Killed') continue
      killed++
      const by = m.killedBy ?? []
      if (by.length > 1) multi++
      const files = new Set(by.map(id => fileOf.get(id) ?? `?${id}`))
      for (const f of files) row(f).kills++
      if (files.size === 1) row([...files][0]!).unique++
    }
  }
}
if (killed > 0 && multi === 0) console.error('警告:没有一个变异被多于一条测试杀死 —— 这份报告多半是默认 bail 跑的,唯一杀不可信。')

const sorted = [...rows].sort((a, b) => b[1].unique - a[1].unique || b[1].kills - a[1].kills || b[1].covered - a[1].covered || a[0].localeCompare(b[0]))
// 唯一杀为 0 只列真跑到过目标代码的(覆盖 > 0);牵连进来(vitest --related)但一行都没跑到的只报个数。
const zero = sorted.filter(([, r]) => r.unique === 0 && r.covered > 0)
const idle = sorted.filter(([, r]) => r.covered === 0).length
if (md) {
  console.log('| 测试文件 | 唯一杀 | 能杀 | 覆盖 |\n|---|---:|---:|---:|')
  for (const [f, r] of sorted) if (r.covered > 0) console.log(`| \`${f}\` | ${r.unique} | ${r.kills} | ${r.covered} |`)
} else {
  console.log(`被杀的变异 ${killed} 个(其中 ${multi} 个被多于一条测试杀死)`)
  for (const [f, r] of sorted) if (r.covered > 0) console.log(`${String(r.unique).padStart(5)} ${String(r.kills).padStart(5)} ${String(r.covered).padStart(5)}  ${f}`)
}
console.log(`\n唯一杀为 0、但跑到过目标代码的测试文件(${zero.length} 个;另有 ${idle} 个被牵连进来、一行目标代码都没跑到,不列):`)
for (const [f, r] of zero) console.log(`- ${f}(能杀 ${r.kills},覆盖 ${r.covered})`)

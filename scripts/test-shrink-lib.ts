/**
 * 测试缩水检查的纯逻辑(CLI 在 scripts/test-shrink-check.ts,规矩在 docs/maintainer/verify.md「测试只增不减」)。
 *
 * 为什么:AI 写代码有两个老毛病 —— 事后补一条「没有修复也会过」的测试,以及为了变绿把测试删掉、跳过、改松。
 * 后者在 diff 里是看得见的,只是评审时没人去数。这里替人数:每个测试文件在 PR 前后各有几条用例、几个 expect、
 * 几个精确断言、几个 skip / only,快照少了几条,vitest 配置的排除清单多了几项。少了的列出来,PR 描述里
 * `## 删掉/放松的测试` 一节要逐个文件写理由,才放行。
 *
 * 判法(宁可漏报,不要误报 —— 误报多了大家就学会无脑写理由):
 *   - 用例按标题配对,**跨文件**配:搬家、拆文件、改名(git 认出的 rename 和没认出的 删+加)都不算少。
 *     标题对不上的,再在同一个文件(改名后的那个)里按顺序配 —— 只改了标题不算删。
 *   - 配上的用例比两样:expect 数(含 expect.soft / expect.poll / assert)少了;精确断言(toBe / toEqual /
 *     toHaveLength / 快照 …)少了。前者是删断言,后者是把 toBe(3) 改成 toBeDefined() 这类放松。
 *   - 文件级:skip / skipIf / runIf / todo / fails 的数目变多;任何地方新出现 .only。
 *   - 快照(.snap)条目按键配,跨文件;同一文件里按顺序兜底(测试改了标题,键跟着变)。
 *   - vitest*.config.* 的 exclude 数组里多了字符串 = 有测试被排除了(Windows 排除清单就是这么长出来的)。
 *
 * 不管的:Rust / Swift / Kotlin 测试;it.each 表格少了几行;把断言挪进 helper(会被当成 expect 变少 —— 写一句理由即可)。
 */

import { spawnSync } from 'node:child_process'

// ───────────────────────── 词法:只够数括号、认字符串 ─────────────────────────

type Tok = { k: 'id' | 'str' | 'p' | 'num'; v: string; start: number; end: number }

const ID_START = /[A-Za-z_$]/
const ID_PART = /[A-Za-z0-9_$]/
/** 这些关键字后面的 `/` 是正则开头,不是除号。 */
const REGEX_AFTER_KW = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'])

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = src.length
  /** 正在哪几层模板字符串的 `${ … }` 里:每层记着里面又开了几个 `{`。 */
  const tpl: number[] = []
  const prevAllowsDivision = (): boolean => {
    const p = out[out.length - 1]
    if (!p) return false
    if (p.k === 'num' || p.k === 'str') return true
    if (p.k === 'id') return !REGEX_AFTER_KW.has(p.v)
    return p.v === ')' || p.v === ']' || p.v === '}'
  }
  /** 从模板字符串的一段开头扫到反引号(收尾)或 `${`(进表达式)。返回下一个位置。 */
  const templateChunk = (from: number): number => {
    let j = from
    while (j < n) {
      const c = src[j]
      if (c === '\\') { j += 2; continue }
      if (c === '`') return j + 1
      if (c === '$' && src[j + 1] === '{') { tpl.push(0); return j + 2 }
      j++
    }
    return n
  }
  const skipQuoted = (from: number): number => {
    const q = src[from]
    let j = from + 1
    while (j < n) {
      const c = src[j]
      if (c === '\\') { j += 2; continue }
      if (c === q || c === '\n') return j + 1
      j++
    }
    return n
  }
  while (i < n) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (c === '"' || c === "'") { const e = skipQuoted(i); out.push({ k: 'str', v: src.slice(i + 1, e - 1), start: i, end: e }); i = e; continue }
    if (c === '`') {
      // 整段模板只出一个 str 记号(值 = 到第一个 `${` 为止);`${ … }` 里的代码照常切成记号。
      const e = templateChunk(i + 1)
      const inExpr = src[e - 1] === '{'
      out.push({ k: 'str', v: src.slice(i + 1, inExpr ? e - 2 : e - 1), start: i, end: e })
      i = e
      continue
    }
    if (tpl.length && (c === '{' || c === '}')) {
      const top = tpl.length - 1
      if (c === '}' && tpl[top] === 0) { tpl.pop(); i = templateChunk(i + 1); continue }
      tpl[top]! += c === '{' ? 1 : -1
    }
    if (c === '/' && !prevAllowsDivision()) {
      // 正则字面量:到没被转义、不在 [...] 里的 `/`,再吃掉 flags。
      let j = i + 1
      let inClass = false
      while (j < n && src[j] !== '\n') {
        const d = src[j]
        if (d === '\\') { j += 2; continue }
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        j++
      }
      j++
      while (j < n && ID_PART.test(src[j]!)) j++
      out.push({ k: 'str', v: src.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    if (ID_START.test(c)) {
      let j = i + 1
      while (j < n && ID_PART.test(src[j]!)) j++
      out.push({ k: 'id', v: src.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) j++
      out.push({ k: 'num', v: src.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    out.push({ k: 'p', v: c, start: i, end: i + 1 })
    i++
  }
  return out
}

/** 每个开括号对应的闭括号下标(不成对的就指到末尾)。 */
function matchBrackets(toks: Tok[]): Map<number, number> {
  const m = new Map<number, number>()
  const stack: number[] = []
  const pair: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  toks.forEach((t, i) => {
    if (t.k !== 'p') return
    if (t.v === '(' || t.v === '[' || t.v === '{') stack.push(i)
    else if (pair[t.v]) {
      // 从栈顶往下找同类开括号,中间不成对的丢掉(宁可数偏一点,不要整份文件错位)。
      for (let s = stack.length - 1; s >= 0; s--) {
        if (toks[stack[s]!]!.v === pair[t.v]) { m.set(stack[s]!, i); stack.length = s; break }
      }
    }
  })
  for (const s of stack) m.set(s, toks.length - 1)
  return m
}

// ───────────────────────── 一份测试文件里有什么 ─────────────────────────

export type Case = { title: string; expects: number; exact: number }
export type FileFacts = { cases: Case[]; skips: number; only: number }

/** 精确断言:能把值钉死的那些。toBeDefined / toBeTruthy / toBeGreaterThan 这类不算。 */
const EXACT = new Set([
  'toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toHaveLength', 'toContain', 'toContainEqual', 'toMatch',
  'toHaveProperty', 'toHaveBeenCalledWith', 'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith', 'toHaveBeenCalledTimes',
  'toHaveReturnedWith', 'toThrow', 'toThrowError', 'toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchFileSnapshot',
  'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot', 'toBeNull', 'toBeUndefined', 'toBeNaN', 'toBeCloseTo',
  'toBeInstanceOf', 'toSatisfy',
])
const CASE_FNS = new Set(['it', 'test'])
const SUITE_FNS = new Set(['describe', 'suite'])
const SKIP_MODS = new Set(['skip', 'skipIf', 'runIf', 'todo', 'fails'])
/** 带一组参数、之后才是真正调用的修饰:it.each(table)(title, fn)、it.skipIf(cond)(title, fn)。 */
const CALL_MODS = new Set(['each', 'for', 'skipIf', 'runIf'])

export function analyzeTestFile(src: string): FileFacts {
  const toks = tokenize(src)
  const match = matchBrackets(toks)
  const cases: Case[] = []
  let skips = 0
  let only = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.k !== 'id') continue
    const prev = toks[i - 1]
    if (prev && prev.k === 'p' && prev.v === '.') {
      // ctx.skip() / t.skip():用例体里中途跳过
      if (t.v === 'skip' && toks[i + 1]?.v === '(' && toks[i + 2]?.v === ')' && !CASE_FNS.has(toks[i - 2]?.v ?? '') && !SUITE_FNS.has(toks[i - 2]?.v ?? '')) skips++
      continue
    }
    const isCase = CASE_FNS.has(t.v)
    if (!isCase && !SUITE_FNS.has(t.v)) continue
    let j = i + 1
    const mods: string[] = []
    while (toks[j]?.v === '.' && toks[j + 1]?.k === 'id') {
      const mod = toks[j + 1]!.v
      mods.push(mod)
      j += 2
      if (CALL_MODS.has(mod) && toks[j]?.v === '(') j = (match.get(j) ?? j) + 1
    }
    if (toks[j]?.v !== '(') continue
    skips += mods.filter(m => SKIP_MODS.has(m)).length
    only += mods.filter(m => m === 'only').length
    if (!isCase) continue
    const close = match.get(j) ?? toks.length - 1
    // 标题:第一个参数是字符串就用它,否则用第一个参数的原文(it(name, …) 这种)。
    let k = j + 1
    while (k < close && !(toks[k]!.v === ',' && toks[k]!.k === 'p')) {
      const open = toks[k]!
      k = open.k === 'p' && '([{'.includes(open.v) ? (match.get(k) ?? k) + 1 : k + 1
    }
    const first = toks[j + 1]
    const title = first && first.k === 'str' && j + 2 === k ? first.v : src.slice(toks[j + 1]?.start ?? 0, toks[k]?.start ?? 0).trim()
    let expects = 0
    let exact = 0
    for (let b = j + 1; b < close; b++) {
      const x = toks[b]!
      if (x.k !== 'id') continue
      const before = toks[b - 1]
      const afterDot = before?.k === 'p' && before.v === '.'
      if (!afterDot && (x.v === 'expect' || x.v === 'assert')) {
        const nx = toks[b + 1]
        if (nx?.v === '(') expects++
        else if (nx?.v === '.' && toks[b + 3]?.v === '(') {
          const m = toks[b + 2]?.v ?? ''
          if (x.v === 'assert' || m === 'soft' || m === 'poll') expects++
        }
      } else if (afterDot && EXACT.has(x.v) && toks[b + 1]?.v === '(') exact++
    }
    cases.push({ title, expects, exact })
  }
  return { cases, skips, only }
}

/** .snap 里的条目键。 */
export function snapshotKeys(src: string): string[] {
  return [...src.matchAll(/^exports\[`((?:[^`\\]|\\.)*)`\]/gm)].map(m => m[1]!)
}

/** vitest 配置里所有 `exclude: [ … ]` 数组(含里面嵌套的条件数组)里的字符串个数。 */
export function excludeEntries(src: string): number {
  const toks = tokenize(src)
  const match = matchBrackets(toks)
  let count = 0
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.k === 'id' && toks[i]!.v === 'exclude' && toks[i + 1]?.v === ':' && toks[i + 2]?.v === '[') {
      const close = match.get(i + 2) ?? i + 2
      for (let b = i + 3; b < close; b++) if (toks[b]!.k === 'str') count++
      i = close
    }
  }
  return count
}

// ───────────────────────── 两版对比 ─────────────────────────

export const isTestFile = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) && !p.includes('node_modules/')
export const isSnapFile = (p: string) => p.endsWith('.snap')
export const isVitestConfig = (p: string) => /(^|\/)vitest[^/]*\.config\.[cm]?[jt]s$/.test(p)

/** 一个改动过的文件:base 那边的路径/内容、head 那边的路径/内容(新增 / 删除时一边为 null)。 */
export type FileChange = { basePath: string | null; headPath: string | null; base: string | null; head: string | null }
export type Finding = { file: string; what: string }

/** 两个提交之间改到的测试 / 快照 / vitest 配置文件,带两边的内容。git 认出的改名配成一对。 */
export function collectChanges(base: string, head: string, cwd?: string): FileChange[] {
  const git = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const relevant = (p: string) => isTestFile(p) || isSnapFile(p) || isVitestConfig(p)
  const show = (rev: string, path: string): string | null => {
    const r = git(['show', `${rev}:${path}`])
    return r.status === 0 ? r.stdout : null
  }
  // -z:路径里有空格 / 中文也不转义。R / C 后面跟两个路径。
  const diff = git(['diff', '--name-status', '-z', '-M', base, head])
  if (diff.status !== 0) throw new Error(`git diff ${base} ${head} 失败:${diff.stderr.trim()}`)
  const parts = diff.stdout.split('\0')
  const changes: FileChange[] = []
  for (let i = 0; i < parts.length;) {
    const status = parts[i++]
    if (!status) continue
    const code = status[0]
    if (code === 'R' || code === 'C') {
      const from = parts[i++]!
      const to = parts[i++]!
      if (!relevant(from) && !relevant(to)) continue
      changes.push({ basePath: code === 'R' ? from : null, headPath: to, base: code === 'R' ? show(base, from) : null, head: show(head, to) })
      continue
    }
    const path = parts[i++]!
    if (!relevant(path)) continue
    if (code === 'A') changes.push({ basePath: null, headPath: path, base: null, head: show(head, path) })
    else if (code === 'D') changes.push({ basePath: path, headPath: null, base: show(base, path), head: null })
    else changes.push({ basePath: path, headPath: path, base: show(base, path), head: show(head, path) })
  }
  return changes
}

type Entry<T> = { file: string; pairFile: string | null; title: string; data: T; matched?: Entry<T> }

/**
 * 两边的条目按标题配对:先同标题同文件,再同标题跨文件(搬家),最后同一文件里按顺序配(改了标题)。
 * 返回 base 一侧每一条(配上的带 matched)。
 */
function pairUp<T>(base: Entry<T>[], head: Entry<T>[]): Entry<T>[] {
  const used = new Set<Entry<T>>()
  const take = (b: Entry<T>, pred: (h: Entry<T>) => boolean) => {
    const h = head.find(x => !used.has(x) && pred(x))
    if (h) { used.add(h); b.matched = h }
  }
  for (const b of base) take(b, h => h.title === b.title && h.file === b.pairFile)
  for (const b of base) if (!b.matched) take(b, h => h.title === b.title)
  for (const b of base) if (!b.matched && b.pairFile) take(b, h => h.file === b.pairFile)
  return base
}

export function findShrinks(changes: FileChange[]): Finding[] {
  const findings: Finding[] = []
  const shown = (c: FileChange) => (c.headPath ?? c.basePath)!

  // 用例
  const tests = changes.filter(c => (c.basePath && isTestFile(c.basePath)) || (c.headPath && isTestFile(c.headPath)))
  const facts = new Map<FileChange, { base: FileFacts | null; head: FileFacts | null }>()
  for (const c of tests) {
    facts.set(c, {
      base: c.base !== null && c.basePath && isTestFile(c.basePath) ? analyzeTestFile(c.base) : null,
      head: c.head !== null && c.headPath && isTestFile(c.headPath) ? analyzeTestFile(c.head) : null,
    })
  }
  const baseCases: Entry<Case>[] = []
  const headCases: Entry<Case>[] = []
  for (const c of tests) {
    const f = facts.get(c)!
    for (const k of f.base?.cases ?? []) baseCases.push({ file: c.basePath!, pairFile: f.head ? c.headPath : null, title: k.title, data: k })
    for (const k of f.head?.cases ?? []) headCases.push({ file: c.headPath!, pairFile: null, title: k.title, data: k })
  }
  const byBaseFile = new Map(tests.map(c => [c.basePath, c] as const))
  /** 整个文件删了:没搬走的用例合成一条,不逐条刷屏。 */
  const goneWithFile = new Map<FileChange, string[]>()
  for (const b of pairUp(baseCases, headCases)) {
    const c = byBaseFile.get(b.file)!
    if (!b.matched) {
      if (c.headPath && facts.get(c)!.head) findings.push({ file: shown(c), what: `删掉了用例「${b.title}」` })
      else goneWithFile.set(c, [...(goneWithFile.get(c) ?? []), b.title])
      continue
    }
    const h = b.matched
    const where = h.file === shown(c) ? '' : `(搬到了 ${h.file})`
    if (h.data.expects < b.data.expects) findings.push({ file: shown(c), what: `用例「${b.title}」${where}的断言从 ${b.data.expects} 个变成 ${h.data.expects} 个` })
    else if (h.data.exact < b.data.exact) findings.push({ file: shown(c), what: `用例「${b.title}」${where}的精确断言(toBe / toEqual / toHaveLength …)从 ${b.data.exact} 个变成 ${h.data.exact} 个` })
  }
  for (const [c, titles] of goneWithFile) {
    findings.push({ file: shown(c), what: `删掉了整个测试文件,${titles.length} 条用例没搬到别处(如「${titles[0]}」)` })
  }
  for (const c of tests) {
    const f = facts.get(c)!
    if (f.base && f.head && f.head.skips > f.base.skips) findings.push({ file: shown(c), what: `skip / skipIf / runIf / todo / fails 从 ${f.base.skips} 处变成 ${f.head.skips} 处` })
    if (f.head && f.head.only > (f.base?.only ?? 0)) findings.push({ file: shown(c), what: `新加了 .only(其余用例全被跳过)` })
  }

  // 快照
  const snaps = changes.filter(c => (c.basePath && isSnapFile(c.basePath)) || (c.headPath && isSnapFile(c.headPath)))
  const baseKeys: Entry<null>[] = []
  const headKeys: Entry<null>[] = []
  for (const c of snaps) {
    for (const k of c.base !== null ? snapshotKeys(c.base) : []) baseKeys.push({ file: c.basePath!, pairFile: c.head !== null ? c.headPath : null, title: k, data: null })
    for (const k of c.head !== null ? snapshotKeys(c.head) : []) headKeys.push({ file: c.headPath!, pairFile: null, title: k, data: null })
  }
  const snapByBase = new Map(snaps.map(c => [c.basePath, c] as const))
  for (const b of pairUp(baseKeys, headKeys)) if (!b.matched) findings.push({ file: shown(snapByBase.get(b.file)!), what: `快照少了「${b.title}」` })

  // vitest 排除清单
  for (const c of changes) {
    if (!c.headPath || !isVitestConfig(c.headPath) || c.base === null || c.head === null) continue
    const was = excludeEntries(c.base)
    const now = excludeEntries(c.head)
    if (now > was) findings.push({ file: c.headPath, what: `exclude 多了 ${now - was} 项(被排除的测试不再跑)` })
  }
  return findings
}

// ───────────────────────── PR 描述 ─────────────────────────

export const SHRINK_HEADING = '删掉/放松的测试'
export const RED_GREEN_HEADING = '红/绿'

/** `## <heading>` 一节的正文(到下一个 `#` / `##` 标题为止),去掉 HTML 注释;没有这一节返回 null。 */
export function section(body: string, heading: string): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex(l => l.replace(/^##\s*/, '').trim() === heading && /^##\s/.test(l))
  if (at < 0) return null
  const rest: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(l)) break
    rest.push(l)
  }
  return rest.join('\n').replace(/<!--[\s\S]*?(-->|$)/g, '').trim()
}

/** 标题或分支看起来是修 bug:分支 fix/…;标题以 fix 或「修」开头(「修改」「修订」不算)。 */
export function looksLikeFix(title: string, headRef: string): boolean {
  if (/^fix\//i.test(headRef)) return true
  const t = title.trim()
  return /^fix\b/i.test(t) || (/^修/.test(t) && !/^修(改|订)/.test(t))
}

/** 被点名的文件在 `## 删掉/放松的测试` 里没写理由的那些。写全路径或文件名都认;那一行除了文件名还得有字。 */
export function unexplained(files: string[], sectionText: string): string[] {
  const lines = sectionText.split('\n')
  return files.filter(f => {
    const names = [f, f.split('/').pop()!]
    return !lines.some(l => names.some(n => l.includes(n) && l.replace(n, '').replace(/[\s`*\-:：,，.。|()（）]/g, '').length >= 2))
  })
}

/** baseRef:PR 要合进的分支(不带 origin/)。 */
export type PrInfo = { title: string; body: string; headRef: string; baseRef?: string }
export type Verdict = { ok: boolean; messages: string[] }

/**
 * dev → master 的发版 PR,diff 是上次发版以来 dev 的累计:里面每个 PR 进 dev 时都过过这道检查,
 * 再查一遍只会把两周的删减全列出来(1.7.8 是 102 个文件),逼人机械地抄一遍「随 #NNN」。所以它不查。
 * 只认 dev → master:别的分支直接开进 master 照查,这里不是绕开检查的口子。
 */
export const RELEASE_BASE = 'master'
export const RELEASE_HEAD = 'dev'

export function judge(findings: Finding[], pr: PrInfo): Verdict {
  if (pr.baseRef === RELEASE_BASE && pr.headRef === RELEASE_HEAD) {
    return { ok: true, messages: [`✓ ${RELEASE_HEAD} → ${RELEASE_BASE} 的发版 PR:里面每个 PR 进 ${RELEASE_HEAD} 时都查过,这里不再查。`] }
  }
  const messages: string[] = []
  let ok = true
  const files = [...new Set(findings.map(f => f.file))]
  if (files.length) {
    const sec = section(pr.body, SHRINK_HEADING)
    const missing = sec ? unexplained(files, sec) : files
    if (missing.length) {
      ok = false
      messages.push(`✗ 测试变少/变松了,PR 描述里 \`## ${SHRINK_HEADING}\` 一节要逐个文件写理由${sec === null ? '(这一节还没有)' : ''}。没写到的:\n${missing.map(f => `  - ${f}`).join('\n')}`)
    } else {
      messages.push(`✓ 测试变少/变松的 ${files.length} 个文件,描述里都写了理由。`)
    }
  }
  if (looksLikeFix(pr.title, pr.headRef)) {
    const rg = section(pr.body, RED_GREEN_HEADING)
    if (!rg) {
      ok = false
      messages.push(`✗ 这是修 bug 的 PR(分支 fix/… 或标题以「修」/fix 开头),描述里要有 \`## ${RED_GREEN_HEADING}\`:贴出把修复撤掉时新测试红、带上修复时绿的那条命令和结果(写不了测试就写为什么)。见 docs/maintainer/verify.md「红/绿」。`)
    } else {
      messages.push(`✓ 修 bug 的 PR,描述里有 \`## ${RED_GREEN_HEADING}\`。`)
    }
  }
  return { ok, messages }
}

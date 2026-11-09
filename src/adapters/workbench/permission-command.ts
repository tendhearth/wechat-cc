import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { readAnchoredFile } from './anchored-fs'
import { floorReason, isLowRisk, toolClass } from '../permission-rules/floor'
import { EDIT_REPORTING_PROVIDERS } from '../permission-rules/decide'
import { inspectPermissionExecutable, PERMISSION_SYSTEM_DIRS, type PermissionExecutable, type PermissionExecutionEnvironment } from './permission-executable'
import type { PermissionAsk } from '../../domain/permission-rules/types'
import type { PermissionScript } from '../../ports/workbench'

const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
export const PERMISSION_SCRIPT_MAX = 128 * 1024

/** Only literal argv: preserve argument order, case, assignments and quoted whitespace.
 * Shell expansion, operators, comments and redirection are deliberately ineligible. */
export function literalCommand(command: string, assignments: boolean[] = []): string[] | null {
  const words: string[] = []; let word = '', quote = '', started = false, wordStart = 0
  const push = () => { words.push(word); assignments.push(/^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(wordStart))) }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (!started && !quote && !/[ \t]/.test(c)) wordStart = i
    if (quote === "'") { if (c === quote) quote = ''; else word += c; continue }
    if (c === '\\') {
      const next = command[++i]; if (next === undefined || /[\r\n]/.test(next)) return null
      // In double quotes a backslash before an ordinary character is literal.
      word += quote && !/[$`"\\]/.test(next) ? '\\' + next : next; started = true; continue
    }
    if (c === '$' || c === '`') return null
    if (quote) { if (c === quote) quote = ''; else word += c; continue }
    if (c === "'" || c === '"') { quote = c; started = true; continue }
    // zsh expands an unquoted leading =command; quoted/escaped = stays literal.
    if (c === '=' && !word) return null
    if (/[;&|><(){}*?\[\]~#!^\r\n\0]/.test(c)) return null
    if (/[ \t]/.test(c)) { if (started) push(); word = ''; started = false }
    else { word += c; started = true }
  }
  if (quote) return null
  if (started) push()
  return words.length ? words : null
}

// These native commands do not take a script entry. This is only an execution
// classification, not an allow list: existing rules/red lines still run first.
// Unknown programs, shell syntax, wrappers and build tools require an explicit
// one-shot decision. They never create automatic task grants.
const NATIVE_COMMANDS = new Set(['echo', 'pwd', 'true', 'false', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rm', 'mkdir', 'touch', 'cp', 'mv', 'chmod', 'diff', 'uniq', 'date', 'uname', 'sleep'])
export function needsBoundExecution(command: string): boolean {
  const assignments: boolean[] = [], argv = literalCommand(command, assignments)
  if (!argv) return true
  const start = argv.findIndex((_w, i) => !assignments[i]), head = argv[start] ?? ''
  // 只认不带路径的裸命令名:`./ls`、`/tmp/x/ls` 是可写脚本,同名也不能借此解除强制询问(第三轮复审 P1)。
  // 真正的执行身份由 permission-executable 另外核对,只用于任务放行资格。
  return start !== 0 || /[\\/]/.test(head) || !NATIVE_COMMANDS.has(head)
}

/** requiresBoundExecution is a legacy internal name for the automatic-approval
 * veto. It never vetoes an explicit owner one-shot invocation decision. */
export interface CommandSnapshot { ask: PermissionAsk; scripts: PermissionScript[]; hash?: string; requiresBoundExecution?: boolean; executable?: PermissionExecutable }
export function inspectPermissionCommand(facts: { tool: string; command?: string; paths?: string[]; cwd?: string; requiresBoundExecution?: true }, opts: { taskId: string; root?: string; provider?: string; stateDir?: string; executionEnvironment?: () => PermissionExecutionEnvironment | undefined }, depth = 0): CommandSnapshot {
  const ask: PermissionAsk = { surface: 'workbench', provider: opts.provider ?? '', tool: facts.tool, command: facts.command,
    paths: facts.paths, cwd: facts.cwd ?? null, project: opts.root ?? null, isolatedWorktree: false, tier: 'admin', scope: opts.taskId }
  const snapshot: CommandSnapshot = { ask, scripts: [], requiresBoundExecution: facts.requiresBoundExecution || (facts.command
    ? facts.command.length >= 2000 || needsBoundExecution(facts.command)
    : toolClass(facts.tool) === 'shell') }
  const assignments: boolean[] = []
  const argv = facts.command && literalCommand(facts.command, assignments)
  if (!argv || !opts.root || !facts.cwd || toolClass(facts.tool) !== 'shell' || depth > 3) return snapshot
  let root: string, cwd: string
  try { root = realpathSync.native(opts.root); cwd = realpathSync.native(facts.cwd) } catch { return snapshot }
  const inside = (p: string) => { const r = relative(root, p); return r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') && !isAbsolute(r) }
  if (!inside(cwd)) return snapshot
  let eligible = EDIT_REPORTING_PROVIDERS.has(opts.provider ?? '') && !snapshot.requiresBoundExecution && facts.command!.length < 2000 && !floorReason(ask, undefined, { stateDir: opts.stateDir })
  const start = argv.findIndex((_w, i) => !assignments[i])
  const head = argv[start] ?? ''
  const program = head.split(/[\\/]/).at(-1)!
  let environment: PermissionExecutionEnvironment | undefined
  try { environment = opts.executionEnvironment?.() } catch { /* Unknown execution identity: owner can still allow once. */ }
  const executable = inspectPermissionExecutable(head, cwd, environment)
  if (executable) snapshot.executable = executable
  else eligible = false
  // Task permission only narrows the existing low-risk gate. Never infer that an
  // unrecognized runner has no mutable code just because scripts is empty.
  if (!['echo', 'pwd', 'true', 'false'].includes(program) && !isLowRisk({ ...ask, command: [program, ...argv.slice(start + 1)].join(' ') })) eligible = false
  if(argv.some((word,i)=>i!==start&&((isAbsolute(word)&&!inside(word))||word.split(/[\\/]/).includes('..'))))eligible=false
  if(argv.some(word=>/^(?:--cwd|--prefix|--directory|--dir)(?:=|$)/.test(word)||word==='-C'))eligible=false
  if(argv.slice(0,start).some(word=>/^(?:PATH|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP)=/.test(word)))eligible=false
  if (['env', 'command', 'exec', 'time', 'nice', 'nohup', 'timeout', 'xargs', 'parallel', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(program)) eligible = false
  // Inline programs / modules may load mutable code invisible in the card.
  if (argv.some(w => /^(?:-[cem]|--eval|--require|--import|--preload)(?:=|$)/.test(w))) return snapshot
  const runtime = /^(?:python[\d.]*|node|bun|deno|bash|sh|zsh|ruby|perl)$/.test(head.split(/[\\/]/).at(-1)!)
  const systemNativeHead = isAbsolute(head) && NATIVE_COMMANDS.has(program) && PERMISSION_SYSTEM_DIRS.has(dirname(resolve(head)))
  const candidates = argv.filter((w, i) => /\.(?:py|[cm]?js|tsx?|sh|bash|zsh|rb|pl)$/i.test(w) || (i === start && !runtime && !executable && !systemNativeHead && /[\\/]/.test(w)))
  if (program === 'source' || program === '.') {
    const entry = argv[start + 1]
    if (entry && !entry.startsWith('-') && !candidates.includes(entry)) candidates.push(entry)
  }
  // Also show extensionless interpreter scripts behind a wrapper, without granting
  // the wrapper a reusable permission.
  for (let i = start; i < argv.length; i++) {
    if (!/^(?:python[\d.]*|node|bash|sh|zsh|ruby|perl)$/.test(argv[i]!.split(/[\\/]/).at(-1)!)) continue
    const entry = argv.slice(i + 1).find(w => !w.startsWith('-'))
    if (entry && !candidates.includes(entry)) candidates.push(entry)
  }
  if (program === 'deno' && argv[start + 1] === 'run') {
    const entry = argv[start + 2]
    if (!entry || entry.startsWith('-')) eligible = false
    else if (!candidates.includes(entry)) candidates.push(entry)
  }
  // Package aliases execute mutable files too: bind both the package definition
  // and the literal script it resolves to. Unresolved or compound aliases ask again.
  if (['bun', 'npm', 'pnpm', 'yarn'].includes(program) && argv[start + 1] === 'run') {
    const name = argv[start + 2]
    const packagePath = relative(root, resolve(cwd, 'package.json')).replaceAll('\\', '/')
    try {
      const bytes = readAnchoredFile(root, packagePath, PERMISSION_SCRIPT_MAX, { path: 'package.json 不可安全读取', size: 'package.json 过大', changed: 'package.json 已变化' })
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      snapshot.scripts.push({ path: packagePath, content, sha256: hash(bytes) })
      const pkg = JSON.parse(content) as { scripts?: Record<string, unknown> }
      const script = name && pkg.scripts?.[name]
      if (name && (pkg.scripts?.[`pre${name}`] || pkg.scripts?.[`post${name}`])) eligible = false
      if (typeof script !== 'string') {
        if (program !== 'bun' || !name || !candidates.includes(name)) eligible = false
      }
      else {
        // npm's run operand is always a script key, even when it ends in .py.
        if(program!=='bun'){const index=candidates.indexOf(name!);if(index>=0)candidates.splice(index,1)}
        const child = inspectPermissionCommand({ ...facts, command: script }, opts, depth + 1)
        snapshot.scripts.push(...child.scripts)
        if (!child.hash) eligible = false
      }
    } catch { if(program!=='bun'||!name||!candidates.includes(name))eligible = false }
  }
  if (['npm', 'pnpm', 'yarn'].includes(program) && argv[start + 1] !== 'run') eligible = false
  if (runtime && !candidates.length && !argv.some(w => ['test', 'vitest', 'run', 'x'].includes(w))) eligible = false
  if (candidates.length > 8) eligible = false
  for (const name of [...new Set(candidates)].slice(0, 8)) {
    const absolute = resolve(cwd, name); const path = relative(root, absolute).replaceAll('\\', '/')
    const script: PermissionScript = { path, content: '' }; snapshot.scripts.push(script)
    // Do not follow lexical .. or symlinks, or attach protected/outside files.
    if (!inside(absolute) || name.split(/[\\/]/).includes('..') || floorReason({ ...ask, command: name }, undefined, { stateDir: opts.stateDir })) {
      script.error = '无法安全读取此脚本'; eligible = false; continue
    }
    try {
      const bytes = readAnchoredFile(root, path, PERMISSION_SCRIPT_MAX, { path: '脚本路径不可读或含链接', size: '脚本不是普通文件或超过 128 KiB', changed: '读取期间脚本已变化' })
      script.content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (script.content.includes('\0')) throw Error('脚本不是文本')
      script.sha256 = hash(bytes)
      if (floorReason({ ...ask, command: script.content }, undefined, { stateDir: opts.stateDir })) eligible = false
    } catch (e) { script.content = ''; script.error = e instanceof Error ? e.message : '脚本不可读'; eligible = false }
  }
  if (eligible && !snapshot.scripts.length) {
    snapshot.hash = hash(JSON.stringify([cwd, argv, assignments.slice(0, start + 1), executable]))
    ask.commandHash = snapshot.hash
  }
  return snapshot
}

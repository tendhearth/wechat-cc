import { relative, isAbsolute, sep } from 'node:path'
import type { PermissionAsk, RuleWhen } from '../../domain/permission-rules/types'
import { hasUnscopedShellPath, toolClass } from './floor'

/** A small literal grammar, also applied to every future match. */
export function rememberCommandPrefix(command: string): string | null {
  if (command.length >= 2000 || !/^[a-zA-Z0-9_./-]+(?: +[a-zA-Z0-9_./-]+)*$(?![\s\S])/.test(command) ||
      hasUnscopedShellPath(command)) return null
  const [head, verb, ...rest] = command.split(/ +/)
  if (head === 'bun' && verb === 'test' && rest.every(arg => !arg.startsWith('-'))) return 'bun test'
  if (head === 'git' && verb === 'status' && rest.length === 0) return 'git status'
  if (head === 'pwd' && verb === undefined) return 'pwd'
  return null
}

export function rememberWhen(ask: PermissionAsk): RuleWhen | null {
  if (ask.ambiguousRememberFacts || ask.tier !== 'admin' || !ask.project || !ask.cwd || ask.surface === 'chat' ||
      !/^[\p{L}\p{N}_ ./\\:\p{M}-]+$/u.test(ask.project) || ask.project.length > 200 ||
      !/^[\w-]+$/.test(ask.tool)) return null
  const inside = (path: string) => {
    const r = relative(ask.project!, path)
    return isAbsolute(path) && !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)
  }
  if (!inside(ask.cwd)) return null
  const base = { projectExact: ask.project, tool: ask.tool }
  if (toolClass(ask.tool) === 'shell' && ask.command && !ask.paths?.length) {
    const commandPrefix = rememberCommandPrefix(ask.command)
    return commandPrefix ? { ...base, commandPrefix } : null
  }
  // Limit reuse to the same file. Move/delete and other multi-path writes stay one-shot.
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'fileChange', 'edit'].includes(ask.tool) &&
      !ask.command && ask.paths?.length === 1) {
    const pathExact = ask.paths[0]!
    if (pathExact !== ask.project && pathExact.length <= 200 && inside(pathExact) &&
        /^[\p{L}\p{N}_ ./\\:\p{M}-]+$/u.test(pathExact)) return { ...base, pathExact }
  }
  return null
}

export function sameRememberWhen(a: RuleWhen, b: RuleWhen): boolean {
  return a.projectExact === b.projectExact && a.tool === b.tool && a.commandPrefix === b.commandPrefix && a.pathExact === b.pathExact
}

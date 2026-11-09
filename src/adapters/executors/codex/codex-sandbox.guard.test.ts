import { expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { workbenchCodexConfig } from './codex-config'
import { codexChatThreadConfig } from './codex-chat-provider'
import { TIER_PROFILES } from '../../../domain/user-tier'

// SECURITY INVARIANT: current sandbox permits broad host reads. Loopback would
// turn readable owner credentials into callable approval authority. Any future
// network/local-binding design must first prove task credentials unreadable and
// trustworthy daemon/host isolation; a domain denylist is insufficient.
it('keeps workbench and every dialogue tier offline without a managed proxy',()=>{
  const configs=[workbenchCodexConfig([]),...Object.values(TIER_PROFILES).map(tierProfile=>codexChatThreadConfig(undefined,{tierProfile,permissionMode:'strict'},false))]
  for(const config of configs){expect(config).toMatchObject({sandbox_workspace_write:{network_access:false},features:{network_proxy:false}})}
})
it('has no local-binding or managed-proxy activation path',()=>{
  const root=fileURLToPath(new URL('.',import.meta.url))
  for(const path of productionSources(root)){
    const source=readFileSync(path,'utf8')
    expect(source,path).not.toMatch(/allow_local_binding|TASK_LOOPBACK_PROXY|supportsTaskLoopback|network_access\s*[:=]\s*true/)
  }
})


function productionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'test-support' || entry.name === '__e2e__') return []
    const path = join(root, entry.name)
    return entry.isDirectory() ? productionSources(path) : entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

type StartupCounts = Partial<Record<'app-server' | 'thread/start' | 'thread/resume' | 'session' | 'process-import' | 'session-import', number>>
// These are the currently reviewed Codex startup seams. Every executable
// thread goes through the shared policy and offline receipt checks in
// codex-app-server.ts; history/catalog transports never create threads.
// New entrypoints must be registered here and receive offline behavior tests.
// This guards the recognized startup syntax, not arbitrary future code shapes.
const STARTUPS: Record<string, StartupCounts> = {
  'adapters/executors/codex/codex-app-server.ts': { 'app-server': 1, 'thread/start': 2, 'thread/resume': 2, session: 1, 'process-import': 1 },
  'adapters/executors/codex/codex-chat-provider.ts': { session: 2, 'session-import': 1 },
  'adapters/executors/codex/codex-history-rpc.ts': { 'app-server': 1 },
  'adapters/executors/codex/codex-model-catalog.ts': { 'app-server': 1 },
}
function startupCounts(path: string, source: string): StartupCounts {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const counts: StartupCounts = {}, sessionNames = new Set(['spawnCodexAppServerSession'])
  const add = (kind: keyof StartupCounts) => { counts[kind] = (counts[kind] ?? 0) + 1 }
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text
      if (imported === 'spawnCodexAppServerSession') { add('session-import'); sessionNames.add(node.name.text) }
      if (imported === 'spawnCodexAppServerProcess') add('process-import')
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && ['app-server', 'thread/start', 'thread/resume'].includes(node.text)) add(node.text as keyof StartupCounts)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && sessionNames.has(node.expression.text)) add('session')
    ts.forEachChild(node, visit)
  }
  visit(file)
  return counts
}
function startupViolations(sources: Array<{ path: string; source: string }>, requireAll = false): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const { path, source } of sources) {
    const actual = startupCounts(path, source), expected = STARTUPS[path] ?? {}
    if (Object.keys(actual).length || STARTUPS[path]) {
      seen.add(path)
      if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) errors.push(`${path}: startup entrypoints changed; register the entry and verify offline configuration/receipts (${JSON.stringify(actual)})`)
    }
  }
  if (requireAll) for (const path of Object.keys(STARTUPS)) if (!seen.has(path)) errors.push(`${path}: registered startup source missing`)
  return errors
}

it('registers every recognized Codex process and thread startup recursively across src', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const sources = productionSources(root).map(path => ({ path: relative(root, path).split(sep).join('/'), source: readFileSync(path, 'utf8') }))
  expect(startupViolations(sources, true)).toEqual([])
})

it.each([
  { path: 'features/new-helper.ts', source: `import { spawn } from 'node:child_process'; spawn('/codex', ['app-server', '--listen', 'stdio://'])` },
  { path: 'adapters/executors/codex/nested/new-helper.ts', source: `request('thread/start', { sandbox: 'workspace-write' })` },
  { path: 'lib/new-helper.ts', source: `import { spawnCodexAppServerSession as open } from '../adapters/executors/codex/codex-app-server'; open(options, project, context)` },
])('rejects an unregistered startup outside existing entrypoints: $path', source => {
  expect(startupViolations([source])).toEqual([expect.stringContaining('register the entry and verify offline')])
})

it('rejects an extra unverified thread startup in an already registered module', () => {
  const path = 'adapters/executors/codex/codex-app-server.ts'
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const source = readFileSync(join(root, path), 'utf8') + `
function newEntry() { request('thread/start', {}) }`
  expect(startupViolations([{ path, source }])).toEqual([expect.stringContaining('register the entry and verify offline')])
})

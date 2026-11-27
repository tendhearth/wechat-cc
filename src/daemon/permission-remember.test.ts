import { expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../lib/db'
import { removeTempDir } from '../lib/test-temp'
import { makeMatterStore } from '../adapters/store/matters-store'
import { makeMatterLog } from '../adapters/store/matter-log'
import { makeTerminalTurnLog } from '../adapters/store/terminal-turns'
import { makePermissionDecisionsStore } from './permission-decisions-store'
import { makePermissionGate } from './permission-gate'
import { parseRulesFile as parseOldRules } from '../adapters/permission-rules/__fixtures__/rules-file-origin-dev'
import { parseRulesFile, RULES_FILE } from '../adapters/permission-rules/rules-file'
import type { PermissionAsk } from '../domain/permission-rules/types'

it('counts the latest three explicit decisions across existing records, rechecks and saves once', async () => {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'permit-remember-')))
  const db = openTestDb()
  try {
    const stateDir = join(tmp, 'state'), project = join(tmp, 'project')
    mkdirSync(stateDir); mkdirSync(project)
    const rulesPath = join(stateDir, RULES_FILE)
    const empty = JSON.stringify({ version: 1, enabled: true, review: 'off', rules: [] })
    writeFileSync(rulesPath, empty)
    const store = makePermissionDecisionsStore(db)
    const cheapEval = vi.fn(() => null)
    const gate = makePermissionGate({ stateDir, store, cheapEval, notifyOwner: vi.fn(), log: vi.fn() })
    const matters = makeMatterStore(db)
    const log = makeMatterLog(db)
    const turns = makeTerminalTurnLog({ db, log, matters })
    const request: PermissionAsk = { surface: 'terminal', provider: 'claude', tool: 'Bash', project, cwd: project,
      command: 'bun test src/foo.test.ts', scope: 'term', tier: 'admin', isolatedWorktree: false }
    const approval = () => gate.remember!(() => request)!
    const { key } = approval()
    let at = 100
    const terminal = (verdict: 'allow' | 'deny', explicit = true) => {
      turns.permissionAsked({ source: 'claude', session_id: 'term', cwd: project, tool_name: 'Bash' }, at++)
      turns.permissionSettled('term', verdict, explicit ? { key, verdict } : undefined)
    }
    const task = matters.create({ kind: 'task', title: 'task', projectPath: project })
    const workbench = () => log.writeItem({ matterId: task.id, kind: 'system', status: 'completed', payload: { ownerPermission: { key, verdict: 'allow' } } })
    expect(approval().preview).toBeUndefined()
    terminal('allow'); workbench(); terminal('allow', false)
    expect(approval().preview).toBeUndefined()
    terminal('allow')
    const stale = approval()
    expect(stale.preview).toContain('bun test')
    expect(readFileSync(rulesPath, 'utf8')).toBe(empty)
    terminal('deny')
    expect(stale.save()).toBeNull()
    terminal('allow'); workbench()
    expect(approval().preview).toBeUndefined()
    terminal('allow')
    const fourth = approval()
    writeFileSync(rulesPath, '{corrupt')
    expect(fourth.save()).toBeNull()
    expect(readFileSync(rulesPath, 'utf8')).toBe('{corrupt')
    writeFileSync(rulesPath, empty)
    const lock = rulesPath + '.lock'
    const heldBy = join(lock, String(process.pid))
    mkdirSync(lock)
    writeFileSync(heldBy, '')
    expect(fourth.save()).toBeNull()
    expect(readFileSync(rulesPath, 'utf8')).toBe(empty)
    unlinkSync(heldBy)
    rmdirSync(lock)
    expect(fourth.save()).toEqual({ line: fourth.preview, added: true })
    expect(fourth.save()).toEqual({ line: fourth.preview, added: false })
    const persisted = readFileSync(rulesPath, 'utf8')
    expect(parseRulesFile(persisted).file.rules).toHaveLength(1)
    expect(parseOldRules(persisted).file.rules).toEqual([])
    expect(parseOldRules(persisted).errors).toHaveLength(1)
    expect(approval().preview).toBeUndefined()
    expect(await gate.decide({ ...request, command: 'bun test src/bar.test.ts' })).toMatchObject({ verdict: 'allow', by: 'rule' })
    for (const patch of [
      {tier:'trusted'}, {tier:'guest'}, {command:'bun test src/.env'}, {command:'sudo ls'}, {command:undefined},
      {command:undefined,tool:'Write'}, {command:undefined,tool:'Write',paths:[join(project,'permission-rules.json')]},
      {command:undefined,tool:'Write',paths:[join(tmp,'outside.txt')]},
    ] as const) expect(gate.remember!(() => ({ ...request, ...patch } as PermissionAsk))).toBeUndefined()
    const path = join(project, 'README.md')
    const write: PermissionAsk = { ...request, tool: 'Write', command: undefined, paths: [path] }
    expect(gate.remember!(() => write)).toBeUndefined()
    writeFileSync(path, 'fixture')
    expect(gate.remember!(() => write)?.key).toBeTruthy()
    const file = parseRulesFile(readFileSync(rulesPath, 'utf8')).file
    file.rules.push({ id: 'file', then: 'allow', when: { projectExact: project, tool: write.tool, pathExact: path } })
    writeFileSync(rulesPath, JSON.stringify(file))
    expect((await gate.decide(write)).verdict).toBe('allow')
    unlinkSync(path)
    expect((await gate.decide(write)).verdict).toBe('ask')
    expect(cheapEval).toHaveBeenCalledTimes(3) // Regular decide reads its hook. Learning never asks the model.
  } finally {
    db.close()
    removeTempDir(tmp)
  }
})

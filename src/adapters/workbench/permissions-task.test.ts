import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRunPermissions } from './permissions'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(taskId = 'task-one') {
  const root = mkdtempSync(join(tmpdir(), 'cc-task-approval-')); roots.push(root)
  mkdirSync(join(root, '.cc-workbench/task'), { recursive: true })
  const file = '.cc-workbench/task/check.py'
  writeFileSync(join(root, file), 'print("hello")\n')
  const permissions = makeRunPermissions({ taskId, root, provider: 'codex' })
  const request = (command = `python3 ${file}`, cwd = root) => permissions.request({ tool: 'Bash', description: command, command, cwd })
  return { root, file, permissions, request }
}

describe('explicit permission for the same command in this task', () => {
  it('keeps multiple large scripts out of the card payload and reads immutable full snapshots in bounded chunks',async()=>{
    const f=fixture(),source='// '+ 'x'.repeat(120_000)
    for(const name of ['one.ts','two.ts','three.ts'])writeFileSync(join(f.root,name),source)
    const pending=f.request('bun one.ts two.ts three.ts'),card=f.permissions.pending()[0]!
    expect(card.scripts).toHaveLength(3);expect(JSON.stringify(card).length).toBeLessThan(10_000)
    expect(card.scripts?.[0]).toMatchObject({content:source.slice(0,2000),truncated:true})
    let full='',offset:number|null=0
    while(offset!==null){const chunk=f.permissions.script(card.id,'one.ts',card.scripts![0]!.sha256!,offset);expect(chunk.content.length).toBeLessThanOrEqual(8000);full+=chunk.content;offset=chunk.nextOffset}
    expect(full).toBe(source)
    expect(()=>f.permissions.script(card.id,'one.ts','0'.repeat(64),0)).toThrow('permission_stale')
    f.permissions.resolve(card.id,'deny');expect(await pending).toBe(false)
    expect(()=>f.permissions.script(card.id,'one.ts',card.scripts![0]!.sha256!,0)).toThrow('permission_stale')
  })

  it('rechecks ordinary approvals and fingerprints the actual npm alias instead of a same-named file',async()=>{
    const f=fixture();const old=f.request();writeFileSync(join(f.root,f.file),'print("changed")\n')
    expect(f.permissions.resolve(f.permissions.pending()[0]!.id,'allow')).toBe(false);expect(await old).toBe(false)
    writeFileSync(join(f.root,'check.py'),'print("decoy")\n')
    writeFileSync(join(f.root,'package.json'),JSON.stringify({scripts:{'check.py':`python3 ${f.file}`}}))
    const first=f.request('npm run check.py');const card=f.permissions.pending()[0]!
    expect(card.scripts?.map(s=>s.path)).toContain(f.file)
    f.permissions.resolve(card.id,'allow_task');expect(await first).toBe(true)
    writeFileSync(join(f.root,f.file),'print("real entry changed")\n')
    const changed=f.request('npm run check.py');expect(f.permissions.pending()).toHaveLength(1)
    f.permissions.resolve(f.permissions.pending()[0]!.id,'deny');expect(await changed).toBe(false)
    writeFileSync(join(f.root,'package.json'),JSON.stringify({scripts:{check:'echo ok',precheck:'bash precheck'}}))
    const hook=f.request('npm run check');expect(f.permissions.pending()[0]!.canAllowTask).not.toBe(true)
    f.permissions.rejectAll();expect(await hook).toBe(false)
  })
  it('does not conflate Unicode whitespace or shell assignment syntax', async () => {
    const f=fixture();const first=f.request('echo a b')
    f.permissions.resolve(f.permissions.pending()[0]!.id,'allow_task');expect(await first).toBe(true)
    const unicode=f.request('echo a\u00a0b');expect(f.permissions.pending()).toHaveLength(1)
    f.permissions.resolve(f.permissions.pending()[0]!.id,'deny');expect(await unicode).toBe(false)
    const env=f.request('MODE=one echo test');f.permissions.resolve(f.permissions.pending()[0]!.id,'allow_task');expect(await env).toBe(true)
    const quoted=f.request('"MODE=one" echo test');expect(f.permissions.pending()).toHaveLength(1)
    f.permissions.rejectAll();expect(await quoted).toBe(false)
  })

  it('fingerprints package aliases and never reuses an unresolved wrapper or hidden script', async()=>{
    const f=fixture();writeFileSync(join(f.root,'package.json'),JSON.stringify({scripts:{check:`python3 ${f.file}`}}))
    const first=f.request('bun run check'),card=f.permissions.pending()[0]!
    expect(card.scripts?.map(s=>s.path)).toContain(f.file)
    expect(f.permissions.resolve(card.id,'allow_task')).toBe(true);expect(await first).toBe(true)
    writeFileSync(join(f.root,f.file),'print("changed alias source")\n')
    const changed=f.request('bun run check');expect(f.permissions.pending()).toHaveLength(1)
    f.permissions.resolve(f.permissions.pending()[0]!.id,'deny');expect(await changed).toBe(false)
    writeFileSync(join(f.root,'check'),'git push\n')
    const wrapped=f.request('env bash check'),wrappedCard=f.permissions.pending()[0]!
    expect(wrappedCard.canAllowTask).not.toBe(true);expect(wrappedCard.scripts?.[0]?.content).toBe('git push\n')
    f.permissions.rejectAll();expect(await wrapped).toBe(false)
  })
  it('reuses an exact normalized command, preserving arguments, environment and cwd', async () => {
    const f = fixture(); const first = f.request()
    const card = f.permissions.pending()[0]!
    expect(card.canAllowTask).toBe(true)
    expect(f.permissions.resolve(card.id, 'allow_task')).toBe(true)
    expect(await first).toBe(true)
    expect(await f.request(`  python3   '${f.file}'  `)).toBe(true)
    expect(f.permissions.pending()).toHaveLength(0)
    for (const command of [`python3 ${f.file} --changed`, `MODE=changed python3 ${f.file}`]) {
      const next = f.request(command); expect(f.permissions.pending()).toHaveLength(1)
      f.permissions.resolve(f.permissions.pending()[0]!.id, 'deny'); expect(await next).toBe(false)
    }
    mkdirSync(join(f.root, 'other'))
    const other = f.request(`python3 ../${f.file}`, join(f.root, 'other'))
    expect(f.permissions.pending()).toHaveLength(1)
    f.permissions.rejectAll(); expect(await other).toBe(false)
  })

  it('attaches the inspected script and asks again after content changes, including before approval', async () => {
    const f = fixture(); const first = f.request(); const card = f.permissions.pending()[0]!
    expect(card.scripts?.[0]).toMatchObject({ path: f.file, content: 'print("hello")\n' })
    writeFileSync(join(f.root, f.file), 'print("changed")\n')
    expect(f.permissions.resolve(card.id, 'allow_task')).toBe(false)
    expect(await first).toBe(false)
    const next = f.request(); const nextCard = f.permissions.pending()[0]!
    expect(f.permissions.resolve(nextCard.id, 'allow_task')).toBe(true); expect(await next).toBe(true)
    writeFileSync(join(f.root, f.file), 'print("third version")\n')
    const third = f.request(); expect(f.permissions.pending()).toHaveLength(1)
    f.permissions.rejectAll(); expect(await third).toBe(false)
  })

  it('one-shot approvals, another task, and a finished run do not inherit permission', async () => {
    const f = fixture(); const first = f.request()
    f.permissions.resolve(f.permissions.pending()[0]!.id, 'allow'); expect(await first).toBe(true)
    const again = f.request(); expect(f.permissions.pending()).toHaveLength(1)
    f.permissions.resolve(f.permissions.pending()[0]!.id, 'allow_task'); expect(await again).toBe(true)
    const other = makeRunPermissions({ taskId: 'task-two', root: f.root, provider: 'codex' })
    const pending = other.request({ tool: 'Bash', description: 'test', command: `python3 ${f.file}`, cwd: f.root })
    expect(other.pending()).toHaveLength(1); other.rejectAll(); expect(await pending).toBe(false)
    f.permissions.rejectAll(); expect(await f.request()).toBe(false)
    const restarted = makeRunPermissions({ taskId: 'task-one', root: f.root, provider: 'codex' })
    const rerun = restarted.request({ tool: 'Bash', description: 'test', command: `python3 ${f.file}`, cwd: f.root })
    expect(restarted.pending()).toHaveLength(1); restarted.rejectAll(); expect(await rerun).toBe(false)
  })

  it('never offers or accepts reusable permission for red lines, hidden scripts, expansions or truncated commands', async () => {
    const f = fixture()
    symlinkSync(join(f.root, f.file), join(f.root, 'linked.py'))
    for (const command of ['git push', 'sudo true', 'curl https://example.com', 'touch /outside-task/file', 'bun --cwd other check.ts', 'BASH_ENV=check bash script.sh', 'python3 linked.py', 'python3 missing.py', 'python3 "$SCRIPT"', 'ls && git push', `echo ${'x'.repeat(2000)}`]) {
      const pending = f.request(command); const card = f.permissions.pending()[0]!
      expect(card.canAllowTask).not.toBe(true)
      expect(f.permissions.resolve(card.id, 'allow_task')).toBe(false)
      f.permissions.resolve(card.id, 'deny'); expect(await pending).toBe(false)
    }
    writeFileSync(join(f.root, f.file), 'import os\nos.system("git push")\n')
    const scripted = f.request(); const card = f.permissions.pending()[0]!
    expect(card.scripts?.[0]?.content).toContain('git push')
    expect(card.canAllowTask).not.toBe(true)
    f.permissions.rejectAll(); expect(await scripted).toBe(false)
  })
})

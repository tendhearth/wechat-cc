import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { collectArtifacts, MAX_ARTIFACT_BYTES, readAnchoredRegular } from './artifacts'
import {removeTempDir} from '../../lib/test-temp'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'workbench-artifacts-')) })
afterEach(() => { removeTempDir(root) })

describe('anchored artifact reads', () => {
  it('reads a valid nested regular file relative to the opened root', () => {
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'result.md'), 'safe result')
    expect(readAnchoredRegular(root, 'nested/result.md').toString()).toBe('safe result')
  })

  it('never follows a symlink in a parent component', () => {
    const outside = mkdtempSync(join(tmpdir(), 'workbench-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret')
      symlinkSync(outside, join(root, 'swapped-parent'))
      expect(() => readAnchoredRegular(root, 'swapped-parent/secret.txt')).toThrow('invalid_artifact_path')
    } finally {
      removeTempDir(outside)
    }
  })

  it('bounds the actual read to 8 MiB plus one byte', () => {
    writeFileSync(join(root, 'large.bin'), Buffer.alloc(MAX_ARTIFACT_BYTES + 1))
    expect(() => readAnchoredRegular(root, 'large.bin')).toThrow('invalid_artifact_size')
  })

  it('rejects traversal and absolute names before opening', () => {
    expect(() => readAnchoredRegular(root, '../secret.txt')).toThrow('invalid_artifact_path')
    expect(() => readAnchoredRegular(root, join(root, 'file.txt'))).toThrow('invalid_artifact_path')
  })
})

it('old artifact versions do not consume the per-turn 100-new-version budget', () => {
  const project = join(root, 'project')
  const output = join(project, '.cc-workbench', 'deadbeef')
  mkdirSync(output, { recursive: true })
  const known: Array<{ name: string; sha256: string }> = []
  for (let i = 0; i < 100; i++) {
    const name = `${String(i).padStart(3, '0')}.txt`
    const content = `old-${i}`
    writeFileSync(join(output, name), content)
    known.push({ name, sha256: createHash('sha256').update(content).digest('hex') })
  }
  writeFileSync(join(output, '100.txt'), 'new version')
  const added: Array<{ name: string }> = []
  const store = {
    artifacts: () => known,
    addArtifact: (artifact: { name: string }) => { added.push(artifact) },
  }
  collectArtifacts(store as never, 'deadbeef', project, root)
  expect(added.map(a => a.name)).toContain('100.txt')
})
it('collects source code as inert text and saves generated snapshots immutably', async () => {
 const {saveArtifactSnapshot,readArtifactSnapshot}=await import('./artifacts')
 const output=join(root,'project/.cc-workbench/task');mkdirSync(output,{recursive:true})
 for(const name of ['a.ts','b.py','page.html','change.diff'])writeFileSync(join(output,name),'<script>never execute</script>')
 const records:any[]=[];const store={artifacts:()=>records,addArtifact:(a:any)=>{records.push(a);return a}}
 collectArtifacts(store as never,'task',join(root,'project'),root)
 expect(records).toHaveLength(4);expect(records.every(a=>a.mime==='text/plain')).toBe(true)
 saveArtifactSnapshot(store as never,'task',{name:'代码变更.json',mime:'application/vnd.cc.workbench-review+json',bytes:Buffer.from('{"version":1}')},root)
 const generated=records.at(-1)
 expect(readArtifactSnapshot(generated.storagePath,root,generated.sha256).toString()).toBe('{"version":1}')
 saveArtifactSnapshot(store as never,'task',{name:'代码变更.json',mime:generated.mime,bytes:Buffer.from('{"version":2}')},root)
 expect(readArtifactSnapshot(generated.storagePath,root,generated.sha256).toString()).toBe('{"version":1}')
})
it('rejects a FIFO without waiting for a writer',async()=>{
 const {execFileSync}=await import('node:child_process');execFileSync('mkfifo',[join(root,'pipe.txt')])
 expect(()=>readAnchoredRegular(root,'pipe.txt')).toThrow('invalid_artifact_size')
})

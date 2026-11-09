import { beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Real Windows fetch tests need the same strict job wrapper as packaged CC. */
export function preparationJobspawnFixture(): void {
  if (process.platform !== 'win32') return
  let folder: string | undefined
  const previous=process.env.WECHAT_CC_JOBSPAWN
  beforeAll(()=>{
    folder=mkdtempSync(join(tmpdir(),'cc-preparation-job-'))
    const binary=join(folder,'cc-jobspawn.exe')
    execFileSync('rustc',['--edition','2021','-O','scripts/jobspawn.rs','-o',binary],{timeout:60_000,stdio:'pipe'})
    process.env.WECHAT_CC_JOBSPAWN=binary
  },70_000)
  afterAll(()=>{
    if(previous===undefined)delete process.env.WECHAT_CC_JOBSPAWN;else process.env.WECHAT_CC_JOBSPAWN=previous
    if(folder)rmSync(folder,{recursive:true,force:true})
  })
}

// Integrator-only source transport. No dependencies, credentials, ignored files or local builds.
import { spawn, execFileSync } from 'node:child_process'
import * as nativeFs from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { jobLifecycle } from './macmini-job-lifecycle.mjs'
import { acquireMachineLock as defaultAcquireMachineLock, machineGateOptions } from './macmini-machine-lock.mjs'
import {removeInactiveSnapshot} from './macmini-source-manifest.mjs'
import { isInsideLab, miniConfiguration } from './macmini-ui-protocol.mjs'
import { receiveBrowserSnapshot, verifiedSourcePayload } from './macmini-browser-snapshot.mjs'
import { pruneInactiveSnapshots } from './macmini-snapshot-retention.mjs'

const finished = child => new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve() : reject(Error(`Snapshot process exited ${code}`)))
})
export async function receiveAppSnapshot({mini,sha,lifecycle=jobLifecycle(),input=process.stdin,fs={},spawnProcess=spawn,acquireMachineLock=defaultAcquireMachineLock,removeSnapshot=removeInactiveSnapshot}) {
  const guardedFs=Object.fromEntries(Object.entries({...nativeFs,...fs}).map(([name,operation])=>[name,async(...args)=>{
    lifecycle.assertRunning();const value=await operation(...args);lifecycle.assertRunning();return value
  }]))
  const {mkdir,readFile,writeFile,rename,realpath}=guardedFs
  const activePath = join(mini.labHome, 'active.json')
  let tar,root,activated=false,activation,receivingDone,cleanupPromise
  const received=new Promise(resolve=>receivingDone=resolve)
  const cleanup=()=>cleanupPromise??=removeSnapshot(root,activePath,activation)
  lifecycle.onStop(async()=>{input.destroy?.();await received;await cleanup()})
  try {
    await acquireMachineLock({ path: join(mini.homeDir, 'ci/lock'), lane: 'app-snapshot', sha,
      ...machineGateOptions(), onAcquired: lifecycle.acquired, assertRunning: lifecycle.assertRunning })
    lifecycle.assertRunning()
    const lab = await realpath(mini.labHome)
    const snapshotRoot = join(mini.labHome, `app-${sha}-${Date.now()}`)
    // Record ownership even if cancellation arrives during mkdir.
    await (fs.mkdir ?? nativeFs.mkdir)(snapshotRoot, { mode: 0o700 })
    root = snapshotRoot
    if (!isInsideLab(lab, await realpath(root))) throw Error('Snapshot path leaves lab')
    await mkdir(join(root, 'project'), { mode: 0o700 })
    lifecycle.assertRunning()
    tar = spawnProcess('/usr/bin/tar', ['-xf', '-', '-C', join(root, 'project')], { detached: true, stdio: ['pipe', 'inherit', 'inherit'] })
    lifecycle.track(tar)
    const done = finished(tar)
    const results = await Promise.allSettled([done, pipeline(input, tar.stdin)])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    lifecycle.assertRunning()
    await writeFile(join(root, 'snapshot.json'), JSON.stringify({ commit: sha, created: new Date().toISOString() }))
    const config = JSON.parse(await readFile(activePath, 'utf8'))
    lifecycle.assertRunning()
    activation=(async()=>{await writeFile(activePath + '.app-next', JSON.stringify({ ...config, appRoot: root }, null, 2), { mode: 0o600 });await rename(activePath + '.app-next', activePath)})()
    await activation;activated=true
    await pruneInactiveSnapshots(mini.labHome, { fs: guardedFs })
    console.log(JSON.stringify({ appRoot: root, commit: sha }))
  } finally {
    receivingDone()
    try{if(root&&!activated)await cleanup()}finally{await lifecycle.finish()}
  }
}

export const supportsAppSnapshot = ref => ['claude/butler-app', 'mini-ui-acceptance', 'cc-alive-2', 'origin/dev', 'app-maestro-build3', 'design-unify-b1-fixes', 'codex-hook-trust-ux', 'topics-are-projects', 'topics-waiting-honest', 'design-b3', 'who-answers-app-avatar'].includes(ref)

export async function main() {
 if (process.argv[2] === '--receive' || process.argv[2] === '--receive-verified') {
  const mini = miniConfiguration({ computerName: execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(), homeDir: homedir(), platformName: process.platform })
  const sha = process.argv[3]
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Expected immutable source commit')
  if(process.argv[2] === '--receive-verified')await receiveBrowserSnapshot({mini,sha,target:'app',selectActiveRoot:(config,root)=>({...config,appRoot:root})})
  else await receiveAppSnapshot({mini,sha})
 } else {
  const ref = process.argv[2] ?? 'origin/dev'
  if (!supportsAppSnapshot(ref)) throw Error('Snapshot ref must be an explicitly authorized UI branch')
  const repo = fileURLToPath(new URL('../../..', import.meta.url))
  const sha = execFileSync('/usr/bin/git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim()
  const verified=ref==='mini-ui-acceptance'||ref==='cc-alive-2'||ref==='design-b3'||ref==='codex-hook-trust-ux'||ref==='topics-waiting-honest'
  const { executorInvocation, sendSnapshot } = await import('./macmini-lab-client.mjs')
  const env = process.env
  const transport = executorInvocation('app-status', process.argv[3] ?? 'home', undefined, env,
    { kind: verified ? 'app-verified-snapshot' : 'app-snapshot', sha })
  if (verified) await sendSnapshot({ transport, payload: verifiedSourcePayload({ repo, sha }), env })
  else await sendSnapshot({ transport, archiveArgs: ['-C', repo, 'archive', '--format=tar', sha], env })
}
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()

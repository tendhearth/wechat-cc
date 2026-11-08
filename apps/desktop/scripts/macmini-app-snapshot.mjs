// Integrator-only source transport. No dependencies, credentials, ignored files or local builds.
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jobLifecycle } from './macmini-job-lifecycle.mjs'
import { acquireMachineLock, machineGateOptions } from './macmini-machine-lock.mjs'
import { miniConfiguration, sshInvocation } from './macmini-ui-protocol.mjs'

const finished = child => new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve() : reject(Error(`Snapshot process exited ${code}`)))
})
if (process.argv[2] === '--receive') {
  const mini = miniConfiguration({ computerName: execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(), homeDir: homedir(), platformName: process.platform })
  const sha = process.argv[3]
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Expected immutable source commit')
  const lifecycle = jobLifecycle()
  let tar
  try {
    await acquireMachineLock({ path: join(mini.homeDir, 'ci/lock'), lane: 'app-snapshot', sha,
      ...machineGateOptions(), onAcquired: lifecycle.acquired })
    const root = join(mini.labHome, `app-${sha}-${Date.now()}`)
    await mkdir(join(root, 'project'), { recursive: true, mode: 0o700 })
    if (!(await realpath(root)).startsWith(mini.labHome + '/')) throw Error('Snapshot path leaves lab')
    tar = spawn('/usr/bin/tar', ['-xf', '-', '-C', join(root, 'project')], { detached: true, stdio: ['pipe', 'inherit', 'inherit'] })
    lifecycle.track(tar)
    const done = finished(tar)
    process.stdin.pipe(tar.stdin)
    await done
    await writeFile(join(root, 'snapshot.json'), JSON.stringify({ commit: sha, created: new Date().toISOString() }))
    const activePath = join(mini.labHome, 'active.json')
    const config = JSON.parse(await readFile(activePath, 'utf8'))
    await writeFile(activePath + '.app-next', JSON.stringify({ ...config, appRoot: root }, null, 2), { mode: 0o600 })
    await rename(activePath + '.app-next', activePath)
    console.log(JSON.stringify({ appRoot: root, commit: sha }))
  } finally {
    await lifecycle.finish()
  }
} else {
  const ref = process.argv[2] ?? 'origin/dev'
  if (!['origin/dev', 'app-maestro-build3'].includes(ref)) throw Error('Snapshot ref must be origin/dev or app-maestro-build3')
  const repo = fileURLToPath(new URL('../../..', import.meta.url))
  const sha = execFileSync('/usr/bin/git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim()
  const transport = sshInvocation('app-status', process.argv[3] ?? 'home', process.env.CC_UI_SSH_CONFIG, undefined, process.env)
  const args = [...transport.args]
  // The receiver is installed beside the trusted desktop executor by the integrator.
  const receiver = args.at(-1).replace(/app-run\.mjs$/, `app-snapshot.mjs --receive ${sha}`)
  args[args.length - 1] = receiver
  const remote = spawn(transport.file, args, { stdio: ['pipe', 'inherit', 'inherit'] })
  const archive = spawn('/usr/bin/git', ['-C', repo, 'archive', '--format=tar', sha], { stdio: ['ignore', 'pipe', 'inherit'] })
  remote.stdin.on('error', () => {})
  const done = Promise.all([finished(remote), finished(archive)])
  archive.stdout.pipe(remote.stdin)
  await done
}

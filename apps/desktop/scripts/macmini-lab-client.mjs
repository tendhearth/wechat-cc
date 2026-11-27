import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { browserHarness, sshInvocation } from './macmini-ui-protocol.mjs'
import { BOOTSTRAP_VERSION } from './macmini-lab-bootstrap.mjs'

const repository = new URL('../../../', import.meta.url)
const local = name => readFileSync(new URL(name, import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function executorBundle(read = readFileSync) {
  const modules = ['app-snapshot', 'browser-snapshot', 'embedded-ui', 'job-lifecycle',
    'lab-executor', 'machine-lock', 'snapshot-retention', 'source-manifest',
    'ui-app', 'ui-protocol', 'ui-remote'].map(name => `macmini-${name}.mjs`)
  const paths = new Map([...modules.map(name => [name, 'apps/desktop/scripts/' + name]), ...browserHarness])
  const bundle = JSON.stringify([...paths.keys()].sort().map(name => [name,
    read(new URL(paths.get(name), repository)).toString('base64')]))
  return { bundle, sha256: digest(bundle) }
}

export function executorHeader(request, pack = executorBundle()) {
  const header = Buffer.from(JSON.stringify({ version: BOOTSTRAP_VERSION, ...pack, request }))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(header.length)
  return Buffer.concat([size, header])
}

export function executorInvocation(command, target, flow, env, snapshot) {
  const transport = sshInvocation(command, target, env.CC_UI_SSH_CONFIG, flow, env, true)
  return { ...transport, header: executorHeader(snapshot ?? { kind: 'ui' }) }
}

export function sshEnvironment(source) {
  const env = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']) {
    if (source[key]) env[key] = source[key]
  }
  return env
}

const finished = (child, name) => new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => code === 0 ? resolve() : reject(Error(`${name} exited ${code ?? signal}`)))
})

export async function sendSnapshot({ transport, payload, archiveArgs, env, spawnProcess = spawn }) {
  const remote = spawnProcess(transport.file, transport.args, {
    env: sshEnvironment(env), stdio: ['pipe', 'inherit', 'inherit'],
  })
  const remoteDone = finished(remote, 'Snapshot SSH')
  const archive = archiveArgs && spawnProcess('/usr/bin/git', archiveArgs, { stdio: ['ignore', 'pipe', 'inherit'] })
  const archiveDone = archive && finished(archive, 'Git archive')
  const input = Readable.from((async function* () {
    yield transport.header
    if (archive) { yield* archive.stdout; await archiveDone }
    else yield payload
  })())
  try { await Promise.all([remoteDone, archiveDone, pipeline(input, remote.stdin)]) }
  catch (error) { archive?.kill(); remote.kill(); throw error }
}

export function installInvocation(target, env) {
  const transport = sshInvocation('status', target, env.CC_UI_SSH_CONFIG, undefined, env, true)
  const bootstrap = local('macmini-lab-bootstrap.mjs')
  const lock = local('macmini-machine-lock.mjs')
  const installer = local('macmini-lab-install.mjs').toString('base64')
  const command = `--input-type=module -e 'await (await import("data:text/javascript;base64,${installer}")).installFromStdin()'`
  transport.args[transport.args.length - 1] = transport.args.at(-1).replace(/\/[^ ]+bootstrap\.mjs$/, command)
  const sha256 = digest(bootstrap)
  return { ...transport, version: BOOTSTRAP_VERSION, sha256,
    input: JSON.stringify({ bootstrap: bootstrap.toString('base64'), sha256, lock: lock.toString('base64') }) }
}

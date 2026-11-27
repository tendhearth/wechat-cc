// This entry never controls the current desktop. All execution goes over SSH.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { executorInvocation, installInvocation, sshEnvironment } from './macmini-lab-client.mjs'

export function main(argv = process.argv, sourceEnv = process.env, ssh = spawnSync) {
  if (['affected', 'full', 'full-platform'].includes(argv[2])) throw Error('bun run verify runs on the primary Mac, never on mini')
  const isAppTest = argv[2] === 'app-maestro'
  const install = argv[2] === 'lab-install'
  const request = install
    ? installInvocation(argv[3] ?? 'home', sourceEnv)
    : executorInvocation(argv[2] ?? 'status', argv[isAppTest ? 4 : 3] ?? 'home', isAppTest ? (argv[3] ?? 'all') : undefined, sourceEnv)
  if (install) console.log(`Installing macmini-lab-bootstrap.mjs v${request.version} sha256=${request.sha256} on ${argv[3] ?? 'home'}`)
  const input = install ? request.input : Buffer.concat([request.header, Buffer.from(request.input)])
  const result = ssh(request.file, request.args, { env: sshEnvironment(sourceEnv), input, stdio: ['pipe', 'inherit', 'inherit'] })
  if (result.error) console.error('Remote UI lab request failed:', result.error.message)
  return result.status ?? 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main())

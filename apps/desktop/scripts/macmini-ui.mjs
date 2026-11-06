// This entry never controls the current desktop. All execution goes over SSH.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { sshInvocation } from './macmini-ui-protocol.mjs'

export function main(argv = process.argv, sourceEnv = process.env, ssh = spawnSync) {
  if (['affected', 'full', 'full-platform'].includes(argv[2])) throw Error('bun run verify runs on the primary Mac, never on mini')
  const isAppTest = argv[2] === 'app-maestro'
  const request = sshInvocation(argv[2] ?? 'status', argv[isAppTest ? 4 : 3] ?? 'home', sourceEnv.CC_UI_SSH_CONFIG, isAppTest ? (argv[3] ?? 'all') : undefined, sourceEnv)
  const env = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']) {
    if (sourceEnv[key]) env[key] = sourceEnv[key]
  }
  const result = ssh(request.file, request.args, { env, input: request.input, stdio: ['pipe', 'inherit', 'inherit'] })
  if (result.error) console.error('Remote UI lab request failed:', result.error.message)
  return result.status ?? 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main())

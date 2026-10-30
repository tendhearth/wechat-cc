// This entry never controls the current desktop. All execution goes over SSH.
import { spawnSync } from 'node:child_process'
import { sshInvocation } from './macmini-ui-protocol.mjs'

const request = sshInvocation(process.argv[2] ?? 'status')
const env = {}
for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']) {
  if (process.env[key]) env[key] = process.env[key]
}
const result = spawnSync(request.file, request.args, { env, input: request.input, stdio: ['pipe', 'inherit', 'inherit'] })
if (result.error) console.error('Remote UI lab request failed:', result.error.message)
process.exit(result.status ?? 1)

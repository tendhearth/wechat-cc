// This entry never controls the current desktop. All execution goes over SSH.
import { spawnSync } from 'node:child_process'
import { sshInvocation } from './macmini-ui-protocol.mjs'

const isAppTest = process.argv[2] === 'app-maestro'
const request = sshInvocation(process.argv[2] ?? 'status', process.argv[isAppTest ? 4 : 3] ?? 'home', process.env.CC_UI_SSH_CONFIG, isAppTest ? (process.argv[3] ?? 'all') : undefined)
const env = {}
for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']) {
  if (process.env[key]) env[key] = process.env[key]
}
const result = spawnSync(request.file, request.args, { env, input: request.input, stdio: ['pipe', 'inherit', 'inherit'] })
if (result.error) console.error('Remote UI lab request failed:', result.error.message)
process.exit(result.status ?? 1)

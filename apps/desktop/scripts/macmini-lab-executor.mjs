import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { miniConfiguration } from './macmini-ui-protocol.mjs'
import { runRemote } from './macmini-ui-remote.mjs'
import { receiveAppSnapshot } from './macmini-app-snapshot.mjs'
import { receiveBrowserSnapshot } from './macmini-browser-snapshot.mjs'
import { jobLifecycle } from './macmini-job-lifecycle.mjs'

export async function run(request, input, executorDir, timeoutMs) {
  if (request?.kind === 'ui') return runRemote(input, executorDir, jobLifecycle({ timeoutMs }))
  const { kind, sha } = request ?? {}
  if (!['browser-snapshot', 'app-snapshot', 'app-verified-snapshot'].includes(kind) ||
    typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid snapshot entry or source commit')

  const lifecycle = jobLifecycle({ timeoutMs })
  let mini
  try {
    mini = miniConfiguration({ computerName: execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(),
      homeDir: homedir(), platformName: process.platform })
  } catch (error) {
    await lifecycle.finish()
    throw error
  }
  if (kind === 'browser-snapshot') await receiveBrowserSnapshot({ mini, sha, input, lifecycle, harnessRoot: executorDir })
  else if (kind === 'app-snapshot') await receiveAppSnapshot({ mini, sha, input, lifecycle })
  else await receiveBrowserSnapshot({ mini, sha, input, lifecycle, target: 'app', selectActiveRoot: (config, root) => ({ ...config, appRoot: root }) })
}

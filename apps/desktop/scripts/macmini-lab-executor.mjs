import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { miniConfiguration } from './macmini-ui-protocol.mjs'
import { runRemote } from './macmini-ui-remote.mjs'
import { receiveAppSnapshot } from './macmini-app-snapshot.mjs'
import { receiveBrowserSnapshot } from './macmini-browser-snapshot.mjs'

export async function run(request, input, executorDir) {
  if (request?.kind === 'ui') return runRemote(input, executorDir)
  const { kind, sha } = request ?? {}
  if (!['browser-snapshot', 'app-snapshot', 'app-verified-snapshot'].includes(kind) ||
    typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid snapshot entry or source commit')

  const mini = miniConfiguration({ computerName: execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(),
    homeDir: homedir(), platformName: process.platform })
  if (kind === 'browser-snapshot') await receiveBrowserSnapshot({ mini, sha, input, harnessRoot: executorDir })
  else if (kind === 'app-snapshot') await receiveAppSnapshot({ mini, sha, input })
  else await receiveBrowserSnapshot({ mini, sha, input, target: 'app', selectActiveRoot: (config, root) => ({ ...config, appRoot: root }) })
}

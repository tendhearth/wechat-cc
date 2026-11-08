// This launcher isolates daemon credentials. It is not an app-command ACL.
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const QA_IDENTIFIER = 'com.tendhearth.cc-motion-qa-20261029'

/**
 * @param {Record<string, string | undefined>} [inherited]
 * @returns {{ root: string, env: Record<string, string | undefined> & { WECHAT_STATE_DIR: string, WECHAT_CC_WORKBENCH_STATE_DIR: string, WECHAT_CC_NO_BUNDLE_MIGRATE: string } }}
 */
export function createQALaunchEnvironment(inherited = process.env) {
  const root = mkdtempSync(join(tmpdir(), 'cc-motion-native-auth-'))
  const daemon = join(root, 'daemon'), workbench = join(root, 'workbench')
  mkdirSync(daemon, { mode: 0o700 }); mkdirSync(workbench, { mode: 0o700 })
  return { root, env: { ...inherited, WECHAT_STATE_DIR: daemon, WECHAT_CC_WORKBENCH_STATE_DIR: workbench, WECHAT_CC_NO_BUNDLE_MIGRATE: '1' } }
}

export function verifyQABundle(bundle, readPlist = (file, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file], { encoding: 'utf8' }).trim()) {
  const plist = join(bundle, 'Contents/Info.plist')
  if (readPlist(plist, 'CFBundleIdentifier') !== QA_IDENTIFIER) throw Error('Refusing to launch an app without the isolated QA identifier')
  const executable = readPlist(plist, 'CFBundleExecutable')
  if (!executable || basename(executable) !== executable || ['.', '..'].includes(executable)) throw Error('Invalid QA bundle executable')
  return join(bundle, 'Contents/MacOS', executable)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin' || process.argv.length !== 3) throw Error('Usage on macOS: node launch-cc-motion-native-qa.mjs /absolute/path/to/QA.app')
  const bundle = realpathSync(process.argv[2])
  const executable = realpathSync(verifyQABundle(bundle))
  if (!executable.startsWith(join(bundle, 'Contents/MacOS') + '/')) throw Error('QA executable escapes its bundle')
  const { root, env } = createQALaunchEnvironment()
  const child = spawn(executable, [], { env, stdio: 'inherit' })
  console.log(JSON.stringify({ pid: child.pid, identifier: QA_IDENTIFIER, isolatedCredentialRoot: root }))
  child.once('error', error => { console.error(error); process.exitCode = 1 })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}

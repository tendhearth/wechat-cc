import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolveJobspawn } from '../../lib/jobspawn'
import { existsSync } from 'node:fs'

const nil = process.platform === 'win32' ? 'NUL' : '/dev/null'
const ssh = 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oPasswordAuthentication=no -oKbdInteractiveAuthentication=no -oNumberOfPasswordPrompts=0'
/** Shared by scans, checkout and fetch: repository configuration must never run code. */
export const SAFE_GIT = ['--no-pager', '-c', `core.hooksPath=${nil}`, '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false', '-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'core.gitProxy=',
  '-c', `core.sshCommand=${ssh}`, '-c', 'diff.external=', '-c', 'core.alternateRefsCommand=',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false',
  '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'protocol.allow=never',
  ...['file','http','https','ssh','git'].flatMap(p => ['-c', `protocol.${p}.allow=always`])]
export function preparationEnv(ownerConfig = false): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key === 'SSH_ASKPASS' || key === 'SSH_ASKPASS_REQUIRE') delete env[key]
  return { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: ssh, GIT_ALLOW_PROTOCOL: 'file:http:https:ssh:git', GIT_PROTOCOL_FROM_USER: '0',
    GIT_CONFIG_GLOBAL: nil, ...(ownerConfig ? {} : { GIT_CONFIG_NOSYSTEM: '1' }),
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: tmpdir() }
}
export function neutralizeFilters(keys: string): string[] {
  return keys.split('\0').filter(Boolean).flatMap(key => {
    if (!/^filter\.[^\0\r\n]+\.(clean|smudge|process|required)$/i.test(key)) throw Error('invalid_filter_config')
    return ['-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`]
  })
}
const filterQuery = ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']
export function syncFilterOverrides(cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): string[] {
  try { return neutralizeFilters(execFileSync('git', [...SAFE_GIT, ...filterQuery], { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })) }
  catch (e) { if ((e as {status?:number}).status === 1) return []; throw e }
}
export interface PreparationOptions { signal?: AbortSignal; timeoutMs?: number }
/** One deadline shared by the entire preparation, including every subprocess. */
export class Preparation {
  readonly deadline: number
  constructor(readonly options: PreparationOptions = {}) { this.deadline = Date.now() + (options.timeoutMs ?? 30_000) }
  check() {
    if (this.options.signal?.aborted) throw Error('worktree_preparation_cancelled')
    if (Date.now() >= this.deadline) throw Error('worktree_preparation_timeout')
  }
  async git(cwd: string, args: string[], input?: string, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
    this.check()
    const filters = await this.run(cwd, filterQuery).then(neutralizeFilters, e => { if (e.exitStatus === 1) return []; throw e })
    return this.run(cwd, [...filters, ...args], input, extraEnv)
  }
  private run(cwd: string, args: string[], input?: string, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
    this.check()
    const tree = resolveJobspawn({ platform: process.platform, arch: process.arch, execPath: process.execPath, env: process.env, exists: existsSync })
    if (tree.kind === 'missing' && args.includes('fetch')) return Promise.reject(Error('worktree_process_tree_unavailable'))
    return new Promise((accept, reject) => {
      const command = tree.kind === 'found' ? tree.path : 'git'
      const argv = [...SAFE_GIT, ...args]
      const child = spawn(command, tree.kind === 'found' ? ['--require-job', 'git', ...argv] : argv, { cwd, env: { ...preparationEnv(), ...extraEnv }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe','pipe','pipe'] })
      let done = false, size = 0
      const out: Buffer[] = [], err: Buffer[] = []
      const kill = () => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else {
          if (process.platform === 'win32' && tree.kind === 'missing' && child.pid) {
            const stop=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true})
            const fallback=setTimeout(()=>{stop.kill('SIGKILL');child.kill('SIGKILL')},1000)
            stop.on('error',()=>{clearTimeout(fallback);child.kill('SIGKILL')});stop.on('close',()=>{clearTimeout(fallback);child.kill('SIGKILL')});stop.unref()
            return
          }
          child.kill('SIGKILL')
        } } catch { /* already exited */ }
      }
      const finish = (error?: Error, value?: string) => {
        if (done) return
        done = true; clearTimeout(timer); this.options.signal?.removeEventListener('abort', abort)
        // A descendant may retain pipes even after git exits. Never wait for close.
        if(error || process.platform!=='win32')kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
        if (error) reject(error); else accept(value ?? '')
      }
      const abort = () => finish(Error('worktree_preparation_cancelled'))
      const timer = setTimeout(() => finish(Error('worktree_preparation_timeout')), Math.max(1, this.deadline - Date.now()))
      const collect = (list: Buffer[], data: Buffer) => {
        size += data.length
        if (size > 16 * 1024 * 1024) finish(Error('worktree_preparation_output_budget'))
        else list.push(data)
      }
      child.stdout.on('data', data => collect(out, data)); child.stderr.on('data', data => collect(err, data))
      child.on('error', error => finish(error))
      child.on('close', code => finish(code === 0 ? undefined : Object.assign(Error('worktree_git_failed'), { exitStatus: code, detail: Buffer.concat(err).toString().slice(0, 1000) }), Buffer.concat(out).toString()))
      // exit can happen before the final data events; the hard deadline still covers retained pipes.
      this.options.signal?.addEventListener('abort', abort, { once: true })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
      if (this.options.signal?.aborted) abort()
    })
  }
}

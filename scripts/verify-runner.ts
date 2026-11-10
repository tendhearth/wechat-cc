/** Supervise only verify's own subprocess tree; tests retain their existing limits. */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createVerifyProcessTree, type VerifyProcess } from './verify-process-tree'
import { resolveJobspawn } from '../src/lib/jobspawn'
import { existsSync } from 'node:fs'

export interface VerifyStepResult { status: number; timedOut: boolean }
const deadline = (name: string, fallback: number) => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a positive integer <= 2147483647 (milliseconds)`)
  return value
}

export function verifyLaunchTarget(command:string,args:string[],platform:NodeJS.Platform=process.platform,resolve=()=>resolveJobspawn({platform,arch:process.arch,execPath:process.execPath,env:process.env,exists:existsSync})) {
  if(platform!=='win32')return {command,args}
  const job=resolve()
  if(job.kind!=='found')throw Error('verify: cc-jobspawn Job Object unavailable; command not started')
  return {command:job.path,args:['--require-job',command,...args]}
}

export async function runVerifyStep(label: string, command: string, args: string[], cwd?: string, tests = false): Promise<VerifyStepResult> {
  const fileMs = deadline('CC_VERIFY_FILE_TIMEOUT_MS', 120_000)
  const silenceMs = deadline('CC_VERIFY_SILENCE_TIMEOUT_MS', 300_000)
  const token = randomUUID(), prefix = `\x1eCC_VERIFY:${token}:`
  const reporter = fileURLToPath(new URL('./verify-reporter.ts', import.meta.url))
  const argv = tests ? [...args, ...(command === 'npm' ? ['--'] : []), '--reporter=default', `--reporter=${reporter}`] : args
  let target
  try{target=verifyLaunchTarget(command,argv)}catch(err){console.error(String(err));return {status:1,timedOut:false}}
  const child = spawn(target.command, target.args, {cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide:true,
    env: {...process.env, ...(tests ? {CC_VERIFY_PROGRESS_TOKEN: token} : {})}})
  const started = performance.now(), active = new Map<string, {file: string; at: number}>()
  const table=():VerifyProcess[]|null=>{
    if(process.platform==='win32')return []
    try {
      const result=spawnSync('/bin/ps',['-axo','pid=,ppid=,lstart='],{encoding:'utf8',timeout:2_000,maxBuffer:4_000_000,windowsHide:true})
      if(result.status!==0)return null
      return result.stdout.trim().split('\n').flatMap(line=>{
        const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
        return match?[{pid:Number(match[1]),parent:Number(match[2]),birth:match[3]!}]:[]
      })
    } catch{return null}
  }
  const tree=createVerifyProcessTree(child.pid,{table,signal:(pid,signal)=>process.kill(pid,signal),report:line=>console.error(line)})
  const snapshotOwned=()=>process.platform==='win32'?[]:tree.snapshot()
  let forceFinish: (() => void) | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let finishingAt: number | undefined
  let lastOutput = started, lastFile: {file: string; at: number} | undefined, timedOut = false, stopped = false, interrupted = false
  let complete!: (result: VerifyStepResult) => void
  const completion = new Promise<VerifyStepResult>(resolve => { complete = resolve })
  forceFinish = () => complete({status:interrupted ? 130 : 1,timedOut})
  child.once('exit',()=>tree.rootExited())
  child.once('error', error => { console.error(`✗ ${label}: ${error.message}`); complete({status:1,timedOut:false}) })
  child.once('close', code => complete({status:interrupted ? 130 : stopped ? 1 : code ?? 1,timedOut}))
  const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)}s`
  const kill = () => {
    if (stopped) return
    stopped = true
    if (process.platform === 'win32') {
      // libuv retains the wrapper process HANDLE, so this cannot hit a reused
      // PID. Closing the strict Job kills its members even after launcher exit.
      child.kill('SIGKILL')
    } else {
      tree.stop()
    }
    // A daemonized descendant can retain pipes after its parent exits. Never
    // let failed cleanup turn the timeout handler itself into another hang.
    cleanupTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); forceFinish?.() }, 1000)
  }
  const consume = (stream: NodeJS.ReadableStream, output: NodeJS.WriteStream) => {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      lastOutput = performance.now()
      pending += chunk
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        if (!line.startsWith(prefix)) { output.write(line + '\n'); continue }
        try {
          const event = JSON.parse(line.slice(prefix.length)) as {event?: string; file?: string; project?: string; id?: string}
          if (event.event === 'finished') { finishingAt ??= performance.now(); continue }
          if (typeof event.file !== 'string') continue
          const key = event.id ?? `${event.project ?? ''}\0${event.file}`
          if (event.event === 'start') {
            if (active.size === 0) snapshotOwned()
            if (!active.has(key)) active.set(key, {file:event.file,at:performance.now()})
          }
          else if (event.event === 'end') { active.delete(key); lastFile = {file:event.file,at:performance.now()} }
        } catch { output.write(line + '\n') /* ordinary test output cannot break supervision */ }
      }
      if (pending.length > 64_000) { output.write(pending.slice(0, -64_000)); pending = pending.slice(-64_000) }
    })
    stream.on('end', () => { if (pending && !pending.startsWith(prefix)) output.write(pending) })
  }
  consume(child.stdout, process.stdout); consume(child.stderr, process.stderr)
  snapshotOwned()
  const timer = setInterval(() => {
    if (stopped) return
    snapshotOwned()
    // Bun may have delivered stream closure before its ChildProcess close
    // listener. An exited process plus two drained/closed pipes is equivalent.
    if (child.exitCode !== null && (child.stdout.readableEnded || child.stdout.destroyed) && (child.stderr.readableEnded || child.stderr.destroyed)) {
      complete({status:child.exitCode,timedOut:false}); return
    }
    const hanging = [...active.values()].find(file => performance.now() - file.at >= fileMs)
    const silent = performance.now() - lastOutput >= silenceMs
    const teardownAt = finishingAt ?? (active.size === 0 ? lastFile?.at : undefined)
    const finishing = teardownAt !== undefined && performance.now() - teardownAt >= fileMs
    if (!hanging && !silent && !finishing) return
    timedOut = true
    console.error(`  子进程 pid=${child.pid ?? '?'} exit=${child.exitCode ?? 'running'} stdoutClosed=${child.stdout.destroyed || child.stdout.readableEnded} stderrClosed=${child.stderr.destroyed || child.stderr.readableEnded}`)
    console.error(`\n✗ verify timeout / 超时: ${label} (${seconds(started)}); ${hanging ? `单文件超过 ${fileMs}ms` : finishing ? `测试收尾超过 ${fileMs}ms` : `阶段无新输出超过 ${silenceMs}ms`}`)
    for (const file of active.values()) console.error(`  正在跑: ${file.file} (${seconds(file.at)})`)
    if (!active.size) console.error(lastFile ? `  最近结束: ${lastFile.file} (${seconds(lastFile.at)} 前); 等待测试进程收尾` : '  尚无测试文件进度; 等待测试运行器/收集阶段')
    kill()
  }, Math.min(1000, Math.max(10, Math.min(fileMs, silenceMs) / 4)))
  const interrupt = () => { interrupted = true; console.error(`\n✗ verify interrupted: ${label}`); kill() }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  try {
    return await completion
  } finally {
    clearInterval(timer)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
  }
}

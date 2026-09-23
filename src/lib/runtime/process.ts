/**
 * runtime/process.ts — 子进程:Bun 上走 `Bun.spawn` / `Bun.spawnSync`,Node 上走 node:child_process。
 *
 * 接口按 Bun 的 Subprocess 的子集照抄:`stdout` / `stderr` 是 Web ReadableStream(Node 用
 * `Readable.toWeb` 转),`stdin` 是 write/end 的 sink,`exited` 是退出码的 Promise。默认
 * stdio 也按 Bun 的来(stdin ignore / stdout pipe / stderr inherit),调用方都是显式写的。
 * Bun 上返回的就是 Bun 的 Subprocess 本体,零开销。
 */
import type {Readable, Writable} from 'node:stream'

export type Stdio = 'pipe' | 'ignore' | 'inherit'
export interface SpawnOptions {
  /** Windows 上不弹控制台窗口(subsystem=2 前提);两条路都默认带上。 */
  windowsHide?: boolean
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
}
export interface StdinSink { write(chunk: string | Uint8Array): unknown; end(): unknown; flush?(): unknown }
export interface Subprocess {
  readonly pid: number
  readonly stdin: StdinSink | null
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}
export interface SpawnSyncResult { exitCode: number | null; stdout: Buffer; stderr: Buffer }

const isBun = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

export function spawn(cmd: string[], options: SpawnOptions = {}): Subprocess {
  if (isBun()) {
    const bun = (globalThis as unknown as { Bun: { spawn: (cmd: string[], options: SpawnOptions) => Subprocess } }).Bun
    return bun.spawn(cmd, { windowsHide: true, ...options })
  }
  const cp = require('node:child_process') as typeof import('node:child_process')
  const {Readable} = require('node:stream') as typeof import('node:stream')
  const [bin, ...args] = cmd
  if (!bin) throw new Error('spawn: empty command')
  const child = cp.spawn(bin, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv | undefined,
    stdio: [options.stdin ?? 'ignore', options.stdout ?? 'pipe', options.stderr ?? 'inherit'],
    // Windows 上 daemon 跑在 subsystem=2(无控制台窗口),子进程不能弹窗 —— 见 spawn-windowshide.test.ts。
    windowsHide: true,
  })
  const exited = new Promise<number>(resolve => {
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 + signalNumber(signal) : 1)))
    child.once('error', () => resolve(1))
  })
  const toWeb = (stream: Readable | null): ReadableStream<Uint8Array> | null => stream ? (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>) : null
  const sink = (stream: Writable | null): StdinSink | null => stream ? { write: chunk => stream.write(chunk), end: () => stream.end(), flush: () => undefined } : null
  return {
    pid: child.pid ?? -1,
    stdin: sink(child.stdin),
    stdout: toWeb(child.stdout),
    stderr: toWeb(child.stderr),
    exited,
    kill: signal => { child.kill(signal as NodeJS.Signals | number | undefined) },
  }
}

export function spawnSync(cmd: string[], options: Pick<SpawnOptions, 'cwd' | 'env'> = {}): SpawnSyncResult {
  if (isBun()) {
    const bun = (globalThis as unknown as { Bun: { spawnSync: (cmd: string[], options: object) => { exitCode: number | null; stdout: Buffer; stderr: Buffer } } }).Bun
    const result = bun.spawnSync(cmd, { windowsHide: true, ...options })
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout ?? []), stderr: Buffer.from(result.stderr ?? []) }
  }
  const cp = require('node:child_process') as typeof import('node:child_process')
  const [bin, ...args] = cmd
  if (!bin) throw new Error('spawnSync: empty command')
  const result = cp.spawnSync(bin, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv | undefined, windowsHide: true })
  return { exitCode: result.status, stdout: Buffer.from(result.stdout ?? []), stderr: Buffer.from(result.stderr ?? []) }
}

function signalNumber(signal: NodeJS.Signals): number {
  const {constants} = require('node:os') as typeof import('node:os')
  return constants.signals[signal] ?? 0
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * 起一个 `codex app-server` 子进程的唯一接缝(工作台与对话侧共用,B1 2026-10-25)。
 *
 * 生产里就是 node:child_process 的 spawn;单独成一个模块,是为了 daemon e2e 能把**这一个**模块换成照剧本说话的
 * 假 app-server(src/test-support/executors/codex-scripted.ts),而不必 mock 整个 node:child_process
 * —— daemon 里别的子进程(探测版本、ffmpeg……)照常起。
 */
export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => ChildProcessWithoutNullStreams

export const spawnCodexAppServerProcess: CodexAppServerSpawn = (command, args, options) =>
  spawn(command, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

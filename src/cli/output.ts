// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分 Task 1),行为不变。
import { writeFileSync } from 'node:fs'
// Write potentially-large JSON to a sibling file, return the small
// envelope {ok, out_file, bytes} via stdout. Fixes the desktop sessions
// browser truncation: bun --compile binaries lose bytes when emitting
// MB-sized payloads to a pipe (observed across console.log, process.stdout
// .write, and chunked fs.writeSync — the kernel pipe buffer fills, the
// receiver drains line-by-line, and the producer drops writes on
// EAGAIN). Tauri-side reads from disk instead. CLI consumers that pass
// --out-file get the file route; everyone else (terminal users, tests)
// falls back to plain stdout via console.log.
export function emitJson(data: unknown, outFile: string | undefined): void {
  if (!outFile) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  // Sync write to a regular file: no pipe buffer, no async stdio path.
  const body = JSON.stringify(data, null, 2)
  writeFileSync(outFile, body, 'utf8')
  console.log(JSON.stringify({ ok: true, out_file: outFile, bytes: body.length }))
}


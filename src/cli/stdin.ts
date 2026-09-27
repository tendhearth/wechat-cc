// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分 Task 1),行为不变。
/** Read stdin to EOF. Returns '' immediately if stdin is a TTY. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

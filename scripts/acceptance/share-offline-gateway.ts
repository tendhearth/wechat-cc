/** Fail closed: offline boot may probe providers, but never calls a model. */
import { writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.WECHAT_STATE_DIR
if (!dir?.startsWith('/private/tmp/') || !dir.includes('/acc/state/') || !existsSync(join(dir, '.acceptance-only')) || !existsSync(join(dir, '.share-acceptance'))) throw Error('marked share state required')
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
  appendFileSync(join(dir, 'offline-model-attempts.jsonl'), '{"blocked":true}\n')
  return Response.json({ error: { message: 'offline acceptance: model disabled' } }, { status: 503 })
} })
writeFileSync(join(dir, 'gateway.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}` }))
process.on('SIGTERM', () => { server.stop(true); process.exit(0) })

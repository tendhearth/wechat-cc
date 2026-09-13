/** Owned native attachment proof. No real model API, credentials, MCP or channel.
 * Requires macOS loopback sandbox. Run: bun scripts/workbench-native-attachments-smoke.ts --run */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, gunzipSync } from 'node:zlib'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentAttachment, AgentEvent, AgentProvider, AgentSession } from '../src/core/agent-provider'
import { createClaudeAgentProvider } from '../src/core/claude-agent-provider'
import { createWorkbenchCodexProvider } from '../src/core/workbench/codex-app-server'
import { workbenchClaudeOptions } from '../src/daemon/bootstrap/wire-workbench'
import { TIER_PROFILES } from '../src/core/user-tier'
import { findCodexBinary } from '../src/lib/find-codex-binary'

if (!process.argv.includes('--run')) { console.log('Run with --run for owned, loopback-only native attachment fixtures.'); process.exit(0) }
if (process.platform !== 'darwin') throw Error('macOS sandbox-exec is required for this isolated fixture.')
const claudeBinary = Bun.which('claude'), codexBinary = findCodexBinary()
assert(claudeBinary && codexBinary, 'Install Claude and Codex to run this fixture.')
const versions = { claude: execFileSync(claudeBinary, ['--version'], { encoding: 'utf8' }).trim(), codex: execFileSync(codexBinary, ['--version'], { encoding: 'utf8' }).trim() }
const area = await realpath(await mkdtemp(join(tmpdir(), 'cc-native-attachments-')))
const safePath = process.env.PATH ?? '/usr/bin:/bin'
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, { PATH: safePath, LANG: 'en_US.UTF-8', TERM: 'dumb', HOME: area, TMPDIR: area })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const profile = '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))'
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// Deterministic valid PNG pixels and a tiny complete PDF, not user media.
function png(red: number, green: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc(16 * 49)
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const at = y * 49 + 1 + x * 3; pixels[at] = red; pixels[at + 1] = green }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
function pdf(): Buffer {
  const stream = 'BT /F1 12 Tf 10 20 Td (Owned PDF fixture) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let text = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const start = Buffer.byteLength(text)
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
  return Buffer.from(text + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`)
}
const materials: AgentAttachment[] = []
for (const [name, mime, bytes] of [['a.png', 'image/png', png(240, 0)], ['b.png', 'image/png', png(0, 240)], ['owned.pdf', 'application/pdf', pdf()]] as const) {
  const path = join(area, name); await writeFile(path, bytes)
  materials.push({ name, mime, path, sha256: digest(bytes), data: bytes.toString('base64') })
}
const [imageA, imageB, document] = materials as [AgentAttachment, AgentAttachment, AgentAttachment]
// Prove adapters deliver accepted bytes without reopening image snapshot paths.
await rm(imageA.path); await rm(imageB.path)
const requests: Record<'codex' | 'claude', any[]> = { codex: [], claude: [] }
let holdNextCodex = false, releaseResponse: (() => void) | undefined, held = false
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks), body = JSON.parse((request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString() || '{}')
  const codex = request.url?.startsWith('/codex/')
  if (!codex && !request.url?.includes('/v1/messages')) { response.setHeader('content-type', 'application/json'); response.end(request.url?.includes('count_tokens') ? '{"input_tokens":100}' : '{}'); return }
  const provider = codex ? 'codex' : 'claude'; requests[provider].push(body)
  const id = `owned-${provider}-${requests[provider].length}`
  if (codex && holdNextCodex) {
    holdNextCodex = false; held = true
    await new Promise<void>(resolve => { releaseResponse = resolve })
  }
  response.setHeader('content-type', 'text/event-stream')
  const event = (value: any) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
  if (codex) {
    const item = { id: `message-${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OWNED_ATTACHMENT_COMPLETE', annotations: [] }] }
    event({ type: 'response.created', response: { id } }); event({ type: 'response.output_item.added', output_index: 0, item }); event({ type: 'response.output_item.done', output_index: 0, item })
    event({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } })
  } else {
    event({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OWNED_ATTACHMENT_COMPLETE' } }); event({ type: 'content_block_stop', index: 0 })
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }); event({ type: 'message_stop' })
  }
  response.end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const wrappers = { codex: join(area, 'codex'), claude: join(area, 'claude') }
for (const [key, binary] of [['codex', codexBinary], ['claude', claudeBinary]] as const) {
  await writeFile(wrappers[key], `#!/bin/sh\nexport CODEX_HOME=${quote(area)}\nexport HOME=${quote(area)}\nexec /usr/bin/sandbox-exec -p ${quote(profile)} ${quote(binary)} "$@"\n`); await chmod(wrappers[key], 0o700)
}
await mkdir(join(area, '.claude'))
await writeFile(join(area, 'config.toml'), `model='mock-model'\nmodel_provider='fixture'\n[model_providers.fixture]\nname='Owned attachment fixture'\nbase_url='http://127.0.0.1:${port}/codex/v1'\nwire_api='responses'\nrequires_openai_auth=false\nsupports_websockets=false\n[features]\nplugins=false\napps=false\nhooks=false\n`)
const claudeEnv = { HOME: area, CLAUDE_CONFIG_DIR: join(area, '.claude'), XDG_CONFIG_HOME: join(area, '.config'), ANTHROPIC_API_KEY: 'owned-attachment-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/claude`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' }
const options = () => workbenchClaudeOptions({ cwd: area, model: 'claude-sonnet-4-6', pathToClaudeCodeExecutable: wrappers.claude, env: claudeEnv }, 'Only the owned attachment fixture.', async () => ({ behavior: 'deny', message: 'Fixture does not permit tools.' }))
function blocks(provider: 'codex' | 'claude', body: any): any[] { return (body[provider === 'codex' ? 'input' : 'messages'] ?? []).filter((message: any) => message.role === 'user').flatMap((message: any) => Array.isArray(message.content) ? message.content : []) }
function latestUserBody(provider: 'codex' | 'claude', body: any) {
  const key = provider === 'codex' ? 'input' : 'messages'
  return { [key]: (body[key] ?? []).filter((message: any) => message.role === 'user').slice(-1) }
}
function hasImage(provider: 'codex' | 'claude', body: any, attachment: AgentAttachment): boolean {
  return blocks(provider, body).some(block => {
    const data = provider === 'codex' && block.type === 'input_image' ? /^data:image\/[^;]+;base64,(.+)$/.exec(block.image_url)?.[1]
      : provider === 'claude' && block.type === 'image' && block.source?.type === 'base64' ? block.source.data : undefined
    return typeof data === 'string' && digest(Buffer.from(data, 'base64')) === attachment.sha256
  })
}
function hasPdf(body: any) { return blocks('claude', body).some(block => block.type === 'document' && block.source?.type === 'base64' && block.source.media_type === 'application/pdf' && digest(Buffer.from(block.source.data, 'base64')) === document.sha256) }
async function collect(session: AgentSession, text: string, attachments: readonly AgentAttachment[]) {
  const events: AgentEvent[] = [], deadline = setTimeout(() => { void session.close() }, 30_000)
  try { for await (const event of session.dispatch(text, attachments)) events.push(event) }
  finally { clearTimeout(deadline) }
  assert(!events.some(event => event.kind === 'error'), 'native attachment turn failed')
  const results = events.filter(event => event.kind === 'result'); assert.equal(results.length, 1)
  assert(events.some(event => event.kind === 'text' && event.text.includes('OWNED_ATTACHMENT_COMPLETE')))
  return results[0]!.sessionId
}
const context = { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict' as const, chatId: 'owned-attachment-task', requestPermission: async () => false, workbenchTimeline: true }
async function checkProvider(name: 'codex' | 'claude', provider: AgentProvider) {
  const spawn = (resumeSessionId?: string) => provider.spawn({ alias: 'owned-attachments', path: area }, { ...context, resumeSessionId })
  let session = await spawn()
  try {
    const nativeId = await collect(session, 'Inspect image A and the attached file.', [imageA, document])
    assert(hasImage(name, latestUserBody(name, requests[name].at(-1)), imageA), `${name} initial request has no actual image A bytes`)
    if (name === 'claude') assert(hasPdf(requests.claude.at(-1)), 'Claude production adapter did not forward the PDF bytes')
    else { assert(JSON.stringify(blocks(name, requests.codex.at(-1))).includes(document.path)); assert(!JSON.stringify(requests.codex.at(-1)).includes(document.data!)) }
    assert.equal(await collect(session, '', [imageB]), nativeId)
    assert(hasImage(name, requests[name].at(-1), imageA) && hasImage(name, requests[name].at(-1), imageB), `${name} continuation lost image bytes`)
    assert(hasImage(name, latestUserBody(name, requests[name].at(-1)), imageB), `${name} image-only continuation did not append image B`)
    await session.close(); session = await spawn(nativeId)
    assert.equal(await collect(session, 'Continue from the same session.', [imageA]), nativeId)
    assert(hasImage(name, requests[name].at(-1), imageB), `${name} resumed history lost image B`)
    assert(hasImage(name, latestUserBody(name, requests[name].at(-1)), imageA), `${name} resumed input did not append image A`)
    if (name === 'codex') {
      held = false; holdNextCodex = true
      const done = collect(session, 'Begin an active turn.', [imageA])
      const deadline = Date.now() + 10_000
      while (!held) { assert(Date.now() < deadline, 'native steer fixture never became active'); await new Promise(resolve => setTimeout(resolve, 20)) }
      await session.steer!('', [imageB]); releaseResponse?.()
      assert.equal(await done, nativeId)
      assert(hasImage('codex', latestUserBody('codex', requests.codex.at(-1)), imageB), 'accepted native steer did not deliver image B as visual input')
      await assert.rejects(session.steer!('stale attachment', [imageB]), /no_active_turn/)
    }
    return { provider: name, initialImage: true, imageOnlyContinuation: true, continuationImages: true, resumedImageHistory: true, resumedNewImage: true, visualBytesIndependentOfPath: true, sameNativeSession: true, ...(name === 'claude' ? { nativePdf: true } : { activeImageOnlySteer: true, staleSteerRejected: true, ordinaryFileIsReference: true }) }
  } finally { releaseResponse?.(); await session.close() }
}
try {
  // Prove the installed native CLI accepts PDF blocks before enabling that
  // mapping in production. Retained as a focused compatibility probe.
  async function* pdfInput(): AsyncIterable<SDKUserMessage> { yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: document.data! } }, { type: 'text', text: 'Inspect this owned PDF.' }] } } }
  const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 30_000)
  const raw = query({ prompt: pdfInput(), options: { ...options(), abortController: abort, maxTurns: 1 } })
  try { for await (const message of raw) if (message.type === 'result') break }
  finally { clearTimeout(deadline); raw.close() }
  assert(hasPdf(requests.claude.at(-1)), 'installed native CLI did not forward the PDF content block')
  console.log(JSON.stringify({ probe: 'claude-native-pdf', forwardedExactBytes: true, versions }))
  if (!process.argv.includes('--pdf-probe')) {
    console.log(JSON.stringify(await checkProvider('codex', createWorkbenchCodexProvider({ codexPathOverride: wrappers.codex, model: 'mock-model', rpcTimeoutMs: 10_000 }))))
    console.log(JSON.stringify(await checkProvider('claude', createClaudeAgentProvider({ sdkOptionsForProject: options }))))
  }
} finally {
  releaseResponse?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(area, { recursive: true, force: true })
}

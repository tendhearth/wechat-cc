/** Offline JSON-RPC stdio peer. No network, credentials, or daemon. */
import { createInterface } from 'node:readline'
// Delayed polite exit gives the revocation test a deterministic HTTP 401 window.
process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 150) })
const send = (value: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value as object }) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'offline-bridge', version: '1' } } })
  else if (message.method === 'notifications/initialized') setTimeout(() => send({ method: 'notifications/message', params: { level: 'info', data: 'idle notification' } }), 25)
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] } })
  else if (message.method === 'tools/call') {
    if (message.params.name === 'exit') process.exit(0)
    send({ method: 'notifications/message', params: { level: 'info', data: 'offline notification' } })
    send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }] } })
  }
}

import type { AgentEvent } from './agent-provider'

/** A retained epoch must not accumulate an unbounded backlog behind a slow UI. */
export class ClaudeWorkbenchEvents implements AsyncIterable<AgentEvent> {
  private buffer: { event: AgentEvent; bytes: number }[] = []
  private bytes = 0
  private waiting?: (value: IteratorResult<AgentEvent>) => void
  private closed = false
  private claimed = false
  constructor(private readonly eventLimit = 2048, private readonly byteLimit = 8_000_000) {
    if (eventLimit < 1 || byteLimit < 64) throw new Error('claude_runtime_event_budget_invalid')
  }
  push(event: AgentEvent) {
    if (this.closed) return
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting({ value: event, done: false }); return }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (this.buffer.length >= this.eventLimit || this.bytes + bytes > this.byteLimit) throw new Error('claude_runtime_event_buffer_limit')
    this.buffer.push({ event, bytes }); this.bytes += bytes
  }
  fail(error: Error) {
    // Keep the error observable even if normal delivery exhausted its budget.
    const message = error.message.slice(0, Math.min(1024, Math.floor((this.byteLimit - 32) / 6)))
    const event: AgentEvent = { kind: 'error', message }, bytes = Buffer.byteLength(JSON.stringify(event))
    while (this.buffer.length && (this.buffer.length >= this.eventLimit || this.bytes + bytes > this.byteLimit)) this.bytes -= this.buffer.shift()!.bytes
    try { this.push(event) } finally { this.end() }
  }
  end() {
    this.closed = true
    if (this.waiting) { this.waiting({ value: undefined, done: true }); this.waiting = undefined }
  }
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.claimed) throw new Error('claude_runtime_single_consumer_required')
    this.claimed = true
    return {
      next: () => {
        const next = this.buffer.shift()
        if (next) { this.bytes -= next.bytes; return Promise.resolve({ value: next.event, done: false }) }
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        if (this.waiting) return Promise.reject(new Error('claude_runtime_concurrent_next_unsupported'))
        return new Promise(resolve => { this.waiting = resolve })
      },
      return: async () => { this.end(); this.buffer = []; this.bytes = 0; return { value: undefined, done: true } },
    }
  }
}

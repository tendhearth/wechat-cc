import { AsyncLocalStorage } from 'node:async_hooks'

// Trusted delivery code supplies the original text; never infer it by stripping user/model text.
const scope = new AsyncLocalStorage<{ text: string; displayed: string }>()

export function withParticipantLabel<T>(text: string, label: string | undefined, send: (displayed: string) => T): T {
  const displayed = label ? `[${label}] ${text}` : text
  return scope.run({ text, displayed }, () => send(displayed))
}

/** WeChat stores the body; an outbound that falls back to App also receives the body. */
export function unprefixedReplyText(displayed: string): string {
  const current = scope.getStore()
  return current?.displayed === displayed ? current.text : displayed
}

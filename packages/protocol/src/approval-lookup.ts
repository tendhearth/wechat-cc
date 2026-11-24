// A navigational receipt. The approval screen fetches the current request
// with its normal owner credentials and binds any decision to the live run.
const lookupText = '请打开审批页查看这项请求。'
const lookupPattern = /^请打开审批页查看这项请求。\n\[打开审批页\]\((\/matter\/([a-f0-9]{8})\/decide\?request=([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}))\)$/

export function approvalLookupReply(taskId: string, requestId: string): string {
  return `${lookupText}\n[打开审批页](/matter/${taskId}/decide?request=${requestId})`
}

export function parseApprovalLookupReply(text: string) {
  const match = lookupPattern.exec(text)
  if (match?.[0] !== text) return null
  return { text: lookupText, href: match[1]!, taskId: match[2]!, requestId: match[3]! }
}

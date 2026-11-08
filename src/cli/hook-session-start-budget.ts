/** Production budgets stay fixed; only isolated tests can inject a longer one. */
export function sessionStartBudget(env: Record<string, string | undefined> = process.env) {
  const injected = Number(env.WECHAT_CC_TEST_SESSION_START_BUDGET_MS)
  const requestMs = env.NODE_ENV === 'test' && Number.isFinite(injected) && injected > 0
    ? injected : 650
  return { requestMs, softMs: requestMs + 150, hardMs: requestMs + 250 }
}

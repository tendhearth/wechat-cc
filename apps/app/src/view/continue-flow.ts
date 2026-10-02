/**
 * 会话读页「接着做」的两段流程(spec 2026-10-01-tendhearth-continue-sessions §4.4;final fix Q1–Q3)。
 * 纯逻辑,不碰 React:页面只照着做。
 */

export type PreviewRun<T> = { current: false } | { current: true; ok: true; value: T } | { current: true; ok: false }

/**
 * 问预览的那一路:只认最新一次。最新一次还在问 ⇒ onChecking(true)(确认按钮转圈、不能点,Q1);
 * 最新一次回来 / 作废 ⇒ onChecking(false)。旧的那次回来时不算数,也不提前放开按钮。
 */
export function previewTracker(onChecking: (checking: boolean) => void) {
  let seq = 0
  return {
    async run<T>(ask: () => Promise<T>): Promise<PreviewRun<T>> {
      const my = ++seq
      onChecking(true)
      try {
        const value = await ask()
        if (my !== seq) return { current: false }
        onChecking(false)
        return { current: true, ok: true, value }
      } catch {
        if (my !== seq) return { current: false }
        onChecking(false)
        return { current: true, ok: false }
      }
    },
    /** 换会话 / 离开页面:在路上的那次作废,按钮放开。 */
    cancel(): void { seq++; onChecking(false) },
  }
}

export type AdoptResult = 'ok' | 'busy' | { error: string }
export type AdoptStep =
  | { kind: 'navigate'; matterId: string }
  | { kind: 'stay' }
  | { kind: 'reopen' }
  | { kind: 'fail'; code: string }

/**
 * 「接着做」/「打开这件事」的 POST 回来之后做什么。
 * keyStillCurrent:页面还是发请求时那个会话吗 —— 换了就什么都不做,不跳到旧会话那件事(Q3)。
 * redirected:这一次已经是「接过了 ⇒ 打开」绕过来的;再说接过了就不再绕,落到中性的那一句(Q2)。
 */
export function adoptStep(r: AdoptResult, matterId: string | null, o: { keyStillCurrent: boolean; redirected: boolean }): AdoptStep {
  if (!o.keyStillCurrent) return { kind: 'stay' }
  if (r === 'busy') return { kind: 'stay' } // 同一个请求还在路上(本机)
  if (r === 'ok' && matterId) return { kind: 'navigate', matterId }
  const code = r === 'ok' ? 'unknown' : r.error
  if (code === 'session_managed' && !o.redirected) return { kind: 'reopen' }
  return { kind: 'fail', code }
}

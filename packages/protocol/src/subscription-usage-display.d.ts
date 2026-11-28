type UsageLanguage = 'zh-Hans' | 'en'
type UsageWindow = { usedPercent: number; resetsAt: number | null; durationMins: number | null }

export function usageResetTime(resetsAt: number | null, now: number, lang?: UsageLanguage): string | null
export function usageWindowDisplay(usage: UsageWindow, now: number, lang?: UsageLanguage): {
  label: string
  percent: number
  warning: boolean
}

import type { Lang } from './index'

// Short labels for the approved phone hierarchy; policy and action text stays in the shared tables.
const en = {
  memory: 'Memory',
  facts: 'Remembered',
  portrait: 'CC’s view of you',
  portraitNote: 'CC’s interpretation, separate from the factual records above.',
  withdrawn: 'Taken back ({n})',
  withCC: 'With CC',
  computer: 'Your computer',
  preferences: 'Preferences',
  connections: 'Connections',
  sessions: 'Computer sessions',
  devices: 'Devices',
  rename: 'Rename this phone',
  jobs: 'Scheduled things',
  activity: 'Recent activity',
  about: 'About CC',
  licences: 'Open-source licences',
  welcome: 'CC',
  welcomeBody: 'Close by, through your computer at home.',
  family: 'Tendhearth · Nate Gu & Co.',
} as const
const zh: Record<keyof typeof en, string> = {
  memory: '记忆',
  facts: '记住的',
  portrait: 'CC 眼中的你',
  portraitNote: 'CC 的推测，与上面的事实记录分开。',
  withdrawn: '收回的话（{n}）',
  withCC: '和 CC',
  computer: '家里的电脑',
  preferences: '偏好',
  connections: '连接',
  sessions: '电脑会话',
  devices: '设备',
  rename: '给这台手机改名',
  jobs: '定时的事',
  activity: '最近的事',
  about: '关于 CC',
  licences: '开源许可',
  welcome: 'CC',
  welcomeBody: '和家里的电脑连起来。',
  family: 'Tendhearth · Nate Gu & Co.',
}
export function secondaryText(lang: Lang, key: keyof typeof en, vars?: Record<string, string | number>): string {
  const text = (lang === 'zh-Hans' ? zh : en)[key]
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match) : text
}

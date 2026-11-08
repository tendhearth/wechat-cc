import type { Lang } from './index'

const en = {
  handoff: 'Delegate',
  summary: 'CC’s summary',
  earlier: 'Earlier conversation',
  process: 'Process and execution',
  options: 'Project and execution',
} as const
const zh: Record<keyof typeof en, string> = {
  handoff: '交办',
  summary: 'CC 的概括',
  earlier: '之前的对话',
  process: '过程与执行信息',
  options: '项目与执行方式',
}

export const conversationText = (lang: Lang, key: keyof typeof en): string => (lang === 'zh-Hans' ? zh : en)[key]

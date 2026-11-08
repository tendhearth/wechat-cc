/** Structured provenance wins; text recognition is deliberately limited to whole maintenance receipts. */
const ROUTINE_SPEECH = new Set(['upgrade_notice', 'restart_notice', 'boot_notice'])
export function isRoutineSpeech(kind: string): boolean { return ROUTINE_SPEECH.has(kind) }

/** Legacy rows lack provenance. Keep mixed records and user decisions/promises/development work. */
export function isRoutineTopicText(text: string): boolean {
  const s = text.normalize('NFKC').trim()
  if (!s || /决定|承诺|答应|待|尚未|仍|未完成|下一步|根因|漏洞|修复|需求|设计|实现|录制|演示|验收|回滚|because|todo|fix|implement|decid|promise/i.test(s)) return false
  const clauses = s.replace(/\.{2,}/g, ';').split(/[\n;；。,…，]+/).map(x => x.trim()).filter(Boolean)
  return clauses.length > 0 && clauses.every(c =>
    /^(?:CC[ :：]*)?(?:CLI[ :：]*)?(?:Codex|Claude(?: Code)?|cursor-agent|agy)\s*(?:已)?(?:自动)?(?:升至|升级(?:至|到)?|更新(?:至|到)?)\s*v?\d+(?:\.\d+)+(?:\s*(?:自检(?:已)?(?:过|通过)|升级完成|成功))*[!！]?$/i.test(c) ||
    /^(?:CC\s*)?(?:服务升级至\s*DB|(?:数据库|DB)\s*(?:已)?迁移(?:至|到)?)\s*v?\d+[!！]?$/i.test(c) ||
    /^(?:(?:CC|wechat-cc)\s+)?self\s+deploy\s*(?:已)?(?:完成|成功|通过|passed|ok)[!！]?$/i.test(c) ||
    /^(?:(?:CC|wechat-cc)\s+)?(?:self\s+)?(?:soak|selftest)\s*(?:已)?(?:完成|成功|通过|passed|ok)[!！]?$/i.test(c) ||
    /^(?:便宜模型|cheap model)\s*(?:已)?(?:切至|切换至|切到)\s*(?:agy|codex|claude|cursor-agent)$/i.test(c),
  )
}

export function isTopicMessage(m: { source: string; direction: string; text: string }): boolean {
  if (m.source === 'workbench') return false
  if (m.direction === 'in') return !!m.text.trim()
  if (m.source.startsWith('speech:') && isRoutineSpeech(m.source.slice(7))) return false
  return !!m.text.trim() && !isRoutineTopicText(m.text)
}

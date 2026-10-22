/**
 * 记忆目录里每样东西是哪一类(第三批 3e,设计稿 docs/superpowers/specs/2026-10-23-memory-source-vs-derived-design.md)。
 *
 * - source:源,丢了就没了(主人、CC、nightly 写的)。源一变,生成物就过期(第 2 步接 writeMemorySource)。
 * - derived:生成物,能从源重算(合成任务写)。合成只吃源(第 3 步),主人怎么改它等主人在稿 §5 的 A / B 里选。
 * - queue:中间态,消费即删(today-draft)。
 * - ledger:账,只追加、不重算(日志、出处、归档、墓碑、内部状态)。
 *
 * 名单就是这一张表;认不出的(notes/ 下主人新建的文件之类)按 source 算 —— 宁可当源保护起来,也不当生成物覆盖掉。
 */
export type MemoryArtifactKind = 'source' | 'derived' | 'queue' | 'ledger'

export const MEMORY_ARTIFACTS: Readonly<Record<string, { kind: MemoryArtifactKind; why: string }>> = {
  'memory.md': { kind: 'source', why: '每轮注入的那份;nightly 整理、主人纠正 / 编辑' },
  'profile.md': { kind: 'source', why: 'CC 自己的笔记(MCP memory_write);gardener 会压缩' },
  'corrections.md': { kind: 'source', why: '主人的纠正,nightly 据此不再加回' },
  'preferences.md': { kind: 'source', why: 'CC 记下的偏好' },
  'persona.md': { kind: 'source', why: 'CC 的人设' },
  'agenda.md': { kind: 'source', why: '待办;晨报和定时也读' },
  '_overview.md': { kind: 'derived', why: 'synthesizeOverview 合成;串门当人设、快照、桌面' },
  '_profile.json': { kind: 'derived', why: 'synthesizeProfile 合成;桌面画像页' },
  'portrait.svg': { kind: 'derived', why: 'generatePortrait 从 _profile / _overview / profile 生成' },
  'portrait.json': { kind: 'derived', why: '画像的生成时间' },
  'knowledge.md': { kind: 'derived', why: 'ingest 从知识库生成;它的源不在记忆目录里' },
  'today-draft.md': { kind: 'queue', why: 'profile.md 每次写的差异,nightly 读完删' },
  'memory-log.jsonl': { kind: 'ledger', why: 'nightly 的审计日志,只追加' },
  'memory-sources.json': { kind: 'ledger', why: '整理时的出处映射(当时的消息 id)' },
  '.derived-state.json': { kind: 'ledger', why: '生成物过期标记本身' },
}

/** 相对记忆目录的路径 → 类别。notes/ 下的、认不出的 ⇒ source;墓碑 `*.deleted-*`、点开头的临时文件 ⇒ ledger。 */
export function memoryArtifactKind(relPath: string): MemoryArtifactKind {
  const p = relPath.split('\\').join('/').replace(/^\.\//, '')
  const known = MEMORY_ARTIFACTS[p]
  if (known) return known.kind
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (/\.deleted-/.test(base) || base.startsWith('.')) return 'ledger'
  return 'source'
}

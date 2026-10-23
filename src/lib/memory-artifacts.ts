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

export const MEMORY_ARTIFACTS: Readonly<Record<string, { kind: MemoryArtifactKind; why: string; synthesisInput?: false }>> = {
  'memory.md': { kind: 'source', why: '每轮注入的那份;nightly 整理、主人纠正 / 编辑' },
  'profile.md': { kind: 'source', why: 'CC 自己的笔记(MCP memory_write);gardener 会压缩' },
  // 不喂合成:每一行都复述了被纠正的那句(「主人说这条已经过时:<原话>」)—— 当素材喂进去,总览可能正好把主人撤掉的话写回来,
  // 而总览会进串门人设、带到别人的 CC 那里。它是给 nightly 的指令,不是关于主人的事实。
  'corrections.md': { kind: 'source', why: '主人的纠正,nightly 据此不再加回', synthesisInput: false },
  'preferences.md': { kind: 'source', why: 'CC 记下的偏好' },
  'persona.md': { kind: 'source', why: 'CC 的人设' },
  // 不喂合成(总览):由代码原样插成「## 你写的」一节,对外(串门)时整节去掉。要是也喂给模型,它会把主人原话换个说法写进
  // 生成的那部分,串门时就跟着出去了 —— 去掉那一节也挡不住(记忆编辑第 3 步定)。每晚整理 memory.md 照旧读它(那份不对外)。
  'owner.md': { kind: 'source', why: '主人原话:主人在记忆上加 / 改写的行;只经记忆编辑写,CC 和整理都不改', synthesisInput: false },
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
  'memory-redactions.json': { kind: 'ledger', why: '合成出口挡掉被更正之话的次数(3b 的数据)' },
}

/**
 * 合成(总览 / 画像)能不能拿它当素材(3e 记忆第 3 步):只吃源,而且不吃标了 synthesisInput: false 的(corrections.md)。
 * 生成物不喂生成物(以前只排除了 _overview.md 自己,knowledge.md 被读两遍、today-draft 和 profile.md 重复)。
 */
export function feedsSynthesis(relPath: string): boolean {
  const p = relPath.split('\\').join('/').replace(/^\.\//, '')
  return memoryArtifactKind(p) === 'source' && MEMORY_ARTIFACTS[p]?.synthesisInput !== false
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

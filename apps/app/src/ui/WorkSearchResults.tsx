import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { useState } from 'react'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection, useQuery } from '../state/hooks'
import { useBackendCtx } from '../state/BackendProvider'
import { useWork } from '../state/useWork'
import { useTerminalSessions } from '../state/useTerminal'
import { homeView } from '../view/home'
import { isMatterArchived } from '../view/status'
import { DelegationMessage } from './DelegationMessage'
import { WorkList } from './WorkList'
import { TextField } from './TextField'
import { Button } from './Button'
import { Sheet } from './Sheet'
import { space } from './tokens'
import { Txt } from './Txt'

/** Transient conversation search, including unclassified historical work and terminal sessions. */
export function WorkSearchResults({ query = '', prefix = 'all', share = false }: { query?: string; prefix?: string; share?: boolean }) {
  const lang = useLang(), zh = lang === 'zh-Hans', router = useRouter()
  const { backend } = useBackendCtx(), conn = useConnection(), work = useWork(), terminal = useTerminalSessions()
  const history = useQuery('matter-history', l => backend.matterHistory(l), { refreshOnMount: true })
  const [project, setProject] = useState(''), [state, setState] = useState(''), [archived, setArchived] = useState(false)
  const matters = (history.data ?? work.matters).filter(m => (!query || `${m.title} ${m.projectPath ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!project || m.projectPath?.toLocaleLowerCase().includes(project.toLocaleLowerCase())) && (archived || !isMatterArchived(m)))
  const matching = new Set(matters.map(m => m.id))
  const known = new Set((history.data ?? work.matters).map(m => m.id))
  const approvals = work.approvals.filter(a => matching.has(a.taskId) || (!known.has(a.taskId) && !project && (!query || a.summary.toLocaleLowerCase().includes(query.toLocaleLowerCase()))))
  // Archived rows are searchable references; opening retains the original archived matter identity.
  const view = homeView({ ...work, approvals, matters: matters.map(m => isMatterArchived(m) ? { ...m, status: 'done', archivedAt: null } : m), terminal: (terminal.sessions ?? []).filter(s => (!query || `${s.project} ${s.last_summary}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!project || s.project?.toLocaleLowerCase().includes(project.toLocaleLowerCase()))), known: backend.mode === 'demo' || conn.state === 'online', now: Date.now(), lang, backWindowMs: null, keepStaleWaiting: true })
  const rows = view.groups.flatMap(g => g.rows).filter(r => (!state || r.status === state) && (!share || r.source === 'matter'))
  return <View style={{ gap: space.s }}>
    <Sheet title={zh ? '筛选事项' : 'Filter work'} testID="search-work-filters">
      <TextField testID="search-project" accessibilityLabel={zh ? '项目' : 'Project'} placeholder={zh ? '项目或文件夹' : 'Project or folder'} value={project} onChangeText={setProject} />
      {[['', zh ? '所有状态' : 'Any state'], ['waiting', zh ? '等你' : 'Waiting for you'], ['working', zh ? '在做' : 'Working'], ['done', zh ? '做完了' : 'Done'], ['replied', zh ? '带回来了' : 'Returned'], ['failed', zh ? '没做成' : 'Failed'], ['stopped', zh ? '停下了' : 'Stopped']].map(([value, label]) => <Button key={value} testID={`search-state-${value || 'all'}`} kind="secondary" label={`${state === value ? '✓ ' : ''}${label}`} onPress={() => setState(value!)} />)}
      <Button testID="search-archived" kind="secondary" label={archived ? (zh ? '含归档' : 'Including archived') : (zh ? '查看归档' : 'Include archived')} onPress={() => setArchived(v => !v)} />
    </Sheet>
    <Txt role="caption" tone="inkSoft">{zh ? '以前交办的事 · 按原时间保留' : 'Previously delegated · Original dates retained'}</Txt>
    {/* Preserve loading/stale/empty semantics from the former All page. */}
    <WorkList view={{ ...view, groups: [] }} prefix={prefix} known={history.data !== undefined} loading={history.loading} error={history.error} onRetry={() => void history.refresh()} emptyText={rows.length ? null : t(lang, 'together.empty')} />
    {rows.map(row => share ? <Button key={`${row.source}:${row.id}`} testID={`row-${row.source}-${row.id}`} kind="secondary" label={row.title} onPress={() => router.push(`/share?matter=${encodeURIComponent(row.id)}`)} /> : <DelegationMessage key={`${row.source}:${row.id}`} row={row} historical synced={conn.state === 'online' && !history.error} />)}
    {history.data?.length === 200 ? <Txt role="caption" tone="inkSoft">{zh ? '目前可读取最近 200 件事。更早的事请让 CC 帮你找。' : 'Showing the latest 200 items. Ask CC to find earlier work.'}</Txt> : null}
  </View>
}

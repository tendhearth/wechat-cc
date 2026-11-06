import { AgentAvatars } from './AgentAvatars'
import { progressView } from '../view/progress'
import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useQuery } from '../state/hooks'
import { useChatUpdates } from '../state/useChatUpdates'
import { rememberReference } from '../state/conversation-references'
import type { HomeRow } from '../view/home'
import { agentsLabel } from '../view/agents'
import { Sheet } from './Sheet'
import { MatterRow } from './MatterRow'
import { Button } from './Button'
import { Txt } from './Txt'
import { space } from './tokens'

/** A CC reference, never a simulated transcript of the executor. Protected actions stay in their existing detail. */
export function DelegationMessage({ row, historical = false, synced, live = false }: { row: HomeRow; historical?: boolean; synced: boolean; live?: boolean }) {
  const lang = useLang(), router = useRouter(), { backend } = useBackendCtx()
  const zh = lang === 'zh-Hans'
  return <View testID={`delegation-${row.source}-${row.id}`} style={{ gap: space.xs }}>
    <Txt role="caption" tone="inkSoft">{historical ? (zh ? '以前交办的事' : 'Previously delegated') : 'CC'} · {new Date(row.updatedAt).toLocaleString(lang)}</Txt>
    {row.agents.length ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}><AgentAvatars ids={row.agents} names={row.agentNames} size={18} /><Txt role="meta" tone="inkSoft">{agentsLabel(row.agents, row.agentNames)}</Txt></View> : null}
    <MatterRow row={row} fetchTitle onOpen={() => { rememberReference(backend, row.id, row.source); router.push(row.href) }} />
    {live && row.source === 'matter' ? <ReferenceProgress row={row} /> : null}
    {!synced ? <Txt role="meta" tone="inkSoft">{zh ? '尚未同步' : 'Not synced'}</Txt> : null}
    <Sheet testID={`delegation-expand-${row.id}`} title={zh ? '看过程' : 'View progress'}>
      <DelegationProgress row={row} />
    </Sheet>
  </View>
}
function DelegationProgress({ row }: { row: HomeRow }) {
  const lang = useLang(), router = useRouter(), { backend } = useBackendCtx(), zh = lang === 'zh-Hans'
  const detail = useQuery(`matter:${row.id}`, l => backend.matter(row.id, l), { enabled: row.source === 'matter', refreshOnMount: true })
  useChatUpdates(row.source === 'matter' ? row.id : undefined, detail.refresh)
  return <View style={{ gap: space.m }}>
    {row.agents.length ? <Txt role="meta">{agentsLabel(row.agents, row.agentNames)}</Txt> : null}
    {row.detail || row.caption ? <Txt content="user">{row.detail ?? row.caption}</Txt> : null}
    {detail.error ? <Txt role="meta" tone="inkSoft">{zh ? '尚未同步' : 'Not synced'}</Txt> : null}
    {(detail.data?.artifacts ?? []).map(a => <Txt key={a.id} content="user">{a.name}</Txt>)}
    <Button kind="secondary" testID={`delegation-open-${row.id}`} label={row.status === 'waiting' ? (zh ? '等你决定 · 查看请求' : 'Waiting for you · View request') : (zh ? '打开这件事' : 'Open this work')} onPress={() => router.push(row.href)} />
  </View>
}

function ReferenceProgress({ row }: { row: HomeRow }) {
  const { backend } = useBackendCtx(), lang = useLang(), zh = lang === 'zh-Hans'
  const detail = useQuery(`matter:${row.id}`, l => backend.matter(row.id, l), { refreshOnMount: true })
  useChatUpdates(row.id, detail.refresh)
  const d = detail.data
  if (!d) return null
  const status = progressView(d, null, null).status
  const result = ['replied', 'done'].includes(status) ? d.events.findLast(e => e.kind === 'text') : null
  const activity = d.events.findLast(e => e.activity?.label)
  return <View style={{ gap: space.xs }}>
    {!row.agents.length && d.task ? <Txt role="meta" tone="inkSoft">{agentsLabel([d.task.providerId], d.matter.agentNames)}</Txt> : null}
    {detail.error ? <Txt role="meta" tone="inkSoft">{zh ? '尚未同步' : 'Not synced'}</Txt> : null}
    {result ? <View testID={`delegation-result-${row.id}`}><Txt role="caption" tone="inkSoft">{zh ? 'CC 带回的结果' : 'Result brought back by CC'}</Txt><Txt content="user" numberOfLines={3}>{result.text}</Txt></View>
      : d.task?.error ? <Txt content="user" numberOfLines={3}>{d.task.error}</Txt>
      : activity ? <Txt testID={`delegation-progress-${row.id}`} role="meta" tone="inkSoft" content="user" numberOfLines={2}>{activity.activity!.label}</Txt> : null}
  </View>
}

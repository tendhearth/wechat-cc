import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useQuery } from '../state/hooks'
import { useChatUpdates } from '../state/useChatUpdates'
import type { HomeRow } from '../view/home'
import { agentsLabel } from '../view/agents'
import { Sheet } from './Sheet'
import { MatterRow } from './MatterRow'
import { Button } from './Button'
import { Txt } from './Txt'
import { space } from './tokens'

/** A CC reference, never a simulated transcript of the executor. Protected actions stay in their existing detail. */
export function DelegationMessage({ row, historical = false, synced }: { row: HomeRow; historical?: boolean; synced: boolean }) {
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const detail = useQuery(`matter:${row.id}`, l => backend.matter(row.id, l), { enabled: row.source === 'matter' })
  useChatUpdates(row.source === 'matter' ? row.id : undefined, detail.refresh)
  const result = detail.data?.artifacts ?? []
  const zh = lang === 'zh-Hans'
  return <View testID={`delegation-${row.source}-${row.id}`} style={{ gap: space.xs }}>
    <Txt role="caption" tone="inkSoft">{historical ? (zh ? '以前交办的事' : 'Previously delegated') : 'CC'} · {new Date(row.updatedAt).toLocaleString(lang)}</Txt>
    <MatterRow row={row} fetchTitle onOpen={() => router.push(row.href)} />
    {!synced || detail.error ? <Txt role="meta" tone="inkSoft">{zh ? '尚未同步' : 'Not synced'}</Txt> : null}
    <Sheet testID={`delegation-expand-${row.id}`} title={zh ? '看过程' : 'View progress'}>
      <View style={{ gap: space.m }}>
        {row.agents.length ? <Txt role="meta">{agentsLabel(row.agents, row.agentNames)}</Txt> : null}
        {row.detail || row.caption ? <Txt content="user">{row.detail ?? row.caption}</Txt> : null}
        {result.map(a => <Txt key={a.id} content="user">{a.name}</Txt>)}
        <Button kind="secondary" testID={`delegation-open-${row.id}`} label={row.status === 'waiting' ? (zh ? '等你决定 · 查看请求' : 'Waiting for you · View request') : (zh ? '打开这件事' : 'Open this work')} onPress={() => router.push(row.href)} />
      </View>
    </Sheet>
  </View>
}

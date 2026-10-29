import { useRouter } from 'expo-router'
import { Pressable, SectionList, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useWork } from '../../state/useWork'
import { useAllMatterInputs, useInputRecovery } from '../../state/useMatterInputs'
import { useTerminalSessions } from '../../state/useTerminal'
import { inputNeedsChecking } from '../../state/matter-inputs'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Button } from '../../ui/Button'
import { BusyIndicator } from '../../ui/motion'
import { StatusHint } from '../../ui/StatusHint'
import { LinkRow } from '../../ui/Rows'
import { TerminalItem } from '../../ui/TerminalItem'
import { agentsLabel } from '../../view/agents'
import { originKey } from '../../view/origin'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { togetherGroups, togetherView } from '../../view/together'
import { terminalRows } from '../../view/terminal'
import { Icon } from '../../ui/Icon'
import { IconButton } from '../../ui/IconButton'
import { WaitingTitle } from '../../ui/WaitingTitle'

// 「一起做」:交给 CC 的事(全部没归档的),分三组:等你 / 在做 / 做完(手机端用词表)。每组一个衬线小标题,只有「等你」上强调色。
// 每行标题 + 状态词 + 副标题,点进进展页。三组只在这里,「此刻」只列等你的那几件(同一件东西只有一个家)。
// 和 CC 的对话只住在「此刻」(2026-10-05,同一件东西只有一个家);这里底部是「交办」,不是「跟 CC 说」。
// 「电脑上的会话」是把电脑上已有的会话接进来,放在列表末尾,不和事情抢第一眼。
// 「终端里的会话」(2026-10-14):主人在 CC 外面开的 Claude Code / Codex,和 CC 自己的事并排 —— CC 是所有执行者的总管。
// 一行只有一个动作(点进详情);允许这一步 / 先不做只在详情里。
export default function Together() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { approvals, agents, matters, mattersKnown, mattersLoading, mattersError, refreshMatters } = useWork()
  const sections = togetherGroups(togetherView(matters, approvals, agents)).map(g => ({ key: g.key, data: g.rows }))
  const saved = useAllMatterInputs().filter(inputNeedsChecking).length
  const recovery = useInputRecovery()
  const terminal = useTerminalSessions()
  const termRows = terminalRows(terminal.sessions, Date.now(), lang)
  const terminalSection = termRows.length > 0 ? (
    <View testID="together-terminal" style={{ paddingTop: space.xl }}>
      <Txt role="meta" tone="inkSoft" accessibilityRole="header" style={{ marginBottom: space.s }}>{t(lang, 'terminal.title')}</Txt>
      <View>
        {termRows.map(r => (
          <TerminalItem key={r.id} row={r} onOpen={() => router.push(`/terminal/${encodeURIComponent(r.id)}`)} />
        ))}
      </View>
    </View>
  ) : null

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'together.title')} actions={<View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <IconButton name="plus" testID="together-delegate" label={t(lang, 'together.delegate')} onPress={() => router.push('/compose')} />
        <StatusHint testID="together-more" icon="more" value={saved || undefined} label={`${t(lang, 'minimal.more')}${saved ? `, ${t(lang, 'input.savedTitle')} ${saved}` : ''}`} description="">
          {close => <View>
            <LinkRow testID="together-saved-inputs" icon="restore" label={`${t(lang, 'input.savedTitle')}${saved ? ` · ${saved}` : ''}`} detail={recovery.phase !== 'ready' ? t(lang, 'feedback.stale') : undefined} onPress={() => { close(); router.push('/inputs') }} />
            <LinkRow testID="together-sessions" icon="terminal" label={t(lang, 'sessions.title')} onPress={() => { close(); router.push('/sessions') }} />
          </View>}
        </StatusHint>
      </View>} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <SectionList
        sections={sections}
        keyExtractor={(r) => r.id}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <View style={{ paddingTop: space.xl, paddingBottom: space.s }}>
          <Txt testID={`together-group-${section.key}`} role="caption" tone={section.key === 'waiting' ? 'accent' : 'inkSoft'} accessibilityRole="header">{t(lang, `together.group.${section.key}`)}</Txt>
        </View>}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, flexGrow: 1 }}
        ListHeaderComponent={<>
          {!mattersKnown && mattersError ? <View style={{ paddingVertical: space.m, gap: space.s }}>
            <StatusHint testID="together-unavailable" icon="alert" label={t(lang, 'feedback.loadingFailed')} shortLabel={t(lang, 'feedback.loadingFailed')} description={t(lang, 'feedback.loadingFailed')} />
            <Button kind="secondary" testID="together-retry" label={t(lang, 'common.retry')} busy={mattersLoading} onPress={() => void refreshMatters()} />
          </View> : !mattersKnown ? <View style={{ paddingVertical: space.l }}><BusyIndicator testID="together-loading" label={t(lang, 'progress.loading')} /></View> : mattersError ? (
            <StatusHint testID="together-stale" icon="clock" label={t(lang, 'feedback.stale')} shortLabel={t(lang, 'feedback.stale')} description={t(lang, 'feedback.stale')}>
              <Button kind="secondary" testID="together-retry" label={t(lang, 'common.retry')} busy={mattersLoading} onPress={() => void refreshMatters()} />
            </StatusHint>
          ) : null}
        </>}
        ListFooterComponent={terminalSection}
        ListEmptyComponent={mattersKnown ? <View style={{ flex: 1, justifyContent: 'center', paddingVertical: space.xxl }}>
          <Txt testID="together-empty" role="bubble" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'together.empty')}</Txt>
        </View> : null}
        renderItem={({ item }) => {
          const pending=approvals.find(a => a.taskId === item.id)
          const title=pending?.summary || item.title
          const outcome=['failed','stopped','replied'].includes(item.status)
          return <Pressable testID={`together-item-${item.id}`} accessibilityRole="button"
            accessibilityLabel={`${title}, ${t(lang, `status.${item.status}`)}${item.agents.length ? `, ${agentsLabel(item.agents, item.agentNames)}` : ''}${item.origin ? `, ${t(lang, originKey(item.origin))}` : ''}`}
            onPress={() => router.push(pending ? `/approval/${encodeURIComponent(item.id)}` : `/matter/${encodeURIComponent(item.id)}`)}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 64, paddingVertical: space.m, opacity: pressed ? 0.7 : 1 })}>
            {item.status === 'working' ? <View style={{ width: 18 }} /> : <Icon name={item.status === 'waiting' ? 'shield' : item.status === 'done' ? 'done' : item.status === 'failed' ? 'alert' : item.status === 'replied' ? 'message' : 'pause'} color={item.status === 'waiting' ? c.accent : c.inkSoft} />}
            <View style={{ flex: 1, gap: space.xs }}>
              {pending ? <WaitingTitle taskId={item.id} requestId={pending.id} fallback={title} /> : <Txt role="item" content="user" numberOfLines={2}>{title}</Txt>}
              {pending && title !== item.title ? <Txt role="caption" tone="inkSoft" content="user" numberOfLines={1}>{item.title}</Txt> : null}
              {outcome ? <Txt role="caption" tone="inkSoft">{t(lang, `status.${item.status}`)}</Txt> : null}
            </View>
            <Icon name="chevronRight" size={16} color={c.inkSoft} />
          </Pressable>
        }}
      />
    </SafeAreaView>
  )
}

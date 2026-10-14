import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useTerminalActions, useTerminalSessions } from '../../state/useTerminal'
import { Button } from '../../ui/Button'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { TerminalStatusPill } from '../../ui/TerminalItem'
import { TextField } from '../../ui/TextField'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { canSayTo, terminalErrorKey, terminalRow } from '../../view/terminal'

/** 手机上说一句最多这么长(同 daemon 的 PHONE_CLI_SAY_MAX)。 */
const SAY_MAX = 4000

// 一条终端会话(2026-10-14):最后一句、等批准的那一项(能拍就拍),和「接着说一句」。
// 说一句走的是微信「@码」同一条路:收下即回,跑完的结果成为这里的「最后一句」。在跑 / 在等批准时不能说。
export default function TerminalSession() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { id: raw } = useLocalSearchParams<{ id: string }>()
  const id = decodeURIComponent(String(raw ?? ''))
  const terminal = useTerminalSessions()
  const actions = useTerminalActions()
  const [text, setText] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const s = terminal.sessions.find(x => x.session_id === id)
  const row = s ? terminalRow(s, Date.now(), lang) : null
  const sayOpen = !!row && canSayTo(row.status) && terminal.online
  const sending = actions.pending === `cli:say:${id}`
  const deciding = actions.pending === `cli:decide:${id}`

  const decide = async (d: 'allow' | 'deny') => {
    if (!s) return
    setNote(null)
    const err = await actions.decide(s, d)
    setNote(err === null ? t(lang, 'terminal.decided') : err === 'busy' ? null : t(lang, terminalErrorKey(err)))
  }
  const send = async () => {
    const body = text.trim()
    if (!body || body.length > SAY_MAX || !sayOpen || sending) return
    setNote(null)
    const err = await actions.say(id, body)
    if (err === null) { setText(''); setNote(t(lang, 'terminal.sent')) }
    else if (err !== 'busy') setNote(t(lang, terminalErrorKey(err)))
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={row?.project ?? t(lang, 'terminal.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/together'))} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
          {!row ? (
            <Txt testID="terminal-missing" role="bubble" tone="inkSoft" style={{ paddingTop: space.xl }}>
              {terminal.loaded ? t(lang, 'terminal.gone') : t(lang, 'sessions.loading')}
            </Txt>
          ) : (
            <>
              <View style={{ gap: space.s }}>
                <TerminalStatusPill status={row.status} testID="terminal-detail-status" />
                <Txt role="small" tone="inkSoft">{`${row.source} · ${row.stale ? t(lang, 'terminal.stale.hint') : row.ago}`}</Txt>
              </View>
              {row.pendingText ? (
                <View style={{ gap: space.m }}>
                  <Txt testID="terminal-detail-pending" role="body" content="user">{row.pendingText}</Txt>
                  {row.actionable ? (
                    <View style={{ flexDirection: 'row', gap: space.m }}>
                      <View style={{ flex: 1 }}><Button kind="primary" testID="terminal-detail-allow" label={t(lang, 'terminal.allow')} busy={deciding} disabled={!terminal.online} onPress={() => void decide('allow')} /></View>
                      <View style={{ flex: 1 }}><Button kind="secondary" testID="terminal-detail-deny" label={t(lang, 'terminal.deny')} disabled={!terminal.online || deciding} onPress={() => void decide('deny')} /></View>
                    </View>
                  ) : <Txt testID="terminal-detail-local" role="meta" tone="inkSoft">{t(lang, 'terminal.askedLocally')}</Txt>}
                </View>
              ) : null}
              <View style={{ gap: space.s }}>
                <Txt role="meta" tone="inkSoft" accessibilityRole="header">{t(lang, 'terminal.lastSaid')}</Txt>
                <Txt testID="terminal-detail-summary" role="bubble" content="user" tone={row.summary ? 'ink' : 'inkSoft'}>{row.summary ?? t(lang, 'terminal.noSummary')}</Txt>
              </View>
              {note ? <Txt testID="terminal-detail-note" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{note}</Txt> : null}
            </>
          )}
        </ScrollView>
        {row && row.status !== 'ended' ? (
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.m, paddingBottom: space.m, gap: space.s }}>
            {!canSayTo(row.status) ? <Txt testID="terminal-say-busy" role="meta" tone="inkSoft">{t(lang, 'terminal.sayBusy')}</Txt> : null}
            <TextField
              testID="terminal-say-input"
              accessibilityLabel={t(lang, 'terminal.sayPlaceholder')}
              placeholder={t(lang, 'terminal.sayPlaceholder')}
              value={text}
              onChangeText={setText}
              editable={sayOpen}
              multiline
              maxLength={SAY_MAX}
              style={{ minHeight: 48, maxHeight: 160, paddingHorizontal: space.l, paddingVertical: space.m, borderWidth: 1, borderColor: c.hair, borderRadius: radius.control, opacity: sayOpen ? 1 : 0.55 }}
            />
            <Button kind="primary" testID="terminal-say-send" label={t(lang, 'terminal.send')} busy={sending} disabled={!sayOpen || !text.trim()} onPress={() => void send()} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

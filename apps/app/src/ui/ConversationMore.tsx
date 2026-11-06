import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useAllMatterInputs, useInputRecovery } from '../state/useMatterInputs'
import { inputNeedsChecking } from '../state/matter-inputs'
import { LinkRow } from './Rows'
import { StatusHint } from './StatusHint'
export function ConversationMore() {
  const lang = useLang(), zh = lang === 'zh-Hans', router = useRouter()
  const saved = useAllMatterInputs().filter(inputNeedsChecking).length
  const recovery = useInputRecovery()
  return <StatusHint testID="home-more" icon="more" value={saved || undefined} label={t(lang, 'minimal.more')} description="">
    {close => <View>
      <LinkRow testID="home-saved-inputs" label={`${t(lang, 'input.savedTitle')}${saved ? ` · ${saved}` : ''}`} detail={recovery.phase !== 'ready' ? t(lang, 'feedback.stale') : undefined} onPress={() => { close(); router.push('/inputs') }} />
      <LinkRow testID="home-sessions" label={t(lang, 'sessions.title')} onPress={() => { close(); router.push('/sessions') }} />
      <LinkRow testID="conversation-cc-acts" label={zh ? 'CC 自己做的事' : 'CC’s own activities'} onPress={() => { close(); router.push('/cc-activity') }} />
      <LinkRow testID="conversation-letters" label={t(lang, 'letters.title')} onPress={() => { close(); router.push('/letters') }} />
      <LinkRow testID="conversation-memory" label={t(lang, 'memory.title')} onPress={() => { close(); router.push('/memory') }} />
      <LinkRow testID="conversation-activity" label={zh ? '活动记录' : 'Activity'} onPress={() => { close(); router.push('/activity') }} />
      <LinkRow testID="conversation-settings" label={t(lang, 'settings.title')} onPress={() => { close(); router.push('/settings') }} />
    </View>}
  </StatusHint>
}

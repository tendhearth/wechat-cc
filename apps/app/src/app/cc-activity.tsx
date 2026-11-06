import { useRouter } from 'expo-router'
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLang } from '../i18n/useLang'
import { useCcActs } from '../state/useCcActs'
import { useCompanion } from '../state/useCompanion'
import { ccActsView } from '../view/cc-acts'
import { companionCard } from '../view/companion'
import { CcActsGroup } from '../ui/CcActsGroup'
import { CompanionCard } from '../ui/CompanionCard'
import { TopBar } from '../ui/TopBar'
import { space } from '../ui/tokens'
import { useTheme } from '../ui/useTheme'
export default function CcActivity() {
  const router = useRouter(), { c } = useTheme(), lang = useLang(), now = Date.now()
  const acts = ccActsView(useCcActs(), now, lang), companion = useCompanion()
  const card = companion.home ? companionCard(companion.home.events, companion.home.seenUntil, now, companion.localSeen) : null
  return <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
    <TopBar title={lang === 'zh-Hans' ? 'CC 自己做的事' : 'CC’s own activities'} onBack={() => router.canGoBack() ? router.back() : router.replace('/')} />
    <ScrollView contentContainerStyle={{ padding: space.xl }}><CcActsGroup view={acts} /><CompanionCard card={card} onSeen={companion.markSeen} /></ScrollView>
  </SafeAreaView>
}

import { useRouter } from 'expo-router'
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { OFL_TEXT } from '../ui/ofl-text'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { reflowLicence } from '../view/licences'

// 设置 → 开源字体许可:随包的 OFL.txt 原文(Noto Serif SC / Source Serif 4 / Geist Mono)。OFL 要求再分发时附上许可证。
export default function Licences() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'settings.fontLicences')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} onAvatar={() => router.push('/settings')} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xxl, gap: space.l }}>
        <Txt testID="licences-intro" role="meta" tone="inkSoft">{t(lang, 'licences.intro')}</Txt>
        <Txt testID="licences-text" role="small" selectable>{reflowLicence(OFL_TEXT)}</Txt>
      </ScrollView>
    </SafeAreaView>
  )
}

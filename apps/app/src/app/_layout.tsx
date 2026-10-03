import { useFonts } from 'expo-font'
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { credentials } from '../net/secure-store'
import { inputJournal } from '../net/input-journal-native'
import { pushForget } from '../push/native'
import { PushProvider } from '../push/PushProvider'
import { PushRouter } from '../push/PushRouter'
import { BackendProvider } from '../state/BackendProvider'
import { SessionProvider, useSession } from '../state/session'
import { useLang } from '../i18n/useLang'
import { FONT_FILES } from '../ui/font-files'
import { palette } from '../ui/tokens'
import { fontGate } from '../ui/type'

// 根布局:语言 = 设置覆盖 ?? 系统(SessionProvider + useLang);页面永远同一张暖纸(spec 2026-10-01 §1.8),不跟系统深浅;本地衬线字体加载完(或出错退回系统字)才画页面;
// 有配对 ⇒ 真后端,否则演示后端,包住全部页面;推送登记(PushProvider)跟着后端走;点通知 / 前台横幅(PushRouter)叠在页面之上;钥匙串读完之前只画底色。首次打开跳 /welcome 的判断在 (tabs)/_layout 里做。
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider store={credentials} push={pushForget} inputs={inputJournal}>
        <Themed />
      </SessionProvider>
    </SafeAreaProvider>
  )
}

function Themed() {
  const session = useSession()
  const lang = useLang()
  const [loaded, error] = useFonts(FONT_FILES)
  const c = palette
  const theme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: c.paper, card: c.paper, text: c.ink, border: c.hair, primary: c.accent } }
  if (!session.ready || fontGate(loaded, error) === 'wait') return <View style={{ flex: 1, backgroundColor: c.paper }} />
  return (
    <BackendProvider lang={lang} pairing={session.pairing} inputScope={session.inputScope} onRevoked={session.dropStoredPairing} onStale={session.forgetStale}>
      <PushProvider>
        <ThemeProvider value={theme}>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.paper } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="welcome" options={{ gestureEnabled: false }} />
            <Stack.Screen name="push-open" options={{ gestureEnabled: false }} />
          </Stack>
          <PushRouter />
        </ThemeProvider>
      </PushProvider>
    </BackendProvider>
  )
}

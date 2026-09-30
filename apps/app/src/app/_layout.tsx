import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { credentials } from '../net/secure-store'
import { BackendProvider } from '../state/BackendProvider'
import { SessionProvider, useSession } from '../state/session'
import { useLang } from '../i18n/useLang'
import { palette } from '../ui/tokens'

// 根布局:语言 = 设置覆盖 ?? 系统(SessionProvider + useLang);主题跟 useColorScheme();
// 有配对 ⇒ 真后端,否则演示后端,包住全部页面;钥匙串读完之前只画底色。首次打开跳 /welcome 的判断在 (tabs)/_layout 里做。
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider store={credentials}>
        <Themed />
      </SessionProvider>
    </SafeAreaProvider>
  )
}

function Themed() {
  const session = useSession()
  const dark = useColorScheme() === 'dark'
  const lang = useLang()
  const c = palette[dark ? 'dark' : 'light']
  const base = dark ? DarkTheme : DefaultTheme
  const theme = { ...base, colors: { ...base.colors, background: c.bg, card: c.card, text: c.ink, border: c.line, primary: c.primary } }
  if (!session.ready) return <View style={{ flex: 1, backgroundColor: c.bg }} />
  return (
    <BackendProvider lang={lang} pairing={session.pairing} onRevoked={session.dropStoredPairing}>
      <ThemeProvider value={theme}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="welcome" options={{ gestureEnabled: false }} />
        </Stack>
      </ThemeProvider>
    </BackendProvider>
  )
}

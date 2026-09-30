// 协议包(zod v4 + noble)目前只有类型被页面引用;留一条运行时 import,让 export:check 继续证明它在 Metro 下能打包。
// 下一份计划真后端接上后,由真后端的 import 接替,这一行可删。
import '@wechat-cc/protocol'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { BackendProvider } from '../state/BackendProvider'
import { SessionProvider } from '../state/session'
import { useLang } from '../i18n/useLang'
import { palette } from '../ui/tokens'

// 根布局:语言 = 设置覆盖 ?? 系统(SessionProvider + useLang);主题跟 useColorScheme();
// 演示后端包住全部页面。首次打开跳 /welcome 的判断在 (tabs)/_layout 里做。
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Themed />
      </SessionProvider>
    </SafeAreaProvider>
  )
}

function Themed() {
  const dark = useColorScheme() === 'dark'
  const lang = useLang()
  const c = palette[dark ? 'dark' : 'light']
  const base = dark ? DarkTheme : DefaultTheme
  const theme = { ...base, colors: { ...base.colors, background: c.bg, card: c.card, text: c.ink, border: c.line, primary: c.primary } }
  return (
    <BackendProvider lang={lang}>
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

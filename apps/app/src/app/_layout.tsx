import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';
import { BackendProvider } from '../state/BackendProvider';

// 最小根布局:跟随系统深浅色,一个 Stack。页面与演示模式在后续任务里加。
export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <BackendProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }} />
      </ThemeProvider>
    </BackendProvider>
  );
}

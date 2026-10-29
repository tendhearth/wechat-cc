import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

// 底部只保留两个文字标签,当前项用短线和强调色表示。待回应数留在读屏标签,不重复堆在底栏。
export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View
      accessibilityRole="tabbar"
      style={{
        flexDirection: 'row',
        gap: space.m,
        paddingHorizontal: space.xl,
        paddingTop: space.s,
        paddingBottom: Math.max(insets.bottom, space.s),
        backgroundColor: c.paper,
      }}
    >
      {state.routes.map((route, i) => {
        const { options } = descriptors[route.key]!
        const label = typeof options.title === 'string' ? options.title : route.name
        const focused = state.index === i
        const badge = options.tabBarBadge
        return (
          <Pressable
            key={route.key}
            testID={options.tabBarButtonTestID}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={badge ? `${label} ${badge}` : label}
            onPress={() => {
              const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
              if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params)
            }}
            style={{
              flex: 1,
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Txt role="meta" tone={focused ? 'accent' : 'inkSoft'}>{label}</Txt>
            {focused ? <View testID={`${options.tabBarButtonTestID}-selected`} style={{ position: 'absolute', bottom: 0, width: 16, height: 2, backgroundColor: c.accent }} /> : null}
          </Pressable>
        )
      })}
    </View>
  )
}

import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

// 底部两个标签「此刻 / 一起做」:选中的是一块暖色底(Codex 稿 navOnBg / navOnInk)。
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
        backgroundColor: c.bg,
        borderTopWidth: 1,
        borderTopColor: c.line,
      }}
    >
      {state.routes.map((route, i) => {
        const { options } = descriptors[route.key]!
        const label = typeof options.title === 'string' ? options.title : route.name
        const focused = state.index === i
        return (
          <Pressable
            key={route.key}
            testID={options.tabBarButtonTestID}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={label}
            onPress={() => {
              const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
              if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params)
            }}
            style={{
              flex: 1,
              minHeight: 44,
              borderRadius: radius.button,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: focused ? c.navOnBg : 'transparent',
            }}
          >
            <Text style={{ color: focused ? c.navOnInk : c.muted, fontSize: 15 }}>{label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

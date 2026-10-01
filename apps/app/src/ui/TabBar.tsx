import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

// 底部两个标签「此刻 / 一起做」:不画色块,选中只把字变成墨色(未选中 inkSoft)。
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
        backgroundColor: c.rail,
        borderTopWidth: 1,
        borderTopColor: c.hair,
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
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Txt role="body" tone={focused ? 'ink' : 'inkSoft'}>{label}</Txt>
          </Pressable>
        )
      })}
    </View>
  )
}

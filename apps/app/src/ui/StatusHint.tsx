import { useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Modal, Pressable, ScrollView, View, findNodeHandle } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { Icon, type IconName } from './Icon'
import { Txt } from './Txt'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

/** An explanation entry. Recovery controls are explicit children; opening never performs writes. */
export function StatusHint({ label, description, icon = 'info', shortLabel, testID, children }: { label: string; description: string; icon?: IconName; shortLabel?: string; testID?: string; children?: ReactNode }) {
  const { c } = useTheme()
  const lang = useLang()
  const [open, setOpen] = useState(false)
  const entry = useRef<View>(null)
  const heading = useRef<View>(null)
  const focus = (target: View | null) => {
    // Accessibility may be unavailable on a platform; the native Modal still owns focus containment.
    try { const handle = target ? findNodeHandle(target) : null; if (handle !== null) AccessibilityInfo.setAccessibilityFocus?.(handle) } catch {}
  }
  return (
    <>
      <Pressable ref={entry} testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={({ pressed }) => ({ minWidth: 44, minHeight: 44, paddingHorizontal: shortLabel ? space.s : 0, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
        {shortLabel ? <Txt role="meta" tone="inkSoft">{shortLabel}</Txt> : <Icon name={icon} color={c.inkSoft} />}
      </Pressable>
      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)} onShow={() => focus(heading.current)} onDismiss={() => focus(entry.current)}>
        <View style={{ flex: 1, justifyContent: 'center', backgroundColor: c.paper, padding: space.xl }}>
          <View accessibilityViewIsModal accessibilityLabel={label} testID={testID ? `${testID}-dialog` : undefined} style={{ maxHeight: '90%', borderRadius: radius.sheet }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
              <View ref={heading} accessible accessibilityRole="header" accessibilityLabel={label} style={{ flex: 1 }}>
                <Txt role="title">{label}</Txt>
              </View>
              <Pressable testID={testID ? `${testID}-close` : undefined} accessibilityRole="button" accessibilityLabel={t(lang, 'artifacts.close')} onPress={() => setOpen(false)} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="close" color={c.inkSoft} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ paddingVertical: space.l, gap: space.l }}>
              <Txt testID={testID ? `${testID}-description` : undefined}>{description}</Txt>
              {children}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  )
}

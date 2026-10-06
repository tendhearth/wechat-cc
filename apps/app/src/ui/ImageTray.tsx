import { Image, Pressable, View } from 'react-native'
import { t, type Lang } from '../i18n'
import type { PickedImage } from '../state/image-upload'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** 输入框上方一排待发的图(2026-10-06):缩略图 + 右上角 ×;一张都没有就不占地方。 */
export function ImageTray({ images, lang, onRemove, testID }: { images: readonly PickedImage[]; lang: Lang; onRemove(id: string): void; testID: string }) {
  const { c } = useTheme()
  if (!images.length) return null
  return (
    <View testID={testID} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s }}>
      {images.map((img, i) => (
        <View key={img.id} testID={`${testID}-item`} style={{ width: 64, height: 64 }}>
          <Image source={{ uri: img.uri }} accessibilityLabel={t(lang, 'images.picked')} style={{ width: 64, height: 64, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair, backgroundColor: c.paper }} />
          <Pressable
            testID={`${testID}-remove-${i}`}
            accessibilityRole="button"
            accessibilityLabel={t(lang, 'images.remove')}
            hitSlop={8}
            onPress={() => onRemove(img.id)}
            style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: c.paper, borderWidth: 1, borderColor: c.hair }}
          >
            <Txt role="caption">×</Txt>
          </Pressable>
        </View>
      ))}
    </View>
  )
}

/** 「图片」按钮:与「交给 CC 去做一件事」同一种描边小按钮(一个强调色只给动作,这里不上色)。 */
export function AddImageButton({ lang, disabled, onPress, testID }: { lang: Lang; disabled: boolean; onPress(): void; testID: string }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t(lang, 'images.add')}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.control, borderWidth: 1, borderColor: c.hair, opacity: disabled ? 0.55 : pressed ? 0.7 : 1 })}
    >
      <Txt role="meta">{t(lang, 'images.add')}</Txt>
    </Pressable>
  )
}

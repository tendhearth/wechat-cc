import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { Button } from './Button'
import { LinkRow } from './Rows'
import { StatusHint } from './StatusHint'
export function ConversationAdd({ onImages, canAddImages = true }: { onImages(): void; canAddImages?: boolean }) {
  const lang = useLang(), router = useRouter()
  return <StatusHint icon="plus" label={lang === 'zh-Hans' ? '添加' : 'Add'} testID="chat-plus" description="">
    {close => <View>
      <Button kind="secondary" testID="chat-add-image" label={t(lang, 'images.add')} disabled={!canAddImages} onPress={() => { close(); onImages() }} />
      <LinkRow testID="chat-handoff" label={lang === 'zh-Hans' ? '交办一件事' : 'Delegate work'} onPress={() => { close(); router.push('/compose') }} />
    </View>}
  </StatusHint>
}

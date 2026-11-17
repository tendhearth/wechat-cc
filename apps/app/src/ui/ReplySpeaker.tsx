import { View } from 'react-native'
import type { ReplyAttribution } from '@wechat-cc/protocol'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { agentGlyph } from '../view/agents'
import { replyProvider } from '../view/reply-speaker'
import { AgentAvatar } from './AgentAvatars'
import { Txt } from './Txt'

export function ReplySpeaker({ role, reply, providers, showFallback = true }: {
  role: 'me' | 'cc'; reply: Partial<ReplyAttribution>; providers?: readonly { id: string; name: string }[]; showFallback?: boolean
}) {
  const lang = useLang()
  const provider = replyProvider(role, reply)
  if (!provider) return showFallback ? <Txt role="caption" tone="inkSoft" style={{ textAlign: role === 'me' ? 'right' : 'left' }}>{t(lang, role === 'me' ? 'chat.me' : 'cc.label')}</Txt> : null
  const name = providers?.find(p => p.id === provider)?.name
  const label = name?.trim() ? name : provider
  // openai is the custom compatible-service slot. Never infer its brand from a model/name.
  const id = provider !== 'openai' && agentGlyph(provider) ? provider : 'service'
  return <View testID="reply-avatar" accessible accessibilityRole="image" accessibilityLabel={label}>
    <AgentAvatar id={id} size={24} names={{ service: 'AI' }} />
  </View>
}

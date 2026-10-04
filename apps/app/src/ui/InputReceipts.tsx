import { Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import type { InputSnapshot } from '../state/matter-inputs'
import { inputCanRetry, inputStatusText } from '../view/matter-input'
import { Dot } from './Dot'
import { MessageText } from './Markdown'
import { space } from './tokens'
import { Txt } from './Txt'

/** 一条补充一行真实回执,原文与动作紧挨着它,不用额外卡片。 */
export function InputReceipts({ rows, onRestore, onRetry, disabled }: {
  rows: readonly InputSnapshot[]; onRestore: (row: InputSnapshot) => void; onRetry?: (row: InputSnapshot) => void; disabled?: boolean
}) {
  const lang = useLang()
  return <View style={{ gap: space.m }}>
    {rows.map(row => (
      <View key={row.requestId} testID={`input-receipt-${row.requestId}`} style={{ gap: space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
          <Dot kind={row.status === 'delivered' ? 'ok' : row.status === 'refused' || row.status === 'failed' ? 'bad' : row.status === 'held' ? 'warn' : 'unknown'} size={8} />
          <Txt testID={`input-status-${row.requestId}`} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{inputStatusText(row.status, lang, row.error)}</Txt>
        </View>
        <MessageText role="user" text={row.rawText} typeRole="bubble" />
        <View style={{ flexDirection: 'row', gap: space.l, flexWrap: 'wrap' }}>
          <Pressable testID={`input-restore-${row.requestId}`} accessibilityRole="button" accessibilityLabel={t(lang, 'input.restore')} onPress={() => onRestore(row)} hitSlop={6} style={{ minHeight: 36, justifyContent: 'center' }}>
            <Txt role="small" style={{ textDecorationLine: 'underline' }}>{t(lang, 'input.restore')}</Txt>
          </Pressable>
          {onRetry && inputCanRetry(row) ? (
            <Pressable testID={`input-retry-${row.requestId}`} accessibilityRole="button" accessibilityLabel={t(lang, 'input.retry')} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={() => onRetry(row)} hitSlop={6} style={{ minHeight: 36, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
              <Txt role="small" style={{ textDecorationLine: 'underline' }}>{t(lang, 'input.retry')}</Txt>
            </Pressable>
          ) : null}
        </View>
      </View>
    ))}
  </View>
}

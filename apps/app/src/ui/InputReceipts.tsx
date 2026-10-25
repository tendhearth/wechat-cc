import { useRef } from 'react'
import { Pressable, View } from 'react-native'
import { labelJoin, t } from '../i18n'
import { useLang } from '../i18n/useLang'
import type { InputSnapshot } from '../state/matter-inputs'
import { inputCanRetry, inputStatusText } from '../view/matter-input'
import { MessageText } from './Markdown'
import { MotionView } from './motion'
import { StatusHint } from './StatusHint'
import { space } from './tokens'
import { Txt } from './Txt'

function ReceiptStatus({ row }: { row: InputSnapshot }) {
  const lang = useLang()
  const phase = `${row.status}:${row.error ?? ''}`
  const event = useRef<{ phase: string; key?: string }>({ phase })
  if (event.current.phase !== phase) event.current = { phase, key: `${row.requestId}:${phase}` }
  const label = t(lang, `feedback.input.${row.status}`)
  return <MotionView kind="status" eventKey={event.current.key} style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
    <View accessibilityLiveRegion="polite">
      <StatusHint testID={`input-status-${row.requestId}`} icon={row.status === 'delivered' ? 'check' : row.status === 'failed' || row.status === 'refused' ? 'alert' : 'clock'}
        label={labelJoin(t(lang, 'feedback.status'), label)} shortLabel={label} description={inputStatusText(row.status, lang, row.error)} />
    </View>
  </MotionView>
}

/** 一条补充一行真实回执,原文与动作紧挨着它,不用额外卡片。 */
export function InputReceipts({ rows, onRestore, onRetry, disabled }: {
  rows: readonly InputSnapshot[]; onRestore: (row: InputSnapshot) => void; onRetry?: (row: InputSnapshot) => void; disabled?: boolean
}) {
  const lang = useLang()
  return <View style={{ gap: space.m }}>
    {rows.map(row => (
      <View key={row.requestId} testID={`input-receipt-${row.requestId}`} style={{ gap: space.xs }}>
        <ReceiptStatus row={row} />
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

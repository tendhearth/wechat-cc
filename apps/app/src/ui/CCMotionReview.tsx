import { useState } from 'react'
import { View } from 'react-native'
import type { CCPhase } from '@wechat-cc/protocol'
import { Button } from './Button'
import { CCFigure } from './CCFigure'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** Offline art review, reachable only behind the existing dev-e2e build gate. No backend or credentials. */
export function CCMotionReview() {
  const { c } = useTheme()
  const [phase, setPhase] = useState<CCPhase>('idle')
  const [behavior, setBehavior] = useState<'idle' | 'done' | 'look'>('idle')
  const [event, setEvent] = useState(0)
  const [here, setHere] = useState(true)
  return <View style={{ flex: 1, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
    <Txt role="item">离线动作检查</Txt><Txt role="meta" tone="inkSoft">合成信号 · 不代表真实 CC 正在工作</Txt>
    <CCFigure size={180} presence={here ? 'here' : 'away'} phase={phase} behavior={behavior} eventKey={event} />
    {(['idle', 'listening', 'thinking', 'speaking'] as const).map(value => <Button key={value} testID={`review-${value}`} kind="secondary" label={value} onPress={() => { setHere(true); setBehavior('idle'); setPhase(value) }} />)}
    <View style={{ flexDirection: 'row', gap: 16 }}>
      <Button testID="review-done" kind="secondary" label="完成" onPress={() => { setPhase('idle'); setBehavior('done'); setEvent(n => n + 1) }} />
      <Button testID="review-look" kind="secondary" label="新话题" onPress={() => { setPhase('idle'); setBehavior('look'); setEvent(n => n + 1) }} />
      <Button testID="review-away" kind="secondary" label="暗态" onPress={() => setHere(false)} />
    </View>
  </View>
}

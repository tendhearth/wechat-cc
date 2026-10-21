import type { ReactNode } from 'react'
import { Image, View } from 'react-native'
import { agentGlyph, agentMonogram, agentsLabel, agentStack, type AgentGlyph, type AgentNames } from '../view/agents'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

// 白色透明底的单色图,按 ink 着色(tintColor):跟页面同一支笔,不带各家的品牌色(设计原则:只有一个强调色)。
const GLYPH: Record<AgentGlyph, number> = {
  claude: require('../../assets/agents/claude.png'),
  codex: require('../../assets/agents/codex.png'),
  cursor: require('../../assets/agents/cursor.png'),
  agy: require('../../assets/agents/agy.png'),
  gemini: require('../../assets/agents/gemini.png'),
  kimi: require('../../assets/agents/kimi.png'),
  openai: require('../../assets/agents/openai.png'),
  deepseek: require('../../assets/agents/deepseek.png'),
  qwen: require('../../assets/agents/qwen.png'),
}

/** 叠多少:露出来的部分约占 64%,足够认出是谁(Linear / Figma 的头像叠差不多也是这个比例)。 */
const OVERLAP = 0.36
/** 外圈一道纸色描边,把叠在后面的那个干净地切开。 */
const RING = 2

function Disc({ size, children }: { size: number; children: ReactNode }) {
  const { c } = useTheme()
  return (
    <View style={{ width: size + RING * 2, height: size + RING * 2, borderRadius: size, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.rail, borderWidth: 1, borderColor: c.hair, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </View>
    </View>
  )
}

export function AgentAvatar({ id, size = 24, names }: { id: string; size?: number; names?: AgentNames }) {
  const { c } = useTheme()
  const glyph = agentGlyph(id)
  return (
    <Disc size={size}>
      {glyph
        ? <Image source={GLYPH[glyph]} style={{ width: Math.round(size * 0.6), height: Math.round(size * 0.6), tintColor: c.ink }} resizeMode="contain" />
        : <Txt role="caption" tone="ink">{agentMonogram(id, names)}</Txt>}
    </Disc>
  )
}

/**
 * 一件事的执行者:一个就是一个圆,几个就往左半叠,正在做的(第一个)压在最上面;超过 3 个折成「+N」。
 * 整组对读屏是一张图,标签念名字(names = daemon 给的 id → 名字;没有 ⇒ 念 id)。没有执行者 ⇒ 什么都不画。
 */
export function AgentAvatars({ ids, names, size = 24, max = 3, testID }: { ids: readonly string[] | undefined; names?: AgentNames; size?: number; max?: number; testID?: string }) {
  const { shown, more } = agentStack(ids, max)
  if (shown.length === 0) return null
  const step = -(size + RING * 2) * OVERLAP
  const n = shown.length + (more ? 1 : 0)
  return (
    <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={agentsLabel(ids, names)} style={{ flexDirection: 'row', alignItems: 'center' }}>
      {shown.map((id, i) => (
        <View key={id} style={{ marginLeft: i === 0 ? 0 : step, zIndex: n - i }}>
          <AgentAvatar id={id} size={size} names={names} />
        </View>
      ))}
      {more ? (
        <View style={{ marginLeft: step, zIndex: 0 }}>
          <Disc size={size}><Txt role="caption" tone="inkSoft">{`+${more}`}</Txt></Disc>
        </View>
      ) : null}
    </View>
  )
}

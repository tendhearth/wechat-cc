import { decodeMarkdownEntities, hasMarkdownFormatting, parseMarkdown, safeMarkdownUrl, type Token, type Tokens } from '@wechat-cc/markdown'
import { memo, useMemo, useState, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { radius, space } from './tokens'
import { Txt, type Tone } from './Txt'
import { useTheme } from './useTheme'

type BodyRole = 'body' | 'bubble'
type InlineRole = BodyRole | 'title' | 'item'
type Props = { text: string; typeRole?: BodyRole }

/** 助手正文的原生阅读出口。解析结果只随原文改变;链接只接受共享策略批准的绝对网址。 */
export const Markdown = memo(function Markdown({ text, typeRole = 'body' }: Props) {
  const tokens = useMemo(() => parseMarkdown(text), [text])
  return <View style={{ maxWidth: '100%', minWidth: 0, gap: space.s }}><Blocks tokens={tokens} typeRole={typeRole} /></View>
})

/** 用户与助手共用阅读格式;用户原文只在需要时展开。系统、错误、工具日志不进入此组件。 */
export function MessageText({ text, role, typeRole = 'body', userAlign = 'left' }: Props & { role: 'user' | 'assistant'; userAlign?: 'left' | 'right' }) {
  return role === 'assistant' ? <Markdown text={text} typeRole={typeRole} /> : <UserMessage text={text} typeRole={typeRole} userAlign={userAlign} />
}

const UserMessage = memo(function UserMessage({ text, typeRole = 'body', userAlign }: Props & { userAlign: 'left' | 'right' }) {
  const lang = useLang()
  const formatted = useMemo(() => hasMarkdownFormatting(text), [text])
  const [sourceFor, setSourceFor] = useState<string | null>(null)
  const expanded = sourceFor === text
  if (!formatted) return <Txt selectable role={typeRole} content="user" style={{ textAlign: userAlign }}>{text}</Txt>
  const label = t(lang, expanded ? 'message.hideSource' : 'message.showSource')
  return (
    <View style={{ maxWidth: '100%', minWidth: 0, gap: space.xs }}>
      <Markdown text={text} typeRole={typeRole} />
      <Pressable testID="message-source-toggle" accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded }}
        onPress={() => setSourceFor(expanded ? null : text)} hitSlop={6}
        style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
        <Txt role="caption" tone="inkSoft">{label}</Txt>
      </Pressable>
      {expanded ? <Txt testID="message-source-text" selectable role={typeRole} content="user">{text}</Txt> : null}
    </View>
  )
})

function Inline({ tokens, typeRole, tone = 'ink' }: { tokens: Token[]; typeRole: InlineRole; tone?: Tone }): ReactNode {
  const { c } = useTheme()
  return tokens.map((token, i) => {
    const nested = (nextTone = tone) => <Inline tokens={(token as { tokens?: Token[] }).tokens ?? []} typeRole={typeRole} tone={nextTone} />
    switch (token.type) {
      case 'checkbox': return null // 列表行的标记已经展示状态,宽松列表的段内 token 不再重复。
      case 'strong':
        // 中文使用已打包的衬线家族,重点用轻底色;强调色只给可点击动作。
        return <Txt key={i} role={typeRole} content="user" tone={tone} style={{ backgroundColor: c.ground }}>{nested()}</Txt>
      case 'em':
        return <Txt key={i} role={typeRole} content="user" tone={tone} style={{ textDecorationLine: 'underline' }}>{nested()}</Txt>
      case 'del':
        return <Txt key={i} role={typeRole} content="user" tone={tone} style={{ textDecorationLine: 'line-through' }}>{nested()}</Txt>
      case 'link': {
        const link = token as Tokens.Link
        const url = safeMarkdownUrl(link.href)
        return url ? (
          <Txt key={i} role={typeRole} content="user" tone="accent" accessibilityRole="link"
            onPress={() => { void Linking.openURL(url).catch(() => {}) }} style={{ textDecorationLine: 'underline' }}>
            {nested('accent')}
          </Txt>
        ) : <Txt key={i} role={typeRole} content="user" tone={tone}>{nested()}</Txt>
      }
      case 'image':
        return <Txt key={i} role={typeRole} content="user" tone="inkSoft">{decodeMarkdownEntities((token as Tokens.Image).text) || '📷'}</Txt>
      case 'codespan':
        return <Txt key={i} role="code" content="user" tone={tone} style={{ backgroundColor: c.rail }}>{(token as Tokens.Codespan).text}</Txt>
      case 'br': return '\n'
      case 'text':
        return token.tokens ? <Inline key={i} tokens={token.tokens} typeRole={typeRole} tone={tone} />
          : <Txt key={i} role={typeRole} content="user" tone={tone}>{decodeMarkdownEntities((token as Tokens.Text).text)}</Txt>
      case 'escape':
        return <Txt key={i} role={typeRole} content="user" tone={tone}>{(token as Tokens.Escape).text}</Txt>
      default:
        // HTML 是文字,不会创建原生控件或执行脚本;未知扩展也不会吞掉原文。
        return <Txt key={i} role={typeRole} content="user" tone={tone}>{token.raw}</Txt>
    }
  })
}

function Blocks({ tokens, typeRole }: { tokens: Token[]; typeRole: BodyRole }): ReactNode {
  const { c } = useTheme()
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'space': case 'def': case 'checkbox': return null
      case 'paragraph': case 'text':
        return <Txt key={i} selectable role={typeRole} content="user">
          {token.tokens ? <Inline tokens={token.tokens} typeRole={typeRole} /> : decodeMarkdownEntities((token as Tokens.Text).text)}
        </Txt>
      case 'heading': {
        const heading = token as Tokens.Heading
        return <Txt key={i} selectable role={heading.depth <= 2 ? 'title' : 'item'} content="user" accessibilityRole="header" style={{ paddingTop: space.s }}>
          <Inline tokens={heading.tokens} typeRole={heading.depth <= 2 ? 'title' : 'item'} />
        </Txt>
      }
      case 'code':
        return <ScrollView key={i} horizontal nestedScrollEnabled style={{ maxWidth: '100%', backgroundColor: c.rail, borderRadius: radius.nav }} contentContainerStyle={{ padding: space.m }}>
          <Txt selectable role="code" content="user">{(token as Tokens.Code).text}</Txt>
        </ScrollView>
      case 'blockquote':
        return <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: c.hair, paddingLeft: space.m, gap: space.s }}>
          <Blocks tokens={(token as Tokens.Blockquote).tokens} typeRole={typeRole} />
        </View>
      case 'list': {
        const list = token as Tokens.List
        return <View key={i} style={{ gap: space.s }}>
          {list.items.map((item, j) => (
            <View key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.s }}>
              <Txt role={typeRole} content="user" tone="inkSoft" style={{ minWidth: space.l }}>
                {item.task ? item.checked ? '☑' : '☐' : list.ordered ? `${Number(list.start) + j}.` : '•'}
              </Txt>
              <View style={{ flex: 1, minWidth: 0, gap: space.s }}><Blocks tokens={item.tokens} typeRole={typeRole} /></View>
            </View>
          ))}
        </View>
      }
      case 'table': {
        const table = token as Tokens.Table
        return <ScrollView key={i} horizontal nestedScrollEnabled style={{ maxWidth: '100%' }}>
          <View style={{ borderWidth: 1, borderColor: c.hair, borderRadius: radius.nav, overflow: 'hidden' }}>
            {[table.header, ...table.rows].map((row, j) => (
              <View key={j} style={{ flexDirection: 'row', backgroundColor: j === 0 ? c.rail : c.paper, borderTopWidth: j === 0 ? 0 : 1, borderTopColor: c.hair }}>
                {row.map((cell, k) => (
                  <View key={k} style={{ width: 160, padding: space.s, borderLeftWidth: k === 0 ? 0 : 1, borderLeftColor: c.hair }}>
                    <Txt selectable role={typeRole} content="user" style={{ textAlign: cell.align ?? 'left' }}>
                      <Inline tokens={cell.tokens} typeRole={typeRole} tone={j === 0 ? 'accent' : 'ink'} />
                    </Txt>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      }
      case 'hr': return <View key={i} style={{ height: 1, backgroundColor: c.hair, marginVertical: space.xs }} />
      default: return <Txt key={i} selectable role={typeRole} content="user">{token.raw}</Txt>
    }
  })
}

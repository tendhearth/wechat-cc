import { decodeMarkdownEntities, parseMarkdown, safeMarkdownUrl, type Token, type Tokens } from '@wechat-cc/markdown'
import { memo, useMemo, type ReactNode } from 'react'
import { Linking, ScrollView, View } from 'react-native'
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

/** 用户消息保持原样。系统、错误、工具日志不进入此组件。 */
export function MessageText({ text, role, typeRole = 'body', userAlign = 'left' }: Props & { role: 'user' | 'assistant'; userAlign?: 'left' | 'right' }) {
  return role === 'assistant' ? <Markdown text={text} typeRole={typeRole} /> : <Txt selectable role={typeRole} content="user" style={{ textAlign: userAlign }}>{text}</Txt>
}

function Inline({ tokens, typeRole, tone = 'ink' }: { tokens: Token[]; typeRole: InlineRole; tone?: Tone }): ReactNode {
  const { c } = useTheme()
  return tokens.map((token, i) => {
    const nested = (nextTone = tone) => <Inline tokens={(token as { tokens?: Token[] }).tokens ?? []} typeRole={typeRole} tone={nextTone} />
    switch (token.type) {
      case 'strong':
        // 中文只有已打包的 Regular 家族,重点靠字色和轻底色表现,不会让字形回退。
        return <Txt key={i} role={typeRole} content="user" tone="accent" style={{ backgroundColor: c.rail }}>{nested('accent')}</Txt>
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

import type { ReactNode } from 'react'
import type { PermissionDisplay } from '@wechat-cc/protocol'
import { Pressable, View } from 'react-native'
import { labelJoin, t, tCount, type Lang } from '../i18n'
import { approvalLines, approvalRelativePath } from '../view/approval'
import { DiffLine } from './DiffLine'
import { monoFamily } from './fonts'
import { Txt } from './Txt'
import { componentAppearance, space } from './tokens'
import { useTheme } from './useTheme'

type Body = PermissionDisplay['body']
type Field = NonNullable<PermissionDisplay['extra']>[number]

function readFields(fields: Field[]): string {
  return fields.map(({ name, value }) => labelJoin(name, value)).join(', ')
}

function operationLabel(body: Body, cwd: string, lang: Lang): string {
  const path = (value: string) => approvalRelativePath(value, cwd)
  switch (body.kind) {
    case 'command': return [t(lang, 'approval.readCommand', { command: body.command }), cwd && t(lang, 'approval.inDirectory', { path: cwd })].filter(Boolean).join(', ')
    case 'edit': return t(lang, 'approval.readEdit', {
      path: path(body.path),
      before: body.changes.reduce((n, edit) => n + approvalLines(edit.before).length, 0),
      after: body.changes.reduce((n, edit) => n + approvalLines(edit.after).length, 0),
    })
    case 'write': return t(lang, 'approval.readWrite', { path: path(body.path), n: approvalLines(body.content).length })
    case 'patch': return t(lang, 'approval.readPatch', { n: body.files.length, paths: body.files.map(file => path(file.path)).join(', ') })
    case 'url': return [t(lang, 'approval.readUrl', { value: body.url }), body.prompt && t(lang, 'approval.fetchPrompt', { prompt: body.prompt })].filter(Boolean).join(', ')
    case 'query': return t(lang, 'approval.readQuery', { value: body.query })
    case 'fields': return t(lang, 'approval.readFields', { value: readFields(body.fields) })
    case 'text': return body.text
  }
}

function Panel({ children, testID }: { children: ReactNode; testID?: string }) {
  const { c } = useTheme()
  const appearance = componentAppearance.message
  return <View testID={testID} style={{
    gap: space.s, borderRadius: appearance.radius, backgroundColor: c[appearance.userBackground],
    paddingHorizontal: appearance.paddingX, paddingVertical: appearance.paddingY,
  }}>{children}</View>
}

// The accessibility label reads the operation as a unit. “See all” stays a separate button.
function Visual({ children, label }: { children: ReactNode; label?: string }) {
  const visual = <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{children}</View>
  return label ? <View testID="approval-operation-label" accessible accessibilityRole="text" accessibilityLabel={label}>{visual}</View> : visual
}

function More({ label, open }: { label: string; open: () => void }) {
  return <Pressable testID="approval-operation-more" accessibilityRole="button" accessibilityLabel={label}
    onPress={open} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
    <Txt role="small" tone="inkSoft">{label}</Txt>
  </Pressable>
}

function FieldTable({ fields, lang, open, label }: { fields: Field[]; lang: Lang; open: () => void; label?: string }) {
  let remaining = 8
  const rows = fields.flatMap(({ name, value }, index) => {
    const lines = approvalLines(value)
    const count = Math.max(1, lines.length)
    const visible = Math.max(0, remaining)
    remaining -= count
    if (!visible) return []
    return [<View key={index} style={{ flexDirection: 'row', gap: space.m, paddingBottom: space.xs }}>
      <Txt selectable role="small" tone="inkSoft" style={{ flex: 1 }}>{name}</Txt>
      <Txt selectable role="code" style={{ flex: 2 }}>{lines.length > visible ? lines.slice(0, visible).join('\n') : value}</Txt>
    </View>]
  })
  return <><Visual label={label}>{rows}</Visual>{remaining < 0 ? <More label={t(lang, 'approval.full')} open={open} /> : null}</>
}

function FilePath({ path, detail }: { path: string; detail?: string }) {
  return <Txt selectable role="caption" tone="inkSoft" style={{ fontFamily: monoFamily, marginBottom: space.xs }}>{path}{detail ? ` ${detail}` : ''}</Txt>
}

function changeLabel(change: string, lang: Lang) {
  let kind = change
  try {
    const parsed = JSON.parse(change)
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed)
      // Show the full descriptor if this version carries unfamiliar metadata.
      if (keys.some(key => !['type', 'move_path', 'movePath'].includes(key)) || keys.length > 2) return change
      const destination = parsed.move_path ?? parsed.movePath
      if (typeof destination === 'string') return `${t(lang, 'approval.change.rename')} → ${destination}`
      if (destination != null) return change
      kind = parsed.type
    }
  } catch { /* Older entries use a plain change name. */ }
  if (kind === 'add' || kind === 'update' || kind === 'delete') return t(lang, `approval.change.${kind}`)
  if (kind === 'move' || kind === 'rename') return t(lang, 'approval.change.rename')
  return change
}

function UrlText({ url }: { url: string }) {
  const parts = /^([a-z][\w+.-]*:\/\/)([^/?#]*@)?(\[[^\]]+\]|[^:/?#]+)([\s\S]*)$/i.exec(url)
  return <Txt selectable role="code" tone="inkSoft">{parts
    ? <>{parts[1]}{parts[2]}<Txt role="code" tone="ink">{parts[3]}</Txt>{parts[4]}</>
    : url}</Txt>
}

function OperationBody({ body, cwd, lang, open, label }: { body: Body; cwd: string; lang: Lang; open: () => void; label: string }) {
  const path = (value: string) => approvalRelativePath(value, cwd)
  switch (body.kind) {
    case 'command':
    case 'text': {
      const command = body.kind === 'command'
      const original = command ? body.command : body.text
      const lines = approvalLines(original)
      const hidden = lines.length - 8
      const preview = hidden > 0 ? lines.slice(0, 8).join('\n') : original
      return <>
        <Visual label={label}><View style={{ flexDirection: 'row' }}>
          {command ? <Txt role="code" tone="inkSoft">{'$ '}</Txt> : null}
          <Txt selectable role="code" testID="approval-operation-source" style={{ flex: 1 }}>{preview}</Txt>
        </View></Visual>
        {hidden > 0 ? <More label={tCount(lang, 'approval.moreLines', hidden)} open={open} /> : null}
      </>
    }
    case 'edit': return <>
      <Visual label={label}><FilePath path={path(body.path)} detail={body.replaceAll ? t(lang, 'approval.replaceAll') : undefined} /></Visual>
      {body.changes.map(({ before, after }, i) => {
        const rows = [
          ...approvalLines(before).map(line => ({ line: `− ${line}`, kind: 'remove' as const })),
          ...approvalLines(after).map(line => ({ line: `+ ${line}`, kind: 'add' as const })),
        ]
        return <View key={i} testID={`approval-edit-${i}`}>
          <Visual>{rows.slice(0, 12).map(({ line, kind }, j) => <DiffLine key={j} line={line} kind={kind} highlight selectable />)}</Visual>
          {rows.length > 12 ? <More label={t(lang, 'approval.full')} open={open} /> : null}
        </View>
      })}
    </>
    case 'write': {
      const lines = approvalLines(body.content)
      return <>
        <Visual label={label}><FilePath path={path(body.path)} />{lines.slice(0, 12).map((line, i) => <DiffLine key={i} line={`+ ${line}`} kind="add" highlight selectable />)}</Visual>
        {lines.length > 12 ? <More label={t(lang, 'approval.allLines', { n: lines.length })} open={open} /> : null}
      </>
    }
    case 'patch': return <>{body.files.map((file, i) => {
      const lines = approvalLines(file.diff)
      return <View key={i} testID={`approval-patch-${i}`}>
        <Visual label={i === 0 ? label : undefined}>
          <FilePath path={path(file.path)} detail={`(${changeLabel(file.change, lang)})`} />
          {lines.slice(0, 12).map((line, j) => <DiffLine key={j} line={line} selectable highlight kind={
            line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : undefined
          } />)}
        </Visual>
        {lines.length > 12 ? <More label={t(lang, 'approval.full')} open={open} /> : null}
      </View>
    })}</>
    case 'url': return <Visual label={label}><UrlText url={body.url} /></Visual>
    case 'query': return <Visual label={label}><Txt selectable role="code">{lang === 'zh-Hans' ? `「${body.query}」` : `“${body.query}”`}</Txt></Visual>
    case 'fields': return <FieldTable fields={body.fields} lang={lang} open={open} label={label} />
  }
}

export function PermissionOperation({ display, cwd, lang, open }: {
  display: PermissionDisplay; cwd: string; lang: Lang; open: () => void
}) {
  const { body, extra } = display
  const spoken = [operationLabel(body, cwd, lang), extra?.length ? readFields(extra) : ''].filter(Boolean).join(', ')
  return <View style={{ gap: space.s }}>
    <Panel testID={`approval-operation-${body.kind}`}>
      <OperationBody body={body} cwd={cwd} lang={lang} open={open} label={spoken} />
    </Panel>
    {body.kind === 'command' && cwd ? <Visual><Txt selectable testID="approval-operation-cwd" role="small" tone="inkSoft">{t(lang, 'approval.inDirectory', { path: cwd })}</Txt></Visual> : null}
    {body.kind === 'url' && body.prompt ? <Visual><Txt selectable role="small" tone="inkSoft">{t(lang, 'approval.fetchPrompt', { prompt: body.prompt })}</Txt></Visual> : null}
    {extra?.length ? <Panel testID="approval-operation-extra"><FieldTable fields={extra} lang={lang} open={open} /></Panel> : null}
  </View>
}

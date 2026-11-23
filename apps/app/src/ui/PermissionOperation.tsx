import type { ReactNode } from 'react'
import { hasInvisiblePermissionText, permissionEditPreview, permissionOperationSource, type PermissionDisplay } from '@wechat-cc/protocol'
import { Pressable, View } from 'react-native'
import { labelJoin, t, tCount, type Lang } from '../i18n'
import { approvalDirectory, approvalLines, approvalRelativePath } from '../view/approval'
import { DiffLine } from './DiffLine'
import { PermissionInvisibleNotice, PermissionText, PermissionTextRuns, spokenPermissionText } from './PermissionText'
import { monoFamily } from './fonts'
import { Txt } from './Txt'
import { componentAppearance, space } from './tokens'
import { useTheme } from './useTheme'

type Body = PermissionDisplay['body']
type Field = NonNullable<PermissionDisplay['extra']>[number]

function readFields(fields: Field[]): string {
  return fields.map(({ name, value }) => labelJoin(name, value)).join(', ')
}

function operationLabel(body: Body, projectPath: string, lang: Lang): string {
  const path = (value: string) => approvalRelativePath(value, projectPath)
  switch (body.kind) {
    case 'command': return t(lang, 'approval.readCommand', { command: body.command })
    case 'edit': return [t(lang, 'approval.readEdit', {
      path: [...new Set(body.changes.map(edit => path(edit.path ?? body.path)))].join(', '),
      before: body.changes.reduce((n, edit) => n + approvalLines(edit.before).length, 0),
      after: body.changes.reduce((n, edit) => n + approvalLines(edit.after).length, 0),
    }), body.replaceAll && t(lang, 'approval.replaceAll')].filter(Boolean).join(', ')
    case 'write': return t(lang, 'approval.readWrite', { path: path(body.path), n: approvalLines(body.content).length })
    case 'patch': return t(lang, 'approval.readPatch', {
      n: body.files.length,
      paths: body.files.map(file => `${path(file.path)}, ${changeLabel(file.change, file.movePath === undefined ? undefined : path(file.movePath), lang, true)}`).join(lang === 'zh-Hans' ? '。' : '. '),
    })
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

function More({ label, open }: { label: string; open?: () => void }) {
  if (!open) return null
  return <Pressable testID="approval-operation-more" accessibilityRole="button" accessibilityLabel={label}
    onPress={open} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
    <Txt role="small" tone="inkSoft">{label}</Txt>
  </Pressable>
}

function FieldTable({ fields, lang, open, label, moreLabel }: { fields: Field[]; lang: Lang; open?: () => void; label?: string; moreLabel?: string }) {
  let remaining = 8
  const rows = fields.flatMap(({ name, value }, index) => {
    const lines = approvalLines(value)
    const count = Math.max(1, lines.length)
    const visible = Math.max(0, remaining)
    remaining -= count
    if (!visible) return []
    return [<View key={index} style={{ flexDirection: 'row', gap: space.m, paddingBottom: space.xs }}>
      <PermissionText selectable role="small" tone="inkSoft" style={{ flex: 1 }} value={name} lang={lang} />
      <PermissionText selectable role="code" style={{ flex: 2 }} value={lines.length > visible ? lines.slice(0, visible).join('\n') : value} lang={lang} />
    </View>]
  })
  return <><Visual label={label}>{rows}</Visual>{remaining < 0 ? <More label={moreLabel ?? t(lang, 'approval.full')} open={open} /> : null}</>
}

function FilePath({ path, detail, lang }: { path: string; detail?: string; lang: Lang }) {
  return <PermissionText selectable role="caption" tone="inkSoft" style={{ fontFamily: monoFamily, marginBottom: space.xs }}
    value={detail ? `${path} ${detail}` : path} lang={lang} />
}

function ApprovalDiffLine({ line, kind }: { line: string; kind?: 'add' | 'remove' }) {
  return <DiffLine line={line} kind={kind} highlight selectable><PermissionTextRuns value={line || ' '} /></DiffLine>
}

function changeLabel(kind: string, destination: string | undefined, lang: Lang, spoken = false) {
  if (destination !== undefined) return spoken ? t(lang, 'approval.change.destination', { path: destination })
    : `${t(lang, 'approval.change.rename')} → ${destination}`
  if (kind === 'add' || kind === 'update' || kind === 'delete') return t(lang, `approval.change.${kind}`)
  if (kind === 'move' || kind === 'rename') return t(lang, 'approval.change.rename')
  return kind
}

function UrlText({ url }: { url: string }) {
  const parts = /^([a-z][\w+.-]*:\/\/)([^/?#]*@)?(\[[^\]]+\]|[^:/?#]+)([\s\S]*)$/i.exec(url)
  return <Txt selectable role="code" tone="inkSoft">{parts
    ? <><PermissionTextRuns value={parts[1] + (parts[2] ?? '')} /><Txt role="code" tone="ink"><PermissionTextRuns value={parts[3]} /></Txt><PermissionTextRuns value={parts[4]} /></>
    : <PermissionTextRuns value={url} />}</Txt>
}

function OperationBody({ body, truncated, projectPath, lang, open, label, moreLabel }: { body: Body; truncated?: boolean; projectPath: string; lang: Lang; open?: () => void; label: string; moreLabel?: string }) {
  const path = (value: string) => approvalRelativePath(value, projectPath)
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
          <PermissionText selectable role="code" testID="approval-operation-source" style={{ flex: 1 }} value={preview} lang={lang} />
        </View></Visual>
        {hidden > 0 ? <More label={moreLabel ?? tCount(lang, 'approval.moreLines', hidden)} open={open} /> : null}
      </>
    }
    case 'edit': return <>
      <Visual label={label}><FilePath lang={lang} path={path(body.path)} detail={body.replaceAll ? t(lang, 'approval.replaceAll') : undefined} /></Visual>
      {body.changes.map(({ before, after, path: changePath }, i) => {
        const edit = permissionEditPreview(before, after)
        const rows = [
          ...edit.before.map(line => ({ line: `− ${line}`, kind: 'remove' as const })),
          ...edit.after.map(line => ({ line: `+ ${line}`, kind: 'add' as const })),
        ]
        return <View key={i} testID={`approval-edit-${i}`}>
          <Visual>{changePath && changePath !== body.path ? <FilePath lang={lang} path={path(changePath)} /> : null}{rows.slice(0, 12).map(({ line, kind }, j) => <ApprovalDiffLine key={j} line={line} kind={kind} />)}</Visual>
          {edit.finalNewlineChange ? <Txt role="small" tone="inkSoft">{t(lang,
            edit.finalNewlineChange === 'removed' ? 'approval.fragmentNewlineRemoved' : 'approval.fragmentNewlineAdded')}</Txt> : null}
          {edit.whitespaceChange ? <Txt role="small" tone="inkSoft">{t(lang, 'approval.whitespaceChange')}</Txt> : null}
          {rows.length > 12 ? <More label={moreLabel ?? t(lang, 'approval.full')} open={open} /> : null}
        </View>
      })}
    </>
    case 'write': {
      const lines = approvalLines(body.content)
      return <>
        <Visual label={label}><FilePath lang={lang} path={path(body.path)} />{lines.slice(0, 12).map((line, i) => <ApprovalDiffLine key={i} line={`+ ${line}`} kind="add" />)}</Visual>
        {body.content && !body.content.endsWith('\n') && !truncated ? <Txt role="small" tone="inkSoft">{t(lang, 'approval.noFinalNewline')}</Txt> : null}
        {lines.length > 12 ? <More label={moreLabel ?? t(lang, 'approval.allLines', { n: lines.length })} open={open} /> : null}
      </>
    }
    case 'patch': return <>{body.files.map((file, i) => {
      const lines = approvalLines(file.diff)
      return <View key={i} testID={`approval-patch-${i}`}>
        <Visual label={i === 0 ? label : undefined}>
          <FilePath lang={lang} path={path(file.path)} detail={`(${changeLabel(file.change, file.movePath === undefined ? undefined : path(file.movePath), lang)})`} />
          {lines.slice(0, 12).map((line, j) => <ApprovalDiffLine key={j} line={line} kind={
            line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : undefined
          } />)}
        </Visual>
        {lines.length > 12 ? <More label={moreLabel ?? t(lang, 'approval.full')} open={open} /> : null}
      </View>
    })}</>
    case 'url': return <Visual label={label}><UrlText url={body.url} /></Visual>
    case 'query': return <Visual label={label}><PermissionText selectable role="code" lang={lang} value={lang === 'zh-Hans' ? `「${body.query}」` : `“${body.query}”`} /></Visual>
    case 'fields': return <FieldTable fields={body.fields} lang={lang} open={open} label={label} moreLabel={moreLabel} />
  }
}

export function PermissionOperation({ display, projectPath, cwd, lang, open, testID, moreLabel, source, summaryOnly }: {
  display: PermissionDisplay; projectPath: string; cwd?: string | undefined; lang: Lang; open?: () => void; testID?: string; moreLabel?: string; source?: string; summaryOnly?: boolean
}) {
  const { body, extra } = display
  const directory = approvalDirectory(cwd, projectPath, lang)
  const pathBase = cwd ?? projectPath
  const diff = body.kind === 'edit' ? body.changes.flatMap(({ before, after }) => [...approvalLines(before), ...approvalLines(after)])
    : body.kind === 'write' ? approvalLines(body.content)
    : body.kind === 'patch' ? body.files.flatMap(file => approvalLines(file.diff)) : []
  const spoken = spokenPermissionText([operationLabel(body, pathBase, lang), extra?.length ? readFields(extra) : '',
    ...diff.filter(hasInvisiblePermissionText), directory].filter(Boolean).join(', '), lang)
  const marked = [permissionOperationSource(display), directory, source ?? ''].some(hasInvisiblePermissionText)
  return <View testID={testID} style={{ gap: space.s }}>
    {summaryOnly ? <Txt testID="terminal-summary-label" role="small" tone="inkSoft">{t(lang, 'terminal.summary')}</Txt> : null}
    <Panel testID={`approval-operation-${body.kind}`}>
      <OperationBody body={body} truncated={display.truncated || summaryOnly} projectPath={pathBase} lang={lang} open={open} label={spoken} moreLabel={moreLabel} />
    </Panel>
    {summaryOnly ? <Txt testID="terminal-summary-whitespace" role="small" tone="inkSoft">{t(lang, 'terminal.summaryWhitespace')}</Txt> : null}
    {directory ? <Visual><PermissionText selectable testID="approval-operation-cwd" role="small" tone="inkSoft" lang={lang} value={directory} /></Visual> : null}
    {body.kind === 'url' && body.prompt ? <Visual><PermissionText selectable role="small" tone="inkSoft" lang={lang} value={t(lang, 'approval.fetchPrompt', { prompt: body.prompt })} /></Visual> : null}
    {/* 多出来的字段一个都不吞,但不和主体抢:不带底,小字表 */}
    {extra?.length ? <View testID="approval-operation-extra"><FieldTable fields={extra} lang={lang} open={open} moreLabel={moreLabel} /></View> : null}
    {marked ? <PermissionInvisibleNotice lang={lang} /> : null}
  </View>
}

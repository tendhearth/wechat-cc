import type { ReactNode } from 'react'
import { permissionEditPreview, type PermissionDisplay } from '@wechat-cc/protocol'
import { Pressable, View } from 'react-native'
import { labelJoin, t, tCount, type Lang } from '../i18n'
import { approvalDirectory, approvalLines, approvalRelativePath } from '../view/approval'
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
      <Txt selectable role="small" tone="inkSoft" style={{ flex: 1 }}>{name}</Txt>
      <Txt selectable role="code" style={{ flex: 2 }}>{lines.length > visible ? lines.slice(0, visible).join('\n') : value}</Txt>
    </View>]
  })
  return <><Visual label={label}>{rows}</Visual>{remaining < 0 ? <More label={moreLabel ?? t(lang, 'approval.full')} open={open} /> : null}</>
}

function FilePath({ path, detail }: { path: string; detail?: string }) {
  return <Txt selectable role="caption" tone="inkSoft" style={{ fontFamily: monoFamily, marginBottom: space.xs }}>{path}{detail ? ` ${detail}` : ''}</Txt>
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
    ? <>{parts[1]}{parts[2]}<Txt role="code" tone="ink">{parts[3]}</Txt>{parts[4]}</>
    : url}</Txt>
}

function OperationBody({ body, projectPath, lang, open, label, moreLabel }: { body: Body; projectPath: string; lang: Lang; open?: () => void; label: string; moreLabel?: string }) {
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
          <Txt selectable role="code" testID="approval-operation-source" style={{ flex: 1 }}>{preview}</Txt>
        </View></Visual>
        {hidden > 0 ? <More label={moreLabel ?? tCount(lang, 'approval.moreLines', hidden)} open={open} /> : null}
      </>
    }
    case 'edit': return <>
      <Visual label={label}><FilePath path={path(body.path)} detail={body.replaceAll ? t(lang, 'approval.replaceAll') : undefined} /></Visual>
      {body.changes.map(({ before, after, path: changePath }, i) => {
        const edit = permissionEditPreview(before, after)
        const noNewline = { line: t(lang, 'approval.noFinalNewline'), kind: undefined }
        const rows = [
          ...edit.before.map(line => ({ line: `− ${line}`, kind: 'remove' as const })),
          ...(edit.noFinalNewline === 'before' ? [noNewline] : []),
          ...edit.after.map(line => ({ line: `+ ${line}`, kind: 'add' as const })),
          ...(edit.noFinalNewline === 'after' ? [noNewline] : []),
        ]
        return <View key={i} testID={`approval-edit-${i}`}>
          <Visual>{changePath && changePath !== body.path ? <FilePath path={path(changePath)} /> : null}{rows.slice(0, 12).map(({ line, kind }, j) => <DiffLine key={j} line={line} kind={kind} highlight selectable />)}</Visual>
          {rows.indexOf(noNewline) >= 12 ? <Txt role="small" tone="inkSoft">{t(lang,
            edit.noFinalNewline === 'before' ? 'approval.noFinalNewlineBefore' : 'approval.noFinalNewlineAfter')}</Txt> : null}
          {edit.whitespaceChange ? <Txt role="small" tone="inkSoft">{t(lang, 'approval.whitespaceChange')}</Txt> : null}
          {rows.length > 12 ? <More label={moreLabel ?? t(lang, 'approval.full')} open={open} /> : null}
        </View>
      })}
    </>
    case 'write': {
      const lines = approvalLines(body.content)
      return <>
        <Visual label={label}><FilePath path={path(body.path)} />{lines.slice(0, 12).map((line, i) => <DiffLine key={i} line={`+ ${line}`} kind="add" highlight selectable />)}</Visual>
        {lines.length > 12 ? <More label={moreLabel ?? t(lang, 'approval.allLines', { n: lines.length })} open={open} /> : null}
      </>
    }
    case 'patch': return <>{body.files.map((file, i) => {
      const lines = approvalLines(file.diff)
      return <View key={i} testID={`approval-patch-${i}`}>
        <Visual label={i === 0 ? label : undefined}>
          <FilePath path={path(file.path)} detail={`(${changeLabel(file.change, file.movePath === undefined ? undefined : path(file.movePath), lang)})`} />
          {lines.slice(0, 12).map((line, j) => <DiffLine key={j} line={line} selectable highlight kind={
            line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : undefined
          } />)}
        </Visual>
        {lines.length > 12 ? <More label={moreLabel ?? t(lang, 'approval.full')} open={open} /> : null}
      </View>
    })}</>
    case 'url': return <Visual label={label}><UrlText url={body.url} /></Visual>
    case 'query': return <Visual label={label}><Txt selectable role="code">{lang === 'zh-Hans' ? `「${body.query}」` : `“${body.query}”`}</Txt></Visual>
    case 'fields': return <FieldTable fields={body.fields} lang={lang} open={open} label={label} moreLabel={moreLabel} />
  }
}

export function PermissionOperation({ display, projectPath, cwd, lang, open, testID, moreLabel }: {
  display: PermissionDisplay; projectPath: string; cwd?: string | undefined; lang: Lang; open?: () => void; testID?: string; moreLabel?: string
}) {
  const { body, extra } = display
  const directory = approvalDirectory(cwd, projectPath, lang)
  const pathBase = cwd ?? projectPath
  const spoken = [operationLabel(body, pathBase, lang), directory, extra?.length ? readFields(extra) : ''].filter(Boolean).join(', ')
  return <View testID={testID} style={{ gap: space.s }}>
    <Panel testID={`approval-operation-${body.kind}`}>
      <OperationBody body={body} projectPath={pathBase} lang={lang} open={open} label={spoken} moreLabel={moreLabel} />
    </Panel>
    {directory ? <Visual><Txt selectable testID="approval-operation-cwd" role="small" tone="inkSoft">{directory}</Txt></Visual> : null}
    {body.kind === 'url' && body.prompt ? <Visual><Txt selectable role="small" tone="inkSoft">{t(lang, 'approval.fetchPrompt', { prompt: body.prompt })}</Txt></Visual> : null}
    {/* 多出来的字段一个都不吞,但不和主体抢:不带底,小字表 */}
    {extra?.length ? <View testID="approval-operation-extra"><FieldTable fields={extra} lang={lang} open={open} moreLabel={moreLabel} /></View> : null}
  </View>
}

import type { ComponentProps } from 'react'
import { permissionTextSegments } from '@wechat-cc/protocol'
import { t, type Lang } from '../i18n'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

export function spokenPermissionText(value: string, lang: Lang): string {
  return permissionTextSegments(value).map(({ text, marked }) =>
    marked ? ` ${t(lang, 'approval.invisibleCharacter', { text })} ` : text).join('')
}

export function PermissionTextRuns({ value }: { value: string }) {
  const { c } = useTheme()
  return <>{permissionTextSegments(value).map(({ text, marked }, i) => marked
    ? <Txt key={i} testID="approval-invisible" role="inherit" tone="inkSoft" style={{ backgroundColor: c.ground, writingDirection: 'ltr' }}>{text}</Txt>
    : text)}</>
}

export function PermissionText({ value, lang, ...props }: Omit<ComponentProps<typeof Txt>, 'children'> & { value: string; lang: Lang }) {
  const spoken = spokenPermissionText(value, lang)
  return <Txt {...props} accessible={spoken !== value ? true : props.accessible}
    accessibilityLabel={spoken !== value ? spoken : props.accessibilityLabel}><PermissionTextRuns value={value} /></Txt>
}

export function PermissionInvisibleNotice({ lang }: { lang: Lang }) {
  return <Txt testID="approval-invisible-notice" role="small" tone="inkSoft">{t(lang, 'approval.invisibleNotice')}</Txt>
}

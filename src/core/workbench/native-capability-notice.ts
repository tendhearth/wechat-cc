import type { NativeClaudeTools } from './claude-native-config'

const display = (value: string) => value.replace(/[^A-Za-z0-9_.@/-]/g, '_').slice(0, 120)
const list = (names: string[], reason: (name: string) => string) => {
  const visible = names.slice(0, 24).map(name => `${display(name) || '名称无效'}（${reason(name).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100)}）`)
  if (names.length > visible.length) visible.push(`其余 ${names.length - visible.length} 项`)
  return visible.join('；')
}

/** These notices belong to the task journal, not the model conversation. */
export function claudeNativeCapabilityNotice(native: NativeClaudeTools): string | null {
  const parts: string[] = []
  if (native.omitted.length) parts.push(`本次未带入的本机工具：${list(native.omitted, name => native.omissionReasons?.[name] ?? '未获本机批准或当前接入方式不支持')}。`)
  if (Object.keys(native.disabledPlugins ?? {}).length) parts.push('本次不加载原生插件及其自动 hook；支持的直接配置工具仍可按次批准使用。')
  return parts.length ? parts.join('\n').slice(0, 4000) : null
}

export function codexNativeCapabilityNotice(discovered: unknown, enabled: Set<string>): string | null {
  if (!Array.isArray(discovered)) return null
  const names = discovered.filter(value => value && typeof value.name === 'string' && value.enabled === true && !enabled.has(value.name)).map(value => value.name as string)
  return names.length ? `本次未带入的本机工具：${list(names, () => '陪伴专用工具或当前接入方式不支持')}。其余直接配置工具保留逐次批准。`.slice(0, 4000) : null
}

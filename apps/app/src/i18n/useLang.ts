import { getLocales } from 'expo-localization'
import { pickLang, type Lang } from './index'

// 目前只跟随系统;设置里手动改语言在后续任务接入(会在这里叠一层存储的覆盖值)。
export function useLang(): Lang {
  return pickLang(getLocales().map((l) => l.languageTag))
}

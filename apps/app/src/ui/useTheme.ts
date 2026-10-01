import { palette } from './tokens'

/** 不跟系统变:永远同一套(spec 2026-10-01 §1.8)。键名就是共用 token 的键名(paper / ink / inkSoft / hair / accent …)。 */
export function useTheme() { return { c: palette } }

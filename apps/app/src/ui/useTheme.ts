import { palette, type Palette } from './tokens'

/** 旧键名 → 新 token 的过渡别名(Task 6 删掉,守卫测试届时禁止旧键名)。 */
type LegacyAliases = { bg: string; card: string; muted: string; line: string; primary: string; primaryInk: string; navOnBg: string; navOnInk: string; accentSoft: string; danger: string }
const c: Palette & LegacyAliases = {
  ...palette,
  bg: palette.paper, card: palette.paper, muted: palette.inkSoft, line: palette.hair,
  primary: palette.accent, primaryInk: palette.onAccent, navOnBg: palette.rail, navOnInk: palette.ink,
  accentSoft: 'transparent', danger: palette.bad,
}
/** 不跟系统变:永远同一套(spec 2026-10-01 §1.8)。 */
export function useTheme() { return { c } }

import { rewriteSystemPath } from '../push/open'

// 系统交来的深链(安卓点通知、别的 app 发的 tendhearth://…)进路由之前先洗一遍:见 push/open.ts rewriteSystemPath。
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try { return rewriteSystemPath(path, __DEV__) } catch { return '/' }
}

import { useLinkingURL } from 'expo-linking'
import { usePathname, useRouter } from 'expo-router'
import { getShareExtensionKey, ShareIntentModule } from 'expo-share-intent'
import { useEffect, useRef } from 'react'
import { AppState, Platform } from 'react-native'
import { PHONE_CHAT_MAX_IMAGES } from '@wechat-cc/protocol'
import { isShareExtensionUrl, normalizeShare } from '../view/share'
import { getShare, putShare } from './share-inbox'
import { useSession } from './session'

/**
 * 分享给 CC(2026-10-18):接系统分享面板交来的内容,放进 share-inbox,打开 /share 让主人选去处。不画东西。
 * 不用 expo-share-intent 的 useShareIntent:它的 parseShareIntent 把安卓的 content:// 换成读不了的文件路径(见 view/share.ts),
 * 这里直接听原生模块,取法照它:iOS 等分享扩展开的 tendhearth://dataUrl=… 链接(+native-intent 已把路由改到 /share),
 * 安卓在启动与每次回前台时问一次(取走即清,重复问不会重复给)。
 * 老的 development build 里没有这个原生模块 ⇒ 整个不生效。
 * 没配对时分享进来:分享页先请主人配对 / 先看看;配好(或选了先看看)回到别的页时,把还没选去处的那份重新打开。
 */
export function ShareGate() {
  const router = useRouter()
  const pathname = usePathname()
  const url = useLinkingURL()
  const { seenWelcome } = useSession()
  const m = ShareIntentModule

  useEffect(() => {
    if (!m) return
    const key = getShareExtensionKey()
    const changed = m.addListener('onChange', e => {
      putShare(normalizeShare(e.value as unknown, PHONE_CHAT_MAX_IMAGES))
      void Promise.resolve(m.clearShareIntent(key)).catch(() => {})
      if (Platform.OS === 'android') router.navigate('/share')
    })
    // 扩展 / 模块认不出来的内容(iOS 已经被链接带到 /share):给分享页一份空的,它说「这一版只收文字、链接和图片」,只剩「算了」
    const failed = m.addListener('onError', () => {
      putShare({ text: '', images: [], overMax: false, unsupported: 1, tooLarge: 0 })
      if (Platform.OS === 'android') router.navigate('/share')
    })
    return () => { changed.remove(); failed.remove() }
  }, [m, router])

  useEffect(() => {
    if (!m || Platform.OS !== 'ios' || !isShareExtensionUrl(url)) return
    try { m.getShareIntent(url!) } catch { /* onError 会说 */ }
  }, [m, url])

  useEffect(() => {
    if (!m || Platform.OS !== 'android') return
    const ask = () => { try { m.getShareIntent('') } catch { /* 没有就算了 */ } }
    ask()
    const sub = AppState.addEventListener('change', s => { if (s === 'active') ask() })
    return () => sub.remove()
  }, [m])

  // 配对 / 先看看之后接着选:只在「刚变成可以用」那一下记住,等配对页自己跳完(它 replace 到此刻)再打开分享页。
  const prevSeen = useRef(seenWelcome)
  const resume = useRef(false)
  useEffect(() => {
    if (!prevSeen.current && seenWelcome && getShare()) resume.current = true
    prevSeen.current = seenWelcome
    if (!resume.current) return
    if (!getShare()) { resume.current = false; return }
    if (pathname === '/share' || pathname === '/pair' || pathname === '/welcome') return
    resume.current = false
    router.navigate('/share')
  }, [seenWelcome, pathname, router])

  return null
}

import { useRouter } from 'expo-router'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { getDraft, putDraftImages, setDraft } from '../state/drafts'
import type { ImageCheck, PickedImage } from '../state/image-upload'
import { useSession } from '../state/session'
import { clearShare, getShare, subscribeShare } from '../state/share-inbox'
import { Button } from '../ui/Button'
import { ImageTray } from '../ui/ImageTray'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { mergeDraftText, shareGate, shareRoute, type ShareChoice } from '../view/share'

// 分享给 CC(2026-10-18):别的 app 分享进来的文字 / 链接 / 图片,先摆出来,主人选「跟 CC 说」或「交给 CC 做一件事」——
// 两条路都只是预填输入框、带上图,不替主人发。没配对 ⇒ 先配对或先看看(分享留着);「算了」清掉。
export default function Share() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const session = useSession()
  const pending = useSyncExternalStore(subscribeShare, getShare)
  const draft = pending?.draft
  const [images, setImages] = useState<PickedImage[]>([])
  const [skipped, setSkipped] = useState<Exclude<ImageCheck, 'ok'> | null>(null)
  const [reading, setReading] = useState(false)
  // 图只读一次(每份分享一个 seq):重编 JPEG、算 sha256,和相册选图得到同样的 PickedImage
  const seq = pending?.seq
  useEffect(() => {
    setImages([]); setSkipped(null)
    const sources = getShare()?.draft.images ?? []
    if (!sources.length) { setReading(false); return }
    let alive = true
    setReading(true)
    // 用到才加载:图片处理与哈希是原生模块,不进页面的静态依赖
    void import('../net/share-read').then(m => m.readSharedImages(sources)).then(r => {
      if (alive) { setImages(r.images); setSkipped(r.skipped) }
    }).catch(() => { if (alive) setSkipped('unsupported') }).finally(() => { if (alive) setReading(false) })
    return () => { alive = false }
  }, [seq])

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'))
  const dismiss = () => { clearShare(); leave() }
  const choose = (choice: ShareChoice) => {
    if (!draft) return
    const { href, draftKey } = shareRoute(choice)
    setDraft(draftKey, mergeDraftText(getDraft(draftKey), draft.text))
    putDraftImages(draftKey, images)
    clearShare()
    router.replace(href)
  }

  const gate = shareGate(session)
  // 图还在读 ⇒ 先等;读完一张都没成、又没有字 ⇒ 两个去处都不亮(只剩「算了」)
  const usable = !!draft && !reading && (!!draft.text.trim() || images.length > 0)
  const notes = [
    draft?.overMax ? t(lang, 'images.max') : null,
    skipped === 'too_large' || draft?.tooLarge ? t(lang, 'images.tooLarge') : skipped === 'unsupported' ? t(lang, 'images.unsupported') : null,
    draft?.unsupported ? t(lang, 'share.onlyTextLinksImages') : null,
  ].filter((n): n is string => !!n)

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'share.title')} onBack={dismiss} />
      <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        {!draft ? (
          <Txt testID="share-receiving" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{t(lang, 'share.receiving')}</Txt>
        ) : (
          <>
            {draft.text.trim() ? (
              <View testID="share-text" style={{ paddingVertical: space.m }}>
                <Txt role="bubble" content="user" numberOfLines={12} selectable>{draft.text}</Txt>
              </View>
            ) : null}
            <ImageTray testID="share-images" images={images} lang={lang} onRemove={id => setImages(cur => cur.filter(i => i.id !== id))} />
            {reading ? <Txt testID="share-reading" role="meta" tone="inkSoft">{t(lang, 'progress.loading')}</Txt> : null}
            {notes.map(n => <Txt key={n} testID="share-note" role="meta" tone="inkSoft">{n}</Txt>)}
          </>
        )}
        {gate === 'needsPair' ? (
          <View testID="share-needs-pair" style={{ gap: space.m }}>
            <Txt role="item" accessibilityRole="header">{t(lang, 'share.needsPairTitle')}</Txt>
            <Txt role="bubble" tone="inkSoft">{t(lang, 'share.needsPairBody')}</Txt>
            <Button kind="primary" testID="share-pair" label={t(lang, 'welcome.pair')} onPress={() => router.push('/pair')} />
            <Button kind="secondary" testID="share-look-first" label={t(lang, 'welcome.lookFirst')} onPress={session.markWelcomeSeen} />
          </View>
        ) : draft ? (
          <View style={{ gap: space.m }}>
            <Txt role="caption" tone="inkSoft">{t(lang, 'share.hint')}</Txt>
            <Button kind="primary" testID="share-to-chat" label={t(lang, 'share.toChat')} onPress={() => choose('chat')} disabled={!usable} />
            <Button kind="secondary" testID="share-to-matter" label={t(lang, 'share.toMatter')} onPress={() => choose('matter')} disabled={!usable} />
          </View>
        ) : null}
        <Pressable testID="share-dismiss" accessibilityRole="button" accessibilityLabel={t(lang, 'share.dismiss')} onPress={dismiss} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Txt role="body" tone="inkSoft">{t(lang, 'share.dismiss')}</Txt>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  )
}

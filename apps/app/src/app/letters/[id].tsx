import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, type Lang } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useQuery } from '../../state/hooks'
import { downloadLetterPage } from '../../state/artifact-download'
import { bytesToBase64 } from '../../state/image-upload'
import { sha256Hex } from '../../ui/FileViewer'
import { MessageText } from '../../ui/Markdown'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { letterDate, letterPages } from '../../view/letters'

// 一封信(2026-10-18):逐页信纸图,按块读下来;按文字寄的那封(排不成图)显示全文。
export default function Letter() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { backend } = useBackendCtx()
  // 与列表同一个查询键:从列表点进来不再问一次电脑
  const q = useQuery('letters', () => backend.letters())
  const letter = q.data?.find(l => l.id === id) ?? null
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={letter ? letterDate(letter.day, lang) : t(lang, 'letters.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/letters'))} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        {!q.data ? (
          <Txt testID="letter-state" role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{t(lang, q.error ? 'letters.unavailable' : 'progress.loading')}</Txt>
        ) : !letter ? (
          <Txt testID="letter-missing" role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{t(lang, 'letters.notFound')}</Txt>
        ) : letter.pages > 0 ? (
          letterPages(letter).map(p => <LetterPage key={p} id={letter.id} page={p} lang={lang} />)
        ) : (
          <View testID="letter-text" style={{ paddingVertical: space.l }}>
            <MessageText role="assistant" text={letter.text ?? letter.opening} />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function LetterPage({ id, page, lang }: { id: string; page: number; lang: Lang }) {
  const { backend } = useBackendCtx()
  const { c } = useTheme()
  const [uri, setUri] = useState<string | null>(null)
  const [ratio, setRatio] = useState(3 / 4)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    downloadLetterPage(backend, id, page, sha256Hex).then(
      bytes => {
        if (!alive) return
        const u = `data:image/png;base64,${bytesToBase64(bytes)}`
        setUri(u)
        Image.getSize(u, (w, h) => { if (alive && w > 0 && h > 0) setRatio(w / h) }, () => {})
      },
      () => { if (alive) setFailed(true) },
    )
    return () => { alive = false }
  }, [backend, id, page])
  const label = t(lang, 'letters.page', { n: page })
  if (failed) return <Txt testID="letter-page-failed" role="meta" tone="inkSoft">{label} · {t(lang, 'letters.pageFailed')}</Txt>
  return (
    <View testID="letter-page" accessible accessibilityRole="image" accessibilityLabel={label}
      style={{ width: '100%', aspectRatio: ratio, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
      {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" /> : <ActivityIndicator size="small" color={c.inkSoft} accessibilityLabel={t(lang, 'progress.loading')} />}
    </View>
  )
}

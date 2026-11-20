import type { NotebookPenT } from '@wechat-cc/protocol'
import { useFonts } from 'expo-font'
import { useEffect, useState } from 'react'
import { notebookPen } from '../view/notebook'
import { PEN_FONT_FILES } from './font-files'

const kai = 'THPenKai-Regular'
const hand = 'THPenHand-Regular'
const fangsong = 'THPenFangsong-Regular'
const kaiFiles = { [kai]: PEN_FONT_FILES[kai] }
const handFiles = { [hand]: PEN_FONT_FILES[hand] }
const fangsongFiles = { [fangsong]: PEN_FONT_FILES[fangsong] }

export function useNotebookPen(pen: NotebookPenT | undefined, pending: boolean) {
  // Independent results let a working pen appear even if another resource stalls.
  const [kaiLoaded, kaiError] = useFonts(kaiFiles)
  const [handLoaded, handError] = useFonts(handFiles)
  const [fangsongLoaded, fangsongError] = useFonts(fangsongFiles)
  const style = pen && notebookPen(pen)
  const family = pending ? undefined : style?.family
  const [loaded, error] = {
    [kai]: [kaiLoaded, kaiError],
    [hand]: [handLoaded, handError],
    [fangsong]: [fangsongLoaded, fangsongError],
  }[family ?? kai]
  const ready = !pending && (!family || loaded || !!error)
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (ready || timedOut) return
    const timer = setTimeout(() => setTimedOut(true), 1500)
    return () => clearTimeout(timer)
  }, [ready, timedOut])

  return { ready: ready || timedOut, family: family && loaded ? family : undefined, color: style?.color }
}

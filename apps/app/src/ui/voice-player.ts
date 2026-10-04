// 回复里的语音附件(回复交付,2026-10-04):电脑合成好的声音(base64)写进缓存文件再放 —— 播放器认文件、不认 data: URI。
// 同一时刻只放一段:点下一段就停掉上一段。静音键打开时也要出声(主人点了「播放」)。
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'
import { File, Paths } from 'expo-file-system'
import { b64Decode } from '@wechat-cc/protocol'
import { audioExt } from '../view/chat'

let current: { player: AudioPlayer; file: File } | null = null
let modeSet = false

function stop() {
  const c = current
  current = null
  if (!c) return
  try { c.player.remove() } catch { /* 已经释放 */ }
  try { if (c.file.exists) c.file.delete() } catch { /* 缓存目录系统会清 */ }
}

/** 放一段声音;key 只用来起缓存文件名(消息 id + 下标)。抛错 = 没放出来(调用方说一句)。 */
export async function playVoice(audio: { mime: string; data: string }, key: string): Promise<void> {
  stop()
  if (!modeSet) {
    await setAudioModeAsync({ playsInSilentMode: true })
    modeSet = true
  }
  const file = new File(Paths.cache, `cc-voice-${key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}.${audioExt(audio.mime)}`)
  if (file.exists) file.delete()
  file.create()
  file.write(b64Decode(audio.data))
  const player = createAudioPlayer(file.uri)
  current = { player, file }
  player.addListener('playbackStatusUpdate', status => {
    if (status.didJustFinish && current?.player === player) stop()
  })
  player.play()
}

export function stopVoice(): void { stop() }

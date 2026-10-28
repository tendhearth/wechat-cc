// 按住说话的录音(2026-10-18):只在手指按着的时候开麦克风;录完读成 base64 就删掉文件,声音不留在手机上。
// 16 kHz 单声道 AAC 24 kbps(m4a):60 秒约 180 KB,放得进一次请求(PHONE_TRANSCRIBE_MAX_BYTES,算法见 protocol api.ts)。
import { AudioQuality, IOSOutputFormat, getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, type RecordingOptions } from 'expo-audio'
import { File } from 'expo-file-system'
import { PHONE_TRANSCRIBE_MAX_BYTES } from '@wechat-cc/protocol'
import { useMemo } from 'react'
import type { TalkRecorder } from '../state/hold-to-talk'
import { stopVoice } from './voice-player'

export const TALK_MIME = 'audio/mp4'
export const TALK_RECORDING: RecordingOptions = {
  extension: '.m4a', sampleRate: 16_000, numberOfChannels: 1, bitRate: 24_000, isMeteringEnabled: false,
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  // 安卓:到上限自己停(JS 那边 60 秒也会停,这是第二道)
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac', maxFileSize: PHONE_TRANSCRIBE_MAX_BYTES },
  web: { mimeType: 'audio/webm', bitsPerSecond: 24_000 },
}

const deleteQuietly = (uri: string | null) => {
  if (!uri) return
  try { const f = new File(uri); if (f.exists) f.delete() } catch { /* 缓存目录系统会清 */ }
}
// 录完把会话放回只放音:不然 iOS 的回复语音会从听筒出来
const playbackOnly = () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {})

export function useTalkRecorder(): TalkRecorder {
  const recorder = useAudioRecorder(TALK_RECORDING)
  return useMemo<TalkRecorder>(() => ({
    async permission() {
      const cur = await getRecordingPermissionsAsync()
      if (cur.granted) return 'granted'
      if (!cur.canAskAgain) return 'denied'
      return (await requestRecordingPermissionsAsync()).granted ? 'asked' : 'denied'
    },
    async start() {
      stopVoice()
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      try {
        await recorder.prepareToRecordAsync()
        recorder.record()
      } catch (e) { await playbackOnly(); throw e }
    },
    async stop(keep) {
      try { await recorder.stop() } finally { await playbackOnly() }
      const uri = recorder.uri
      if (!keep || !uri) { deleteQuietly(uri); return null }
      try {
        const f = new File(uri)
        const size = f.size ?? 0
        return { audioBase64: size > 0 && size <= PHONE_TRANSCRIBE_MAX_BYTES ? await f.base64() : '', size }
      } finally { deleteQuietly(uri) }
    },
  }), [recorder])
}

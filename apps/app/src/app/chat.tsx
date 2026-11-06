import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect } from 'react'

// Reuse an existing owner conversation even when a legacy link arrives over it.
export default function Chat() {
  const params = useLocalSearchParams<{ message?: string }>()
  const router = useRouter()
  const key = JSON.stringify(params)
  useEffect(() => { router.dismissTo({ pathname: '/', params: JSON.parse(key) }) }, [router, key])
  return null
}

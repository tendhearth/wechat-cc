import { Redirect, useLocalSearchParams } from 'expo-router'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// 批准并进一件事(设计稿 2026-10-31 U):旧链接 / 旧推送的 /approval/<id>?request= 去 /matter/<id>/decide。
export default function ApprovalRedirect() {
  const params = useLocalSearchParams<{ id: string; request?: string }>()
  const id = one(params.id) ?? ''
  const request = one(params.request)
  return <Redirect href={`/matter/${encodeURIComponent(id)}/decide${request ? `?request=${encodeURIComponent(request)}` : ''}`} />
}

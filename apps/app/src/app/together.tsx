import { Redirect } from 'expo-router'

// 「一起做」已并进主页(设计稿 2026-10-31 U);旧链接去「全部」。
export default function Together() {
  return <Redirect href="/all" />
}

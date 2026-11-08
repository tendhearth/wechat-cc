// 兼容原有组件入口；事项详情与主页使用同一份 protocol 状态记号，连接/错误提示保留语义点。
import { StatusWord } from './MatterRow'
import type { StatusKey } from '@wechat-cc/protocol'
export type { StatusKey }
export function StatusPill({ status, label }: { status: StatusKey; label?: string }) {
  return <StatusWord status={status} label={label} />
}

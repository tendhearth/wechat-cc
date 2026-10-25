/**
 * 桌面 / MCP 那一边(`/v1/*`)的请求 / 响应契约 —— 唯一的一份在协议包里(`packages/protocol/src/desktop-api.ts`,
 * 架构终态 F1),daemon 和三端客户端读同一份。这里只转出,老的 import 不用改。
 */
export * from '@wechat-cc/protocol/desktop-api'

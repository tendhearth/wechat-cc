// @ts-check
// 生成物,别手改:改 packages/protocol/src/routes.ts 后跑 bun run gen:routes(表在 packages/protocol/src/desktop-calls.ts)
// 桌面类型化客户端的表(架构终态 F5):命名空间.方法 → 路由键。拼请求、送出去见 ../daemon-client.js。

/** @typedef {"GET /v1/a2a/activity" | "GET /v1/a2a/info" | "GET /v1/a2a/list" | "GET /v1/access/list" | "GET /v1/atelier/model-status" | "GET /v1/atelier/works" | "GET /v1/avatar/info" | "GET /v1/cli/sessions" | "GET /v1/companion/pet" | "GET /v1/companion/presence" | "GET /v1/companion/status" | "GET /v1/companion/thoughts" | "GET /v1/connections" | "GET /v1/conversations/list" | "GET /v1/dialogue/search" | "GET /v1/dialogue/thread" | "GET /v1/dialogue/threads" | "GET /v1/dialogue/timeline" | "GET /v1/events/list" | "GET /v1/health" | "GET /v1/health/incidents" | "GET /v1/journal" | "GET /v1/journal/postcards" | "GET /v1/license/status" | "GET /v1/llm/health" | "GET /v1/matter/owner-chat" | "GET /v1/matter/owner-chat/file" | "GET /v1/matter/owner-chat/search" | "GET /v1/memory/file" | "GET /v1/memory/files" | "GET /v1/memory/portrait" | "GET /v1/memory/profile" | "GET /v1/memory/profile/status" | "GET /v1/memory/projects" | "GET /v1/memory/retractions" | "GET /v1/memory/source" | "GET /v1/milestones/list" | "GET /v1/observations/list" | "GET /v1/penpal/channels" | "GET /v1/penpal/letters" | "GET /v1/phone/devices" | "GET /v1/plugins/list" | "GET /v1/plugins/registry" | "GET /v1/sessions/chats" | "GET /v1/sessions/projects" | "GET /v1/social/inbound" | "GET /v1/social/intro/offers" | "GET /v1/social/relationships" | "GET /v1/social/wishes" | "GET /v1/workbench" | "GET /v1/workbench/artifact" | "GET /v1/workbench/attachment" | "GET /v1/workbench/attention" | "GET /v1/workbench/entry-options" | "GET /v1/workbench/entry-receipt" | "GET /v1/workbench/handoff" | "GET /v1/workbench/models" | "GET /v1/workbench/review" | "GET /v1/workbench/rewind-preview" | "GET /v1/workbench/session" | "GET /v1/workbench/sessions" | "GET /v1/workbench/task" | "POST /v1/a2a/install" | "POST /v1/a2a/pause" | "POST /v1/a2a/preview" | "POST /v1/a2a/remove" | "POST /v1/a2a/test" | "POST /v1/atelier/share" | "POST /v1/avatar/remove" | "POST /v1/avatar/set" | "POST /v1/cli/hooks/install" | "POST /v1/conversation/set-mode" | "POST /v1/dialogue/unlock" | "POST /v1/journal/favorite" | "POST /v1/journal/remove" | "POST /v1/journal/seen" | "POST /v1/journal/status" | "POST /v1/knowledge/facts/find_facts" | "POST /v1/knowledge/facts/set_fact_status" | "POST /v1/knowledge/graph/top_contacts" | "POST /v1/license/activate" | "POST /v1/license/deactivate" | "POST /v1/llm/keys" | "POST /v1/memory/edit" | "POST /v1/memory/file/write" | "POST /v1/memory/portrait/generate" | "POST /v1/memory/profile/generate" | "POST /v1/memory/retractions/restore" | "POST /v1/memory/source/review" | "POST /v1/memory/synthesize" | "POST /v1/memory/view" | "POST /v1/net/probe" | "POST /v1/observations/archive" | "POST /v1/pair/accept" | "POST /v1/pair/start" | "POST /v1/penpal/letters" | "POST /v1/penpal/letters/read" | "POST /v1/penpal/letters/resend" | "POST /v1/phone/link" | "POST /v1/plugins/install" | "POST /v1/plugins/toggle" | "POST /v1/plugins/upgrade" | "POST /v1/reminders/schedule" | "POST /v1/sessions/delete" | "POST /v1/social/enable" | "POST /v1/social/inbound" | "POST /v1/social/intro/accept" | "POST /v1/social/intro/decline" | "POST /v1/social/intro/request" | "POST /v1/social/visit" | "POST /v1/social/wish" | "POST /v1/social/wish/cancel" | "POST /v1/social/wish/send" | "POST /v1/workbench/answer" | "POST /v1/workbench/approve" | "POST /v1/workbench/archive" | "POST /v1/workbench/attachment" | "POST /v1/workbench/cancel" | "POST /v1/workbench/continue" | "POST /v1/workbench/create" | "POST /v1/workbench/create-entry" | "POST /v1/workbench/discard-attachment" | "POST /v1/workbench/handoff" | "POST /v1/workbench/handoff-preview" | "POST /v1/workbench/import" | "POST /v1/workbench/input" | "POST /v1/workbench/permission" | "POST /v1/workbench/prepare-continuation" | "POST /v1/workbench/prepare-resume" | "POST /v1/workbench/project" | "POST /v1/workbench/quota-handoff" | "POST /v1/workbench/review-comment" | "POST /v1/workbench/review-comments-send" | "POST /v1/workbench/review-hunk" | "POST /v1/workbench/review-mark" | "POST /v1/workbench/review-return" | "POST /v1/workbench/review-revert" | "POST /v1/workbench/rewind" | "POST /v1/workbench/rewind-resolve" | "POST /v1/workbench/script-approve" | "POST /v1/workbench/unattended-ack" | "POST /v1/workbench/withdraw-input" | "POST /v1/workbench/worktree" | "POST /v1/workbench/writer-exited"} V1Key */

export const V1 = /** @type {const} */ ({
  "access": {
    "list": "GET /v1/access/list"
  },
  "avatar": {
    "info": "GET /v1/avatar/info",
    "set": "POST /v1/avatar/set",
    "remove": "POST /v1/avatar/remove"
  },
  "a2a": {
    "list": "GET /v1/a2a/list",
    "info": "GET /v1/a2a/info",
    "activity": "GET /v1/a2a/activity",
    "preview": "POST /v1/a2a/preview",
    "install": "POST /v1/a2a/install",
    "remove": "POST /v1/a2a/remove",
    "pause": "POST /v1/a2a/pause",
    "test": "POST /v1/a2a/test"
  },
  "atelier": {
    "modelStatus": "GET /v1/atelier/model-status",
    "share": "POST /v1/atelier/share",
    "works": "GET /v1/atelier/works"
  },
  "cli": {
    "hooksInstall": "POST /v1/cli/hooks/install",
    "sessions": "GET /v1/cli/sessions"
  },
  "companion": {
    "pet": "GET /v1/companion/pet",
    "presence": "GET /v1/companion/presence",
    "status": "GET /v1/companion/status",
    "thoughts": "GET /v1/companion/thoughts"
  },
  "connections": {
    "get": "GET /v1/connections"
  },
  "conversation": {
    "setMode": "POST /v1/conversation/set-mode"
  },
  "conversations": {
    "list": "GET /v1/conversations/list"
  },
  "dialogue": {
    "timeline": "GET /v1/dialogue/timeline",
    "threads": "GET /v1/dialogue/threads",
    "thread": "GET /v1/dialogue/thread",
    "search": "GET /v1/dialogue/search",
    "unlock": "POST /v1/dialogue/unlock"
  },
  "events": {
    "list": "GET /v1/events/list"
  },
  "health": {
    "get": "GET /v1/health",
    "incidents": "GET /v1/health/incidents"
  },
  "journal": {
    "list": "GET /v1/journal",
    "favorite": "POST /v1/journal/favorite",
    "postcards": "GET /v1/journal/postcards",
    "remove": "POST /v1/journal/remove",
    "seen": "POST /v1/journal/seen",
    "status": "POST /v1/journal/status"
  },
  "knowledge": {
    "findFacts": "POST /v1/knowledge/facts/find_facts",
    "setFactStatus": "POST /v1/knowledge/facts/set_fact_status",
    "topContacts": "POST /v1/knowledge/graph/top_contacts"
  },
  "license": {
    "status": "GET /v1/license/status",
    "activate": "POST /v1/license/activate",
    "deactivate": "POST /v1/license/deactivate"
  },
  "llm": {
    "health": "GET /v1/llm/health",
    "keys": "POST /v1/llm/keys"
  },
  "matter": {
    "ownerChatFile": "GET /v1/matter/owner-chat/file",
    "ownerChat": "GET /v1/matter/owner-chat",
    "ownerChatSearch": "GET /v1/matter/owner-chat/search"
  },
  "memory": {
    "edit": "POST /v1/memory/edit",
    "retractions": "GET /v1/memory/retractions",
    "restore": "POST /v1/memory/retractions/restore",
    "file": "GET /v1/memory/file",
    "fileWrite": "POST /v1/memory/file/write",
    "files": "GET /v1/memory/files",
    "profile": "GET /v1/memory/profile",
    "profileStatus": "GET /v1/memory/profile/status",
    "projects": "GET /v1/memory/projects",
    "view": "POST /v1/memory/view",
    "portrait": "GET /v1/memory/portrait",
    "portraitGenerate": "POST /v1/memory/portrait/generate",
    "profileGenerate": "POST /v1/memory/profile/generate",
    "source": "GET /v1/memory/source",
    "sourceReview": "POST /v1/memory/source/review",
    "synthesize": "POST /v1/memory/synthesize"
  },
  "milestones": {
    "list": "GET /v1/milestones/list"
  },
  "net": {
    "probe": "POST /v1/net/probe"
  },
  "observations": {
    "list": "GET /v1/observations/list",
    "archive": "POST /v1/observations/archive"
  },
  "pair": {
    "accept": "POST /v1/pair/accept",
    "start": "POST /v1/pair/start"
  },
  "penpal": {
    "channels": "GET /v1/penpal/channels",
    "letters": "GET /v1/penpal/letters",
    "send": "POST /v1/penpal/letters",
    "read": "POST /v1/penpal/letters/read",
    "resend": "POST /v1/penpal/letters/resend"
  },
  "phone": {
    "devices": "GET /v1/phone/devices",
    "link": "POST /v1/phone/link"
  },
  "plugins": {
    "list": "GET /v1/plugins/list",
    "registry": "GET /v1/plugins/registry",
    "toggle": "POST /v1/plugins/toggle",
    "install": "POST /v1/plugins/install",
    "upgrade": "POST /v1/plugins/upgrade"
  },
  "sessions": {
    "projects": "GET /v1/sessions/projects",
    "chats": "GET /v1/sessions/chats",
    "delete": "POST /v1/sessions/delete"
  },
  "reminders": {
    "schedule": "POST /v1/reminders/schedule"
  },
  "social": {
    "enable": "POST /v1/social/enable",
    "inbound": "GET /v1/social/inbound",
    "setInbound": "POST /v1/social/inbound",
    "introAccept": "POST /v1/social/intro/accept",
    "introDecline": "POST /v1/social/intro/decline",
    "introOffers": "GET /v1/social/intro/offers",
    "introRequest": "POST /v1/social/intro/request",
    "relationships": "GET /v1/social/relationships",
    "visit": "POST /v1/social/visit",
    "wish": "POST /v1/social/wish",
    "wishCancel": "POST /v1/social/wish/cancel",
    "wishSend": "POST /v1/social/wish/send",
    "wishes": "GET /v1/social/wishes"
  },
  "workbench": {
    "list": "GET /v1/workbench",
    "answer": "POST /v1/workbench/answer",
    "approve": "POST /v1/workbench/approve",
    "archive": "POST /v1/workbench/archive",
    "artifact": "GET /v1/workbench/artifact",
    "attachment": "GET /v1/workbench/attachment",
    "uploadAttachment": "POST /v1/workbench/attachment",
    "attention": "GET /v1/workbench/attention",
    "cancel": "POST /v1/workbench/cancel",
    "continue": "POST /v1/workbench/continue",
    "create": "POST /v1/workbench/create",
    "createEntry": "POST /v1/workbench/create-entry",
    "discardAttachment": "POST /v1/workbench/discard-attachment",
    "entryOptions": "GET /v1/workbench/entry-options",
    "entryReceipt": "GET /v1/workbench/entry-receipt",
    "handoff": "POST /v1/workbench/handoff",
    "handoffStatus": "GET /v1/workbench/handoff",
    "handoffPreview": "POST /v1/workbench/handoff-preview",
    "import": "POST /v1/workbench/import",
    "input": "POST /v1/workbench/input",
    "models": "GET /v1/workbench/models",
    "permission": "POST /v1/workbench/permission",
    "prepareContinuation": "POST /v1/workbench/prepare-continuation",
    "prepareResume": "POST /v1/workbench/prepare-resume",
    "project": "POST /v1/workbench/project",
    "quotaHandoff": "POST /v1/workbench/quota-handoff",
    "review": "GET /v1/workbench/review",
    "reviewComment": "POST /v1/workbench/review-comment",
    "reviewCommentsSend": "POST /v1/workbench/review-comments-send",
    "reviewHunk": "POST /v1/workbench/review-hunk",
    "reviewMark": "POST /v1/workbench/review-mark",
    "reviewReturn": "POST /v1/workbench/review-return",
    "reviewRevert": "POST /v1/workbench/review-revert",
    "rewind": "POST /v1/workbench/rewind",
    "rewindPreview": "GET /v1/workbench/rewind-preview",
    "rewindResolve": "POST /v1/workbench/rewind-resolve",
    "scriptApprove": "POST /v1/workbench/script-approve",
    "session": "GET /v1/workbench/session",
    "sessions": "GET /v1/workbench/sessions",
    "task": "GET /v1/workbench/task",
    "unattendedAck": "POST /v1/workbench/unattended-ack",
    "withdrawInput": "POST /v1/workbench/withdraw-input",
    "worktree": "POST /v1/workbench/worktree",
    "writerExited": "POST /v1/workbench/writer-exited"
  }
})

/** 主人工作区(路由表里 `desktop.ownerWorkspace` 的行)的路径:打包版交给宿主代理,webview 不拿那份凭据。 */
export const OWNER_WORKSPACE_PATHS = /** @type {const} */ ([
  "/v1/companion/thoughts",
  "/v1/knowledge/facts/find_facts",
  "/v1/knowledge/facts/set_fact_status",
  "/v1/knowledge/graph/top_contacts",
  "/v1/llm/keys",
  "/v1/reminders/schedule"
])

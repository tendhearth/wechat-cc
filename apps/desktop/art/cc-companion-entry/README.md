# CC · 陪伴与事情交互样板

Preview: http://127.0.0.1:4186/apps/desktop/art/cc-companion-entry/preview.html

Serve the repository root with a local static server. The page lives outside the desktop frontend distribution and is not wired into production navigation.

## Try it

1. On 此刻, write a personal draft. Open 登录修复 and write a different draft. Switch back: each stays in its own composer.
2. Send a task message and immediately open another project. The delayed **simulated** response returns to its original task.
3. Both CC 产品 and 秋季分享 contain 准备初稿. Their drafts, file names and messages are keyed by separate IDs.
4. Open 看看过程, then 查看原会话 to inspect a clearly labeled example of user speech versus CC-authored instructions. Escape closes the dialog and returns focus.
5. 暂停演示 changes only the selected task's preview status. No process is actually stopped.
6. Open a sample artifact, or return to 回到 CC 身边 to try personal conversation without a project scope.

## Boundaries

- All tasks, device names, model activity, transcripts and replies are fixtures. Reload resets in-memory drafts and messages.
- File selection retains **names only**. File contents are never read or uploaded. No recording or model invocation is implemented.
- CSP prohibits network connections. Only same-origin styles, scripts, icons and the existing frozen CC image/mask are loaded.
- Stable scope IDs prove isolation within this preview only. This is not production project authorization, concurrent filesystem isolation, native-session takeover, autonomous orchestration or cross-device transport.
- No frozen assets, production routing, provider configuration or existing conversations were modified.

## Verification (2026-09-12)

- `bun --bun vitest run apps/desktop/art/cc-companion-entry/state.test.ts`: 6 passing isolation tests.
- `bun run typecheck`: passed.
- Chrome browser interaction check: independent personal/task drafts; a delayed reply after navigation; same-title task attachment isolation; source dialog and Escape; per-task pause; personal chat; 760px / 420px navigation and drawer; no page errors or horizontal document overflow.
- Screenshots: `home-1440.png`, `task-1440.png`, `companion-1440.png`, `task-760.png`, `home-420.png`.

The approved image concepts guide the spacing, palette and hierarchy. The preview reuses the canonical sprite and entity mask plus the existing Hugeicons subset, rather than replacing the frozen character with generated artwork.

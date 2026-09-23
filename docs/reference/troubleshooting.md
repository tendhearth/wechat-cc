# Troubleshooting

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

**`bun`, `git`, or `wechat-cc` not found after install**
Reopen your terminal. PATH changes from `bun link` or a fresh Bun/Git
install don't take effect in the current shell session.

**Reading logs on Windows — Chinese characters show as garbage**
PowerShell's default `Get-Content` reads files as ANSI (GBK). Use:
```powershell
Get-Content "$env:USERPROFILE\.claude\channels\wechat\channel.log" -Tail 60 -Encoding UTF8
```

**Windows Firewall popup on first `share_page`**
Fixed in v1.0 — `docs.ts` binds `127.0.0.1`. If you see this on an older
install, run `wechat-cc update`.

**`wechat-cc update` fails with "git not found"**
`update` runs `git pull`. Ensure Git is in PATH. Windows:
`winget install Git.Git`, then reopen the terminal.

**Bot stops responding (errcode=-14)**
Run `/health` from WeChat (admin-gated). Expired bots show up there;
respond with `清理 <bot-id>` to remove from active list. Re-scan the QR
to bind a fresh session.

**AI replies with "AI 暂时不可用…" notice (v0.5.17+)**
Your AI provider's credentials have gone stale — either OAuth tokens
expired and the long-running subprocess can't refresh, or you haven't
run `claude` interactively on this machine yet. The daemon now self-heals
on the next message (idle reset + reactive sentinel), but if you want to
force it right now, send `/reset` (or `/重置`) from your WeChat chat. The
daemon also auto-recycles a stale session for any chat that's still busy
when its access token expires, so most users won't see this notice more
than once per failure.

If you've never run `claude` on this machine: open a terminal, run
`claude /login`, complete the OAuth flow, then send any message in WeChat
— the next dispatch picks up the fresh keychain credential automatically.

**Codex provider unavailable / no codex reply (v0.5.17+)**
`wechat-cc-cli doctor` shows the installed `codex` version. If it differs
from the bundled SDK's expected version (e.g. installed 0.125 vs bundled
0.128), the boot log will say `codex provider NOT registered — version
check failed`. Fix: `npm i -g @openai/codex@<expected-version>` (the boot
log includes the exact version), or remove the older codex from PATH.
Restart the daemon. `wechat-cc setup` doesn't need to re-run.

---

// wechat-cc desktop installer — Tauri command surface.
//
// The bundled `wechat-cc-cli` sidecar (a `bun build --compile`d
// self-contained binary built from the project's cli.ts) is the single
// source of truth for every CLI operation the GUI invokes. There is no
// dependency on a system-installed `bun`, no requirement for a cloned
// wechat-cc source tree, and no PATH lookup — the sidecar lives inside
// the .app/.exe/.deb bundle and is resolved by tauri-plugin-shell.

pub mod daemon_mode;

use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
async fn wechat_cli_json(app: AppHandle, args: Vec<String>) -> Result<Value, String> {
    let stdout = run_sidecar(&app, args).await?;
    serde_json::from_str(&stdout)
        .map_err(|err| format!("invalid JSON from wechat-cc: {err}\n{stdout}"))
}

// Reads payload via a temp file instead of stdout. The bun --compile CLI
// loses bytes when pushing MB-sized JSON (sessions read-jsonl) through a
// pipe — pipe-buffer fills, EAGAIN, writes drop. The CLI's --out-file flag
// dumps the JSON to disk synchronously and prints just the small envelope
// {ok, out_file, bytes} on stdout, which we then read from disk.
#[tauri::command]
async fn wechat_cli_json_via_file(app: AppHandle, args: Vec<String>) -> Result<Value, String> {
    let id: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("wechat-cc-{id}-{}.json", std::process::id()));
    let tmp_str = tmp.to_string_lossy().to_string();
    let mut full_args = args;
    full_args.push("--out-file".into());
    full_args.push(tmp_str.clone());
    let _ = run_sidecar(&app, full_args).await?;
    let body = std::fs::read_to_string(&tmp).map_err(|err| format!("read {tmp_str}: {err}"))?;
    let _ = std::fs::remove_file(&tmp);
    serde_json::from_str(&body).map_err(|err| format!("invalid JSON in {tmp_str}: {err}"))
}

#[tauri::command]
async fn wechat_cli_text(app: AppHandle, args: Vec<String>) -> Result<String, String> {
    run_sidecar(&app, args).await
}

// Direct file save — sidesteps the missing tauri-plugin-dialog/-fs.
// Without it, exportProjectMarkdown's `<a download>.click()` blob fallback
// silently no-ops in the Tauri webview (downloads aren't wired). Writes to
// $HOME/Downloads/<filename>; refuses anything that would escape that dir.
#[tauri::command]
fn save_text_file(filename: String, content: String) -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|err| format!("cannot resolve home dir: {err}"))?;
    let downloads = std::path::PathBuf::from(home).join("Downloads");
    std::fs::create_dir_all(&downloads).map_err(|err| format!("mkdir {}: {err}", downloads.display()))?;
    // Strip any path component from the filename — only the basename is allowed.
    let basename = std::path::Path::new(&filename)
        .file_name()
        .ok_or_else(|| "empty filename".to_string())?
        .to_string_lossy()
        .to_string();
    if basename.is_empty() || basename == "." || basename == ".." {
        return Err(format!("illegal filename: {filename}"));
    }
    let target = downloads.join(&basename);
    std::fs::write(&target, content).map_err(|err| format!("write {}: {err}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn render_qr_svg(text: String) -> Result<String, String> {
    use qrcode::render::svg;
    use qrcode::QrCode;
    let code = QrCode::new(text.as_bytes()).map_err(|err| format!("qr encode failed: {err}"))?;
    Ok(code
        .render::<svg::Color<'_>>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .dark_color(svg::Color("#111111"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

// Opens the companion as its own transparent desktop window. The aquarium
// itself remains a regular webview page, so it can reuse the same Canvas scene
// and assets as the dashboard rather than keeping a second animation engine in
// Rust. A second request focuses the existing window instead of stacking copies.
// ASYNC on purpose (2026-08-25, Windows 卡死 fix): Tauri v2's documented
// rule is that creating a webview window inside a SYNCHRONOUS command
// deadlocks on Windows — wry marshals window creation onto the main thread
// while the sync command may itself be blocking that thread. `async fn`
// moves the command off the main thread, which is the officially
// recommended fix. macOS never deadlocked here; behavior there is unchanged.
#[tauri::command]
async fn open_companion_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("companion") {
        window.show().map_err(|err| format!("show companion window: {err}"))?;
        window.set_focus().map_err(|err| format!("focus companion window: {err}"))?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        &app,
        "companion",
        WebviewUrl::App("companion-window.html".into()),
    )
    .title("CC")
    // Desktop mode begins at the compact size, so it behaves like a quiet
    // companion rather than competing with the main workspace. The user can
    // expand it at any time with the in-window + control.
    .inner_size(240.0, 300.0)
    .min_inner_size(200.0, 250.0)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    // No drag region and no maximize: a still double-click on CC must never
    // zoom this transparent always-on-top window to the whole display.
    .maximizable(false);

    // Windows: an undecorated window keeps its DWM shadow by default, which
    // paints an opaque halo/flicker around a TRANSPARENT window. Drop it.
    #[cfg(target_os = "windows")]
    let builder = builder.shadow(false);

    builder
        .build()
        .map_err(|err| format!("create companion window: {err}"))?;

    Ok(())
}

// 关掉主窗口 = 销毁它(全程没有 hide-on-close),而常驻置顶的浮窗还吊着进程 ——
// 「关了主窗口只留桌宠」正是这个功能的主场景。这时点包袱得先把窗口重建回来,
// 再导航;但新窗口的前端还没 listen,事件发出去就丢了,所以目的地先存这儿,
// 由前端 boot 完成后调 take_pending_navigate 主动来取。
struct PendingNavigate(Mutex<Option<String>>);

// 浮窗点脚边的道具 → 主窗口露面并切到觅食台(spec 2026-09-03-companion-presence §3.4)。
// 页面名只是转发,白名单在 JS 侧;这里不解释它。async 与 open_companion_window
// 同理(Windows 上窗口操作别占主线程 —— 重建窗口时这条更要紧)。
#[tauri::command]
async fn show_main_window(
    app: AppHandle,
    page: Option<String>,
    pending: State<'_, PendingNavigate>,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|err| format!("show main window: {err}"))?;
        main.unminimize().map_err(|err| format!("unminimize main window: {err}"))?;
        main.set_focus().map_err(|err| format!("focus main window: {err}"))?;
        if let Some(page) = page {
            // 定向发给 main,不广播:浮窗自己也监听不到才对。
            app.emit_to("main", "wechat-cc:navigate", serde_json::json!({ "page": page }))
                .map_err(|err| format!("emit navigate: {err}"))?;
        }
        return Ok(());
    }

    if let Some(page) = page {
        let mut slot = pending
            .0
            .lock()
            .map_err(|err| format!("pending navigate lock: {err}"))?;
        *slot = Some(page);
    }
    // 照 tauri.conf.json 里 main 的原始配置重建(尺寸、标题、装饰一律不另写一份)。
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| "no main window in tauri.conf.json".to_string())?;
    WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|err| format!("main window config: {err}"))?
        .build()
        .map_err(|err| format!("create main window: {err}"))?;
    Ok(())
}

// 前端 boot 完成后来取「重建主窗口之前记下的目的地」,取走即清空。
// 没有待办时返回 null —— 正常启动就是这条路。
#[tauri::command]
fn take_pending_navigate(pending: State<'_, PendingNavigate>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut slot| slot.take())
}

// Keep companion controls on the Rust side. Dynamic windows have a more
// restrictive capability surface than the main webview, whereas these
// commands always target the one trusted companion window by label.
#[tauri::command]
fn close_companion_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("companion")
        .ok_or_else(|| "companion window is not open".to_string())?;
    window
        .close()
        .map_err(|err| format!("close companion window: {err}"))
}

#[tauri::command]
fn start_companion_drag(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("companion")
        .ok_or_else(|| "companion window is not open".to_string())?;
    window
        .start_dragging()
        .map_err(|err| format!("start companion drag: {err}"))
}

#[tauri::command]
fn resize_companion_window(app: AppHandle, direction: String) -> Result<(), String> {
    let window = app
        .get_webview_window("companion")
        .ok_or_else(|| "companion window is not open".to_string())?;
    let factor = match direction.as_str() {
        "in" => 1.12,
        "out" => 1.0 / 1.12,
        _ => return Err("invalid companion resize direction".to_string()),
    };
    let scale_factor = window
        .scale_factor()
        .map_err(|err| format!("read companion scale factor: {err}"))?;
    let current = window
        .inner_size()
        .map_err(|err| format!("read companion size: {err}"))?
        .to_logical::<f64>(scale_factor);
    let width = (current.width * factor).clamp(200.0, 600.0);
    let height = (current.height * factor).clamp(250.0, 750.0);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|err| format!("resize companion window: {err}"))
}

// Spawn the bundled sidecar and collect its stdout. Stderr is forwarded as
// part of the error payload so callers (the wizard / dashboard) can render a
// useful message when something goes wrong. Termination with a non-zero exit
// code is treated as failure regardless of stdout content.
//
// Dev hot-reload (debug builds only): if a repo root is resolved — either
// from $WECHAT_CC_DEV_ROOT or by walking up from CARGO_MANIFEST_DIR and
// finding a cli.ts — bypass the bundled (and almost certainly stale)
// sidecar binary and shell out to `bun <root>/cli.ts <args>`. This way
// edits to cli.ts / src/**/*.ts take effect on the *next* invoke without
// re-running `bun build --compile`. Release builds (cfg(not(debug_assertions)))
// always use the sidecar so production has no path that depends on bun
// being on PATH or on a writable repo checkout.
// Where the bundled first-party plugins (e.g. wxvault) landed in the app's
// resource dir. `resources: ["../../../plugins/"]` in tauri.conf maps each `..`
// to `_up_`, so from $RESOURCE the dir is `_up_/_up_/_up_/plugins`. Probe the
// likely spots and return the first that exists; if none do we leave the env
// unset and the daemon falls back to its execPath logic (graceful, not a crash).
// Passed to the sidecar as WECHAT_CC_BUNDLED_PLUGINS_DIR (read by paths.ts)
// because the daemon can't portably derive the platform-specific resource path.
fn bundled_plugins_dir(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().resource_dir().ok()?;
    for rel in ["_up_/_up_/_up_/plugins", "plugins"] {
        let p = base.join(rel);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

async fn run_sidecar(app: &AppHandle, args: Vec<String>) -> Result<String, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = resolve_dev_repo_root() {
        return run_dev_bun(&root, args).await;
    }

    let sidecar = app
        .shell()
        .sidecar("wechat-cc-cli")
        .map_err(|err| format!("failed to resolve wechat-cc-cli sidecar: {err}"))?;

    // Point the sidecar at the bundled plugins dir (see bundled_plugins_dir).
    let sidecar = match bundled_plugins_dir(app) {
        Some(dir) => sidecar.env(
            "WECHAT_CC_BUNDLED_PLUGINS_DIR",
            dir.to_string_lossy().to_string(),
        ),
        None => sidecar,
    };

    let (mut rx, _child) = sidecar
        .args(args)
        .spawn()
        .map_err(|err| format!("failed to spawn wechat-cc-cli: {err}"))?;

    let mut stdout = Vec::<u8>::new();
    let mut stderr = Vec::<u8>::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout.extend_from_slice(&line);
                stdout.push(b'\n');
            }
            CommandEvent::Stderr(line) => {
                stderr.extend_from_slice(&line);
                stderr.push(b'\n');
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }

    let stdout_str = String::from_utf8_lossy(&stdout).trim().to_string();
    let stderr_str = String::from_utf8_lossy(&stderr).trim().to_string();
    if exit_code.unwrap_or(1) != 0 {
        if stderr_str.is_empty() {
            return Err(format!("wechat-cc-cli exited with code {:?}\n{stdout_str}", exit_code));
        }
        return Err(stderr_str);
    }
    Ok(stdout_str)
}

// Suppress unused warnings until streaming is wired through.
#[allow(dead_code)]
fn emit_log(app: &AppHandle, line: &str) {
    let _ = app.emit("wechat-cc:log", line);
}

// ─── Dev hot-reload helpers (debug builds only) ──────────────────────────────
// In release builds these vanish entirely (cfg-gated) — production never
// touches `bun` on PATH and never reads the repo checkout.

#[cfg(debug_assertions)]
fn resolve_dev_repo_root() -> Option<std::path::PathBuf> {
    // Priority 1: explicit env var. Lets the user point at a different
    // checkout (e.g. a feature branch) without recompiling the Rust shim.
    if let Ok(env_root) = std::env::var("WECHAT_CC_DEV_ROOT") {
        let p = std::path::PathBuf::from(env_root);
        if p.join("cli.ts").exists() {
            return Some(p);
        }
    }
    // Priority 2: walk up from CARGO_MANIFEST_DIR (baked in at compile
    // time = .../apps/desktop/src-tauri). Three levels up is the repo
    // root. Verify cli.ts is there before trusting it.
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let guess = manifest.parent()?.parent()?.parent()?.to_path_buf();
    if guess.join("cli.ts").exists() {
        return Some(guess);
    }
    None
}

#[cfg(debug_assertions)]
async fn run_dev_bun(root: &std::path::Path, args: Vec<String>) -> Result<String, String> {
    use tokio::process::Command;
    let cli = root.join("cli.ts");
    // wait_with_output drains stdout+stderr concurrently and waits — no
    // risk of pipe-buffer deadlock on chatty subcommands.
    let output = Command::new("bun")
        .arg(cli)
        .args(&args)
        .current_dir(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to spawn `bun cli.ts` (dev mode): {err}"))?
        .wait_with_output()
        .await
        .map_err(|err| format!("wait: {err}"))?;

    let stdout_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr_str = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        if stderr_str.is_empty() {
            return Err(format!("`bun cli.ts` exited with {:?}\n{stdout_str}", output.status.code()));
        }
        return Err(stderr_str);
    }
    Ok(stdout_str)
}

// Returns the daemon's pid by matching command-line on bun.exe / node.exe.
// Win11 reparents schtasks-spawned processes under svchost so PID/parent
// chains break — command-line is the reliable signal. Returns None on
// non-Windows (the dashboard skips its pre/post check there). See PR3 #19.
//
// CREATE_NO_WINDOW (v0.5.4): the Tauri GUI is subsystem=2 (no console).
// `std::process::Command::new("powershell.exe")` defaults to inheriting
// the parent's console — but with no console to inherit, Windows
// allocates a fresh console window for the powershell child. Setting
// CREATE_NO_WINDOW (0x08000000) tells CreateProcess not to allocate
// any console at all. Without this, every "重启 daemon" click pops a
// PowerShell window. spawnSync from the Bun-compiled sidecar already
// gets this for free (Bun's compile sets the equivalent), but raw
// `std::process::Command` doesn't, so we set it explicitly here.
#[tauri::command]
fn wechat_daemon_pid() -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$p = Get-CimInstance Win32_Process -Filter \"Name = 'bun.exe' OR Name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'wechat-cc' } | Select-Object -First 1; if ($p) { $p.ProcessId }",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let s = String::from_utf8(output.stdout).ok()?;
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        trimmed.parse::<u32>().ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

// OS-level notification — fires from JS (`invoke("notify_user", ...)`) when
// the doctor-poller diff detects a newly-expired account. Uses
// tauri-plugin-notification's native bridge (NSUserNotification on macOS,
// the WinRT toast API on Windows, libnotify on Linux). Errors propagate to
// JS as a string so the renderer can console.warn() them; no fallback.
#[tauri::command]
fn notify_user(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}

// Direct /v1/health ping — reads the bearer token from the token file (0o600,
// rotated every boot) and issues a GET to http://127.0.0.1:<port>/v1/health.
// Returns true iff the response is HTTP 200. Returns an Err string on token
// read failure, network error, or timeout so the JS wrapper can log it; the
// caller always falls back to false.
//
// This must live in Rust (not JS) because the token file is mode 0o600 and
// the Tauri `fs` allowlist is intentionally NOT granted to the renderer.
// Pure HTTP — no subprocess spawned, no CREATE_NO_WINDOW needed.
#[tauri::command]
async fn wechat_health_ping(
    token_file_path: String,
    port: u16,
    timeout_ms: u32,
) -> Result<bool, String> {
    use std::time::Duration;
    use tokio::time::timeout;

    let token = std::fs::read_to_string(&token_file_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;

    let url = format!("http://127.0.0.1:{port}/v1/health");
    let duration = Duration::from_millis(u64::from(timeout_ms));

    let result = timeout(duration, async {
        reqwest::Client::new()
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
    })
    .await;

    match result {
        Ok(Ok(resp)) => Ok(resp.status().as_u16() == 200),
        Ok(Err(_)) => Ok(false),
        Err(_) => Ok(false), // timeout — treat as probe failure, not a hard error
    }
}

// /v1/health 的 version 段 + 本包自带的 CLI 版本。桌面更新器换入新 .app 后旧后台仍在跑
// (docs/cc-workbench.md 修订记录 09-16),重连诊断据此直说「后台还是旧版」。sidecar 由
// 仓库根 package.json 的版本构建,编译期把它包进来就是"本包期望的后台版本"。
const ROOT_PACKAGE_JSON: &str = include_str!("../../../../package.json");

#[tauri::command]
async fn wechat_health_version(
    token_file_path: String,
    port: u16,
    timeout_ms: u32,
) -> Result<serde_json::Value, String> {
    use std::time::Duration;
    use tokio::time::timeout;

    let expected = serde_json::from_str::<serde_json::Value>(ROOT_PACKAGE_JSON)
        .ok()
        .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(str::to_string));
    let token = std::fs::read_to_string(&token_file_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;
    let url = format!("http://127.0.0.1:{port}/v1/health");
    let duration = Duration::from_millis(u64::from(timeout_ms));
    let running = match timeout(duration, async {
        reqwest::Client::new()
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
    })
    .await
    {
        Ok(Ok(resp)) if resp.status().as_u16() == 200 => resp
            .text()
            .await
            .ok()
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            .and_then(|body| body.get("version").cloned())
            .unwrap_or(serde_json::Value::Null),
        _ => serde_json::Value::Null,
    };
    Ok(serde_json::json!({ "running": running, "expected": expected }))
}

// App-conversation-channel bridge (voice arc Stage 0): proxies the webview
// to the daemon's POST /v1/companion/converse endpoint, which drives one
// real turn on the owner's own session and hands the reply back
// synchronously. Discovers the daemon's baseUrl + bearer token the same way
// the CLI/daemon do — <stateDir>/internal-api-info.json (written by
// registerInternalApi in src/daemon/internal-api/lifecycle.ts) holds
// {baseUrl, tokenFilePath, operatorTokenFilePath}; stateDir defaults to
// ~/.claude/channels/wechat, overridable via WECHAT_STATE_DIR (mirrors
// src/lib/config.ts STATE_DIR).
// Unlike wechat_health_ping (which receives port/token_file_path from JS,
// itself sourced from the doctor report), this command is self-contained —
// it has no doctor report to lean on, so it re-derives the same paths.
//
// Security (option B fix, see token-registry.ts's module doc comment):
// POST /v1/companion/converse is admin-tier, but the daemon-wide
// `tokenFilePath` token is only ever registered `trusted` (it's the
// shell-readable operator-CLI token — see index.ts's registerFileToken
// comment) so presenting it here always 403s. Instead this command reads
// the SEPARATE `operatorTokenFilePath` — a distinct admin-tier credential
// minted only for local-operator use. Anyone who can read that file already
// has local filesystem access as the machine owner (could read the WeChat
// data directly), so granting it admin is a deliberate, narrowly-scoped
// exception. Do NOT fall back to tokenFilePath here — that would either
// 403 (correct but confusing) or, worse, mask a real daemon/version
// mismatch where operatorTokenFilePath hasn't been written yet.
#[tauri::command]
async fn agent_converse(text: String) -> Result<String, String> {
    use std::time::Duration;
    use tokio::time::timeout;

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let state_dir = std::env::var("WECHAT_STATE_DIR")
        .unwrap_or_else(|_| {
            PathBuf::from(home)
                .join(".claude")
                .join("channels")
                .join("wechat")
                .to_string_lossy()
                .to_string()
        });
    let info_path = PathBuf::from(&state_dir).join("internal-api-info.json");

    let info_raw = std::fs::read_to_string(&info_path)
        .map_err(|e| format!("read {}: {e}", info_path.display()))?;
    let info: Value = serde_json::from_str(&info_raw)
        .map_err(|e| format!("invalid JSON in {}: {e}", info_path.display()))?;

    let base_url = info
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing baseUrl in {}", info_path.display()))?;
    // operatorTokenFilePath, not tokenFilePath — see the doc comment above
    // this command. Absent means an old daemon that predates the option B
    // fix; fail clearly rather than silently falling back to a token that
    // will just 403.
    let operator_token_file_path = info
        .get("operatorTokenFilePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "operator token unavailable — daemon too old".to_string())?;

    let token = std::fs::read_to_string(operator_token_file_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;

    let url = format!("{base_url}/v1/companion/converse");
    // Must outlast the daemon's own turn budget (turnTimeoutMs, default 10
    // minutes — bootstrap/index.ts): the converse route replies only when
    // the turn finishes, and a cold-start owner turn routinely runs past a
    // minute. A 60s client timeout dropped a completed 108s reply on the
    // floor (2026-08-24 一直没回复 bug): the sink captured it, the HTTP
    // response was written, and nobody was listening.
    let duration = Duration::from_secs(630);
    // reqwest's `json` feature is not enabled in this crate (see Cargo.toml —
    // default-features = false, only "rustls-tls"), so serialize the body by
    // hand rather than pull in a new feature flag.
    let payload = serde_json::to_string(&serde_json::json!({ "text": text }))
        .map_err(|e| format!("failed to serialize request body: {e}"))?;

    let result = timeout(duration, async {
        reqwest::Client::new()
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(payload)
            .send()
            .await
    })
    .await;

    let resp = match result {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => return Err(format!("request error: {e}")),
        Err(_) => return Err("request timed out".to_string()),
    };

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body ({status}): {e}"))?;
    let body: Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("invalid JSON response ({status}): {e}\n{body_text}"))?;

    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        let reply = body
            .get("reply")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        Ok(reply)
    } else {
        let err_msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("request failed: {status}"));
        Err(err_msg)
    }
}

// App-conversation-channel bridge (voice arc Stage 1): proxies the webview
// to the daemon's POST /v1/companion/speak endpoint, which synthesizes reply
// audio for the given text and hands the bytes back as base64. Mirrors
// agent_converse above precisely — same operator-token discovery via
// <stateDir>/internal-api-info.json's operatorTokenFilePath (see that
// command's doc comment for the full security rationale on why the
// operator token, not tokenFilePath, is used here). Only the route and the
// response shape differ: {ok, audio_b64, mime} instead of {ok, reply}.
#[derive(serde::Serialize)]
struct SpeakOut {
    audio_b64: String,
    mime: String,
}

#[tauri::command]
async fn agent_speak(text: String) -> Result<SpeakOut, String> {
    use std::time::Duration;
    use tokio::time::timeout;

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let state_dir = std::env::var("WECHAT_STATE_DIR")
        .unwrap_or_else(|_| {
            PathBuf::from(home)
                .join(".claude")
                .join("channels")
                .join("wechat")
                .to_string_lossy()
                .to_string()
        });
    let info_path = PathBuf::from(&state_dir).join("internal-api-info.json");

    let info_raw = std::fs::read_to_string(&info_path)
        .map_err(|e| format!("read {}: {e}", info_path.display()))?;
    let info: Value = serde_json::from_str(&info_raw)
        .map_err(|e| format!("invalid JSON in {}: {e}", info_path.display()))?;

    let base_url = info
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing baseUrl in {}", info_path.display()))?;
    // operatorTokenFilePath, not tokenFilePath — see agent_converse's doc
    // comment above for why.
    let operator_token_file_path = info
        .get("operatorTokenFilePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "operator token unavailable — daemon too old".to_string())?;

    let token = std::fs::read_to_string(operator_token_file_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;

    let url = format!("{base_url}/v1/companion/speak");
    let duration = Duration::from_secs(60);
    // reqwest's `json` feature is not enabled in this crate (see Cargo.toml —
    // default-features = false, only "rustls-tls"), so serialize the body by
    // hand rather than pull in a new feature flag.
    let payload = serde_json::to_string(&serde_json::json!({ "text": text }))
        .map_err(|e| format!("failed to serialize request body: {e}"))?;

    let result = timeout(duration, async {
        reqwest::Client::new()
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(payload)
            .send()
            .await
    })
    .await;

    let resp = match result {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => return Err(format!("request error: {e}")),
        Err(_) => return Err("request timed out".to_string()),
    };

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body ({status}): {e}"))?;
    let body: Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("invalid JSON response ({status}): {e}\n{body_text}"))?;

    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        let audio_b64 = body
            .get("audio_b64")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let mime = body
            .get("mime")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        Ok(SpeakOut { audio_b64, mime })
    } else {
        let err_msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("request failed: {status}"));
        Err(err_msg)
    }
}

// agent_transcribe — voice arc Stage 2 (voice-in). POSTs an inbound audio clip
// (base64) to the daemon's POST /v1/companion/transcribe endpoint, which sends
// it to the gateway STT and returns the recognized text. Mirrors agent_speak
// precisely (same operator-token discovery + route-scoped credential); only the
// route, request body ({audio_b64, mime}) and response ({ok, text}) differ.
#[tauri::command]
async fn agent_transcribe(audio_b64: String, mime: String) -> Result<String, String> {
    use std::time::Duration;
    use tokio::time::timeout;

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let state_dir = std::env::var("WECHAT_STATE_DIR").unwrap_or_else(|_| {
        PathBuf::from(home)
            .join(".claude")
            .join("channels")
            .join("wechat")
            .to_string_lossy()
            .to_string()
    });
    let info_path = PathBuf::from(&state_dir).join("internal-api-info.json");

    let info_raw = std::fs::read_to_string(&info_path)
        .map_err(|e| format!("read {}: {e}", info_path.display()))?;
    let info: Value = serde_json::from_str(&info_raw)
        .map_err(|e| format!("invalid JSON in {}: {e}", info_path.display()))?;

    let base_url = info
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing baseUrl in {}", info_path.display()))?;
    let operator_token_file_path = info
        .get("operatorTokenFilePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "operator token unavailable — daemon too old".to_string())?;

    let token = std::fs::read_to_string(operator_token_file_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;

    let url = format!("{base_url}/v1/companion/transcribe");
    // Transcription can be slower than TTS on a cold whisper model — allow 120s.
    let duration = Duration::from_secs(120);
    let payload = serde_json::to_string(&serde_json::json!({ "audio_b64": audio_b64, "mime": mime }))
        .map_err(|e| format!("failed to serialize request body: {e}"))?;

    let result = timeout(duration, async {
        reqwest::Client::new()
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(payload)
            .send()
            .await
    })
    .await;

    let resp = match result {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => return Err(format!("request error: {e}")),
        Err(_) => return Err("request timed out".to_string()),
    };

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body ({status}): {e}"))?;
    let body: Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("invalid JSON response ({status}): {e}\n{body_text}"))?;

    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        Ok(body
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string())
    } else {
        let err_msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("request failed: {status}"));
        Err(err_msg)
    }
}

// Owner-only workspace proxy — keeps the admin operator token in this host
// process instead of the webview.
//
// WHY (2026-07-28 security review of 45a5211): the customer-review workspace
// originally fetched the daemon straight from JS, obtaining the operator token
// through `wechat_cli_json ['daemon','api-info','--operator']`. That put an
// admin-tier credential in the renderer's heap for the first time — and
// `wechat_cli_json` applies no argument filtering in the production app, so
// any script that can run in the webview (a future innerHTML hole rendering
// content from a stranger agent, a poisoned frontend dep, devtools) could take
// it and then reach every route in the operator token's routeAllow, including
// POST /v1/companion/converse — i.e. speak to WeChat as the owner. This
// command restores the invariant the other three owner-only commands hold: the
// renderer names an operation, the token never leaves Rust.
//
// The customer-review routes stay `admin` rather than being demoted to
// `trusted` (the other obvious fix): ordinary chat sessions are minted
// `trusted` (tierNameFromProfile), so demoting would let anyone talking to the
// bot read the owner's private customer judgments.
#[tauri::command]
async fn customer_review_api(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, String> {
    use std::time::Duration;
    use tokio::time::timeout;

    // Hard allow-list: this hands out admin authority, so it must never become
    // a generic daemon proxy. Reject anything outside the workspace's own
    // prefix, and any traversal-ish path, before touching the token.
    let route = path.split('?').next().unwrap_or("");
    // 待办 workspace (2026-08-24) shares this channel: obligation list +
    // status writes, contact display names, reminder scheduling — all the
    // owner's own private data, exactly customer review's trust class.
    // Still a hard allow-list, still no generic proxying.
    const OWNER_WORKSPACE_ROUTES: [&str; 6] = [
        "/v1/knowledge/facts/find_facts",
        "/v1/llm/keys",
        "/v1/companion/thoughts",
        "/v1/knowledge/facts/set_fact_status",
        "/v1/knowledge/graph/top_contacts",
        "/v1/reminders/schedule",
    ];
    let allowed = route == "/v1/customer-review"
        || route.starts_with("/v1/customer-review/")
        || OWNER_WORKSPACE_ROUTES.contains(&route);
    if !allowed || path.contains("..") {
        return Err(format!("customer_review_api refuses path: {path}"));
    }
    if method != "GET" && method != "POST" {
        return Err(format!("customer_review_api refuses method: {method}"));
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let state_dir = std::env::var("WECHAT_STATE_DIR").unwrap_or_else(|_| {
        PathBuf::from(home)
            .join(".claude")
            .join("channels")
            .join("wechat")
            .to_string_lossy()
            .to_string()
    });
    let info_path = PathBuf::from(&state_dir).join("internal-api-info.json");

    let info_raw = std::fs::read_to_string(&info_path)
        .map_err(|e| format!("read {}: {e}", info_path.display()))?;
    let info: Value = serde_json::from_str(&info_raw)
        .map_err(|e| format!("invalid JSON in {}: {e}", info_path.display()))?;

    let base_url = info
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing baseUrl in {}", info_path.display()))?;
    // Same rule as agent_converse: never fall back to tokenFilePath.
    let operator_token_file_path = info
        .get("operatorTokenFilePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "operator token unavailable — daemon too old".to_string())?;
    let token = std::fs::read_to_string(operator_token_file_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;

    let url = format!("{base_url}{path}");
    let result = timeout(Duration::from_secs(30), async {
        let client = reqwest::Client::new();
        let req = if method == "GET" {
            client.get(&url)
        } else {
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .body(body.unwrap_or_else(|| "{}".to_string()))
        };
        req.header("Authorization", format!("Bearer {token}"))
            .send()
            .await
    })
    .await;

    let resp = match result {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => return Err(format!("request error: {e}")),
        Err(_) => return Err("request timed out".to_string()),
    };
    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body ({status}): {e}"))?;
    if !status.is_success() {
        let err_msg = serde_json::from_str::<Value>(&body_text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(err_msg);
    }
    Ok(body_text)
}

fn workbench_request_allowed(method: &str, path: &str) -> bool {
    let route = path.split('?').next().unwrap_or("");
    if route.contains("..") {
        return false;
    }
    matches!(
        (method, route),
        ("GET", "/v1/workbench")
            | ("GET", "/v1/workbench/models")
            | ("GET", "/v1/workbench/sessions")
            | ("GET", "/v1/workbench/session")
            | ("GET", "/v1/workbench/task")
            | ("GET", "/v1/workbench/artifact")
            | ("GET", "/v1/workbench/attachment")
            | ("POST", "/v1/workbench/attachment")
            | ("POST", "/v1/workbench/discard-attachment")
            | ("POST", "/v1/workbench/create")
            | ("POST", "/v1/workbench/continue")
            | ("POST", "/v1/workbench/cancel")
            | ("POST", "/v1/workbench/approve")
            | ("POST", "/v1/workbench/permission")
            | ("POST", "/v1/workbench/archive")
            | ("POST", "/v1/workbench/import")
            | ("POST", "/v1/workbench/prepare-resume")
            | ("POST", "/v1/workbench/prepare-continuation")
            | ("POST", "/v1/workbench/handoff-preview")
            | ("POST", "/v1/workbench/handoff")
            | ("GET", "/v1/workbench/handoff")
            | ("GET", "/v1/workbench/attention")
            | ("POST", "/v1/workbench/input")
            | ("POST", "/v1/workbench/answer")
            | ("POST", "/v1/workbench/withdraw-input")
    )
}

// Workbench owns admin-only folder tasks and artifact snapshots. Keep its
// operator token in Rust and expose only the exact contract routes above.
fn validate_workbench_body(method: &str, path: &str, body: Option<&str>) -> Result<(), String> {
    let route = path.split('?').next().unwrap_or("");
    let limit = if route == "/v1/workbench/attachment" { 12 * 1024 * 1024 } else { 128 * 1024 };
    if method == "POST" && body.is_some_and(|value| value.len() > limit) {
        return Err("request_body_too_large".into());
    }
    Ok(())
}

#[tauri::command]
async fn workbench_api(method: String, path: String, body: Option<String>) -> Result<String, String> {
    use std::time::Duration;
    use tokio::time::timeout;

    if !workbench_request_allowed(&method, &path) {
        return Err(format!("workbench_api refuses request: {method} {path}"));
    }
    validate_workbench_body(&method, &path, body.as_deref())?;
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let state_dir = std::env::var("WECHAT_STATE_DIR").unwrap_or_else(|_| {
        PathBuf::from(home).join(".claude").join("channels").join("wechat").to_string_lossy().to_string()
    });
    // Match the browser development proxy's isolated workbench runtime while
    // keeping companion/CLI discovery on WECHAT_STATE_DIR. Release builds
    // always use the shared daemon and do not read this development override.
    #[cfg(debug_assertions)]
    let state_dir = std::env::var("WECHAT_CC_WORKBENCH_STATE_DIR")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or(state_dir);
    let info_path = PathBuf::from(state_dir).join("internal-api-info.json");
    let info: Value = serde_json::from_str(&std::fs::read_to_string(&info_path)
        .map_err(|e| format!("read {}: {e}", info_path.display()))?)
        .map_err(|e| format!("invalid JSON in {}: {e}", info_path.display()))?;
    let base_url = info.get("baseUrl").and_then(Value::as_str)
        .ok_or_else(|| format!("missing baseUrl in {}", info_path.display()))?;
    let token_path = info.get("operatorTokenFilePath").and_then(Value::as_str)
        .ok_or_else(|| "operator token unavailable — daemon too old".to_string())?;
    let token = std::fs::read_to_string(token_path).map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;
    let url = format!("{base_url}{path}");
    let response = timeout(Duration::from_secs(30), async {
        let client = reqwest::Client::new();
        let request = if method == "GET" { client.get(url) } else {
            client.post(url).header("Content-Type", "application/json").body(body.unwrap_or_else(|| "{}".into()))
        };
        request.bearer_auth(token).send().await
    }).await.map_err(|_| "request timed out".to_string())?
      .map_err(|e| format!("request error: {e}"))?;
    let status = response.status();
    let response_body = response.text().await.map_err(|e| format!("failed to read response body ({status}): {e}"))?;
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&response_body).ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(message);
    }
    serde_json::from_str::<Value>(&response_body)
        .map_err(|e| format!("invalid JSON response ({status}): {e}"))?;
    Ok(response_body)
}

#[tauri::command]
fn choose_workbench_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("osascript")
            .args(["-e", "POSIX path of (choose folder with prompt \"选择工作台文件夹\")"])
            .output().map_err(|e| format!("open folder chooser: {e}"))?;
        if !output.status.success() {
            // AppleScript reports user cancellation on stderr; cancellation is
            // a normal empty result rather than a page error.
            return Ok(None);
        }
        let path = String::from_utf8(output.stdout).map_err(|e| format!("folder path is not UTF-8: {e}"))?;
        return Ok(Some(path.trim_end_matches(['\r', '\n']).to_string()));
    }
    #[cfg(not(target_os = "macos"))]
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Open a URL with the system handler. Used for the macOS System Settings
/// deep link when the daemon reports it cannot read the owner's folders
/// (TCC). Allow-list the schemes: this is reachable from the webview.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let ok = url.starts_with("https://") || url.starts_with("x-apple.systempreferences:");
    if !ok {
        return Err(format!("refusing to open url with scheme: {url}"));
    }
    // `open` via the OS launcher rather than the shell plugin's deprecated
    // `open` (which wants a new opener plugin + capability for one call).
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .status()
            .map_err(|e| format!("open failed: {e}"))
            .and_then(|st| if st.success() { Ok(()) } else { Err(format!("open exited {st}")) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("open_url is macOS-only".to_string())
    }
}

// Desktop pet permission card (spec 2026-09-05 §6): the companion window
// resolves a pending tool permission the same way the WeChat "允许 <hash>"
// reply does — one shared `consume(hash, decision)` on the daemon side.
// POST /v1/permissions/resolve is **admin** tier (it IS the permission), so
// like agent_converse this reads the SEPARATE operatorTokenFilePath from
// <stateDir>/internal-api-info.json — see agent_converse's doc comment for
// the full security rationale. Doing it in Rust keeps that token out of the
// webview entirely; the page only ever names a hash and a decision.
#[tauri::command]
async fn pet_permission_resolve(hash: String, decision: String) -> Result<bool, String> {
    use std::time::Duration;
    use tokio::time::timeout;

    // Reject anything that isn't one of the two decisions before touching the
    // network: a typo must not reach the daemon as an unknown verb.
    if decision != "allow" && decision != "deny" {
        return Err(format!("invalid decision: {decision}"));
    }
    if hash.trim().is_empty() {
        return Err("missing permission hash".to_string());
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    let state_dir = std::env::var("WECHAT_STATE_DIR").unwrap_or_else(|_| {
        PathBuf::from(home)
            .join(".claude")
            .join("channels")
            .join("wechat")
            .to_string_lossy()
            .to_string()
    });
    let info_path = PathBuf::from(&state_dir).join("internal-api-info.json");

    let info_raw = std::fs::read_to_string(&info_path)
        .map_err(|e| format!("read {}: {e}", info_path.display()))?;
    let info: Value = serde_json::from_str(&info_raw)
        .map_err(|e| format!("invalid JSON in {}: {e}", info_path.display()))?;

    let base_url = info
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing baseUrl in {}", info_path.display()))?;
    // operatorTokenFilePath, not tokenFilePath — see agent_converse's doc
    // comment (the daemon-wide token is trusted tier and would just 403).
    let operator_token_file_path = info
        .get("operatorTokenFilePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "operator token unavailable — daemon too old".to_string())?;

    let token = std::fs::read_to_string(operator_token_file_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;

    let url = format!("{base_url}/v1/permissions/resolve");
    // reqwest's `json` feature is off in this crate (Cargo.toml) — serialize
    // by hand, same as the other commands here.
    let payload = serde_json::to_string(&serde_json::json!({ "hash": hash, "decision": decision }))
        .map_err(|e| format!("failed to serialize request body: {e}"))?;

    // The route only flips an in-memory pending entry and returns; 10s is
    // generous. A person is watching a button — fail fast and let them retry.
    let result = timeout(Duration::from_secs(10), async {
        reqwest::Client::new()
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(payload)
            .send()
            .await
    })
    .await;

    let resp = match result {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => return Err(format!("request error: {e}")),
        Err(_) => return Err("request timed out".to_string()),
    };

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body ({status}): {e}"))?;
    let body: Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("invalid JSON response ({status}): {e}\n{body_text}"))?;
    if !status.is_success() {
        let err_msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(err_msg);
    }
    // `ok:false` is a real answer, not an error: the hash was already consumed
    // (WeChat got there first) or expired. The card re-syncs from the next poll.
    Ok(body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
}

pub fn run() {
    tauri::Builder::default()
        .manage(PendingNavigate(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            wechat_cli_json,
            wechat_cli_json_via_file,
            wechat_cli_text,
            save_text_file,
            render_qr_svg,
            open_companion_window,
            close_companion_window,
            start_companion_drag,
            resize_companion_window,
            show_main_window,
            take_pending_navigate,
            wechat_daemon_pid,
            notify_user,
            wechat_health_ping,
            wechat_health_version,
            open_url,
            pet_permission_resolve,
            agent_converse,
            agent_speak,
            agent_transcribe,
            customer_review_api,
            workbench_api,
            choose_workbench_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building wechat-cc desktop")
        .run(|app, event| {
            // On macOS, clicking the Dock icon (or opening the app again) emits
            // `Reopen`. The companion aquarium is always-on-top, so without an
            // explicit main-window focus it can look as though the dashboard
            // never opened. Keep the companion running, but bring the real app
            // window back whenever the user re-enters WeChat-cc.
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
        });
}

#[cfg(test)]
mod workbench_proxy_tests {
    use super::workbench_request_allowed;
    static ENVIRONMENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn isolated_workbench_state_is_debug_only_and_leaves_shared_state_unchanged() {
        let _guard = ENVIRONMENT_LOCK.lock().unwrap();
        // Exercise the actual command's discovery path using nonexistent,
        // unique directories: this must never contact a real daemon.
        let root = std::env::temp_dir().join(format!(
            "wechat-workbench-state-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let shared = root.join("shared");
        let isolated = root.join("isolated");
        let previous_shared = std::env::var_os("WECHAT_STATE_DIR");
        let previous_workbench = std::env::var_os("WECHAT_CC_WORKBENCH_STATE_DIR");
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

        std::env::set_var("WECHAT_STATE_DIR", &shared);
        std::env::set_var("WECHAT_CC_WORKBENCH_STATE_DIR", &isolated);
        let override_result = runtime.block_on(super::workbench_api("GET".into(), "/v1/workbench".into(), None));
        let shared_after_request = std::env::var_os("WECHAT_STATE_DIR");
        std::env::set_var("WECHAT_CC_WORKBENCH_STATE_DIR", "");
        let empty_result = runtime.block_on(super::workbench_api("GET".into(), "/v1/workbench".into(), None));
        std::env::remove_var("WECHAT_CC_WORKBENCH_STATE_DIR");
        let absent_result = runtime.block_on(super::workbench_api("GET".into(), "/v1/workbench".into(), None));

        // Restore process state before assertions, including when one fails.
        for (key, previous) in [
            ("WECHAT_STATE_DIR", previous_shared),
            ("WECHAT_CC_WORKBENCH_STATE_DIR", previous_workbench),
        ] {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let selected = if cfg!(debug_assertions) { &isolated } else { &shared };
        assert!(override_result.unwrap_err().starts_with(&format!(
            "read {}:", selected.join("internal-api-info.json").display()
        )));
        for result in [empty_result, absent_result] {
            assert!(result.unwrap_err().starts_with(&format!(
                "read {}:", shared.join("internal-api-info.json").display()
            )));
        }
        assert_eq!(shared_after_request, Some(shared.into_os_string()));
    }

    #[test]
    fn workbench_rejects_oversized_bodies_before_discovery() {
        let _guard = ENVIRONMENT_LOCK.lock().unwrap();
        let missing = std::env::temp_dir().join(format!("cc-oversized-body-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let previous: Vec<_> = ["WECHAT_STATE_DIR", "WECHAT_CC_WORKBENCH_STATE_DIR"].into_iter().map(|key| (key, std::env::var_os(key))).collect();
        for (key, _) in &previous { std::env::set_var(key, &missing); }
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let mut results = Vec::new();
        for (path, limit) in [
            ("/v1/workbench/continue", 128 * 1024),
            ("/v1/workbench/attachment?draft=owned", 12 * 1024 * 1024),
        ] {
            // Character count remains below the limit; UTF-8 bytes exceed it.
            let body = "é".repeat(limit / 2 + 1);
            let result = runtime.block_on(super::workbench_api("POST".into(), path.into(), Some(body)));
            results.push((path, result));
        }
        for (key, value) in previous { match value { Some(value) => std::env::set_var(key, value), None => std::env::remove_var(key) } }
        for (path, result) in results { assert_eq!(result.unwrap_err(), "request_body_too_large", "{path}"); }
    }

    #[test]
    fn workbench_body_limits_accept_exact_utf8_bytes_and_optional_empty_body() {
        for (path, limit) in [
            ("/v1/workbench/continue", 128 * 1024),
            ("/v1/workbench/attachment?draft=owned", 12 * 1024 * 1024),
        ] {
            let exact = "é".repeat(limit / 2);
            assert!(super::validate_workbench_body("POST", path, Some(&exact)).is_ok());
            assert_eq!(super::validate_workbench_body("POST", path, Some(&(exact + "x"))).unwrap_err(), "request_body_too_large");
            assert!(super::validate_workbench_body("POST", path, None).is_ok());
        }
    }

    #[test]
    fn allows_only_the_exact_workbench_method_route_pairs() {
        for (method, path) in [
            ("GET", "/v1/workbench"),
            ("GET", "/v1/workbench/task?id=A1B2C3D4"),
            ("GET", "/v1/workbench/sessions?providerId=claude"),
            ("GET", "/v1/workbench/models?providerId=codex&path=%2Fwork"),
            ("GET", "/v1/workbench/session?key=opaque"),
            ("GET", "/v1/workbench/artifact?id=A1B2C3D4&artifactId=file-1"),
            ("POST", "/v1/workbench/attachment"),
            ("GET", "/v1/workbench/attachment?taskId=deadbeef&id=file-1"),
            ("POST", "/v1/workbench/discard-attachment"),
            ("POST", "/v1/workbench/create"),
            ("POST", "/v1/workbench/continue"),
            ("POST", "/v1/workbench/cancel"),
            ("POST", "/v1/workbench/approve"),
            ("POST", "/v1/workbench/permission"),
            ("POST", "/v1/workbench/archive"),
            ("POST", "/v1/workbench/import"),
            ("POST", "/v1/workbench/prepare-resume"),
            ("POST", "/v1/workbench/prepare-continuation"),
            ("POST", "/v1/workbench/handoff-preview"),
            ("POST", "/v1/workbench/handoff"),
            ("GET", "/v1/workbench/handoff"),
            ("GET", "/v1/workbench/attention"),
            ("POST", "/v1/workbench/input"),
            ("POST", "/v1/workbench/withdraw-input"),
            ("POST", "/v1/workbench/answer"),
            ("GET", "/v1/workbench?q=..&archived=all"),
        ] {
            assert!(workbench_request_allowed(method, path), "expected {method} {path} to be allowed");
        }
        for (method, path) in [
            ("DELETE", "/v1/workbench/attachment"),
            ("GET", "/v1/workbench/discard-attachment"),
            ("POST", "/v1/workbench/attachment/extra"),
            ("GET", "/v1/workbench/attachment/"),
            ("POST", "/v1/workbench/discard-attachment/extra"),
            ("POST", "/v1/workbench"),
            ("GET", "/v1/workbench/create"),
            ("GET", "/v1/workbench/archive"),
            ("POST", "/v1/workbench/archive/extra"),
            ("GET", "/v1/workbench/import"),
            ("GET", "/v1/workbench/prepare-resume"),
            ("GET", "/v1/workbench/prepare-continuation"),
            ("POST", "/v1/workbench/prepare-continuation/extra"),
            ("POST", "/v1/workbench/import/extra"),
            ("GET", "/v1/workbench/task/extra"),
            ("POST", "/v1/workbench/sessions"),
            ("POST", "/v1/workbench/models"),
            ("GET", "/v1/workbench/models/extra"),
            ("POST", "/v1/workbench/session"),
            ("GET", "/v1/workbench/session/extra"),
            ("POST", "/v1/workbench/attention"),
            ("GET", "/v1/workbench/input"),
            ("GET", "/v1/workbench/withdraw-input"),
            ("GET", "/v1/workbench/answer"),
            ("DELETE", "/v1/workbench/attention"),
            ("DELETE", "/v1/workbench/input"),
            ("DELETE", "/v1/workbench/withdraw-input"),
            ("DELETE", "/v1/workbench/answer"),
            ("GET", "/v1/workbench/attention/extra"),
            ("POST", "/v1/workbench/input/extra"),
            ("POST", "/v1/workbench/withdraw-input/extra"),
            ("POST", "/v1/workbench/answer/extra"),
            ("GET", "/v1/workbench/attention/"),
            ("POST", "/v1/workbench/input/"),
            ("POST", "/v1/workbench/withdraw-input/"),
            ("POST", "/v1/workbench/answer/"),
            ("GET", "/v1/workbench/../companion/presence"),
            ("DELETE", "/v1/workbench/task?id=A1B2C3D4"),
            ("GET", "/v1/customer-review"),
        ] {
            assert!(!workbench_request_allowed(method, path), "expected {method} {path} to be refused");
        }
    }
}

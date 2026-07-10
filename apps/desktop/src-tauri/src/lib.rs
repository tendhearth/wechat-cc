// wechat-cc desktop installer — Tauri command surface.
//
// The bundled `wechat-cc-cli` sidecar (a `bun build --compile`d
// self-contained binary built from the project's cli.ts) is the single
// source of truth for every CLI operation the GUI invokes. There is no
// dependency on a system-installed `bun`, no requirement for a cloned
// wechat-cc source tree, and no PATH lookup — the sidecar lives inside
// the .app/.exe/.deb bundle and is resolved by tauri-plugin-shell.

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
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

// App-conversation-channel bridge (voice arc Stage 0): proxies the webview
// to the daemon's POST /v1/companion/converse endpoint, which drives one
// real turn on the owner's own session and hands the reply back
// synchronously. Discovers the daemon's baseUrl + bearer token the same way
// the CLI/daemon do — <stateDir>/internal-api-info.json (written by
// registerInternalApi in src/daemon/internal-api/lifecycle.ts) holds
// {baseUrl, tokenFilePath}; stateDir defaults to ~/.claude/channels/wechat,
// overridable via WECHAT_STATE_DIR (mirrors src/lib/config.ts STATE_DIR).
// Unlike wechat_health_ping (which receives port/token_file_path from JS,
// itself sourced from the doctor report), this command is self-contained —
// it has no doctor report to lean on, so it re-derives the same paths.
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
    let token_file_path = info
        .get("tokenFilePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing tokenFilePath in {}", info_path.display()))?;

    let token = std::fs::read_to_string(token_file_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token read error: {e}"))?;

    let url = format!("{base_url}/v1/companion/converse");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            wechat_cli_json,
            wechat_cli_json_via_file,
            wechat_cli_text,
            save_text_file,
            render_qr_svg,
            wechat_daemon_pid,
            notify_user,
            wechat_health_ping,
            agent_converse
        ])
        .run(tauri::generate_context!())
        .expect("error while running wechat-cc desktop");
}

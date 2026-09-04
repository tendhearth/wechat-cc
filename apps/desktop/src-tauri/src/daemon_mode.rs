//! `wechat-cc --daemon …` — headless: no window, no Dock icon, no Tauri runtime.
//!
//! WHY (2026-09-04): macOS attributes privacy permissions (TCC) to the
//! *responsible process*. When launchd starts the daemon as
//! `~/.bun/bin/bun cli.ts run`, the identity is **bun** — every bun script on
//! the machine shares the grant, System Settings lists "bun", and there is no
//! usage description. Worse, the packaged sidecar is ad-hoc signed, so its
//! identity changes with every build and grants silently evaporate.
//!
//! The fix is structural: the LaunchAgent launches *this* executable (the
//! app's main binary, inside the signed bundle with its Info.plist usage
//! strings), and this executable spawns the sidecar. Then:
//!   - the prompt says "wechat-cc 想要访问…" with our own wording
//!   - System Settings shows the wechat-cc icon
//!   - claude / codex / agy / wxvault are all descendants → inherit the grant
//!   - swapping the LLM provider never touches permissions
//!
//! Deliberately std-only. No Tauri here: building the Tauri app would create
//! an NSApplication, and even without a window that means activation-policy
//! juggling to stay out of the Dock. A plain process that execs the sidecar
//! has none of that.
//!
//! Lifecycle: launchd's default `AbandonProcessGroup=false` SIGKILLs the whole
//! process group when the job is unloaded, so the sidecar dies with us. We do
//! not forward signals ourselves — one fewer place to be wrong.

use std::env;
use std::path::PathBuf;
use std::process::{self, Command};

/// Sidecar lives next to the main binary inside `Contents/MacOS/`.
fn sidecar_path() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent dir".to_string())?;
    let candidate = dir.join("wechat-cc-cli");
    if candidate.is_file() {
        return Ok(candidate);
    }
    Err(format!("sidecar not found at {}", candidate.display()))
}

/// Bundled plugins dir: `<bundle>/Contents/Resources/plugins` when present.
/// Mirrors `bundled_plugins_dir` in lib.rs without needing an AppHandle.
fn bundled_plugins_dir() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    // …/wechat-cc.app/Contents/MacOS/wechat-cc → …/Contents/Resources/plugins
    let contents = exe.parent()?.parent()?;
    let dir = contents.join("Resources").join("plugins");
    if dir.is_dir() { Some(dir) } else { None }
}

/// Run the sidecar with the remaining args (typically `run --dangerously`)
/// and exit with its status. Never returns.
pub fn run(args: Vec<String>) -> ! {
    let sidecar = match sidecar_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("wechat-cc --daemon: {e}");
            process::exit(2);
        }
    };
    let mut cmd = Command::new(&sidecar);
    cmd.args(&args);
    if let Some(dir) = bundled_plugins_dir() {
        cmd.env("WECHAT_CC_BUNDLED_PLUGINS_DIR", dir);
    }
    // Tell the sidecar who launched it — the CLI's service planner uses this
    // to keep pointing the LaunchAgent at the app binary rather than at itself.
    cmd.env("WECHAT_CC_LAUNCHED_BY_APP", "1");
    let status = match cmd.status() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("wechat-cc --daemon: spawn {}: {e}", sidecar.display());
            process::exit(2);
        }
    };
    process::exit(status.code().unwrap_or(1));
}

/// `--daemon` must be the FIRST argument. Returns the remaining args when set.
pub fn parse(argv: &[String]) -> Option<Vec<String>> {
    if argv.len() >= 2 && argv[1] == "--daemon" {
        Some(argv[2..].to_vec())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn v(a: &[&str]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn daemon_flag_must_be_first() {
        assert_eq!(parse(&v(&["wechat-cc", "--daemon", "run", "--dangerously"])), Some(v(&["run", "--dangerously"])));
        assert_eq!(parse(&v(&["wechat-cc", "run", "--daemon"])), None);
        assert_eq!(parse(&v(&["wechat-cc"])), None);
    }

    #[test]
    fn no_args_after_flag_is_fine() {
        assert_eq!(parse(&v(&["wechat-cc", "--daemon"])), Some(vec![]));
    }
}

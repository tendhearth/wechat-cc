//! Only daemon-owned scripts reach the OS launcher. No general shell command IPC.
use serde::Deserialize;

pub fn validate_request(provider: &str, action: &str) -> Result<(), String> {
    if !matches!(provider, "claude" | "codex" | "cursor" | "agy" | "grok") {
        return Err("invalid_provider".into());
    }
    if !matches!(action, "install" | "login") { return Err("invalid_action".into()); }
    Ok(())
}

#[derive(Deserialize)]
pub struct SetupPlan {
    ok: bool,
    provider: String,
    action: String,
    extension: String,
    script: String,
}

pub fn parse_plan(provider: &str, action: &str, response: &str) -> Result<SetupPlan, String> {
    let plan: SetupPlan = serde_json::from_str(response).map_err(|_| "invalid_setup_response".to_string())?;
    if !plan.ok || plan.provider != provider || plan.action != action || plan.script.is_empty()
        || plan.script.len() > 32768 || !matches!(plan.extension.as_str(), "command" | "ps1") {
        return Err("invalid_setup_response".into());
    }
    Ok(plan)
}

#[cfg(unix)]
fn launch_macos_script(script: &str, launch: impl FnOnce(&str, &[String]) -> Result<(), String>) -> Result<(), String> {
    use std::fs::{DirBuilder, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::time::{SystemTime, UNIX_EPOCH};
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "setup_clock_failed")?.as_nanos();
    let dir = std::env::temp_dir().join(format!("cc-cli-setup-{}-{nonce}", std::process::id()));
    DirBuilder::new().mode(0o700).create(&dir).map_err(|_| "setup_temp_failed")?;
    let path = dir.join("connect.command");
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o700).open(&path).map_err(|_| "setup_script_failed")?;
        file.write_all(script.as_bytes()).map_err(|_| "setup_script_failed")?;
        file.sync_all().map_err(|_| "setup_script_failed")?;
        drop(file);
        // Match reveal/Finder: fixed executable and separate arguments, no AppleScript permissions.
        launch("/usr/bin/open", &["-a".into(), "Terminal".into(), path.to_string_lossy().into_owned()])
    })();
    if result.is_err() { let _ = std::fs::remove_file(&path); let _ = std::fs::remove_dir(&dir); }
    // Success: Terminal opens asynchronously; the script cleans itself via its EXIT trap.
    result
}

fn windows_args(script: &str) -> Vec<String> {
    ["-NoLogo", "-NoProfile", "-NoExit", "-Command", script].map(str::to_owned).to_vec()
}

pub fn open(plan: SetupPlan) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if plan.extension != "command" { return Err("invalid_setup_platform".into()); }
        launch_macos_script(&plan.script, |program, args| {
            std::process::Command::new(program).args(args).status()
                .map_err(|_| "open_cli_setup_failed".to_string())
                .and_then(|status| if status.success() { Ok(()) } else { Err("open_cli_setup_failed".into()) })
        })
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if plan.extension != "ps1" { return Err("invalid_setup_platform".into()); }
        std::process::Command::new("powershell.exe").args(windows_args(&plan.script))
            .creation_flags(0x00000010) // CREATE_NEW_CONSOLE: installer/login must be visible.
            .spawn().map(|_| ()).map_err(|_| "open_cli_setup_failed".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = plan; Err("cli_setup_unsupported".into()) }
}

#[cfg(test)]
#[path = "cli_setup_tests.rs"]
mod tests;

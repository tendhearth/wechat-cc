use super::*;

#[test]
fn only_provider_and_action_cross_the_native_boundary() {
    for provider in ["claude", "codex", "cursor", "agy", "grok"] {
        assert!(validate_request(provider, "login").is_ok());
    }
    for provider in ["", "Grok", "__proto__", "grok;whoami", "openai"] {
        assert!(validate_request(provider, "install").is_err());
    }
    assert!(validate_request("grok", "login;whoami").is_err());
}

#[test]
fn refuses_mismatched_daemon_response() {
    assert!(parse_plan("grok", "login", r#"{"ok":true,"provider":"claude","action":"login","extension":"command","script":"echo no"}"#).is_err());
    assert!(parse_plan("grok", "login", r#"{"ok":false,"provider":"grok","action":"login","extension":"command","script":"echo no"}"#).is_err());
}

#[cfg(unix)]
#[test]
fn fake_launcher_observes_private_script_and_fixed_terminal_arguments() {
    use std::os::unix::fs::PermissionsExt;
    let mut script_path = None;
    launch_macos_script("#!/bin/bash\necho fixture\n", |program, args| {
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(&args[..2], &["-a", "Terminal"]);
        let path = std::path::PathBuf::from(&args[2]);
        assert!(path.is_absolute());
        assert_eq!(path.extension().unwrap(), "command");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "#!/bin/bash\necho fixture\n");
        script_path = Some(path);
        Ok(())
    }).unwrap();
    let path = script_path.unwrap();
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[cfg(unix)]
#[test]
fn launch_failure_removes_script() {
    let mut directory = None;
    let r = launch_macos_script("fixture", |_, args| {
        directory = Some(std::path::PathBuf::from(&args[2]).parent().unwrap().to_path_buf());
        Err("fixture failure".into())
    });
    assert_eq!(r.unwrap_err(), "fixture failure");
    assert!(!directory.unwrap().exists());
}

#[test]
fn windows_opens_a_visible_powershell_without_policy_bypass_or_shell_interpolation() {
    let args = windows_args("Write-Host 'fixture $value'");
    assert_eq!(args, vec!["-NoLogo", "-NoProfile", "-NoExit", "-Command", "Write-Host 'fixture $value'"]);
    assert!(!args.iter().any(|arg| arg.contains("Bypass") || arg.contains("Hidden")));
}

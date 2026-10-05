use std::path::PathBuf;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "cc-native-io-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn downloads_preserve_existing_file_and_save_binary_bytes() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("output.bin"), b"keep existing").unwrap();
    let saved = super::write_download_in(&fixture.0, "../output.bin", &[0, 255, 10]).unwrap();
    assert_eq!(PathBuf::from(saved), fixture.0.join("output (1).bin"));
    assert_eq!(std::fs::read(fixture.0.join("output.bin")).unwrap(), b"keep existing");
    assert_eq!(std::fs::read(fixture.0.join("output (1).bin")).unwrap(), [0, 255, 10]);
}

// Keep the process-wide file-size limit and inherited SIGXFSZ disposition out
// of the parallel test runner. The worker performs a real partial file write.
#[cfg(unix)]
#[test]
fn partial_write_failure_removes_only_the_new_download() {
    if let Some(directory) = std::env::var_os("CC_DOWNLOAD_FAULT_DIR") {
        let error = super::write_download_in(&PathBuf::from(directory), "output.bin", &vec![0x5a; 8192]).unwrap_err();
        assert!(error.starts_with("write "), "{error}");
        return;
    }
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("output.bin"), b"keep existing").unwrap();
    std::fs::create_dir(fixture.0.join("output (1).bin")).unwrap();
    let output = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("trap '' XFSZ; ulimit -f 1; exec \"$@\"")
        .arg("download-write-limit")
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", "native_io_tests::partial_write_failure_removes_only_the_new_download", "--nocapture"])
        .env("CC_DOWNLOAD_FAULT_DIR", &fixture.0)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(std::fs::read(fixture.0.join("output.bin")).unwrap(), b"keep existing");
    assert!(fixture.0.join("output (1).bin").is_dir());
    assert!(!fixture.0.join("output (2).bin").exists(), "partial download was left behind");
}

#[test]
fn save_file_ipc_requires_data_b64_in_camel_case_before_decoding() {
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![super::save_file])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let invoke = |body| get_ipc_response(&webview, tauri::webview::InvokeRequest {
        cmd: "save_file".into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: "http://tauri.localhost".parse().unwrap(),
        body: tauri::ipc::InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    }).unwrap_err().as_str().unwrap().to_string();
    for body in [
        serde_json::json!({ "filename": "unused.bin" }),
        serde_json::json!({ "filename": "unused.bin", "data_b64": "%%%" }),
    ] {
        assert!(invoke(body).contains("missing required key dataB64"));
    }
    // Reaching our decoder proves the command received dataB64. Invalid data
    // deliberately stops before home discovery or writing the owner's files.
    assert!(invoke(serde_json::json!({ "filename": "unused.bin", "dataB64": "%%%" })).starts_with("invalid base64:"));
}

#[cfg(unix)]
#[test]
fn launcher_reports_immediate_nonzero_exit() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let mut successful = tokio::process::Command::new("/bin/sh");
    successful.args(["-c", "exit 0"]);
    assert!(runtime.block_on(super::launch_url_with_initial_status(successful)).is_ok());
    let mut command = tokio::process::Command::new("/bin/sh");
    command.args(["-c", "exit 4"]);
    let error = runtime.block_on(super::launch_url_with_initial_status(command)).unwrap_err();
    assert!(error.starts_with("open exited "), "{error}");
}

#[cfg(unix)]
#[test]
fn long_running_launcher_returns_before_exit_and_is_reaped() {
    use std::time::Duration;
    let fixture = Fixture::new();
    let pid_file = fixture.0.join("pid");
    let completed = fixture.0.join("completed");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let mut command = tokio::process::Command::new("/bin/sh");
    command.args(["-c", "echo $$ > \"$1\"; sleep 3; printf completed > \"$2\"", "launcher-fixture"])
        .arg(&pid_file).arg(&completed);
    runtime.block_on(async {
        let result = tokio::time::timeout(Duration::from_secs(2), super::launch_url_with_initial_status(command))
            .await.expect("launcher blocked until browser exit");
        assert!(result.is_ok());
        assert!(!completed.exists(), "command waited for the long-running handler");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if completed.exists() {
                    let pid = std::fs::read_to_string(&pid_file).unwrap();
                    let output = std::process::Command::new("ps").args(["-p", pid.trim(), "-o", "stat="]).output().unwrap();
                    if output.stdout.is_empty() { break }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("launcher exited but was not reaped");
    });
    assert_eq!(std::fs::read(completed).unwrap(), b"completed");
}

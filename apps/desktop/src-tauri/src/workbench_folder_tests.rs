use super::*;

#[test]
fn folder_command_rejects_invalid_task_ids_before_daemon_discovery() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    for id in ["", "abc", "../task", "deadbeef&path=/tmp", "deadbeeλ", "deadbee\n", "012345678"] {
        assert_eq!(runtime.block_on(open_workbench_folder(id.into())).unwrap_err(), "invalid_task_id", "{id}");
    }
}

#[test]
fn folder_path_must_come_from_the_matching_daemon_task() {
    for body in ["null", "{}", r#"{"task":{"id":"feedbeef","path":"/tmp"}}"#, r#"{"task":{"id":"deadbeef","path":1}}"#] {
        assert_eq!(workbench_folder_path("deadbeef", body).unwrap_err(), "invalid_task_directory");
    }
    for path in ["", "relative/folder", "/tmp/../tmp", "https://example.com"] {
        let body = serde_json::json!({"task":{"id":"deadbeef","path":path}}).to_string();
        assert_eq!(workbench_folder_path("deadbeef", &body).unwrap_err(), "invalid_task_directory");
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::cell::Cell;
    use std::os::unix::fs::symlink;
    use std::path::Path;

    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            // 并行测试同一纳秒(macOS 时钟粒度粗)会撞名 ⇒ 加进程内计数器。
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("cc-open-folder-{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), seq));
            std::fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn dir(&self, name: &str) -> PathBuf { let path = self.0.join(name); std::fs::create_dir(&path).unwrap(); path }
    }
    impl Drop for Sandbox { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn response(path: &Path) -> String { serde_json::json!({"task":{"id":"deadbeef","path":path}}).to_string() }

    #[test]
    fn opens_only_the_validated_task_directory_as_one_launcher_argument() {
        let sandbox = Sandbox::new();
        let path = sandbox.dir("folder with spaces ; $(untouched)");
        let from_daemon = workbench_folder_path("deadbeef", &response(&path)).unwrap();
        let folder = inspect_workbench_folder(&from_daemon).unwrap();
        let calls = Cell::new(0);
        launch_workbench_folder(&folder, |argument| { assert_eq!(argument, path); calls.set(calls.get() + 1); Ok(()) }).unwrap();
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn rejects_missing_files_and_symlinks_at_every_directory_level() {
        let sandbox = Sandbox::new();
        let folder = sandbox.dir("folder");
        let nested = folder.join("nested"); std::fs::create_dir(&nested).unwrap();
        let file = sandbox.0.join("file"); std::fs::write(&file, "untouched").unwrap();
        let link = sandbox.0.join("link"); symlink(&folder, &link).unwrap();
        for path in [sandbox.0.join("missing"), file.clone(), link.clone(), link.join("nested")] {
            assert_eq!(inspect_workbench_folder(&path).err().unwrap(), "invalid_task_directory");
        }
        assert_eq!(std::fs::read_to_string(file).unwrap(), "untouched");
    }

    #[test]
    fn rejects_directory_replacement_before_launch() {
        let sandbox = Sandbox::new();
        let path = sandbox.dir("task");
        let folder = inspect_workbench_folder(&path).unwrap();
        std::fs::rename(&path, sandbox.0.join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
        let calls = Cell::new(0);
        let result = launch_workbench_folder(&folder, |_| { calls.set(calls.get() + 1); Ok(()) });
        assert_eq!(result.unwrap_err(), "task_directory_changed");
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn rejects_parent_symlink_substitution_before_launch() {
        let sandbox = Sandbox::new();
        let parent = sandbox.dir("parent"); let path = parent.join("task"); std::fs::create_dir(&path).unwrap();
        let folder = inspect_workbench_folder(&path).unwrap();
        let moved = sandbox.0.join("moved"); std::fs::rename(&parent, &moved).unwrap(); symlink(&moved, &parent).unwrap();
        let calls = Cell::new(0);
        assert_eq!(launch_workbench_folder(&folder, |_| { calls.set(calls.get() + 1); Ok(()) }).unwrap_err(), "invalid_task_directory");
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn propagates_launcher_failure_without_claiming_opened() {
        let sandbox = Sandbox::new(); let path = sandbox.dir("task");
        let folder = inspect_workbench_folder(&path).unwrap();
        assert_eq!(launch_workbench_folder(&folder, |_| Err("launcher_failed".into())).unwrap_err(), "launcher_failed");
    }
}

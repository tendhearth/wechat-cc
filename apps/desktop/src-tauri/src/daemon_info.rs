// 找到正在跑的 daemon(架构终态 F5):状态目录 → `<stateDir>/internal-api-info.json` → baseUrl + operator 令牌。
//
// 以前 agent_converse / agent_speak / agent_transcribe / pet_permission_resolve / customer_review_api /
// workbench_api 六处各抄一遍这段;现在都从这里拿,错误串一字没改(桌面按原文显示,测试也按原文比)。
//
// internal-api-info.json 由 daemon 的 registerInternalApi(src/daemon/internal-api/lifecycle.ts)写:
// {baseUrl, tokenFilePath, operatorTokenFilePath}。状态目录默认 ~/.claude/channels/wechat,WECHAT_STATE_DIR
// 可改(同 src/lib/config.ts 的 STATE_DIR)。
//
// 只读 operatorTokenFilePath,**绝不**退回 tokenFilePath:后者只登记成 trusted 档,拿它调 admin 路由必然 403,
// 退回去只会把「daemon 太老、还没写 operator 令牌」藏起来(详见 lib.rs agent_converse 上面的说明)。
// 令牌只留在 Rust 里,不经任何命令交给 webview。

use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct DaemonInfo {
    pub base_url: String,
    pub operator_token: String,
}

/// 状态目录。先解析 HOME / USERPROFILE —— 和以前六处一样,两个都没有就报错,哪怕设了 WECHAT_STATE_DIR。
pub fn state_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    Ok(std::env::var("WECHAT_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(home).join(".claude").join("channels").join("wechat")))
}

impl DaemonInfo {
    /// 按默认状态目录找。
    pub fn discover() -> Result<Self, String> {
        Self::read(&state_dir()?)
    }

    /// 按给定的状态目录找(工作台的 dev 隔离目录走这条)。
    pub fn read(state_dir: &Path) -> Result<Self, String> {
        let info_path = state_dir.join("internal-api-info.json");
        let info_raw = std::fs::read_to_string(&info_path)
            .map_err(|e| format!("read {}: {e}", info_path.display()))?;
        let info: Value = serde_json::from_str(&info_raw)
            .map_err(|e| format!("invalid JSON in {}: {e}", info_path.display()))?;
        let base_url = info
            .get("baseUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("missing baseUrl in {}", info_path.display()))?
            .to_owned();
        let operator_token_file_path = info
            .get("operatorTokenFilePath")
            .and_then(Value::as_str)
            .ok_or_else(|| "operator token unavailable — daemon too old".to_string())?;
        let operator_token = std::fs::read_to_string(operator_token_file_path)
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("token read error: {e}"))?;
        Ok(Self { base_url, operator_token })
    }
}

#[cfg(test)]
mod tests {
    use super::DaemonInfo;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cc-daemon-info-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_base_url_and_the_trimmed_operator_token() {
        let dir = scratch("ok");
        let token = dir.join("operator-token");
        std::fs::write(&token, "secret\n").unwrap();
        std::fs::write(
            dir.join("internal-api-info.json"),
            serde_json::json!({ "baseUrl": "http://127.0.0.1:1", "tokenFilePath": "/nope", "operatorTokenFilePath": token }).to_string(),
        )
        .unwrap();
        let info = DaemonInfo::read(&dir).unwrap();
        assert_eq!(info.base_url, "http://127.0.0.1:1");
        assert_eq!(info.operator_token, "secret");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_the_former_error_strings() {
        let dir = scratch("errors");
        let info_path = dir.join("internal-api-info.json");
        let err = |dir: &std::path::Path| DaemonInfo::read(dir).err().unwrap();
        assert!(err(&dir).starts_with(&format!("read {}:", info_path.display())));
        std::fs::write(&info_path, "{").unwrap();
        assert!(err(&dir).starts_with(&format!("invalid JSON in {}:", info_path.display())));
        std::fs::write(&info_path, "{}").unwrap();
        assert_eq!(err(&dir), format!("missing baseUrl in {}", info_path.display()));
        // 只有 tokenFilePath:不退回去用它
        std::fs::write(&info_path, r#"{"baseUrl":"http://x","tokenFilePath":"/etc/hosts"}"#).unwrap();
        assert_eq!(err(&dir), "operator token unavailable — daemon too old");
        std::fs::write(&info_path, r#"{"baseUrl":"http://x","operatorTokenFilePath":"/definitely/missing"}"#).unwrap();
        assert!(err(&dir).starts_with("token read error: "));
        let _ = std::fs::remove_dir_all(dir);
    }
}

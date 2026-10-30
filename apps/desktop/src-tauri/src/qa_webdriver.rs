pub(crate) fn validate(debug: bool, identifier: &str, home: &str, computer: &str) -> Result<(), String> {
    if debug && identifier == "com.tendhearth.cc-motion-qa-20261029"
        && home == "/Users/home" && computer == "Home’s Mac mini" {
        Ok(())
    } else {
        Err("Embedded UI tests require the dedicated Mac mini and the isolated debug QA application".into())
    }
}

#[cfg(feature = "qa-webdriver")]
pub(crate) fn validate_process(identifier: &str) -> Result<(), String> {
    let output = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"])
        .output().map_err(|error| format!("read QA machine identity: {error}"))?;
    if !output.status.success() { return Err("Cannot verify the dedicated QA machine".into()); }
    let computer = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    validate(cfg!(debug_assertions), identifier, &std::env::var("HOME").unwrap_or_default(), computer.trim())
}

#[cfg(test)]
#[path = "qa_webdriver_tests.rs"]
mod tests;

#[cfg(all(feature = "qa-webdriver", target_os = "macos"))]
#[path = "qa_webdriver_native.rs"]
pub(crate) mod native;

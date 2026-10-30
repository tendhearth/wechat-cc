use super::validate;

#[test]
fn dedicated_mini_debug_qa_is_allowed() {
    assert!(validate(true, "com.tendhearth.cc-motion-qa-20261029", "/Users/home", "Home’s Mac mini").is_ok());
}

#[test]
fn production_release_and_other_machines_are_rejected() {
    for (debug, identifier, home, computer) in [
        (false, "com.tendhearth.cc-motion-qa-20261029", "/Users/home", "Home’s Mac mini"),
        (true, "com.tendhearth.wechat-cc", "/Users/home", "Home’s Mac mini"),
        (true, "com.tendhearth.cc-motion-qa-20261029", "/Users/nategu_mac_company", "Home’s Mac mini"),
        (true, "com.tendhearth.cc-motion-qa-20261029", "/Users/home", "MacBook Pro"),
    ] { assert!(validate(debug, identifier, home, computer).is_err()); }
}

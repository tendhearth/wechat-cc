//! Exact, validated targets survive the gap between window creation and listen.
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    page: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
}
impl Destination {
    pub fn new(page: Option<String>, task_id: Option<String>) -> Result<Option<Self>, String> {
        match (page.as_deref(), task_id.as_deref()) {
            (None, None) => return Ok(None),
            (Some("overview" | "a2a-agents" | "converse"), None) => {},
            (Some("workbench"), Some(id)) if id.len() == 8 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {},
            _ => return Err("invalid main destination".into()),
        }
        Ok(Some(Self { page: page.unwrap(), task_id }))
    }
    pub fn pending_value(self) -> serde_json::Value {
        if self.task_id.is_none() { serde_json::Value::String(self.page) }
        else { serde_json::to_value(self).expect("serializable destination") }
    }
}

#[derive(Default)]
pub struct NavigationInbox { ready: bool, pending: Option<Destination> }
impl NavigationInbox {
    pub fn request(&mut self, destination: Option<Destination>, window_exists: bool) -> Option<Destination> {
        if !window_exists { self.ready=false; self.pending=destination; None }
        else if !self.ready { if destination.is_some() { self.pending=destination; } None }
        else { destination }
    }
    pub fn take_ready(&mut self) -> Option<Destination> { self.ready=true; self.pending.take() }
}

#[cfg(test)]
#[path = "main_navigation_tests.rs"]
mod tests;

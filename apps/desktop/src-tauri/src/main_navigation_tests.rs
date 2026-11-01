use super::{Destination, NavigationInbox};
fn task(id:&str)->Destination { Destination::new(Some("workbench".into()),Some(id.into())).unwrap().unwrap() }
#[test]
fn validates_whole_targets_before_any_window_work() {
 assert!(Destination::new(Some("workbench".into()),Some("deadbeef".into())).unwrap().is_some());
 for id in ["../abcde","DEADBEEF","abc","deadbeeé"] {assert!(Destination::new(Some("workbench".into()),Some(id.into())).is_err());}
 assert!(Destination::new(Some("workbench".into()),None).is_err());
 assert!(Destination::new(Some("converse".into()),Some("deadbeef".into())).is_err());
 assert!(Destination::new(Some("https://example.com".into()),None).is_err());
 assert!(Destination::new(None,None).unwrap().is_none());
 assert!(Destination::new(None,Some("deadbeef".into())).is_err());
}
#[test]
fn keeps_newest_task_while_a_created_main_has_no_listener_yet() {
 let mut inbox=NavigationInbox::default();
 assert!(inbox.request(Some(task("aaaa1111")),false).is_none());
 assert!(inbox.request(Some(task("bbbb2222")),true).is_none());
 assert_eq!(serde_json::to_value(inbox.take_ready()).unwrap(),serde_json::json!({"page":"workbench","taskId":"bbbb2222"}));
 assert!(inbox.take_ready().is_none());
}
#[test]
fn live_navigation_does_not_leak_into_the_next_window_open() {
 let mut inbox=NavigationInbox::default();assert!(inbox.take_ready().is_none());
 assert_eq!(serde_json::to_value(inbox.request(Some(task("deadbeef")),true)).unwrap(),serde_json::json!({"page":"workbench","taskId":"deadbeef"}));
 assert!(inbox.request(None,false).is_none());assert!(inbox.take_ready().is_none());
}
#[test]
fn a_recreated_window_buffers_its_own_latest_destination() {
 let mut inbox=NavigationInbox::default();inbox.take_ready();
 assert!(inbox.request(Some(task("deadbeef")),false).is_none());
 assert!(inbox.request(Some(task("aaaa1111")),true).is_none());
 assert_eq!(serde_json::to_value(inbox.take_ready()).unwrap(),serde_json::json!({"page":"workbench","taskId":"aaaa1111"}));
}

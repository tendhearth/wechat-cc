use super::Point;

#[test]
fn finite_logical_points_preserve_negative_monitor_origins() {
    assert_eq!(Point::new(-1200.5, 80.0).unwrap(), Point { x: -1200.5, y: 80.0 });
}

#[test]
fn native_origin_normalizes_with_the_window_scale() {
    assert_eq!(Point::from_physical(-2401.0, 160.0, 2.0).unwrap(), Point { x: -1200.5, y: 80.0 });
    assert_eq!(Point::from_physical(-1200.5, 80.0, 1.0).unwrap(), Point { x: -1200.5, y: 80.0 });
}

#[test]
fn confirmation_uses_the_observed_scale_after_crossing_monitors() {
    let point = Point::new(-1200.5, 80.0).unwrap();
    assert!(point.matches_physical(-2401.0, 160.0, 2.0));
    assert!(point.matches_physical(-1200.5, 80.0, 1.0));
    assert!(!point.matches_physical(-1198.0, 80.0, 1.0));
    assert!(!point.matches_physical(-1200.5, 80.0, f64::NAN));
}

#[test]
fn invalid_coordinates_and_scales_are_refused_before_a_native_setter() {
    for (x, y) in [(f64::NAN, 0.0), (0.0, f64::INFINITY), (1e12, 0.0)] { assert!(Point::new(x, y).is_err()); }
    for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] { assert!(Point::from_physical(0.0, 0.0, scale).is_err()); }
}

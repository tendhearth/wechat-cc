#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub(crate) struct Point { pub x: f64, pub y: f64 }

impl Point {
    pub(crate) fn new(x: f64, y: f64) -> Result<Self, String> {
        if !x.is_finite() || !y.is_finite() || x.abs() > 10_000_000.0 || y.abs() > 10_000_000.0 {
            return Err("invalid companion drag position".into());
        }
        Ok(Self { x, y })
    }
    pub(crate) fn from_physical(x: f64, y: f64, scale: f64) -> Result<Self, String> {
        if !scale.is_finite() || scale <= 0.0 { return Err("invalid companion drag scale".into()); }
        Self::new(x / scale, y / scale)
    }
    pub(crate) fn matches_physical(self, x: f64, y: f64, scale: f64) -> bool {
        Self::from_physical(x, y, scale).is_ok_and(|point| (point.x - self.x).abs() <= 0.75 && (point.y - self.y).abs() <= 0.75)
    }
}

#[cfg(test)]
#[path = "companion_drag_tests.rs"]
mod tests;

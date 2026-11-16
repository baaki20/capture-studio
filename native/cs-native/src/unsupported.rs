//! Platforms without a backend: everything reports unsupported, so main uses its fallbacks.

use std::sync::atomic::AtomicBool;
use std::time::Duration;

use crate::{Emitter, WindowInfo};

pub fn backend() -> &'static str {
    "unsupported"
}

pub fn coordinate_space() -> &'static str {
    "physical"
}

pub fn run_cursor(
    _stop: &AtomicBool,
    _period: Duration,
    _out: &mut Emitter,
    _ready: impl FnOnce(bool),
) -> Result<(), String> {
    Err("cursor tracking is not supported on this platform".into())
}

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    Err("window listing is not supported on this platform".into())
}

pub fn foreground_window() -> Result<Option<WindowInfo>, String> {
    Err("window listing is not supported on this platform".into())
}

pub fn inject_pointer(_action: &str, _x: i32, _y: i32, _button: u8) -> Result<(), String> {
    Err("synthetic input is not supported on this platform yet".into())
}

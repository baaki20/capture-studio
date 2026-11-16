//! macOS backend: the pointer from `CGEventCreate` + `CGEventGetLocation` each period (global
//! display coordinates in points, as Electron's DIPs); presses and releases from a listen-only
//! `CGEventTap` on the cursor thread's run loop, which the loop runs for one period at a time.
//! Creating the tap needs the Accessibility (or Input Monitoring) permission; without it the
//! loop still records positions and reports no clicks. Windows come from
//! `CGWindowListCopyWindowInfo` (on-screen, layer 0, front to back); their titles need the Screen
//! Recording permission.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};

use crate::{now_us, Emitter, Sample, WindowInfo, MOVE, PRESS, RELEASE};

type CGEventRef = *mut c_void;
type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type TapCallback = extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: TapCallback,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventCreate(source: *const c_void) -> CGEventRef;
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
    fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: CFMachPortRef,
        order: isize,
    ) -> CFRunLoopSourceRef;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRemoveSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRunInMode(mode: CFStringRef, seconds: f64, return_after_source: u8) -> i32;
    fn CFMachPortInvalidate(port: CFMachPortRef);
    fn CFRelease(cf: *const c_void);
    static kCFRunLoopDefaultMode: CFStringRef;
}

const SESSION_EVENT_TAP: u32 = 1;
const HEAD_INSERT: u32 = 0;
const LISTEN_ONLY: u32 = 1;
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 3;
const RIGHT_UP: u32 = 4;
const OTHER_DOWN: u32 = 25;
const OTHER_UP: u32 = 26;
const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_DISABLED_BY_USER: u32 = 0xFFFF_FFFF;

/// Button events the tap saw since the loop last looked.
static TAPPED: Mutex<Vec<Sample>> = Mutex::new(Vec::new());
/// The running tap, re-enabled when the system disables it for being slow.
static TAP: Mutex<usize> = Mutex::new(0);

pub fn backend() -> &'static str {
    "macos"
}

pub fn coordinate_space() -> &'static str {
    "dip"
}

extern "C" fn on_tap(_proxy: *mut c_void, kind: u32, event: CGEventRef, _info: *mut c_void) -> CGEventRef {
    if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER {
        if let Ok(tap) = TAP.lock() {
            if *tap != 0 {
                unsafe { CGEventTapEnable(*tap as CFMachPortRef, true) };
            }
        }
        return event;
    }
    let mapped = match kind {
        LEFT_DOWN => Some((PRESS, 1)),
        LEFT_UP => Some((RELEASE, 1)),
        RIGHT_DOWN => Some((PRESS, 3)),
        RIGHT_UP => Some((RELEASE, 3)),
        OTHER_DOWN => Some((PRESS, 2)),
        OTHER_UP => Some((RELEASE, 2)),
        _ => None,
    };
    if let Some((action, button)) = mapped {
        let at = unsafe { CGEventGetLocation(event) };
        if let Ok(mut list) = TAPPED.lock() {
            list.push(Sample { t_us: now_us(), x: at.x, y: at.y, action, button });
        }
    }
    event
}

fn location() -> Result<(f64, f64), String> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return Err("CGEventCreate failed".into());
        }
        let at = CGEventGetLocation(event);
        CFRelease(event as *const c_void);
        Ok((at.x, at.y))
    }
}

pub fn run_cursor(
    stop: &AtomicBool,
    period: Duration,
    out: &mut Emitter,
    ready: impl FnOnce(bool),
) -> Result<(), String> {
    location()?;
    let mask: u64 = [LEFT_DOWN, LEFT_UP, RIGHT_DOWN, RIGHT_UP, OTHER_DOWN, OTHER_UP]
        .iter()
        .fold(0, |m, t| m | (1u64 << t));
    let tap = unsafe {
        CGEventTapCreate(SESSION_EVENT_TAP, HEAD_INSERT, LISTEN_ONLY, mask, on_tap, std::ptr::null_mut())
    };
    let run_loop = unsafe { CFRunLoopGetCurrent() };
    let source = if tap.is_null() {
        std::ptr::null_mut()
    } else {
        unsafe {
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
            CGEventTapEnable(tap, true);
            source
        }
    };
    if let Ok(mut slot) = TAP.lock() {
        *slot = tap as usize;
    }
    if let Ok(mut list) = TAPPED.lock() {
        list.clear();
    }
    ready(!tap.is_null());
    let mut last: Option<(f64, f64)> = None;
    let result = (|| {
        while !stop.load(Ordering::SeqCst) {
            let started = Instant::now();
            // Runs the tap's source for the rest of the period (the loop's sleep).
            let rest = period.saturating_sub(started.elapsed()).as_secs_f64();
            unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, rest, 0) };
            let tapped: Vec<Sample> = TAPPED.lock().map(|mut l| l.drain(..).collect()).unwrap_or_default();
            for sample in tapped {
                last = Some((sample.x, sample.y));
                out.push(sample);
            }
            let (x, y) = location()?;
            if last != Some((x, y)) {
                out.push(Sample { t_us: now_us(), x, y, action: MOVE, button: 0 });
                last = Some((x, y));
            }
        }
        Ok(())
    })();
    if let Ok(mut slot) = TAP.lock() {
        *slot = 0;
    }
    if !tap.is_null() {
        unsafe {
            CGEventTapEnable(tap, false);
            CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
            CFMachPortInvalidate(tap);
            CFRelease(source as *const c_void);
            CFRelease(tap as *const c_void);
        }
    }
    result
}

const ON_SCREEN_ONLY: u32 = 1;
const EXCLUDE_DESKTOP: u32 = 16;

fn string_of(dict: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<String> {
    dict.find(CFString::from_static_string(key))
        .and_then(|v| v.downcast::<CFString>())
        .map(|s| s.to_string())
}

fn number_of(dict: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<i64> {
    dict.find(CFString::from_static_string(key))
        .and_then(|v| v.downcast::<CFNumber>())
        .and_then(|n| n.to_i64())
}

fn windows() -> Result<Vec<WindowInfo>, String> {
    let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) };
    if raw.is_null() {
        return Err("CGWindowListCopyWindowInfo failed".into());
    }
    let array: CFArray<CFDictionary<CFString, CFType>> = unsafe { CFArray::wrap_under_create_rule(raw) };
    let mut list = Vec::new();
    for dict in array.iter() {
        if number_of(&dict, "kCGWindowLayer").unwrap_or(0) != 0 {
            continue;
        }
        let mut rect = CGRect::default();
        let bounds = dict
            .find(CFString::from_static_string("kCGWindowBounds"))
            .map(|v| v.as_CFTypeRef() as CFDictionaryRef);
        let Some(bounds) = bounds else { continue };
        if !unsafe { CGRectMakeWithDictionaryRepresentation(bounds, &mut rect) } {
            continue;
        }
        list.push(WindowInfo {
            id: number_of(&dict, "kCGWindowNumber").unwrap_or(0).to_string(),
            title: string_of(&dict, "kCGWindowName").unwrap_or_default(),
            app: string_of(&dict, "kCGWindowOwnerName").unwrap_or_default(),
            pid: number_of(&dict, "kCGWindowOwnerPID").and_then(|p| u32::try_from(p).ok()),
            x: rect.origin.x.round() as i32,
            y: rect.origin.y.round() as i32,
            width: rect.size.width.max(0.0).round() as u32,
            height: rect.size.height.max(0.0).round() as u32,
        });
    }
    Ok(list)
}

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    windows()
}

/// The front-most normal window (the list is front to back).
pub fn foreground_window() -> Result<Option<WindowInfo>, String> {
    Ok(windows()?.into_iter().next())
}

pub fn inject_pointer(_action: &str, _x: i32, _y: i32, _button: u8) -> Result<(), String> {
    Err("synthetic input is not supported on this platform yet".into())
}

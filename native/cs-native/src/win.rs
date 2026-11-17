//! Windows backend: the pointer from `GetCursorPos` each period; presses and releases from a
//! low-level mouse hook (`WH_MOUSE_LL`) installed on the cursor thread, whose messages the loop
//! pumps every period. Windows come from `EnumWindows` (visible, titled top-level windows) with
//! `GetWindowRect` and the owning process's image name. Electron is per-monitor DPI aware, so
//! positions and rects are device pixels.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, EnumWindows, GetCursorPos, GetForegroundWindow,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, PeekMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, MSG,
    MSLLHOOKSTRUCT, PM_REMOVE, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
    WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
};

use crate::{now_us, sleep_rest, Emitter, Sample, WindowInfo, MOVE, PRESS, RELEASE};

/// Button events the hook saw since the loop last looked.
static HOOKED: Mutex<Vec<Sample>> = Mutex::new(Vec::new());

pub fn backend() -> &'static str {
    "win32"
}

pub fn coordinate_space() -> &'static str {
    "physical"
}

/// No input permission to ask for here (macOS only).
pub fn input_access(_prompt: bool) -> Option<bool> {
    None
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let event = match wparam.0 as u32 {
            WM_LBUTTONDOWN => Some((PRESS, 1)),
            WM_LBUTTONUP => Some((RELEASE, 1)),
            WM_MBUTTONDOWN => Some((PRESS, 2)),
            WM_MBUTTONUP => Some((RELEASE, 2)),
            WM_RBUTTONDOWN => Some((PRESS, 3)),
            WM_RBUTTONUP => Some((RELEASE, 3)),
            _ => None,
        };
        if let Some((action, button)) = event {
            if let Ok(mut list) = HOOKED.lock() {
                list.push(Sample {
                    t_us: now_us(),
                    x: f64::from(info.pt.x),
                    y: f64::from(info.pt.y),
                    action,
                    button,
                });
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn cursor_pos() -> Result<(f64, f64), String> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.map_err(|e| format!("GetCursorPos failed: {e}"))?;
    Ok((f64::from(point.x), f64::from(point.y)))
}

pub fn run_cursor(
    stop: &AtomicBool,
    period: Duration,
    out: &mut Emitter,
    ready: impl FnOnce(bool),
) -> Result<(), String> {
    cursor_pos()?;
    let hook = unsafe {
        GetModuleHandleW(None)
            .ok()
            .and_then(|module| SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0).ok())
    };
    if let Ok(mut list) = HOOKED.lock() {
        list.clear();
    }
    ready(hook.is_some());
    let mut last: Option<(f64, f64)> = None;
    let result = (|| {
        while !stop.load(Ordering::SeqCst) {
            let started = Instant::now();
            // The hook runs while this thread retrieves messages.
            let mut msg = MSG::default();
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            let hooked: Vec<Sample> = HOOKED.lock().map(|mut l| l.drain(..).collect()).unwrap_or_default();
            for sample in hooked {
                last = Some((sample.x, sample.y));
                out.push(sample);
            }
            let (x, y) = cursor_pos()?;
            if last != Some((x, y)) {
                out.push(Sample { t_us: now_us(), x, y, action: MOVE, button: 0 });
                last = Some((x, y));
            }
            sleep_rest(started, period);
        }
        Ok(())
    })();
    if let Some(hook) = hook {
        unsafe {
            let _ = UnhookWindowsHookEx(hook);
        }
    }
    result
}

fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size)
            .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..size as usize]);
        full.rsplit(['\\', '/']).next().unwrap_or_default().to_string()
    }
}

fn describe(hwnd: HWND) -> Option<WindowInfo> {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..copied.max(0) as usize]);
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        Some(WindowInfo {
            id: format!("0x{:x}", hwnd.0 as usize),
            title,
            app: process_name(pid),
            pid: (pid != 0).then_some(pid),
            x: rect.left,
            y: rect.top,
            width: (rect.right - rect.left).max(0) as u32,
            height: (rect.bottom - rect.top).max(0) as u32,
        })
    }
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    if let Some(info) = describe(hwnd) {
        list.push(info);
    }
    BOOL(1)
}

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let mut list: Vec<WindowInfo> = Vec::new();
    // EnumWindows walks top-level windows in Z order, front to back.
    unsafe { EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<WindowInfo> as isize)) }
        .map_err(|e| format!("EnumWindows failed: {e}"))?;
    Ok(list)
}

pub fn foreground_window() -> Result<Option<WindowInfo>, String> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(None);
    }
    Ok(describe(hwnd))
}

pub fn inject_pointer(_action: &str, _x: i32, _y: i32, _button: u8) -> Result<(), String> {
    Err("synthetic input is not supported on this platform yet".into())
}

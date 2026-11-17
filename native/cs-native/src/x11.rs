//! X11 backend: the pointer from `QueryPointer` on the root window each period, presses and
//! releases from XInput2 raw button events (all master devices; wheel buttons 4–7 ignored).
//! Windows come from the EWMH properties of the window manager (`_NET_CLIENT_LIST_STACKING`,
//! `_NET_ACTIVE_WINDOW`, `_NET_WM_NAME`, `WM_CLASS`, `_NET_WM_PID`). Positions are root-window
//! pixels.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xinput::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{
    AtomEnum, ConnectionExt as _, Window, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT,
    MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

use crate::{now_us, sleep_rest, Emitter, Sample, WindowInfo, MOVE, PRESS, RELEASE};

pub fn backend() -> &'static str {
    if std::env::var_os("DISPLAY").is_some() {
        "x11"
    } else {
        "unsupported"
    }
}

pub fn coordinate_space() -> &'static str {
    "physical"
}

/// No input permission to ask for here (macOS only).
pub fn input_access(_prompt: bool) -> Option<bool> {
    None
}

fn connect() -> Result<(RustConnection, Window), String> {
    let (conn, screen) =
        RustConnection::connect(None).map_err(|e| format!("cannot open the X display: {e}"))?;
    let root = conn.setup().roots[screen].root;
    Ok((conn, root))
}

fn pointer(conn: &RustConnection, root: Window) -> Result<(f64, f64), String> {
    let reply = conn
        .query_pointer(root)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    Ok((f64::from(reply.root_x), f64::from(reply.root_y)))
}

/// Asks for raw button events on the root window; false when XInput 2.1 is missing.
fn select_buttons(conn: &RustConnection, root: Window) -> bool {
    let attempt = || -> Result<(), Box<dyn std::error::Error>> {
        // 2.1 or later: raw events reach the root window even while another client holds a
        // grab (a press inside an app grabs the pointer until the release).
        let version = conn.xinput_xi_query_version(2, 2)?.reply()?;
        if (version.major_version, version.minor_version) < (2, 1) {
            return Err("XInput 2.1 or later is needed".into());
        }
        let mask = xinput::XIEventMask::RAW_BUTTON_PRESS | xinput::XIEventMask::RAW_BUTTON_RELEASE;
        conn.xinput_xi_select_events(
            root,
            &[xinput::EventMask {
                deviceid: xinput::Device::ALL_MASTER.into(),
                mask: vec![mask],
            }],
        )?
        .check()?;
        conn.flush()?;
        Ok(())
    };
    attempt().is_ok()
}

fn button_of(detail: u32) -> Option<u8> {
    match detail {
        1 => Some(1),
        2 => Some(2),
        3 => Some(3),
        _ => None,
    }
}

pub fn run_cursor(
    stop: &AtomicBool,
    period: Duration,
    out: &mut Emitter,
    ready: impl FnOnce(bool),
) -> Result<(), String> {
    let (conn, root) = connect()?;
    let clicks = select_buttons(&conn, root);
    let mut last: Option<(f64, f64)> = None;
    pointer(&conn, root)?;
    ready(clicks);
    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        while let Some(event) = conn.poll_for_event().map_err(|e| e.to_string())? {
            let (action, detail) = match event {
                Event::XinputRawButtonPress(e) => (PRESS, e.detail),
                Event::XinputRawButtonRelease(e) => (RELEASE, e.detail),
                _ => continue,
            };
            let Some(button) = button_of(detail) else { continue };
            let (x, y) = pointer(&conn, root)?;
            out.push(Sample { t_us: now_us(), x, y, action, button });
            last = Some((x, y));
        }
        let (x, y) = pointer(&conn, root)?;
        if last != Some((x, y)) {
            out.push(Sample { t_us: now_us(), x, y, action: MOVE, button: 0 });
            last = Some((x, y));
        }
        sleep_rest(started, period);
    }
    Ok(())
}

pub fn inject_pointer(action: &str, x: i32, y: i32, button: u8) -> Result<(), String> {
    let (conn, root) = connect()?;
    let (kind, detail) = match action {
        "move" => (MOTION_NOTIFY_EVENT, 0),
        "press" => (BUTTON_PRESS_EVENT, button),
        "release" => (BUTTON_RELEASE_EVENT, button),
        other => return Err(format!("unknown pointer action {other}")),
    };
    let clamp = |v: i32| v.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
    if kind == MOTION_NOTIFY_EVENT {
        conn.xtest_fake_input(kind, detail, 0, root, clamp(x), clamp(y), 0)
    } else {
        conn.xtest_fake_input(kind, detail, 0, root, 0, 0, 0)
    }
    .map_err(|e| e.to_string())?
    .check()
    .map_err(|e| format!("XTest refused the input: {e}"))?;
    conn.flush().map_err(|e| e.to_string())?;
    Ok(())
}

struct Atoms {
    client_list: u32,
    active: u32,
    wm_name: u32,
    utf8: u32,
    pid: u32,
}

fn atom(conn: &RustConnection, name: &str) -> Result<u32, String> {
    Ok(conn
        .intern_atom(false, name.as_bytes())
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom)
}

fn atoms(conn: &RustConnection) -> Result<Atoms, String> {
    Ok(Atoms {
        client_list: atom(conn, "_NET_CLIENT_LIST_STACKING")?,
        active: atom(conn, "_NET_ACTIVE_WINDOW")?,
        wm_name: atom(conn, "_NET_WM_NAME")?,
        utf8: atom(conn, "UTF8_STRING")?,
        pid: atom(conn, "_NET_WM_PID")?,
    })
}

fn property(conn: &RustConnection, window: Window, prop: u32, kind: u32) -> Option<Vec<u8>> {
    let reply = conn.get_property(false, window, prop, kind, 0, 4096).ok()?.reply().ok()?;
    (reply.value_len > 0).then_some(reply.value)
}

fn windows_prop(conn: &RustConnection, root: Window, prop: u32) -> Vec<Window> {
    let Ok(cookie) = conn.get_property(false, root, prop, AtomEnum::WINDOW, 0, 4096) else {
        return Vec::new();
    };
    let Ok(reply) = cookie.reply() else { return Vec::new() };
    reply.value32().map(|it| it.collect()).unwrap_or_default()
}

fn describe(conn: &RustConnection, root: Window, a: &Atoms, window: Window) -> Option<WindowInfo> {
    let title = property(conn, window, a.wm_name, a.utf8)
        .or_else(|| property(conn, window, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
        .map(|v| String::from_utf8_lossy(&v).into_owned())
        .unwrap_or_default();
    // WM_CLASS is "instance\0Class\0"; the class names the application.
    let app = property(conn, window, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into())
        .map(|v| {
            let parts: Vec<&[u8]> = v.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
            String::from_utf8_lossy(parts.last().copied().unwrap_or(&[])).into_owned()
        })
        .unwrap_or_default();
    let pid = conn
        .get_property(false, window, a.pid, AtomEnum::CARDINAL, 0, 1)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().and_then(|mut it| it.next()));
    let geometry = conn.get_geometry(window).ok()?.reply().ok()?;
    let origin = conn.translate_coordinates(window, root, 0, 0).ok()?.reply().ok()?;
    Some(WindowInfo {
        id: format!("0x{window:x}"),
        title,
        app,
        pid,
        x: i32::from(origin.dst_x),
        y: i32::from(origin.dst_y),
        width: u32::from(geometry.width),
        height: u32::from(geometry.height),
    })
}

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let (conn, root) = connect()?;
    let a = atoms(&conn)?;
    // Stacking order is bottom to top; the list is front to back.
    let mut list: Vec<WindowInfo> = windows_prop(&conn, root, a.client_list)
        .into_iter()
        .filter_map(|w| describe(&conn, root, &a, w))
        .collect();
    list.reverse();
    Ok(list)
}

pub fn foreground_window() -> Result<Option<WindowInfo>, String> {
    let (conn, root) = connect()?;
    let a = atoms(&conn)?;
    Ok(windows_prop(&conn, root, a.active)
        .first()
        .filter(|w| **w != 0)
        .and_then(|w| describe(&conn, root, &a, *w)))
}

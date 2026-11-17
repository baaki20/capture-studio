//! Capture Studio's native helper (`cs-native`, plan D7, spec §1.2): the cursor track (positions
//! at a fixed rate plus button presses and releases, stamped on one monotonic clock), the list of
//! top-level windows with their bounds, and the foreground window.
//!
//! Every backend runs the cursor loop on its own thread: it samples the pointer each period,
//! collects button events from the platform's input hook (XInput2 raw events, a low-level mouse
//! hook, a listen-only event tap), and hands batches to JavaScript through a thread-safe function.
//! A batch is a flat array of samples, five numbers each: `[tUs, x, y, action, button]` with
//! `action` 0 = move, 1 = press, 2 = release and `button` 0 = none, 1 = left, 2 = middle,
//! 3 = right. `tUs` is on `monotonicUs()`'s clock, so main can map it to the session clock.
//! Positions are global desktop coordinates in the space `coordinateSpace()` names. When the
//! loop ends (stopped, or the platform failed) one last, empty batch follows the final samples.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi_derive::napi;

#[cfg(target_os = "linux")]
#[path = "x11.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[path = "unsupported.rs"]
mod platform;
#[cfg(windows)]
#[path = "win.rs"]
mod platform;

pub const MOVE: u8 = 0;
pub const PRESS: u8 = 1;
pub const RELEASE: u8 = 2;

/// One cursor sample (see the crate comment).
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub t_us: f64,
    pub x: f64,
    pub y: f64,
    pub action: u8,
    pub button: u8,
}

/// Microseconds on the helper's monotonic clock (its origin is the first call).
pub fn now_us() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1e6
}

/// Batches handed to JavaScript at most this often.
const FLUSH_EVERY: Duration = Duration::from_millis(50);

/// Collects samples on the cursor thread and flushes them in batches.
pub struct Emitter {
    batch: Vec<f64>,
    last_flush: Instant,
    send: Box<dyn FnMut(Vec<f64>) + Send>,
}

impl Emitter {
    pub fn push(&mut self, s: Sample) {
        self.batch
            .extend_from_slice(&[s.t_us, s.x, s.y, f64::from(s.action), f64::from(s.button)]);
        if self.last_flush.elapsed() >= FLUSH_EVERY {
            self.flush();
        }
    }

    pub fn flush(&mut self) {
        self.last_flush = Instant::now();
        if self.batch.is_empty() {
            return;
        }
        (self.send)(std::mem::take(&mut self.batch));
    }
}

/// A top-level window.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct WindowInfo {
    /// Platform window id (X11 window, HWND or CGWindowID), as a string.
    pub id: String,
    pub title: String,
    /// The application or process name, empty when unknown.
    pub app: String,
    pub pid: Option<u32>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct CursorStart {
    /// Button events are reported (false when the platform refused the input hook).
    pub clicks: bool,
}

struct Running {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static RUNNING: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(None))
}

/// The backend this build and session use: `x11`, `win32`, `macos` or `unsupported`.
#[napi]
pub fn backend() -> String {
    platform::backend().to_string()
}

/// `physical` (device pixels) or `dip` (macOS points) for positions and window bounds.
#[napi]
pub fn coordinate_space() -> String {
    platform::coordinate_space().to_string()
}

/// macOS: whether Input Monitoring is granted (clicks need it); with `prompt`, asks for it.
/// Null where there is no such permission.
#[napi]
pub fn input_access(prompt: Option<bool>) -> Option<bool> {
    platform::input_access(prompt.unwrap_or(false))
}

/// The helper's clock, the one cursor samples are stamped with.
#[napi]
pub fn monotonic_us() -> f64 {
    now_us()
}

/// Starts the cursor loop at `rate_hz`; `callback` receives batches (see the crate comment).
/// Fails when a loop is already running or the platform cannot be read at all.
#[napi(ts_args_type = "rateHz: number, callback: (batch: number[]) => void")]
pub fn start_cursor(rate_hz: u32, callback: JsFunction) -> Result<CursorStart> {
    let mut slot = running().lock().map_err(|_| Error::from_reason("helper state poisoned"))?;
    if slot.is_some() {
        return Err(Error::from_reason("the cursor loop is already running"));
    }
    let tsfn: ThreadsafeFunction<Vec<f64>, ErrorStrategy::Fatal> = callback
        .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<Vec<f64>>| Ok(vec![ctx.value]))?;
    let period = Duration::from_secs_f64(1.0 / f64::from(rate_hz.clamp(10, 1000)));
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<std::result::Result<bool, String>>();
    let thread_stop = stop.clone();
    let handle = std::thread::Builder::new()
        .name("cs-native-cursor".into())
        .spawn(move || {
            let send_fn = tsfn.clone();
            let mut emitter = Emitter {
                batch: Vec::with_capacity(512),
                last_flush: Instant::now(),
                send: Box::new(move |batch| {
                    send_fn.call(batch, ThreadsafeFunctionCallMode::NonBlocking);
                }),
            };
            let result = platform::run_cursor(&thread_stop, period, &mut emitter, |clicks| {
                let _ = ready_tx.send(Ok(clicks));
            });
            emitter.flush();
            // The empty batch: JavaScript knows every sample has been delivered.
            tsfn.call(Vec::new(), ThreadsafeFunctionCallMode::Blocking);
            if let Err(message) = result {
                // Before `ready`, this is the start error; afterwards the receiver is gone.
                let _ = ready_tx.send(Err(message));
            }
            drop(tsfn);
        })
        .map_err(|e| Error::from_reason(format!("cannot start the cursor thread: {e}")))?;
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(clicks)) => {
            *slot = Some(Running { stop, handle });
            Ok(CursorStart { clicks })
        }
        Ok(Err(message)) => {
            let _ = handle.join();
            Err(Error::from_reason(message))
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err(Error::from_reason("the cursor loop did not start in time"))
        }
    }
}

/// Stops the cursor loop (after its last batch); does nothing when none is running.
#[napi]
pub fn stop_cursor() {
    let taken = running().lock().ok().and_then(|mut slot| slot.take());
    if let Some(run) = taken {
        run.stop.store(true, Ordering::SeqCst);
        let _ = run.handle.join();
    }
}

/// Visible top-level windows, front to back where the platform says so.
#[napi]
pub fn list_windows() -> Result<Vec<WindowInfo>> {
    platform::list_windows().map_err(Error::from_reason)
}

/// The window with the keyboard focus, or null.
#[napi]
pub fn foreground_window() -> Result<Option<WindowInfo>> {
    platform::foreground_window().map_err(Error::from_reason)
}

/// Synthetic pointer input (X11 XTest; spec §2.16's synthetic input, and the helper's tests):
/// `action` is `move`, `press` or `release`; `button` 1 = left, 2 = middle, 3 = right.
#[napi]
pub fn inject_pointer(action: String, x: i32, y: i32, button: Option<u8>) -> Result<()> {
    platform::inject_pointer(&action, x, y, button.unwrap_or(1)).map_err(Error::from_reason)
}

/// Sleeps the rest of a period that started at `started`.
pub fn sleep_rest(started: Instant, period: Duration) {
    if let Some(rest) = period.checked_sub(started.elapsed()) {
        std::thread::sleep(rest);
    }
}

use gpui_kit::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{SHOW_WINDOW_CMD, SW_HIDE, SW_SHOW, ShowWindowAsync},
};

/// GPUI's Windows application-level hide is currently a no-op. Hide the live
/// window instead, preserving its view, tray and independently running daemon.
pub fn hide(window: &Window) -> Result<(), String> {
    set_visibility(window, SW_HIDE)
}

/// GPUI activation restores minimized windows but does not show a hidden HWND.
/// SW_SHOW preserves normal/maximized placement; GPUI then handles focus.
pub fn show(window: &Window) -> Result<(), String> {
    set_visibility(window, SW_SHOW)
}

fn set_visibility(window: &Window, command: SHOW_WINDOW_CMD) -> Result<(), String> {
    let handle = HasWindowHandle::window_handle(window).map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("expected_windows_window".into());
    };
    // The borrowed handle belongs to this live GPUI window. Post the visibility
    // change so native close/visibility callbacks do not re-enter its model.
    unsafe { ShowWindowAsync(HWND(handle.hwnd.get() as *mut _), command) }
        .ok()
        .map_err(|error| error.to_string())
}

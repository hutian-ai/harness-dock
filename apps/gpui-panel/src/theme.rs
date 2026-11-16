use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;

/// Shared sizing for the native device utility.
/// Keep component-level geometry here; page layouts only compose these controls.
pub mod metrics {
    #[cfg(not(target_os = "macos"))]
    pub const TRAY_HEADER_HEIGHT: f32 = 32.;
    #[cfg(not(target_os = "macos"))]
    pub const GAP: f32 = 12.;
    pub const SIDEBAR_WIDTH: f32 = 208.;
    pub const CONTENT_WIDTH: f32 = 1100.;
    pub const PAGE_PADDING: f32 = 28.;
    pub const SECTION_GAP: f32 = 28.;
    pub const FORM_WIDTH: f32 = 520.;
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}
impl Appearance {
    pub fn parse(value: &str) -> Self {
        match value {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
    pub fn apply(self, cx: &mut App) {
        let mode = match self {
            Self::System => {
                cx.set_window_appearance(None);
                cx.window_appearance().into()
            }
            Self::Light => {
                cx.set_window_appearance(Some(WindowAppearance::Light));
                ThemeMode::Light
            }
            Self::Dark => {
                cx.set_window_appearance(Some(WindowAppearance::Dark));
                ThemeMode::Dark
            }
        };
        Theme::change(mode, None, cx);
    }
}

/// Use GPUI Kit's registered default themes without overriding component tokens.
pub fn sync(appearance: WindowAppearance, cx: &mut App) {
    Theme::change(appearance, None, cx);
}
